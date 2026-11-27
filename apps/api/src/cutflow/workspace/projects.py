"""Manual Blank Project creation, CRUD helpers, and Zero-Copy Local Path ingest."""

from __future__ import annotations

import contextlib
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .. import config, paths
from ..audio import (
    AUDIO_EXTENSIONS,
    extract_filmstrip_jpeg,
    extract_frame_jpeg,
    extract_wav_16k,
    probe_media,
    write_peaks_json,
)
from ..db import ClipProjectRow, JobRow, SourceRow, get_session
from ..db.models import new_id
from ..edl import TimelineMapper, TimelineProject
from ..edl.schema import (
    AudioTrack,
    FramingSegment,
    OutputSpec,
    RatioLiteral,
    SubtitleStyle,
    SubtitleTrack,
    TimelineTracks,
    VideoSlice,
    VideoTrack,
)
from ..ingest import VIDEO_EXTENSIONS
from . import profiles as profile_store

ALLOWED_LOCAL_MEDIA_EXTS = frozenset({*VIDEO_EXTENSIONS, *AUDIO_EXTENSIONS})


def _ensure_blank_slate_mp4() -> Path:
    """Synthesize a lightweight 5s 1920x1080 dark carbon slate MP4 once for empty projects."""
    paths.ensure_layout()
    slate = paths.media_dir() / "blank_slate.mp4"
    if slate.is_file() and slate.stat().st_size > 0:
        return slate

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=0x09090B:s=1920x1080:r=30:d=5.0",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=channel_layout=stereo:sample_rate=48000",
                "-shortest",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                str(slate),
            ],
            capture_output=True,
            timeout=15,
            check=False,
        )
    return slate


def import_local_media_path(
    raw_path: str,
    *,
    profile_id: str | None = None,
    auto_clip: bool = False,
    title: str = "",
) -> tuple[SourceRow, JobRow | None]:
    """Register an existing local disk video/audio file in SQLite with zero byte copying."""
    cleaned = raw_path.strip().strip('"')
    if not cleaned:
        raise ValueError("File path cannot be empty.")
    target = Path(cleaned).expanduser().resolve()
    if not target.is_file():
        raise FileNotFoundError(f"Local media file not found: {target}")

    ext = target.suffix.lower()
    if ext not in ALLOWED_LOCAL_MEDIA_EXTS:
        allowed = ", ".join(sorted(ALLOWED_LOCAL_MEDIA_EXTS))
        raise ValueError(f"Unsupported media extension {ext!r}; allowed: {allowed}")

    duration_ms = 5000
    width: int | None = 1920
    height: int | None = 1080
    fps: float | None = 30.0
    with contextlib.suppress(Exception):
        info = probe_media(target)
        duration_ms = max(200, info.duration_ms)
        width = info.width or None
        height = info.height or None
        fps = info.fps or None

    source_id = new_id("src")
    resolved_title = (title.strip() or target.stem)[:255] or source_id
    chosen_profile = profile_id or (
        profile_store.list_profiles()[0].id if profile_store.list_profiles() else None
    )

    with get_session() as session:
        src = SourceRow(
            id=source_id,
            source_type="local",
            url=None,
            path=str(target),
            title=resolved_title,
            duration_ms=duration_ms,
            width=width,
            height=height,
            fps=fps,
        )
        session.add(src)
        job: JobRow | None = None
        if auto_clip:
            job = JobRow(
                id=new_id("job"),
                source_id=source_id,
                profile_id=chosen_profile,
                status="queued",
                stage="queued",
                progress=0.0,
                settings_json={"trigger": "local_path", "originalFilename": target.name},
            )
            session.add(job)
        session.flush()
        session.expunge(src)
        if job is not None:
            session.expunge(job)
        return src, job


