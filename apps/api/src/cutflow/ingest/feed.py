"""Smart Feed ('Check & Notify') channel poller using zero-download yt-dlp metadata scans."""

from __future__ import annotations

import json
import logging
import subprocess
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import select

from .. import config
from ..db import FeedItemRow, get_session
from ..db.models import new_id
from ..security import SSRFError, validate_public_url
from ..workspace.profiles import CreatorProfile, list_profiles
from .downloader import DownloadError, _cookie_args, find_ytdlp

log = logging.getLogger(__name__)


def _matches_keywords(title: str, keywords: list[str]) -> bool:
    cleaned = [k.strip().lower() for k in keywords if k.strip()]
    if not cleaned:
        return True
    lower = title.lower()
    return any(kw in lower for kw in cleaned)


def _fallback_item_url(channel_url: str, ext_id: str) -> str:
    host = (urlparse(channel_url).hostname or "").lower()
    clean_id = ext_id.lstrip("v") if host.endswith("twitch.tv") else ext_id
    if host.endswith("twitch.tv"):
        return f"https://www.twitch.tv/videos/{clean_id}"
    if host.endswith("kick.com"):
        return f"https://kick.com/video/{ext_id}"
    return f"https://www.youtube.com/watch?v={ext_id}"


def _fetch_channel_entries(
    channel_url: str,
    *,
    limit: int = 8,
    cookies_browser: str = "none",
) -> list[dict[str, Any]]:
    safe_url = validate_public_url(channel_url)
    try:
        ytdlp = find_ytdlp()
    except DownloadError:
        return []
    cmd = [
        ytdlp,
        "--flat-playlist",
        "--dump-single-json",
        "--playlist-end",
        str(limit),
        "--no-warnings",
        *_cookie_args(cookies_browser),
        "--",
        safe_url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=45, check=False)
    if proc.returncode != 0:
        log.warning("Smart Feed poll failed for %s: %s", safe_url, proc.stderr.strip()[:200])
        return []
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return []
    entries = payload.get("entries")
    return entries if isinstance(entries, list) else []


def poll_profile_feed(profile: CreatorProfile, *, limit: int = 8) -> list[dict[str, Any]]:
    """Poll one Creator Profile's followed channels and store newly discovered videos."""
    cfg = config.load()
    discovered: list[dict[str, Any]] = []
    for channel_url in profile.channel_urls:
        try:
            entries = _fetch_channel_entries(
                channel_url,
                limit=limit,
                cookies_browser=cfg.ingest.cookies_browser,
            )
        except SSRFError as exc:
            log.warning("Skipping unsafe channel URL %s: %s", channel_url, exc)
            continue

        for entry in entries:
            if not isinstance(entry, dict):
                continue
            ext_id = str(entry.get("id") or "").strip()
            title = str(entry.get("title") or "").strip()
            item_url = str(entry.get("webpage_url") or entry.get("url") or "").strip()
            if not ext_id or not title:
                continue
            if not item_url or not item_url.startswith(("http://", "https://")):
                item_url = _fallback_item_url(channel_url, ext_id)
            if not _matches_keywords(title, profile.keyword_filters):
                continue

            with get_session() as session:
                exists = session.scalar(
                    select(FeedItemRow).where(
                        FeedItemRow.profile_id == profile.id,
                        FeedItemRow.external_id == ext_id,
                    )
                )
                if exists is not None:
                    continue
                row = FeedItemRow(
                    id=new_id("feed"),
                    profile_id=profile.id,
                    external_id=ext_id,
                    url=item_url,
                    title=title[:255],
                    channel=str(entry.get("channel") or profile.creator_name or "")[:160],
                    duration_s=float(entry.get("duration") or 0.0),
                    thumbnail_url=entry.get("thumbnail"),
                    status="new",
                )
                session.add(row)
                discovered.append(
                    {
                        "id": row.id,
                        "profileId": row.profile_id,
                        "externalId": row.external_id,
                        "url": row.url,
                        "title": row.title,
                        "channel": row.channel,
                        "durationS": row.duration_s,
                        "status": row.status,
                    }
                )
    return discovered


def poll_all_feeds() -> list[dict[str, Any]]:
    added: list[dict[str, Any]] = []
    for prof in list_profiles():
        if prof.channel_urls:
            added.extend(poll_profile_feed(prof))
    return added
