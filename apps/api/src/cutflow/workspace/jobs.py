"""Single-GPU resumable AutoClip pipeline job queue with SSE event streaming."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import defaultdict
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

from sqlalchemy import select

from .. import config, paths
from ..ai import (
    HighlightCandidate,
    TranscriptResult,
    build_clip_edl,
    build_hype_curve,
    detect_webcam_box,
    discover_highlights,
    select_hot_windows,
    transcribe_wav,
)
from ..audio import (
    WordTiming,
    extract_frame_jpeg,
    extract_lossless_clip_slice,
    extract_wav_16k,
    probe_media,
    run_clip_scoped_alignment,
    write_peaks_json,
)
from ..db import ClipProjectRow, JobRow, SourceRow, get_session
from ..db.models import new_id, utcnow_iso
from ..edl import NormalizedBox
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


def run_job_pipeline_sync(
    job_id: str,
    *,
    bus: JobEventBus | None = None,
    transcriber: Callable[..., TranscriptResult] = transcribe_wav,
    highlight_finder: Callable[..., list[HighlightCandidate]] = discover_highlights,
    webcam_detector: Callable[..., NormalizedBox | None] = detect_webcam_box,
) -> list[str]:
    """Execute the full Multi-Signal AutoClip pipeline synchronously for one job."""
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

    profile = (
        profile_store.get_profile(profile_id)
        if profile_id
        else None
    ) or profile_store.list_profiles()[0]

    work_root = paths.work_dir() / source_id
    work_root.mkdir(parents=True, exist_ok=True)

    try:
        # Stage 0: Download remote URL if not yet downloaded locally
        if source_type == "url" and (not str(source_path) or not source_path.is_file()):
            if not source_url:
                raise ValueError("URL source is missing its remote url.")
            _update_job(job_id, status="running", stage="download", progress=0.02, bus=bus)
            with track_stage(job_id, "download"):
                dl = download_video_url(source_url, paths.media_dir(), source_id)
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

        # Stage 1: FFprobe media inspection
        _update_job(job_id, status="running", stage="probe", progress=0.08, bus=bus)
        with track_stage(job_id, "probe"):
            media = probe_media(source_path)

        with get_session() as session:
            src_row = session.get(SourceRow, source_id)
            if src_row is not None:
                src_row.duration_ms = media.duration_ms
                src_row.width = media.width
                src_row.height = media.height
                src_row.fps = media.fps

        # Stage 2: Extract 16kHz WAV + Multi-Signal Hype Curve
        _update_job(job_id, stage="audio_hype", progress=0.20, bus=bus)
        wav_path = work_root / "source_16k.wav"
        with track_stage(job_id, "audio_hype"):
            extract_wav_16k(source_path, wav_path)
            hype_curve = build_hype_curve(wav_path, heatmap=heatmap)
            hot_windows = select_hot_windows(hype_curve, media.duration_ms)

        # Persist downsampled hype curve (at most 120 points) for Dashboard chart
        step = max(1, len(hype_curve) // 120)
        compact_curve = [pt.to_dict() for pt in hype_curve[::step]]
        _update_job(
            job_id,
            stage="transcribe",
            progress=0.38,
            settings_patch={
                "hypeCurve": compact_curve,
                "hotWindowCount": len(hot_windows),
            },
            bus=bus,
            extra_event={"hypeCurve": compact_curve},
        )

        # Stage 3: Hybrid ASR transcription
        prompt_terms = ", ".join(
            t for t in [profile.creator_name, profile.name, *profile.keyword_filters] if t
        )
        with track_stage(job_id, "transcribe"):
            transcript = transcriber(wav_path, initial_prompt=prompt_terms, settings=cfg)

        # Stage 4: Brief-tuned Highlight & Hook-Card discovery
        _update_job(job_id, stage="highlights", progress=0.62, bus=bus)
        with track_stage(job_id, "highlights", asr=transcript.provider):
            candidates = highlight_finder(
                transcript,
                hype_curve,
                media.duration_ms,
                profile,
                source_title=source_title,
            )

        # Stage 5: Zero-copy lossless clip slices + clip-scoped alignment + 100Hz peaks + EDL v1
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
                )

                clip_wav = clip_dir / "clip_16k.wav"
                extract_wav_16k(
                    source_path,
                    clip_wav,
                    start_ms=cand.start_ms,
                    duration_ms=max(500, cand.end_ms - cand.start_ms),
                )
                peaks_path = write_peaks_json(clip_wav, clip_dir / "peaks.json", rate_hz=100)

                mid_ms = (cand.start_ms + cand.end_ms) // 2
                thumb_path = extract_frame_jpeg(source_path, clip_dir / "thumb.jpg", mid_ms)

                if not cam_checked:
                    detected_cam_box = webcam_detector(thumb_path, profile)
                    cam_checked = True

                raw_clip_words = _slice_words_for_clip(transcript.words, cand.start_ms, cand.end_ms)
                aligned_words = run_clip_scoped_alignment(
                    raw_clip_words,
                    clip_wav,
                    mode=cfg.alignment.forced_aligner,
                )

                edl = build_clip_edl(
                    project_id=project_id,
                    source_id=source_id,
                    media=media,
                    profile=profile,
                    candidate=cand,
                    aligned_clip_words=aligned_words,
                    cam_box=detected_cam_box,
                    loudness_lufs=cfg.export.loudness_lufs,
                )

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

        _update_job(
            job_id,
            status="done",
            stage="done",
            progress=1.0,
            settings_patch={"projectIds": created_ids},
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
            # No running loop (e.g., synchronous caller) -> run inline
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