def create_blank_project(
    *,
    title: str = "Untitled Project",
    ratio: RatioLiteral = "9:16",
    source_id: str | None = None,
    local_path: str | None = None,
    profile_id: str | None = None,
) -> dict[str, Any]:
    """Create a manual CapCut-style NLE project (with optional initial source or blank slate)."""
    cfg = config.load()
    if local_path:
        imported_src, _ = import_local_media_path(
            local_path, profile_id=profile_id, auto_clip=False, title=title
        )
        source_id = imported_src.id

    with get_session() as session:
        src_row = session.get(SourceRow, source_id) if source_id else None
        if src_row is None:
            slate_path = _ensure_blank_slate_mp4()
            src_row = session.get(SourceRow, "src_blank_slate")
            if src_row is None:
                src_row = SourceRow(
                    id="src_blank_slate",
                    source_type="blank",
                    url=None,
                    path=str(slate_path),
                    title="Blank Canvas Slate",
                    duration_ms=5000,
                    width=1920,
                    height=1080,
                    fps=30.0,
                )
                session.add(src_row)
                session.flush()
        src_id = src_row.id
        src_path = Path(src_row.path) if src_row.path else Path()
        src_dur = max(1000, int(src_row.duration_ms or 5000))
        src_w = int(src_row.width or 1920)
        src_h = int(src_row.height or 1080)
        src_title = src_row.title

    profiles = profile_store.list_profiles()
    chosen_profile_id = profile_id or (profiles[0].id if profiles else None)
    project_id = new_id("clip")
    job_id = new_id("job")
    clean_title = (
        title.strip()[:160]
        if title.strip()
        else (src_title if src_id != "src_blank_slate" else "Untitled Project")
    )

    clip_dir = paths.work_dir() / src_id / "clips" / project_id
    clip_dir.mkdir(parents=True, exist_ok=True)
    peaks_path_str: str | None = None

    if src_path.is_file() and src_id != "src_blank_slate":
        with contextlib.suppress(Exception):
            extract_frame_jpeg(
                src_path, clip_dir / "thumb.jpg", timestamp_s=min(1.0, src_dur / 2000.0)
            )
            extract_filmstrip_jpeg(
                src_path, clip_dir / "filmstrip.jpg", duration_ms=min(src_dur, 180_000)
            )
        if src_dur <= 600_000:
            with contextlib.suppress(Exception):
                wav_tmp = clip_dir / "audio_16k.wav"
                extract_wav_16k(src_path, wav_tmp)
                peaks_file = clip_dir / "peaks.json"
                write_peaks_json(wav_tmp, peaks_file)
                wav_tmp.unlink(missing_ok=True)
                peaks_path_str = str(peaks_file)

    edl = TimelineProject(
        schema_version=1,
        project_id=project_id,
        source_id=src_id,
        profile_id=chosen_profile_id,
        title=clean_title,
        status="draft",
        source_duration_ms=src_dur,
        source_width=src_w,
        source_height=src_h,
        output=OutputSpec(
            ratio=ratio if ratio in ("9:16", "4:5", "1:1", "16:9") else "9:16",
            quality="1080p",
            speed_preset="final",
            fps=60,
            loudness_lufs=cfg.export.loudness_lufs,
            border_style="none",
            cinema_grade="off",
        ),
        tracks=TimelineTracks(
            video=VideoTrack(
                cold_open=None,
                clips=[
                    VideoSlice(
                        id="s1",
                        source_start_ms=0,
                        source_end_ms=src_dur,
                        source_id=src_id,
                        label=clean_title[:42],
                    )
                ],
                framing=[
                    FramingSegment(
                        id="f1",
                        timeline_start_ms=0,
                        timeline_end_ms=src_dur,
                        mode="fit",
                        fit_backdrop="black",
                    )
                ],
            ),
            audio=AudioTrack(
                gain_db=0.0,
                normalize_lufs=cfg.export.loudness_lufs,
                dialogue_enhance=False,
                bgm=None,
            ),
            subtitles=SubtitleTrack(
                enabled=True,
                style=SubtitleStyle(preset="bold_pop", reveal_mode="progressive"),
                censor_profanity=False,
                margin_v_ratio=0.22,
                mute_ranges=[],
                words=[],
            ),
            overlays=[],
        ),
    )

    with get_session() as session:
        job_row = JobRow(
            id=job_id,
            source_id=src_id,
            profile_id=chosen_profile_id,
            status="done",
            stage="manual",
            progress=1.0,
            settings_json={"trigger": "blank_project", "sliceOriginByProject": {project_id: 0}},
        )
        session.add(job_row)
        session.flush()

        proj_row = ClipProjectRow(
            id=project_id,
            job_id=job_id,
            source_id=src_id,
            rank=1,
            score=100,
            title=clean_title,
            reason="Manual NLE Timeline Project",
            status="draft",
            proxy_path="",
            peaks_path=peaks_path_str,
            edl_json=edl.to_canonical_dict(),
        )
        session.add(proj_row)
        session.flush()
        created_at = proj_row.created_at
        updated_at = proj_row.updated_at

    return {
        "id": project_id,
        "jobId": job_id,
        "sourceId": src_id,
        "title": clean_title,
        "totalDurationMs": TimelineMapper(edl).total_duration_ms,
        "edl": edl.to_canonical_dict(),
        "createdAt": created_at,
        "updatedAt": updated_at,
    }


