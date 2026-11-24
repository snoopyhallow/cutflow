"""1-click Raw VOD Archiving (reclaims multi-GB VODs while keeping lossless clip slices)."""

from __future__ import annotations

import contextlib
import shutil
from pathlib import Path
from typing import Any

from .. import paths
from ..db import SourceRow, get_session
from ..security import PathSandboxError, safe_resolve


def _dir_size_bytes(directory: Path) -> int:
    if not directory.is_dir():
        return 0
    total = 0
    for item in directory.rglob("*"):
        if item.is_file():
            with contextlib.suppress(OSError):
                total += item.stat().st_size
    return total


def archive_source_vod(source_id: str) -> dict[str, Any]:
    """Delete raw source video & full WAV while keeping lossless clip_slice.mp4 + peaks + EDLs."""
    reclaimed = 0
    with get_session() as session:
        row = session.get(SourceRow, source_id)
        if row is None:
            raise KeyError(f"Source {source_id!r} not found.")

        if row.path:
            try:
                media_file = safe_resolve(Path(row.path), paths.media_dir())
                if media_file.is_file():
                    reclaimed += media_file.stat().st_size
                    media_file.unlink()
            except PathSandboxError:
                pass

        raw_wav = paths.work_dir() / source_id / "source_16k.wav"
        if raw_wav.is_file():
            reclaimed += raw_wav.stat().st_size
            raw_wav.unlink()

        row.archived = True

    return {
        "sourceId": source_id,
        "archived": True,
        "reclaimedBytes": reclaimed,
    }


def storage_summary() -> dict[str, Any]:
    """Report disk usage across CutFlow storage directories."""
    paths.ensure_layout()
    usage = shutil.disk_usage(paths.root())
    return {
        "root": str(paths.root()),
        "mediaBytes": _dir_size_bytes(paths.media_dir()),
        "workBytes": _dir_size_bytes(paths.work_dir()),
        "exportsBytes": _dir_size_bytes(paths.exports_dir()),
        "cacheBytes": _dir_size_bytes(paths.cache_dir()),
        "diskFreeBytes": usage.free,
        "diskTotalBytes": usage.total,
    }
