"""FastAPI application entry point for CutFlow."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, db, paths
from .api.v1 import router as v1_router
from .audio import ensure_starter_audio_assets
from .ingest import InboxWatcher
from .security import LocalSecurityMiddleware
from .workspace.jobs import job_manager
from .workspace.profiles import seed_and_import_profiles

log = logging.getLogger(__name__)

ENV_SKIP_LEGACY_IMPORT = "CUTFLOW_SKIP_LEGACY_IMPORT"
ENV_DISABLE_WATCHER = "CUTFLOW_DISABLE_WATCHER"


def _web_dist_dir() -> Path | None:
    env_override = os.environ.get("CUTFLOW_WEB_DIST", "").strip()
    if env_override:
        env_path = Path(env_override).resolve()
        if (env_path / "index.html").exists():
            return env_path
    candidate = Path(__file__).resolve().parents[3] / "web" / "dist"
    return candidate if (candidate / "index.html").exists() else None


async def _inbox_watcher_loop() -> None:
    watcher = InboxWatcher(on_job_created=job_manager.submit)
    while True:
        try:
            await asyncio.to_thread(watcher.scan_once, require_stable=True)
        except Exception as exc:
            log.debug("Inbox watcher tick error: %s", exc)
        await asyncio.sleep(5.0)


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    loop = asyncio.get_running_loop()
    orig_handler = loop.get_exception_handler()

    def _quiet_windows_pipe_reset(
        ev_loop: asyncio.AbstractEventLoop, context: dict[str, object]
    ) -> None:
        exc = context.get("exception")
        if isinstance(exc, ConnectionResetError) and getattr(exc, "winerror", None) == 10054:
            return
        if orig_handler is not None:
            orig_handler(ev_loop, context)
        else:
            ev_loop.default_exception_handler(context)

    loop.set_exception_handler(_quiet_windows_pipe_reset)

    paths.ensure_layout()
    ensure_starter_audio_assets()
    db.init_db()
    if os.environ.get(ENV_SKIP_LEGACY_IMPORT) == "1":
        seed_and_import_profiles(autoclip_profiles_file=Path("/__nonexistent__"))
    else:
        seed_and_import_profiles()

    job_manager.recover_interrupted_jobs()

    watcher_task: asyncio.Task[None] | None = None
    if os.environ.get(ENV_DISABLE_WATCHER) != "1":
        watcher_task = asyncio.create_task(_inbox_watcher_loop())

    try:
        yield
    finally:
        if watcher_task is not None:
            watcher_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher_task


def create_app() -> FastAPI:
    app = FastAPI(
        title="CutFlow API",
        version=__version__,
        description="Local-first AI Video Clipping Studio & Non-Linear Timeline Editor.",
        lifespan=lifespan,
    )
    app.add_middleware(LocalSecurityMiddleware)
    app.include_router(v1_router)

    dist = _web_dist_dir()
    if dist is not None:
        assets = dist / "assets"
        if assets.is_dir():
            app.mount("/assets", StaticFiles(directory=assets), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False, response_model=None)
        async def spa(_request: Request, full_path: str) -> FileResponse | JSONResponse:
            if full_path.startswith("api/"):
                return JSONResponse(status_code=404, content={"detail": "Not found."})
            target = dist / full_path
            if full_path and target.is_file():
                return FileResponse(target)
            return FileResponse(dist / "index.html")

    return app


app = create_app()
