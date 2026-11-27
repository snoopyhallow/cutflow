"""Single-GPU resumable AutoClip & Cinema pipeline job queue with SSE event streaming."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import defaultdict
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

from sqlalchemy import select

from .. import config, paths
from ..ai import (
    HighlightCandidate,
    TranscriptResult,
    auto_reframe_slices,
    build_clip_edl,
    build_hype_curve,
    detect_webcam_box,
    discover_highlights,
    select_hot_windows,
    transcribe_hot_windows,
    transcribe_wav,
)
from ..ai.transcription import release_whisper_cache
from ..audio import (
    WordTiming,
    detect_active_video_box,
    extract_embedded_subtitles,
    extract_filmstrip_jpeg,
    extract_frame_jpeg,
    extract_lossless_clip_slice,
    extract_wav_16k,
    load_sidecar_subtitle_file,
    probe_media,
    run_clip_scoped_alignment,
    write_peaks_json,
)
from ..db import ClipProjectRow, JobRow, SourceRow, get_session
from ..db.models import new_id, utcnow_iso
from ..edl import NormalizedBox, auto_tighten_silence
from ..ingest.downloader import download_video_url
from ..telemetry import track_stage
from . import profiles as profile_store

log = logging.getLogger(__name__)


class JobEventBus:
    """In-memory pub/sub broadcasting job progress updates to SSE subscribers."""

    def __init__(self) -> None:
        self._subscribers: dict[str, list[asyncio.Queue[dict[str, Any]]]] = defaultdict(list)

    def publish(self, job_id: str, event: dict[str, Any]) -> None:
        for queue in list(self._subscribers.get(job_id, ())):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(event)

    async def subscribe(self, job_id: str) -> AsyncIterator[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=64)
        self._subscribers[job_id].append(queue)
        try:
            while True:
                item = await queue.get()
                yield item
                if item.get("status") in ("done", "failed"):
                    break
        finally:
            subs = self._subscribers.get(job_id)
            if subs and queue in subs:
                subs.remove(queue)


def _update_job(
    job_id: str,
    *,
    status: str | None = None,
    stage: str | None = None,
    progress: float | None = None,
    error: str | None = None,
    settings_patch: dict[str, Any] | None = None,
    bus: JobEventBus | None = None,
    extra_event: dict[str, Any] | None = None,
) -> dict[str, Any]:
    with get_session() as session:
        row = session.get(JobRow, job_id)
        if row is None:
            raise KeyError(f"Job {job_id!r} not found.")
        if status is not None:
            row.status = status
        if stage is not None:
            row.stage = stage
        if progress is not None:
            row.progress = round(float(progress), 3)
        if error is not None:
            row.error = error
        if settings_patch:
            row.settings_json = dict(row.settings_json or {}) | settings_patch
        row.updated_at = utcnow_iso()
        snapshot = {
            "jobId": row.id,
            "sourceId": row.source_id,
            "profileId": row.profile_id,
            "status": row.status,
            "stage": row.stage,
            "progress": row.progress,
            "error": row.error,
        }
    if extra_event:
        snapshot.update(extra_event)
    if bus is not None:
        bus.publish(job_id, snapshot)
    return snapshot


def _slice_words_for_clip(
    words: list[WordTiming], clip_start_ms: int, clip_end_ms: int
) -> list[WordTiming]:
    out: list[WordTiming] = []
    for w in words:
        if w.end_ms <= clip_start_ms or w.start_ms >= clip_end_ms:
            continue
        rel_s = max(0, w.start_ms - clip_start_ms)
        rel_e = min(clip_end_ms - clip_start_ms, max(rel_s + 60, w.end_ms - clip_start_ms))
        out.append(
            WordTiming(
                text=w.text,
                start_ms=rel_s,
                end_ms=rel_e,
                speaker=w.speaker,
                confidence=w.confidence,
            )
        )
    return out


def _slice_words_for_arc(
    words: list[WordTiming],
    slices: list[tuple[int, int]],
    clip_wav: Path | None,
    aligner_mode: str,
    *,
    source_path: Path | None = None,
    source_duration_ms: int = 0,
    transcript_provider: str = "",
    transcriber: Callable[..., TranscriptResult] | None = None,
    settings: config.Settings | None = None,
    audio_rel_index: int = 0,
    audio_channels: int = 2,
    center_dialogue_boost: bool = False,
) -> list[WordTiming]:
    """Extract and align clip-relative words across one or more story-arc sub-slices.

    Runs clip-scoped Whisper + 20ms onset alignment directly on the exact short clip WAV
    whenever the job transcript came from coarse cues (embedded/sidecar SRT, Gemini Audio,
    or empty) OR on long sources (>90s) where full-VOD Whisper chunking or hot-window
    boundaries could otherwise introduce drift relative to ``clip_16k.wav``.
    """
    coarse_provider = (
        transcript_provider in ("embedded_subs", "sidecar_subs", "none")
        or transcript_provider.startswith("gemini:")
    )
    prefer_clip_realign = coarse_provider or (
        source_duration_ms > 90_000 and transcriber is transcribe_wav
    )

    if len(slices) == 1:
        raw = _slice_words_for_clip(words, slices[0][0], slices[0][1])
        if (
            (prefer_clip_realign or not raw)
            and transcriber is not None
            and clip_wav is not None
            and clip_wav.is_file()
        ):
            hint = " ".join(w.text for w in raw)[:320]
            with contextlib.suppress(Exception):
                sub_tx = transcriber(clip_wav, initial_prompt=hint, settings=settings)
                if sub_tx.words:
                    return run_clip_scoped_alignment(sub_tx.words, clip_wav, mode=aligner_mode)
        if clip_wav is not None and clip_wav.is_file():
            return run_clip_scoped_alignment(raw, clip_wav, mode=aligner_mode)
        return raw

    import tempfile

    combined: list[WordTiming] = []
    offset_ms = 0
    with tempfile.TemporaryDirectory(prefix="cutflow_arc_align_") as tmp:
        tmp_dir = Path(tmp)
        for idx, (s0, s1) in enumerate(slices):
            dur_ms = max(0, s1 - s0)
            if dur_ms < 200:
                continue
            part = _slice_words_for_clip(words, s0, s1)
            if source_path is not None and source_path.is_file():
                seg_wav = tmp_dir / f"arc_{idx}.wav"
                with contextlib.suppress(Exception):
                    extract_wav_16k(
                        source_path,
                        seg_wav,
                        start_ms=s0,
                        duration_ms=dur_ms,
                        audio_rel_index=audio_rel_index,
                        audio_channels=audio_channels,
                        center_dialogue_boost=center_dialogue_boost,
                    )
                    if (prefer_clip_realign or not part) and transcriber is not None:
                        hint = " ".join(w.text for w in part)[:320]
                        sub_tx = transcriber(seg_wav, initial_prompt=hint, settings=settings)
                        if sub_tx.words:
                            part = sub_tx.words
                    part = run_clip_scoped_alignment(part, seg_wav, mode=aligner_mode)

            for item in part:
                combined.append(
                    WordTiming(
                        text=item.text,
                        start_ms=offset_ms + max(0, min(dur_ms - 40, item.start_ms)),
                        end_ms=offset_ms + max(item.start_ms + 40, min(dur_ms, item.end_ms)),
                        speaker=item.speaker,
                        confidence=item.confidence,
                    )
                )
            offset_ms += dur_ms
    return combined


def run_job_pipeline_sync(
    job_id: str,
    *,
    bus: JobEventBus | None = None,
    transcriber: Callable[..., TranscriptResult] = transcribe_wav,
    highlight_finder: Callable[..., list[HighlightCandidate]] = discover_highlights,
    webcam_detector: Callable[..., NormalizedBox | None] = detect_webcam_box,
) -> list[str]:
    """Execute the full Multi-Signal Stream & Cinema pipeline synchronously for one job."""
    cfg = config.load()
    with get_session() as session:
        job = session.get(JobRow, job_id)
        if job is None:
            raise KeyError(f"Job {job_id!r} not found.")
        source = session.get(SourceRow, job.source_id)
        if source is None:
            raise KeyError(f"Source {job.source_id!r} not found.")
        source_id = source.id
        source_type = source.source_type
        source_url = source.url
        source_path = Path(source.path) if source.path else Path()
        source_title = source.title
        heatmap = source.heatmap_json
        profile_id = job.profile_id
        job_settings = dict(job.settings_json or {})

    profile = (
        profile_store.get_profile(profile_id)
        if profile_id
        else None
    ) or profile_store.list_profiles()[0]

    preferred_lang = profile.preferred_lang or cfg.ingest.preferred_audio_lang or "en"
    work_root = paths.work_dir() / source_id
    work_root.mkdir(parents=True, exist_ok=True)

    try:
        # Stage 0: Download remote URL (or Twitch/VOD Start-End section) with 8x parallel HLS
        if source_type == "url" and (not str(source_path) or not source_path.is_file()):
            if not source_url:
                raise ValueError("URL source is missing its remote url.")
            start_sec = job_settings.get("startSec")
            end_sec = job_settings.get("endSec")
            _update_job(job_id, status="running", stage="download", progress=0.02, bus=bus)

            last_emit = 0.0

            def _on_dl_progress(frac: float, detail: str) -> None:
                nonlocal last_emit
                now = time.monotonic()
                if now - last_emit < 0.75 and frac < 0.99:
                    return
                last_emit = now
                mapped_pct = 0.02 + 0.12 * max(0.0, min(1.0, frac))
                _update_job(
                    job_id,
                    stage="download",
                    progress=mapped_pct,
                    settings_patch={"downloadDetail": detail},
                    bus=bus,
                    extra_event={"downloadDetail": detail},
                )

            with track_stage(job_id, "download"):
                dl = download_video_url(
                    source_url,
                    paths.media_dir(),
                    source_id,
                    start_sec=float(start_sec) if start_sec is not None else None,
                    end_sec=float(end_sec) if end_sec is not None else None,
                    concurrent_fragments=cfg.ingest.concurrent_fragments,
                    cookies_browser=cfg.ingest.cookies_browser,
                    on_progress=_on_dl_progress if bus is not None else None,
                )
            source_path = dl.path
            source_title = dl.title or source_title
            heatmap = dl.heatmap
            with get_session() as session:
                src_row = session.get(SourceRow, source_id)
                if src_row is not None:
                    src_row.path = str(dl.path)
                    src_row.title = source_title
                    src_row.channel = dl.channel or src_row.channel
                    src_row.heatmap_json = dl.heatmap

        # Stage 1: FFprobe multi-track inspection + Cinema Letterbox cropdetect
        _update_job(job_id, status="running", stage="probe", progress=0.14, bus=bus)
        with track_stage(job_id, "probe"):
            media = probe_media(source_path, preferred_lang=preferred_lang)
            active_video_box = detect_active_video_box(source_path, media)

        with get_session() as session:
            src_row = session.get(SourceRow, source_id)
            if src_row is not None:
                src_row.duration_ms = media.duration_ms
                src_row.width = media.width
                src_row.height = media.height
                src_row.fps = media.fps

        center_boost = profile.content_mode == "cinema" or media.audio_channels >= 6

        # Stage 2: Check Sidecar / Embedded Subtitles (<0.5s $0 ASR bypass) + Extract 16k WAV
        _update_job(job_id, stage="audio_hype", progress=0.24, bus=bus)
        pre_transcript: TranscriptResult | None = None
        sidecar_raw = job_settings.get("sidecarSubPath")
        if sidecar_raw and Path(sidecar_raw).is_file():
            with contextlib.suppress(Exception):
                pre_transcript = load_sidecar_subtitle_file(
                    Path(sidecar_raw), language=preferred_lang
                )
        if pre_transcript is None and media.subtitle_streams:
            with track_stage(job_id, "embedded_subs"):
                pre_transcript = extract_embedded_subtitles(
                    source_path, media, preferred_lang=preferred_lang
                )

        wav_path = work_root / "source_16k.wav"
        with track_stage(job_id, "audio_hype"):
            extract_wav_16k(
                source_path,
                wav_path,
                audio_rel_index=media.preferred_audio_rel_index,
                audio_channels=media.audio_channels,
                center_dialogue_boost=center_boost,
            )
            hype_curve = build_hype_curve(
                wav_path,
                heatmap=heatmap,
                content_mode=profile.content_mode,
                dialogue_segments=pre_transcript.segments if pre_transcript else None,
            )
            hot_windows = select_hot_windows(hype_curve, media.duration_ms)

        # Persist downsampled hype curve (at most 120 points) + letterbox metadata
        step = max(1, len(hype_curve) // 120)
        compact_curve = [pt.to_dict() for pt in hype_curve[::step]]
        _update_job(
            job_id,
            stage="transcribe",
            progress=0.40,
            settings_patch={
                "hypeCurve": compact_curve,
                "hotWindowCount": len(hot_windows),
                "activeVideoBox": active_video_box,
                "audioChannels": media.audio_channels,
                "audioStreamIndex": media.preferred_audio_rel_index,
            },
            bus=bus,
            extra_event={"hypeCurve": compact_curve},
        )

        # Stage 3: Use instant Embedded/Sidecar Subtitles when present, else Hybrid Hot-Window ASR
        prompt_terms = ", ".join(
            t for t in [profile.creator_name, profile.name, *profile.keyword_filters] if t
        )
        if pre_transcript is not None and pre_transcript.segments:
            transcript = pre_transcript
        else:
            with track_stage(job_id, "transcribe", windows=len(hot_windows)):
                transcript = transcribe_hot_windows(
                    wav_path,
                    hot_windows,
                    initial_prompt=prompt_terms,
                    settings=cfg,
                    transcriber_fn=transcriber,
                )

        # Stage 4: Brief-tuned Highlight / Multi-Act Cinema Story-Arc discovery
        _update_job(job_id, stage="highlights", progress=0.62, bus=bus)
        with track_stage(job_id, "highlights", asr=transcript.provider):
            candidates = highlight_finder(
                transcript,
                hype_curve,
                media.duration_ms,
                profile,
                source_title=source_title,
            )

        # Stage 5: AAC clip slices + clip word alignment + 100Hz peaks + filmstrip + EDL
        _update_job(job_id, stage="slice_align", progress=0.76, bus=bus)
        created_ids: list[str] = []
        slice_origins: dict[str, int] = {}
        detected_cam_box: NormalizedBox | None = None
        cam_checked = False

        with track_stage(job_id, "slice_align", clip_count=len(candidates)):
            for rank, cand in enumerate(candidates, start=1):
                project_id = new_id("clip")
                clip_dir = work_root / "clips" / project_id
                clip_dir.mkdir(parents=True, exist_ok=True)

                slice_path, slice_origin_ms = extract_lossless_clip_slice(
                    source_path,
                    clip_dir / "clip_slice.mp4",
                    clip_start_ms=cand.start_ms,
                    clip_end_ms=cand.end_ms,
                    handle_ms=3000,
                    source_duration_ms=media.duration_ms,
                    audio_rel_index=media.preferred_audio_rel_index,
                    audio_codec=media.audio_codec,
                    audio_channels=media.audio_channels,
                    video_codec=media.video_codec,
                    center_dialogue_boost=center_boost,
                )

                clip_dur_ms = max(500, cand.end_ms - cand.start_ms)
                clip_wav = clip_dir / "clip_16k.wav"
                extract_wav_16k(
                    source_path,
                    clip_wav,
                    start_ms=cand.start_ms,
                    duration_ms=clip_dur_ms,
                    audio_rel_index=media.preferred_audio_rel_index,
                    audio_channels=media.audio_channels,
                    center_dialogue_boost=center_boost,
                )
                peaks_path = write_peaks_json(clip_wav, clip_dir / "peaks.json", rate_hz=100)

                mid_ms = (cand.start_ms + cand.end_ms) // 2
                thumb_path = extract_frame_jpeg(source_path, clip_dir / "thumb.jpg", mid_ms)
                with contextlib.suppress(Exception):
                    extract_filmstrip_jpeg(
                        source_path,
                        clip_dir / "filmstrip.jpg",
                        start_ms=cand.start_ms,
                        duration_ms=clip_dur_ms,
                    )

                if not cam_checked:
                    detected_cam_box = profile.cam_box or webcam_detector(thumb_path, profile)
                    cam_checked = True

                arc_bounds = (
                    cand.slices
                    if (cand.slices and len(cand.slices) >= 2)
                    else [(cand.start_ms, cand.end_ms)]
                )
                aligned_words = _slice_words_for_arc(
                    transcript.words,
                    arc_bounds,
                    clip_wav if len(arc_bounds) == 1 else None,
                    cfg.alignment.forced_aligner,
                    source_path=source_path,
                    source_duration_ms=media.duration_ms,
                    transcript_provider=transcript.provider,
                    transcriber=transcriber,
                    settings=cfg,
                    audio_rel_index=media.preferred_audio_rel_index,
                    audio_channels=media.audio_channels,
                    center_dialogue_boost=center_boost,
                )

                crop_box_model = (
                    NormalizedBox.model_validate(active_video_box).clamped()
                    if isinstance(active_video_box, dict)
                    else None
                )

                edl = build_clip_edl(
                    project_id=project_id,
                    source_id=source_id,
                    media=media,
                    profile=profile,
                    candidate=cand,
                    aligned_clip_words=aligned_words,
                    cam_box=detected_cam_box,
                    source_crop_box=crop_box_model,
                    source_title=source_title,
                    loudness_lufs=cfg.export.loudness_lufs,
                )

                # Zero-Touch Per-Shot Face Reframe on Cinema / auto_reframe profiles
                if profile.layout_mode == "auto_reframe" or (
                    profile.content_mode == "cinema"
                    and profile.layout_mode in ("centre", "crop")
                ):
                    co_ms = (
                        edl.tracks.video.cold_open.duration_ms
                        if (edl.tracks.video.cold_open and edl.tracks.video.cold_open.enabled)
                        else 0
                    )
                    edl.tracks.video.framing = auto_reframe_slices(
                        edl.tracks.video.clips,
                        default_media_path=source_path,
                        cold_open_ms=co_ms,
                        source_crop_box=crop_box_model,
                        mode="crop" if profile.content_mode == "cinema" else "centre",
                        fit_backdrop=profile.fit_backdrop,
                    )

                # Optional Zero-Touch Auto-Tighten Silence for fast-paced Gaming profiles
                if profile.auto_tighten_silence and len(arc_bounds) == 1:
                    with contextlib.suppress(Exception):
                        edl, _, _ = auto_tighten_silence(edl, min_gap_ms=1100)

                with get_session() as session:
                    session.add(
                        ClipProjectRow(
                            id=project_id,
                            job_id=job_id,
                            source_id=source_id,
                            rank=rank,
                            score=cand.score,
                            title=cand.title[:200],
                            reason=cand.reason,
                            status="draft",
                            proxy_path=str(slice_path),
                            peaks_path=str(peaks_path),
                            edl_json=edl.to_canonical_dict(),
                        )
                    )
                created_ids.append(project_id)
                slice_origins[project_id] = slice_origin_ms
                pct = 0.76 + (0.20 * (rank / max(1, len(candidates))))
                _update_job(
                    job_id,
                    stage="slice_align",
                    progress=pct,
                    settings_patch={"sliceOriginByProject": dict(slice_origins)},
                    bus=bus,
                    extra_event={"clipsCreated": len(created_ids)},
                )

        # Optional Stage 6: Auto-Export draft MP4s when CreatorProfile.auto_export is enabled
        if profile.auto_export and created_ids:
            from .exports import export_clip_project

            _update_job(job_id, stage="auto_export", progress=0.97, bus=bus)
            for pid in created_ids[:3]:
                with contextlib.suppress(Exception):
                    export_clip_project(pid, speed_preset="draft")

        _update_job(
            job_id,
            status="done",
            stage="done",
            progress=1.0,
            settings_patch={
                "projectIds": created_ids,
                "transcriptProvider": transcript.provider,
            },
            bus=bus,
            extra_event={"projectIds": created_ids},
        )
        return created_ids

    except Exception as exc:
        log.exception("Job %s failed: %s", job_id, exc)
        _update_job(
            job_id,
            status="failed",
            stage="failed",
            error=str(exc)[:1000],
            bus=bus,
        )
        raise
    finally:
        release_whisper_cache()


class JobManager:
    """Async single-GPU queue managing background pipeline jobs and SSE notifications."""

    def __init__(self) -> None:
        self.bus = JobEventBus()
        self._semaphore = asyncio.Semaphore(1)
        self._tasks: set[asyncio.Task[Any]] = set()

    def recover_interrupted_jobs(self) -> int:
        """Mark stale 'running' jobs from a prior crash cleanly as failed so users can retry."""
        recovered = 0
        with get_session() as session:
            rows = session.scalars(select(JobRow).where(JobRow.status == "running")).all()
            for row in rows:
                row.status = "failed"
                row.stage = "interrupted"
                row.error = "Server stopped while job was running. Click Retry to resume."
                row.updated_at = utcnow_iso()
                recovered += 1
        return recovered

    def submit(self, job_id: str) -> None:
        """Schedule a job onto the active asyncio event loop with single-GPU serialization."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            run_job_pipeline_sync(job_id, bus=self.bus)
            return

        async def _runner() -> None:
            async with self._semaphore:
                with contextlib.suppress(Exception):
                    await asyncio.to_thread(run_job_pipeline_sync, job_id, bus=self.bus)

        task = loop.create_task(_runner())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)


job_manager = JobManager()
