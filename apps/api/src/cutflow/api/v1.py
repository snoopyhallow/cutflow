"""CutFlow REST & SSE API v1 endpoints."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import desc, select

from .. import __version__, cli, config, paths
from ..ai import generate_post_copy, run_coeditor
from ..db import ClipProjectRow, ExportRow, FeedItemRow, JobRow, SourceRow, get_session
from ..db.models import new_id, utcnow_iso
from ..edl import TimelineMapper, TimelineProject, apply_blade_cut, apply_edl_patch
from ..ingest import VIDEO_EXTENSIONS, InboxWatcher, poll_all_feeds
from ..render import RenderError
from ..security import (
    PathSandboxError,
    SSRFError,
    delete_secret,
    keys_presence,
    safe_resolve,
    safe_slug,
    set_secret,
    validate_public_url,
)
from ..workspace import exports as export_store
from ..workspace import profiles as profile_store
from ..workspace.archive import archive_source_vod, storage_summary
from ..workspace.jobs import job_manager
from ..workspace.profiles import CreatorProfile

router = APIRouter(prefix="/api/v1", tags=["v1"])


class ProfileOut(CreatorProfile):
    inbox_path: str

    @classmethod
    def of(cls, profile: CreatorProfile) -> ProfileOut:
        return cls(
            **profile.model_dump(),
            inbox_path=str(paths.inbox_dir() / safe_slug(profile.id)),
        )


class ProfileCreateIn(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=120)
    creator_name: str = ""
    brief: str = ""
    min_duration_s: float = Field(default=15.0, gt=0)
    max_duration_s: float = Field(default=50.0, gt=0)
    max_clips: int = Field(default=8, ge=1, le=50)
    layout_mode: str = "auto_split"
    split_ratio: float = Field(default=0.35, ge=0.20, le=0.65)
    title_card_style: str = "seam_card_white"
    cold_open_enabled: bool = True
    cold_open_duration_ms: int = Field(default=1500, ge=500, le=4000)
    cta_mode: str = "off"
    cta_text: str = ""
    reveal_mode: str = "progressive"
    caption_style: str = "bold_pop"
    burn_captions: bool = True
    censor_profanity: bool = True
    editor_boundaries: str = ""
    channel_urls: list[str] = Field(default_factory=list)
    keyword_filters: list[str] = Field(default_factory=list)
    auto_queue_feed: bool = False
    auto_export: bool = False


class UrlSourceIn(BaseModel):
    url: str = Field(min_length=1)
    profile_id: str | None = Field(default=None, alias="profileId")
    title: str = ""
    auto_clip: bool = Field(default=True, alias="autoClip")

    model_config = {"populate_by_name": True}


class JobCreateIn(BaseModel):
    source_id: str = Field(alias="sourceId", min_length=1)
    profile_id: str | None = Field(default=None, alias="profileId")

    model_config = {"populate_by_name": True}


class BladeCutIn(BaseModel):
    cut_start_ms: int = Field(alias="cutStartMs", ge=0)
    cut_end_ms: int = Field(alias="cutEndMs", ge=1)

    model_config = {"populate_by_name": True}


class EdlPatchIn(BaseModel):
    ops: list[dict[str, Any]] = Field(min_length=1)


class CoEditorIn(BaseModel):
    instruction: str = Field(min_length=1, max_length=1000)
    boundaries: str | None = None
    playhead_ms: int = Field(default=0, alias="playheadMs", ge=0)
    save_boundaries: bool = Field(default=False, alias="saveBoundaries")

    model_config = {"populate_by_name": True}


class ProjectStatusIn(BaseModel):
    status: str = Field(pattern=r"^(draft|approved|exported|posted|archived)$")


class PostCopyIn(BaseModel):
    platform: str = Field(default="all", pattern=r"^(tiktok|shorts|reels|all)$")


class ExportRequestIn(BaseModel):
    ratio: str | None = None
    quality: str | None = None
    speed_preset: str | None = Field(default=None, alias="speedPreset")

    model_config = {"populate_by_name": True}


class SecretIn(BaseModel):
    key: str
    value: str = Field(min_length=1)


def _source_dict(row: SourceRow) -> dict[str, Any]:
    return {
        "id": row.id,
        "sourceType": row.source_type,
        "url": row.url,
        "title": row.title,
        "channel": row.channel,
        "durationMs": row.duration_ms,
        "width": row.width,
        "height": row.height,
        "fps": row.fps,
        "archived": row.archived,
        "createdAt": row.created_at,
    }


def _job_dict(row: JobRow, *, source_title: str = "", clip_count: int = 0) -> dict[str, Any]:
    settings = row.settings_json or {}
    return {
        "id": row.id,
        "sourceId": row.source_id,
        "sourceTitle": source_title,
        "profileId": row.profile_id,
        "status": row.status,
        "stage": row.stage,
        "progress": row.progress,
        "error": row.error,
        "clipCount": clip_count,
        "hypeCurve": settings.get("hypeCurve", []),
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    }


def _project_summary(row: ClipProjectRow) -> dict[str, Any]:
    edl = TimelineProject.model_validate(row.edl_json)
    proxy_ok = bool(row.proxy_path and Path(row.proxy_path).is_file())
    peaks_ok = bool(row.peaks_path and Path(row.peaks_path).is_file())
    thumb_path = Path(row.proxy_path).parent / "thumb.jpg" if row.proxy_path else None
    thumb_ok = bool(thumb_path and thumb_path.is_file())
    return {
        "id": row.id,
        "jobId": row.job_id,
        "sourceId": row.source_id,
        "rank": row.rank,
        "score": row.score,
        "title": row.title,
        "reason": row.reason,
        "status": row.status,
        "totalDurationMs": TimelineMapper(edl).total_duration_ms,
        "wordCount": len(edl.tracks.subtitles.words),
        "hasSlice": proxy_ok,
        "hasPeaks": peaks_ok,
        "hasThumb": thumb_ok,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    }


def _resolve_profile_id(requested: str | None) -> str:
    if requested:
        found = profile_store.get_profile(requested)
        if found is None:
            raise HTTPException(status_code=404, detail=f"Profile {requested!r} not found.")
        return found.id
    profiles = profile_store.list_profiles()
    if not profiles:
        raise HTTPException(status_code=400, detail="No creator profiles exist.")
    return profiles[0].id


@router.get("/health")
def health() -> dict[str, Any]:
    db_url = paths.database_url()
    dialect = db_url.split(":", 1)[0]
    return {
        "status": "ok",
        "service": "cutflow",
        "version": __version__,
        "database": dialect,
        "inbox_dir": str(paths.inbox_dir()),
    }


@router.get("/system/doctor")
def system_doctor() -> dict[str, Any]:
    return cli.inspect_environment()


# -- Creator Profiles ------------------------------------------------------


@router.get("/profiles", response_model=list[ProfileOut])
def get_profiles() -> list[ProfileOut]:
    items = profile_store.list_profiles()
    profile_store.ensure_inbox_folders(items)
    return [ProfileOut.of(p) for p in items]


@router.post("/profiles", response_model=ProfileOut, status_code=201)
def create_profile(payload: ProfileCreateIn) -> ProfileOut:
    if payload.min_duration_s >= payload.max_duration_s:
        raise HTTPException(status_code=400, detail="min_duration_s must be below max_duration_s.")

    existing_ids = {p.id for p in profile_store.list_profiles()}
    base = safe_slug(payload.id or payload.name)
    chosen = base
    n = 2
    while chosen in existing_ids:
        chosen = f"{base}-{n}"
        n += 1

    data = payload.model_dump()
    data["id"] = chosen
    try:
        profile = CreatorProfile.model_validate(data)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid profile: {exc}") from exc

    saved = profile_store.upsert_profile(profile)
    return ProfileOut.of(saved)


@router.put("/profiles/{profile_id}", response_model=ProfileOut)
def update_profile(profile_id: str, patch: dict[str, Any]) -> ProfileOut:
    existing = profile_store.get_profile(profile_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Profile not found.")

    merged = existing.model_dump() | {k: v for k, v in patch.items() if k != "id"}
    try:
        updated = CreatorProfile.model_validate(merged)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid profile update: {exc}") from exc
    if updated.min_duration_s >= updated.max_duration_s:
        raise HTTPException(status_code=400, detail="min_duration_s must be below max_duration_s.")

    return ProfileOut.of(profile_store.upsert_profile(updated))


@router.delete("/profiles/{profile_id}", status_code=204)
def remove_profile(profile_id: str) -> None:
    if not profile_store.delete_profile(profile_id):
        raise HTTPException(status_code=404, detail="Profile not found.")


# -- Sources, Uploads, URL Ingest & Storage Archive ------------------------


@router.get("/sources")
def list_sources() -> list[dict[str, Any]]:
    with get_session() as session:
        rows = session.scalars(select(SourceRow).order_by(desc(SourceRow.created_at))).all()
        return [_source_dict(r) for r in rows]


@router.post("/sources/upload", status_code=201)
async def upload_source(
    file: UploadFile = File(...),
    profile_id: str | None = Form(default=None),
    auto_clip: bool = Form(default=True),
) -> dict[str, Any]:
    raw_name = Path(file.filename or "upload.mp4").name
    ext = Path(raw_name).suffix.lower() or ".mp4"
    if ext not in VIDEO_EXTENSIONS:
        allowed = ", ".join(sorted(VIDEO_EXTENSIONS))
        raise HTTPException(status_code=400, detail=f"Unsupported file type {ext}; use {allowed}.")

    chosen_profile_id = _resolve_profile_id(profile_id)
    paths.ensure_layout()
    source_id = new_id("src")
    dest = safe_resolve(paths.media_dir() / f"{source_id}{ext}", paths.media_dir())

    total_bytes = 0
    try:
        with dest.open("wb") as out_fh:
            while chunk := await file.read(1024 * 1024):
                total_bytes += len(chunk)
                out_fh.write(chunk)
    finally:
        await file.close()

    if total_bytes == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    title = Path(raw_name).stem[:255] or source_id
    job_payload: dict[str, Any] | None = None

    with get_session() as session:
        src = SourceRow(
            id=source_id,
            source_type="upload",
            url=None,
            path=str(dest),
            title=title,
        )
        session.add(src)
        session.flush()
        src_out = _source_dict(src)

        if auto_clip:
            job = JobRow(
                id=new_id("job"),
                source_id=source_id,
                profile_id=chosen_profile_id,
                status="queued",
                stage="queued",
                progress=0.0,
                settings_json={"trigger": "upload", "originalFilename": raw_name},
            )
            session.add(job)
            session.flush()
            job_payload = _job_dict(job, source_title=title)

    if job_payload is not None:
        job_manager.submit(job_payload["id"])

    return {"source": src_out, "job": job_payload}


@router.post("/sources/url", status_code=202)
def ingest_url_source(payload: UrlSourceIn) -> dict[str, Any]:
    try:
        safe_url = validate_public_url(payload.url)
    except SSRFError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    chosen_profile_id = _resolve_profile_id(payload.profile_id)
    source_id = new_id("src")
    title = payload.title.strip()[:255] or safe_url[:140]
    job_payload: dict[str, Any] | None = None

    with get_session() as session:
        src = SourceRow(
            id=source_id,
            source_type="url",
            url=safe_url,
            path="",
            title=title,
        )
        session.add(src)
        session.flush()
        src_out = _source_dict(src)

        if payload.auto_clip:
            job = JobRow(
                id=new_id("job"),
                source_id=source_id,
                profile_id=chosen_profile_id,
                status="queued",
                stage="download",
                progress=0.0,
                settings_json={"trigger": "url", "url": safe_url},
            )
            session.add(job)
            session.flush()
            job_payload = _job_dict(job, source_title=title)

    if job_payload is not None:
        job_manager.submit(job_payload["id"])

    return {"source": src_out, "job": job_payload}


@router.post("/sources/{source_id}/archive")
def archive_source(source_id: str) -> dict[str, Any]:
    try:
        return archive_source_vod(source_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/storage")
def get_storage() -> dict[str, Any]:
    return storage_summary()


# -- Jobs & Live SSE Progress ----------------------------------------------


@router.get("/jobs")
def list_jobs(limit: int = Query(default=25, ge=1, le=100)) -> list[dict[str, Any]]:
    with get_session() as session:
        rows = session.scalars(select(JobRow).order_by(desc(JobRow.created_at)).limit(limit)).all()
        out: list[dict[str, Any]] = []
        for row in rows:
            src = session.get(SourceRow, row.source_id)
            clips = session.scalars(
                select(ClipProjectRow.id).where(ClipProjectRow.job_id == row.id)
            ).all()
            out.append(
                _job_dict(row, source_title=src.title if src else "", clip_count=len(clips))
            )
        return out


@router.post("/jobs", status_code=202)
def create_job(payload: JobCreateIn) -> dict[str, Any]:
    chosen_profile_id = _resolve_profile_id(payload.profile_id)
    with get_session() as session:
        src = session.get(SourceRow, payload.source_id)
        if src is None:
            raise HTTPException(status_code=404, detail="Source not found.")
        if src.archived:
            raise HTTPException(status_code=400, detail="Source VOD was archived; cannot re-scan.")
        job = JobRow(
            id=new_id("job"),
            source_id=src.id,
            profile_id=chosen_profile_id,
            status="queued",
            stage="queued",
            progress=0.0,
            settings_json={"trigger": "manual"},
        )
        session.add(job)
        session.flush()
        out = _job_dict(job, source_title=src.title)
    job_manager.submit(out["id"])
    return out


@router.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    with get_session() as session:
        row = session.get(JobRow, job_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Job not found.")
        src = session.get(SourceRow, row.source_id)
        clips = session.scalars(
            select(ClipProjectRow)
            .where(ClipProjectRow.job_id == job_id)
            .order_by(ClipProjectRow.rank)
        ).all()
        data = _job_dict(row, source_title=src.title if src else "", clip_count=len(clips))
        data["projects"] = [_project_summary(c) for c in clips]
        return data


@router.get("/jobs/{job_id}/events")
async def stream_job_events(job_id: str) -> StreamingResponse:
    with get_session() as session:
        row = session.get(JobRow, job_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Job not found.")
        initial = {
            "jobId": row.id,
            "sourceId": row.source_id,
            "profileId": row.profile_id,
            "status": row.status,
            "stage": row.stage,
            "progress": row.progress,
            "error": row.error,
        }

    async def event_stream() -> AsyncIterator[str]:
        yield f"data: {json.dumps(initial)}\n\n"
        if initial["status"] in ("done", "failed"):
            return

        gen = job_manager.bus.subscribe(job_id)
        try:
            while True:
                try:
                    evt = await asyncio.wait_for(gen.__anext__(), timeout=15.0)
                    yield f"data: {json.dumps(evt)}\n\n"
                    if evt.get("status") in ("done", "failed"):
                        break
                except TimeoutError:
                    yield ": keepalive\n\n"
                except StopAsyncIteration:
                    break
        finally:
            await gen.aclose()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# -- Clip Projects, Media, Peaks & EDL Operations --------------------------


@router.get("/projects")
def list_projects(
    job_id: str | None = Query(default=None),
    source_id: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> list[dict[str, Any]]:
    with get_session() as session:
        stmt = select(ClipProjectRow).order_by(desc(ClipProjectRow.created_at))
        if job_id:
            stmt = stmt.where(ClipProjectRow.job_id == job_id).order_by(ClipProjectRow.rank)
        if source_id:
            stmt = stmt.where(ClipProjectRow.source_id == source_id)
        rows = session.scalars(stmt.limit(limit)).all()
        return [_project_summary(r) for r in rows]


@router.get("/projects/{project_id}/timeline")
def get_project_timeline(project_id: str) -> dict[str, Any]:
    with get_session() as session:
        row = session.get(ClipProjectRow, project_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Clip project not found.")
        job = session.get(JobRow, row.job_id)
        origins = ((job.settings_json or {}).get("sliceOriginByProject") or {}) if job else {}
        slice_origin_ms = int(origins.get(project_id, 0))
        edl = TimelineProject.model_validate(row.edl_json)
        return {
            "edl": edl.to_canonical_dict(),
            "totalDurationMs": TimelineMapper(edl).total_duration_ms,
            "sliceOriginMs": slice_origin_ms,
        }


@router.put("/projects/{project_id}/timeline")
def put_project_timeline(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        edl = TimelineProject.model_validate(payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid EDL payload: {exc}") from exc
    if edl.project_id != project_id:
        raise HTTPException(status_code=400, detail="EDL projectId must match route project_id.")

    with get_session() as session:
        row = session.get(ClipProjectRow, project_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Clip project not found.")
        row.edl_json = edl.to_canonical_dict()
        row.title = edl.title or row.title
        row.status = edl.status
        row.updated_at = utcnow_iso()

    return {
        "edl": edl.to_canonical_dict(),
        "totalDurationMs": TimelineMapper(edl).total_duration_ms,
    }


@router.get("/projects/{project_id}/media")
def get_project_media(project_id: str) -> FileResponse:
    with get_session() as session:
        row = session.get(ClipProjectRow, project_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Clip project not found.")
        raw_path = row.proxy_path
    if not raw_path:
        raise HTTPException(status_code=404, detail="Clip slice media is not available.")
    try:
        safe = safe_resolve(Path(raw_path), paths.work_dir())
    except PathSandboxError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if not safe.is_file():
        raise HTTPException(status_code=404, detail="Clip slice file missing on disk.")
    return FileResponse(safe, media_type="video/mp4")


@router.get("/projects/{project_id}/thumb")
def get_project_thumb(project_id: str) -> FileResponse:
    with get_session() as session:
        row = session.get(ClipProjectRow, project_id)
        if row is None or not row.proxy_path:
            raise HTTPException(status_code=404, detail="Clip thumbnail not found.")
        candidate = Path(row.proxy_path).parent / "thumb.jpg"
    try:
        safe = safe_resolve(candidate, paths.work_dir())
    except PathSandboxError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if not safe.is_file():
        raise HTTPException(status_code=404, detail="Thumbnail image missing on disk.")
    return FileResponse(safe, media_type="image/jpeg")


@router.get("/projects/{project_id}/peaks")
def get_project_peaks(project_id: str) -> dict[str, Any]:
    with get_session() as session:
        row = session.get(ClipProjectRow, project_id)
        if row is None or not row.peaks_path:
            raise HTTPException(status_code=404, detail="Waveform peaks not found.")
        raw_path = row.peaks_path
    try:
        safe = safe_resolve(Path(raw_path), paths.work_dir())
    except PathSandboxError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if not safe.is_file():
        raise HTTPException(status_code=404, detail="Peaks file missing on disk.")
    return json.loads(safe.read_text(encoding="utf-8"))


@router.post("/projects/{project_id}/blade-cut")
def blade_cut_project(project_id: str, payload: BladeCutIn) -> dict[str, Any]:
    with get_session() as session:
        row = session.get(ClipProjectRow, project_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Clip project not found.")
        current = TimelineProject.model_validate(row.edl_json)
        try:
            updated = apply_blade_cut(current, payload.cut_start_ms, payload.cut_end_ms)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        row.edl_json = updated.to_canonical_dict()
        row.updated_at = utcnow_iso()

    return {
        "edl": updated.to_canonical_dict(),
        "previousEdl": current.to_canonical_dict(),
        "totalDurationMs": TimelineMapper(updated).total_duration_ms,
    }


@router.post("/projects/{project_id}/patch")
def patch_project_edl(project_id: str, payload: EdlPatchIn) -> dict[str, Any]:
    with get_session() as session:
        row = session.get(ClipProjectRow, project_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Clip project not found.")
        current = TimelineProject.model_validate(row.edl_json)
        try:
            updated, before, summaries = apply_edl_patch(current, payload.ops)
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=f"Invalid EDL patch: {exc}") from exc
        row.edl_json = updated.to_canonical_dict()
        row.updated_at = utcnow_iso()

    return {
        "edl": updated.to_canonical_dict(),
        "previousEdl": before.to_canonical_dict(),
        "applied": summaries,
        "totalDurationMs": TimelineMapper(updated).total_duration_ms,
    }


@router.post("/projects/{project_id}/coeditor")
async def coeditor_project(project_id: str, payload: CoEditorIn) -> dict[str, Any]:
    with get_session() as session:
        row = session.get(ClipProjectRow, project_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Clip project not found.")
        current = TimelineProject.model_validate(row.edl_json)

    cfg = config.load()
    profile = profile_store.get_profile(current.profile_id) if current.profile_id else None
    effective_boundaries = (
        payload.boundaries
        if payload.boundaries is not None
        else ((profile.editor_boundaries if profile else "") or cfg.export.editor_boundaries)
    )

    if payload.save_boundaries and payload.boundaries is not None:
        cleaned_b = payload.boundaries.strip()
        cfg.export.editor_boundaries = cleaned_b
        config.save(cfg)
        if profile is not None:
            profile.editor_boundaries = cleaned_b
            profile_store.upsert_profile(profile)

    try:
        result = await asyncio.to_thread(
            run_coeditor,
            current,
            payload.instruction,
            boundaries=effective_boundaries,
            playhead_ms=payload.playhead_ms,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if result.applied:
        with get_session() as session:
            row = session.get(ClipProjectRow, project_id)
            if row is not None:
                row.edl_json = result.edl.to_canonical_dict()
                row.title = result.edl.title or row.title
                row.updated_at = utcnow_iso()

    return {
        "edl": result.edl.to_canonical_dict(),
        "previousEdl": result.previous_edl.to_canonical_dict(),
        "applied": result.applied,
        "ops": result.ops,
        "reply": result.reply,
        "provider": result.provider,
        "boundaries": effective_boundaries,
        "totalDurationMs": TimelineMapper(result.edl).total_duration_ms,
    }


@router.patch("/projects/{project_id}/status")
def update_project_status(project_id: str, payload: ProjectStatusIn) -> dict[str, Any]:
    with get_session() as session:
        row = session.get(ClipProjectRow, project_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Clip project not found.")
        edl = TimelineProject.model_validate(row.edl_json)
        edl.status = payload.status  # type: ignore[assignment]
        row.status = payload.status
        row.edl_json = edl.to_canonical_dict()
        row.updated_at = utcnow_iso()
        return _project_summary(row)


@router.post("/projects/{project_id}/post-copy")
async def project_post_copy(
    project_id: str, payload: PostCopyIn | None = None
) -> dict[str, Any]:
    req = payload or PostCopyIn()
    with get_session() as session:
        row = session.get(ClipProjectRow, project_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Clip project not found.")
        edl = TimelineProject.model_validate(row.edl_json)
    profile = profile_store.get_profile(edl.profile_id) if edl.profile_id else None
    return await asyncio.to_thread(
        generate_post_copy,
        edl,
        profile=profile,
        platform=req.platform,
    )


# -- Exports & Delivery ----------------------------------------------------


@router.post("/projects/{project_id}/export", status_code=201)
async def render_project_export(
    project_id: str, payload: ExportRequestIn | None = None
) -> dict[str, Any]:
    req = payload or ExportRequestIn()
    try:
        return await asyncio.to_thread(
            export_store.export_clip_project,
            project_id,
            ratio=req.ratio,
            quality=req.quality,
            speed_preset=req.speed_preset,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RenderError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/exports")
def get_exports(project_id: str | None = Query(default=None)) -> list[dict[str, Any]]:
    return export_store.list_exports(project_id=project_id)


@router.get("/exports/{export_id}/download")
def download_export(export_id: str) -> FileResponse:
    with get_session() as session:
        row = session.get(ExportRow, export_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Export not found.")
        raw_path = row.path
    try:
        safe = safe_resolve(Path(raw_path), paths.exports_dir())
    except PathSandboxError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if not safe.is_file():
        raise HTTPException(status_code=404, detail="Export MP4 missing on disk.")
    return FileResponse(safe, media_type="video/mp4", filename=safe.name)


@router.delete("/exports/{export_id}", status_code=204)
def remove_export(export_id: str) -> None:
    if not export_store.delete_export(export_id):
        raise HTTPException(status_code=404, detail="Export not found.")


# -- Inbox Scan & Smart Feed ("Check & Notify") ----------------------------


@router.post("/inbox/scan")
def trigger_inbox_scan(profile_id: str | None = Query(default=None)) -> dict[str, Any]:
    watcher = InboxWatcher(on_job_created=job_manager.submit)
    ingested = watcher.scan_once(profile_id=profile_id, require_stable=False)
    return {"ingested": ingested, "count": len(ingested)}


@router.get("/feed")
def list_feed(status: str | None = Query(default=None)) -> list[dict[str, Any]]:
    with get_session() as session:
        stmt = select(FeedItemRow).order_by(desc(FeedItemRow.discovered_at))
        if status:
            stmt = stmt.where(FeedItemRow.status == status)
        rows = session.scalars(stmt.limit(60)).all()
        return [
            {
                "id": r.id,
                "profileId": r.profile_id,
                "externalId": r.external_id,
                "url": r.url,
                "title": r.title,
                "channel": r.channel,
                "durationS": r.duration_s,
                "thumbnailUrl": r.thumbnail_url,
                "status": r.status,
                "discoveredAt": r.discovered_at,
            }
            for r in rows
        ]


@router.post("/feed/poll")
def poll_feeds() -> dict[str, Any]:
    discovered = poll_all_feeds()
    return {"discovered": discovered, "count": len(discovered)}


@router.post("/feed/{feed_id}/clip", status_code=202)
def clip_feed_item(feed_id: str) -> dict[str, Any]:
    with get_session() as session:
        item = session.get(FeedItemRow, feed_id)
        if item is None:
            raise HTTPException(status_code=404, detail="Feed item not found.")
        url = item.url
        profile_id = item.profile_id
        title = item.title
        item.status = "queued"

    return ingest_url_source(
        UrlSourceIn(url=url, profileId=profile_id, title=title, autoClip=True)
    )


@router.post("/feed/{feed_id}/dismiss")
def dismiss_feed_item(feed_id: str) -> dict[str, str]:
    with get_session() as session:
        item = session.get(FeedItemRow, feed_id)
        if item is None:
            raise HTTPException(status_code=404, detail="Feed item not found.")
        item.status = "dismissed"
    return {"id": feed_id, "status": "dismissed"}


# -- Settings & Write-Only Secrets -----------------------------------------


@router.get("/settings")
def get_settings() -> dict[str, Any]:
    return {
        "settings": config.load().model_dump(mode="json"),
        "keys_present": keys_presence(),
    }


@router.put("/settings")
def put_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = config.load().model_dump(mode="json")
    for key, val in patch.items():
        if key in current and isinstance(current[key], dict) and isinstance(val, dict):
            current[key] = current[key] | val
        else:
            current[key] = val
    try:
        updated = config.Settings.model_validate(current)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid settings: {exc}") from exc
    config.save(updated)
    return {
        "settings": updated.model_dump(mode="json"),
        "keys_present": keys_presence(),
    }


@router.put("/settings/secrets", status_code=204)
def put_secret(payload: SecretIn) -> None:
    try:
        set_secret(payload.key, payload.value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.delete("/settings/secrets/{key}", status_code=204)
def remove_secret(key: str) -> None:
    delete_secret(key)
