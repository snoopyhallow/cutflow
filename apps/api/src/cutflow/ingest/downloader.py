"""SSRF-guarded multi-platform URL downloader (YouTube, Kick, Twitch, TikTok, X) via yt-dlp."""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..security import SSRFError, validate_public_url


class DownloadError(RuntimeError):
    """Raised when yt-dlp metadata extraction or download fails."""


@dataclass(slots=True)
class DownloadedVideo:
    path: Path
    title: str
    channel: str
    heatmap: list[dict[str, Any]] | None
    duration_s: float = 0.0


def _find_ytdlp() -> str:
    found = shutil.which("yt-dlp")
    if not found:
        raise DownloadError(
            "yt-dlp was not found on PATH. Install yt-dlp to enable URL & channel ingestion."
        )
    return found


def fetch_url_metadata(url: str, *, resolve_dns: bool = True) -> dict[str, Any]:
    """Validate URL against SSRF rules and fetch yt-dlp JSON metadata (including YT heatmap)."""
    safe_url = validate_public_url(url, resolve_dns=resolve_dns)
    ytdlp = _find_ytdlp()
    cmd = [
        ytdlp,
        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        "--",
        safe_url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    if proc.returncode != 0:
        raise DownloadError(f"yt-dlp metadata failed: {proc.stderr.strip()[:300]}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise DownloadError(f"Invalid yt-dlp JSON metadata: {exc}") from exc


def download_video_url(
    url: str,
    dest_dir: Path,
    source_id: str,
    *,
    resolve_dns: bool = True,
) -> DownloadedVideo:
    """Download a remote video into ``dest_dir`` safely (SSRF-checked, zero shell=True)."""
    try:
        safe_url = validate_public_url(url, resolve_dns=resolve_dns)
    except SSRFError:
        raise

    meta = fetch_url_metadata(safe_url, resolve_dns=resolve_dns)
    ytdlp = _find_ytdlp()
    dest_dir.mkdir(parents=True, exist_ok=True)
    out_template = str(dest_dir / f"{source_id}.%(ext)s")

    cmd = [
        ytdlp,
        "--no-playlist",
        "--no-warnings",
        "-f",
        "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "--merge-output-format",
        "mp4",
        "-o",
        out_template,
        "--",
        safe_url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800, check=False)
    if proc.returncode != 0:
        raise DownloadError(f"yt-dlp download failed: {proc.stderr.strip()[:400]}")

    expected = dest_dir / f"{source_id}.mp4"
    if not expected.is_file():
        matches = sorted(dest_dir.glob(f"{source_id}.*"))
        if not matches:
            raise DownloadError("yt-dlp exited cleanly but no downloaded file was found.")
        expected = matches[0]

    raw_heatmap = meta.get("heatmap")
    heatmap = raw_heatmap if isinstance(raw_heatmap, list) else None
    return DownloadedVideo(
        path=expected,
        title=str(meta.get("title") or expected.stem)[:255],
        channel=str(meta.get("channel") or meta.get("uploader") or "")[:160],
        heatmap=heatmap,
        duration_s=float(meta.get("duration") or 0.0),
    )