def duplicate_clip_project(project_id: str) -> ClipProjectRow:
    with get_session() as session:
        orig = session.get(ClipProjectRow, project_id)
        if orig is None:
            raise KeyError(f"Clip project {project_id!r} not found.")
        edl = TimelineProject.model_validate(orig.edl_json)
        new_pid = new_id("clip")
        new_title = f"{orig.title or edl.title or 'Project'} (Copy)"[:200]
        edl.project_id = new_pid
        edl.title = new_title

        copy_row = ClipProjectRow(
            id=new_pid,
            job_id=orig.job_id,
            source_id=orig.source_id,
            rank=orig.rank,
            score=orig.score,
            title=new_title,
            reason=orig.reason,
            status="draft",
            proxy_path=orig.proxy_path,
            peaks_path=orig.peaks_path,
            edl_json=edl.to_canonical_dict(),
        )
        session.add(copy_row)
        job = session.get(JobRow, orig.job_id)
        if job is not None:
            settings = dict(job.settings_json or {})
            origins = dict(settings.get("sliceOriginByProject") or {})
            origins[new_pid] = int(origins.get(orig.id, 0))
            settings["sliceOriginByProject"] = origins
            job.settings_json = settings
        session.flush()
        session.expunge(copy_row)
        return copy_row


def delete_clip_project(project_id: str) -> bool:
    with get_session() as session:
        row = session.get(ClipProjectRow, project_id)
        if row is None:
            return False
        session.delete(row)
    return True


