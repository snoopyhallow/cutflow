"""Hardlink inbox/<creator>/ folder watcher with two-pass write-stability detection."""

from __future__ import annotations

import logging
import os
import shutil
from collections.abc import Callable
from pathlib import Path

from .. import config, paths
from ..db import JobRow, SourceRow, get_session
from ..db.models import new_id
from ..security import safe_slug
from ..workspace import profiles as profile_store

log = logging.getLogger(__name__)

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}


def ingest_local_file_to_media(src_path: Path, source_id: str, *, prefer_hardlink: bool) -> Path:
    """Place a dropped video into CutFlow's media directory using zero-copy NTFS hardlink first."""
    paths.ensure_layout()
    ext = src_path.suffix.lower() if src_path.suffix else ".mp4"
    dest = paths.media_dir() / f"{source_id}{ext}"
    if prefer_hardlink:
        try:
            os.link(src_path, dest)
            return dest
        except OSError:
            pass  # Different drive or filesystem without hardlink support -> copy fallback
    shutil.copy2(src_path, dest)
    return dest


def _move_to_processed(file_path: Path, profile_folder: Path) -> Path:
    processed_dir = profile_folder / "processed"
    processed_dir.mkdir(parents=True, exist_ok=True)
    target = processed_dir / file_path.name
    if target.exists():
        stem, suffix = file_path.stem, file_path.suffix
        idx = 2
        while target.exists():
            target = processed_dir / f"{stem}_{idx}{suffix}"
            idx += 1
    shutil.move(str(file_path), str(target))
    return target


class InboxWatcher:
    """Scans ``inbox/<profile_slug>/`` for finished video drops and enqueues clipping jobs."""

    def __init__(self, on_job_created: Callable[[str], None] | None = None) -> None:
        self._seen_fingerprints: dict[Path, tuple[int, int]] = {}
        self._on_job_created = on_job_created

    def scan_once(
        self,
        *,
        profile_id: str | None = None,
        require_stable: bool = True,
    ) -> list[dict[str, str]]:
        """Check inbox profile folders once and ingest any stable dropped videos."""
        cfg = config.load()
        profiles = profile_store.list_profiles()
        if profile_id is not None:
            profiles = [p for p in profiles if p.id == profile_id]
        profile_store.ensure_inbox_folders(profiles)

        ingested: list[dict[str, str]] = []
        active_files: set[Path] = set()

        for prof in profiles:
            folder = paths.inbox_dir() / safe_slug(prof.id)
            if not folder.is_dir():
                continue
            for entry in sorted(folder.iterdir()):
                if not entry.is_file():
                    continue
                if entry.suffix.lower() not in VIDEO_EXTENSIONS:
                    continue
                if entry.name.startswith(".") or entry.name.endswith(".part"):
                    continue

                active_files.add(entry)
                try:
                    stat = entry.stat()
                except OSError:
                    continue
                if stat.st_size <= 0:
                    continue

                fingerprint = (stat.st_size, stat.st_mtime_ns)
                if require_stable:
                    prev = self._seen_fingerprints.get(entry)
                    self._seen_fingerprints[entry] = fingerprint
                    if prev != fingerprint:
                        continue  # Still being copied/written; wait for next tick

                source_id = new_id("src")
                job_id = new_id("job")
                media_path = ingest_local_file_to_media(
                    entry,
                    source_id,
                    prefer_hardlink=cfg.storage.hardlink_inbox_drops,
                )
                _move_to_processed(entry, folder)
                self._seen_fingerprints.pop(entry, None)

                with get_session() as session:
                    session.add(
                        SourceRow(
                            id=source_id,
                            source_type="inbox",
                            url=None,
                            path=str(media_path),
                            title=entry.stem[:255],
                        )
                    )
                    session.flush()
                    session.add(
                        JobRow(
                            id=job_id,
                            source_id=source_id,
                            profile_id=prof.id,
                            status="queued",
                            stage="queued",
                            progress=0.0,
                            settings_json={"trigger": "inbox", "originalFilename": entry.name},
                        )
                    )

                ingested.append(
                    {
                        "sourceId": source_id,
                        "jobId": job_id,
                        "profileId": prof.id,
                        "filename": entry.name,
                    }
                )
                if self._on_job_created is not None:
                    self._on_job_created(job_id)

        # Prune vanished paths from fingerprint cache
        for tracked in list(self._seen_fingerprints):
            if tracked not in active_files:
                self._seen_fingerprints.pop(tracked, None)

        return ingested
