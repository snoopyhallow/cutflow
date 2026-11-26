"""Filesystem layout and sandboxed path resolution for CutFlow."""

from __future__ import annotations

import os
from pathlib import Path

ENV_HOME = "CUTFLOW_HOME"
ENV_INBOX = "CUTFLOW_INBOX_DIR"
ENV_DB_URL = "DATABASE_URL"


def root() -> Path:
    """Return CutFlow's data root (``~/.cutflow`` unless ``CUTFLOW_HOME`` is set)."""
    override = os.environ.get(ENV_HOME)
    if override:
        return Path(override).expanduser().resolve()
    return (Path.home() / ".cutflow").resolve()


def media_dir() -> Path:
    return root() / "media"


def work_dir() -> Path:
    return root() / "work"


def exports_dir() -> Path:
    return root() / "exports"


def bgm_dir() -> Path:
    return root() / "bgm"


def sfx_dir() -> Path:
    return root() / "sfx"


def cache_dir() -> Path:
    return root() / "cache"


def telemetry_dir() -> Path:
    return root() / "telemetry"


def config_path() -> Path:
    return root() / "config.json"


def db_path() -> Path:
    return root() / "cutflow.db"


def database_url() -> str:
    """Return SQLAlchemy database URL (local SQLite by default, Postgres via DATABASE_URL)."""
    override = os.environ.get(ENV_DB_URL)
    if override:
        return override
    ensure_layout()
    return f"sqlite:///{db_path().as_posix()}"


def inbox_dir() -> Path:
    """Return the watch-folder root containing one subfolder per Creator Profile.

    Uses ``CUTFLOW_INBOX_DIR`` if set; isolates inside ``CUTFLOW_HOME/inbox``
    during test runs; otherwise defaults to ``~/clip-farming/inbox``.
    """
    override = os.environ.get(ENV_INBOX)
    if override:
        return Path(override).expanduser().resolve()
    if os.environ.get(ENV_HOME):
        return (root() / "inbox").resolve()
    return (Path.home() / "clip-farming" / "inbox").resolve()


def ensure_layout() -> Path:
    """Create all CutFlow runtime directories idempotently."""
    base = root()
    for folder in (
        base,
        media_dir(),
        work_dir(),
        exports_dir(),
        bgm_dir(),
        sfx_dir(),
        cache_dir(),
        telemetry_dir(),
    ):
        folder.mkdir(parents=True, exist_ok=True)
    return base