def transcribe_clip_project(
    project_id: str,
    *,
    language: str = "",
    transcriber_fn=None,
) -> dict[str, Any]:
    """Generate or refresh synced word-level Auto-Captions across an existing project's timeline."""
    import tempfile

    from ..ai import infer_word_glow_color, transcribe_wav
    from ..audio import extract_lossless_clip_slice, run_clip_scoped_alignment
    from ..db.models import utcnow_iso
    from ..edl.schema import SubtitleWord
    from ..render.compiler import _build_atempo_filters
    from .exports import _resolve_render_media

    cfg = config.load()
    if language.strip():
        cfg.alignment.language = language.strip()
    runner = transcriber_fn or transcribe_wav

    with get_session() as session:
        proj = session.get(ClipProjectRow, project_id)
        if proj is None:
            raise KeyError(f"Clip project {project_id!r} not found.")
        source = session.get(SourceRow, proj.source_id)
        job = session.get(JobRow, proj.job_id)
        media_path, input_origin_ms = _resolve_render_media(proj, source, job)
        edl = TimelineProject.model_validate(proj.edl_json)
        has_raw_src = (
            source is not None
            and not source.archived
            and bool(source.path)
            and Path(source.path).is_file()
        )
        raw_source_path = Path(source.path) if (has_raw_src and source is not None) else None
        proxy_path_str = proj.proxy_path or ""
        source_dur_ms = int(source.duration_ms or 0) if source is not None else 0
        source_media_map: dict[str, tuple[Path, int]] = {
            proj.source_id: (media_path, input_origin_ms)
        }
        for sl in edl.tracks.video.clips:
            if sl.source_id and sl.source_id not in source_media_map:
                extra = session.get(SourceRow, sl.source_id)
                if extra and not extra.archived and extra.path and Path(extra.path).is_file():
                    source_media_map[sl.source_id] = (Path(extra.path), 0)

    # Heal legacy keyframe-shifted clip_slice.mp4 automatically when raw source exists!
    refreshed_origin_ms: int | None = None
    if raw_source_path is not None and proxy_path_str and edl.tracks.video.clips:
        slice_target = Path(proxy_path_str)
        s_min = min(c.source_start_ms for c in edl.tracks.video.clips)
        s_max = max(c.source_end_ms for c in edl.tracks.video.clips)
        if edl.tracks.video.cold_open and edl.tracks.video.cold_open.enabled:
            co = edl.tracks.video.cold_open
            s_min = min(s_min, co.source_start_ms)
            s_max = max(s_max, co.source_start_ms + co.duration_ms)
        with contextlib.suppress(Exception):
            _, refreshed_origin_ms = extract_lossless_clip_slice(
                raw_source_path,
                slice_target,
                clip_start_ms=s_min,
                clip_end_ms=s_max,
                handle_ms=3000,
                source_duration_ms=source_dur_ms or None,
            )

    before = edl.model_copy(deep=True)
    updated = edl.model_copy(deep=True)
    mapper = TimelineMapper(updated)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required on PATH to extract audio for Auto-Captions.")

    is_punch = updated.tracks.subtitles.style.preset == "viral_punch_glow"
    new_words: list[SubtitleWord] = []
    provider_used = "none"
    detected_lang = language or cfg.alignment.language or "en"

    with tempfile.TemporaryDirectory(prefix="cutflow_autocap_") as tmp:
        tmp_dir = Path(tmp)
        for idx, (t_start, t_end, clip) in enumerate(mapper.spans):
            if clip.freeze_duration_ms > 0 or clip.muted or clip.gain_db <= -59.5:
                continue
            seg_media, seg_origin = source_media_map.get(
                clip.source_id or updated.source_id, (media_path, input_origin_ms)
            )
            if not seg_media.is_file():
                continue
            rel_start_s = max(0.0, (clip.source_start_ms - seg_origin) / 1000.0)
            raw_dur_s = max(0.15, clip.raw_source_duration_ms / 1000.0)
            slice_wav = tmp_dir / f"span_{idx}.wav"
            af_chain = _build_atempo_filters(clip.speed)
            if clip.reverse:
                af_chain = ["areverse", *af_chain]
            cmd = [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                f"{rel_start_s:.3f}",
                "-t",
                f"{raw_dur_s:.3f}",
                "-i",
                str(seg_media),
                "-vn",
            ]
            if af_chain:
                cmd.extend(["-af", ",".join(af_chain)])
            cmd.extend(["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(slice_wav)])
            proc = subprocess.run(cmd, capture_output=True, timeout=180, check=False)
            if proc.returncode != 0 or not slice_wav.is_file():
                continue

            res = runner(slice_wav, initial_prompt=updated.title, settings=cfg)
            if res.provider != "none":
                provider_used = res.provider
            if res.language:
                detected_lang = res.language

            aligned = (
                run_clip_scoped_alignment(res.words, slice_wav, mode=cfg.alignment.forced_aligner)
                if res.words
                else []
            )
            span_dur = t_end - t_start
            for w_idx, wt in enumerate(aligned):
                ws = t_start + max(0, min(span_dur - 60, wt.start_ms))
                we = t_start + max(wt.start_ms + 60, min(span_dur, wt.end_ms))
                if we <= ws:
                    continue
                glow = infer_word_glow_color(wt.text) if is_punch else None
                new_words.append(
                    SubtitleWord(
                        id=f"w_{idx}_{w_idx}",
                        text=wt.text,
                        start_ms=ws,
                        end_ms=we,
                        speaker=wt.speaker,
                        glow_color=glow,
                    )
                )

    new_words.sort(key=lambda w: (w.start_ms, w.end_ms))
    # Prevent adjacent overlap across span boundaries
    for i in range(1, len(new_words)):
        if new_words[i].start_ms < new_words[i - 1].end_ms:
            if new_words[i].start_ms > new_words[i - 1].start_ms + 60:
                new_words[i - 1].end_ms = new_words[i].start_ms
            else:
                new_words[i].start_ms = new_words[i - 1].end_ms
                new_words[i].end_ms = max(new_words[i].start_ms + 60, new_words[i].end_ms)

    updated.tracks.subtitles.words = new_words
    if new_words:
        updated.tracks.subtitles.enabled = True

    updated_at_out = ""
    effective_origin_ms = (
        refreshed_origin_ms if refreshed_origin_ms is not None else input_origin_ms
    )
    with get_session() as session:
        row = session.get(ClipProjectRow, project_id)
        if row is not None:
            row.edl_json = updated.to_canonical_dict()
            row.updated_at = utcnow_iso()
            updated_at_out = row.updated_at
            if refreshed_origin_ms is not None:
                job_row = session.get(JobRow, row.job_id)
                if job_row is not None:
                    st = dict(job_row.settings_json or {})
                    origins = dict(st.get("sliceOriginByProject") or {})
                    origins[project_id] = refreshed_origin_ms
                    st["sliceOriginByProject"] = origins
                    job_row.settings_json = st

    return {
        "edl": updated.to_canonical_dict(),
        "previousEdl": before.to_canonical_dict(),
        "wordCount": len(new_words),
        "provider": provider_used,
        "language": detected_lang,
        "totalDurationMs": TimelineMapper(updated).total_duration_ms,
        "sliceOriginMs": effective_origin_ms,
        "updatedAt": updated_at_out,
    }
