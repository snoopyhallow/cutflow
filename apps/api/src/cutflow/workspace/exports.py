"""Export execution, post-archive slice fallback, DB persistence, and cleanup."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import desc, select

from .. import config, paths
from ..db import ClipProjectRow, ExportRow, JobRow, SourceRow, get_session
from ..db.models import new_id, utcnow_iso
from ..edl import TimelineProject
from ..render import render_edl_to_mp4
from ..security import PathSandboxError, safe_resolve, safe_slug
from ..telemetry import track_stage


def _resolve_render_media(
    project: ClipProjectRow,
    source: SourceRow | None,
    job: JobRow | None,
) -> tuple[Path, int]:
    """Choose raw source when present, or lossless clip_slice.mp4 after Raw VOD Archive."""
    if source is not None and not source.archived and source.path:
        raw = Path(source.path)
        if raw.is_file():
            return raw, 0

    if project.proxy_path:
        slice_file = Path(project.proxy_path)
        if slice_file.is_file():
            settings = (job.settings_json or {}) if job is not None else {}
            origins = settings.get("sliceOriginByProject") or {}
            origin_ms = int(origins.get(project.id, 0))
            return slice_file, origin_ms

    raise FileNotFoundError(
        "Neither the raw VOD nor a lossless clip slice exists on disk for this project."
    )


def _export_dict(row: ExportRow, *, title: str = "", encoder: str = "") -> dict[str, Any]:
    return {
        "id": row.id,
        "projectId": row.project_id,
        "title": title,
        "ratio": row.ratio,
        "quality": row.quality,
        "speedPreset": row.speed_preset,
        "sizeBytes": row.size_bytes,
        "durationMs": row.duration_ms,
        "encoder": encoder,
        "createdAt": row.created_at,
    }


def export_clip_project(
    project_id: str,
    *,
    ratio: str | None = None,
    quality: str | None = None,
    speed_preset: str | None = None,
) -> dict[str, Any]:
    """Render a clip project's current EDL v1 to MP4 and persist an ExportRow."""
    cfg = config.load()
    with get_session() as session:
        proj = session.get(ClipProjectRow, project_id)
        if proj is None:
            raise KeyError(f"Clip project {project_id!r} not found.")
        source = session.get(SourceRow, proj.source_id)
        job = session.get(JobRow, proj.job_id)
        media_path, input_origin_ms = _resolve_render_media(proj, source, job)
        edl = TimelineProject.model_validate(proj.edl_json)
        title = proj.title or edl.title or proj.id

        # Resolve per-source media paths for multi-source Theme Mashup EDLs
        source_media_map: dict[str, tuple[Path, int]] = {
            proj.source_id: (media_path, input_origin_ms)
        }
        extra_src_ids = {
            sl.source_id
            for sl in edl.tracks.video.clips
            if sl.source_id and sl.source_id not in source_media_map
        }
        extra_src_ids.update(
            br.source_id
            for br in edl.tracks.video.broll
            if br.source_id and br.source_id not in source_media_map
        )
        extra_src_ids.update(
            ac.source_id
            for ac in edl.tracks.audio.clips
            if ac.source_id and ac.source_id not in source_media_map
        )
        for sid in extra_src_ids:
            extra_src = session.get(SourceRow, sid)
            if extra_src is not None and not extra_src.archived and extra_src.path:
                raw_p = Path(extra_src.path)
                if raw_p.is_file():
                    source_media_map[sid] = (raw_p, 0)
                    continue
            alt_proj = session.scalar(
                select(ClipProjectRow).where(ClipProjectRow.source_id == sid)
            )
            if alt_proj is not None:
                alt_job = session.get(JobRow, alt_proj.job_id)
                source_media_map[sid] = _resolve_render_media(alt_proj, extra_src, alt_job)

    render_edl = edl.model_copy(deep=True)
    if ratio in ("9:16", "4:5", "1:1", "16:9"):
        render_edl.output.ratio = ratio  # type: ignore[assignment]
    if quality in ("720p", "1080p", "1440p", "4k"):
        render_edl.output.quality = quality  # type: ignore[assignment]
    if speed_preset in ("draft", "final"):
        render_edl.output.speed_preset = speed_preset  # type: ignore[assignment]

    export_id = new_id("exp")
    slug = safe_slug(title, max_length=40, default="clip")
    paths.ensure_layout()
    out_mp4 = safe_resolve(
        paths.exports_dir()
        / f"{slug}_{render_edl.output.quality}_{render_edl.output.speed_preset}_{export_id}.mp4",
        paths.exports_dir(),
    )
    scratch_dir = paths.work_dir() / "render_scratch" / export_id

    with track_stage(
        export_id,
        "render_mp4",
        project_id=project_id,
        quality=render_edl.output.quality,
        speed_preset=render_edl.output.speed_preset,
    ):
        plan = render_edl_to_mp4(
            render_edl,
            media_path=media_path,
            output_path=out_mp4,
            scratch_dir=scratch_dir,
            input_origin_ms=input_origin_ms,
            source_media_map=source_media_map,
            prefer_nvenc=cfg.export.prefer_hardware_encoder,
        )

    size_bytes = out_mp4.stat().st_size
    with get_session() as session:
        row = ExportRow(
            id=export_id,
            project_id=project_id,
            path=str(out_mp4),
            ratio=render_edl.output.ratio,
            quality=render_edl.output.quality,
            speed_preset=render_edl.output.speed_preset,
            size_bytes=size_bytes,
            duration_ms=plan.duration_ms,
        )
        session.add(row)
        proj_row = session.get(ClipProjectRow, project_id)
        if proj_row is not None:
            proj_row.status = "exported"
            proj_row.updated_at = utcnow_iso()
        session.flush()
        return _export_dict(row, title=title, encoder=plan.encoder)


def list_exports(project_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    with get_session() as session:
        stmt = select(ExportRow).order_by(desc(ExportRow.created_at))
        if project_id:
            stmt = stmt.where(ExportRow.project_id == project_id)
        rows = session.scalars(stmt.limit(limit)).all()
        out: list[dict[str, Any]] = []
        for row in rows:
            proj = session.get(ClipProjectRow, row.project_id)
            out.append(_export_dict(row, title=proj.title if proj else row.project_id))
        return out


def delete_export(export_id: str) -> bool:
    with get_session() as session:
        row = session.get(ExportRow, export_id)
        if row is None:
            return False
        raw_path = row.path
        session.delete(row)

    if raw_path:
        try:
            safe = safe_resolve(Path(raw_path), paths.exports_dir())
            safe.unlink(missing_ok=True)
        except PathSandboxError:
            pass
    return True
