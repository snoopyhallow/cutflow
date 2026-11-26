"""SSRF-guarded multi-platform & Twitch Long-VOD downloader via yt-dlp."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from ..security import SSRFError, validate_public_url

_UNSUPPORTED_STREAMING_DOMAINS: tuple[str, ...] = (
    "kisskh.",
    "fmovies",
    "123movies",
    "soap2day",
    "gomovies",
    "sflix",
    "lookmovie",
    "hurawatch",
    "flixhq",
    "bflix",
)

_DIRECT_MEDIA_EXTS = (".mp4", ".mkv", ".mov", ".webm", ".m4v", ".m3u8")
_PCT_RE = re.compile(r"(\d+(?:\.\d+)?)%")


class DownloadError(RuntimeError):
    """Raised when yt-dlp metadata extraction or download fails."""


class UnsupportedSiteError(DownloadError):
    """Raised when a URL points to an obfuscated/DRM site outside yt-dlp."""


@dataclass(slots=True)
class DownloadedVideo:
    path: Path
    title: str
    channel: str
    heatmap: list[dict[str, Any]] | None
    duration_s: float = 0.0
    platform: str = "generic"
    chapters: list[dict[str, Any]] = field(default_factory=list)


def find_ytdlp() -> str:
    """Locate yt-dlp on PATH or inside the active Python virtual environment."""
    exe_dir = Path(sys.executable).resolve().parent
    candidates = [
        exe_dir / ("yt-dlp.exe" if os.name == "nt" else "yt-dlp"),
        exe_dir / "yt-dlp",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    found = shutil.which("yt-dlp")
    if found:
        return found
    raise DownloadError(
        "yt-dlp was not found in .venv or on PATH. Run `uv pip install yt-dlp` to enable URLs."
    )


def detect_url_platform(url: str) -> str:
    """Classify a public URL into a known platform slug for UI badges & ingest routing."""
    parsed = urlparse(url.strip())
    host = (parsed.hostname or "").lower()
    path_lower = (parsed.path or "").lower()

    if any(tok in host for tok in _UNSUPPORTED_STREAMING_DOMAINS):
        raise UnsupportedSiteError(
            f"Streaming site '{host}' uses an obfuscated/encrypted web player outside yt-dlp. "
            "Drop a local .mkv or .mp4 file into CutFlow instead."
        )
    if host.endswith(("twitch.tv", "clips.twitch.tv")):
        return "twitch"
    if host.endswith(("youtube.com", "youtu.be", "m.youtube.com")):
        return "youtube"
    if host.endswith("kick.com"):
        return "kick"
    if host.endswith("tiktok.com"):
        return "tiktok"
    if host.endswith(("twitter.com", "x.com")):
        return "x"
    if host.endswith("vimeo.com"):
        return "vimeo"
    if host.endswith(("bilibili.com", "b23.tv")):
        return "bilibili"
    if path_lower.endswith(_DIRECT_MEDIA_EXTS):
        return "direct"
    return "generic"


def _cookie_args(cookies_browser: str | None) -> list[str]:
    if cookies_browser and cookies_browser in ("chrome", "edge", "firefox", "brave"):
        return ["--cookies-from-browser", cookies_browser]
    return []


def chapters_to_heatmap(
    chapters: list[dict[str, Any]] | None, duration_s: float
) -> list[dict[str, Any]] | None:
    """Synthesize normalized Hype Curve boost markers from VOD chapters/stream markers."""
    if not chapters or duration_s <= 0:
        return None
    points: list[dict[str, Any]] = []
    for ch in chapters:
        if not isinstance(ch, dict):
            continue
        try:
            s0 = max(0.0, float(ch.get("start_time", 0.0)))
            s1 = float(ch.get("end_time", min(duration_s, s0 + 60.0)))
        except (TypeError, ValueError):
            continue
        if s1 <= s0:
            continue
        # Boost the opening 45s of each VOD chapter/game transition marker
        window_end = min(s1, s0 + 45.0)
        points.append({"start_time": round(s0, 2), "end_time": round(window_end, 2), "value": 0.82})
    return points or None


def fetch_url_metadata(
    url: str,
    *,
    cookies_browser: str = "none",
    resolve_dns: bool = True,
) -> dict[str, Any]:
    """Validate URL against SSRF/site rules and fetch yt-dlp JSON metadata."""
    safe_url = validate_public_url(url, resolve_dns=resolve_dns)
    detect_url_platform(safe_url)
    ytdlp = find_ytdlp()
    cmd = [
        ytdlp,
        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        *_cookie_args(cookies_browser),
        "--",
        safe_url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=75, check=False)
    if proc.returncode != 0:
        stderr = proc.stderr.strip()
        if "unsupported url" in stderr.lower():
            host = urlparse(safe_url).hostname or "this site"
            raise UnsupportedSiteError(
                f"'{host}' is not supported by yt-dlp (custom/DRM web player). "
                "Drop a local .mkv or .mp4 video file instead."
            )
        raise DownloadError(f"yt-dlp metadata failed: {stderr[:320]}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise DownloadError(f"Invalid yt-dlp JSON metadata: {exc}") from exc


def probe_url_metadata(
    url: str,
    *,
    cookies_browser: str = "none",
    resolve_dns: bool = True,
) -> dict[str, Any]:
    """Return a clean UI-ready probe summary for Twitch, YouTube, Kick, TikTok, etc."""
    safe_url = validate_public_url(url, resolve_dns=resolve_dns)
    platform = detect_url_platform(safe_url)
    meta = fetch_url_metadata(
        safe_url,
        cookies_browser=cookies_browser,
        resolve_dns=resolve_dns,
    )
    duration_s = float(meta.get("duration") or 0.0)
    raw_chapters = meta.get("chapters") if isinstance(meta.get("chapters"), list) else []
    chapters = [
        {
            "title": str(ch.get("title") or "Marker")[:120],
            "startS": round(float(ch.get("start_time") or 0.0), 1),
            "endS": round(float(ch.get("end_time") or 0.0), 1),
        }
        for ch in raw_chapters
        if isinstance(ch, dict)
    ]
    return {
        "url": safe_url,
        "platform": platform,
        "title": str(meta.get("title") or "Untitled Stream")[:255],
        "channel": str(meta.get("channel") or meta.get("uploader") or "")[:160],
        "durationS": round(duration_s, 2),
        "thumbnail": meta.get("thumbnail"),
        "isLive": bool(meta.get("is_live", False)),
        "hasHeatmap": isinstance(meta.get("heatmap"), list) and len(meta["heatmap"]) > 0,
        "chapters": chapters[:40],
        "supportsRangeClip": True,
    }


def build_ytdlp_download_argv(
    ytdlp_bin: str,
    safe_url: str,
    out_template: str,
    *,
    start_sec: float | None = None,
    end_sec: float | None = None,
    concurrent_fragments: int = 8,
    cookies_browser: str = "none",
) -> list[str]:
    """Construct an explicit, shell-free yt-dlp argv with parallel HLS & optional range cuts."""
    n_frags = max(1, min(16, int(concurrent_fragments)))
    cmd = [
        ytdlp_bin,
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "--concurrent-fragments",
        str(n_frags),
        "--progress-template",
        "download:CFPROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        *_cookie_args(cookies_browser),
        "-f",
        "bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b",
        "--merge-output-format",
        "mp4",
    ]

    if start_sec is not None or end_sec is not None:
        s0 = max(0.0, float(start_sec or 0.0))
        if end_sec is not None and float(end_sec) > 0:
            s1 = float(end_sec)
            if s1 <= s0:
                raise ValueError("Range end_sec must be greater than start_sec.")
            section = f"*{s0:.2f}-{s1:.2f}"
        else:
            section = f"*{s0:.2f}-inf"
        cmd.extend(["--download-sections", section])

    cmd.extend(["-o", out_template, "--", safe_url])
    return cmd


def _parse_progress_line(line: str) -> tuple[float, str] | None:
    if not line.startswith("CFPROG|"):
        return None
    parts = line.strip().split("|")
    if len(parts) < 4:
        return None
    pct_raw, speed_raw, eta_raw = parts[1].strip(), parts[2].strip(), parts[3].strip()
    m = _PCT_RE.search(pct_raw)
    if not m:
        return None
    pct = max(0.0, min(100.0, float(m.group(1)))) / 100.0
    tokens = [f"{pct * 100:.0f}%"]
    if speed_raw and speed_raw != "NA":
        tokens.append(speed_raw)
    if eta_raw and eta_raw != "NA":
        tokens.append(f"ETA {eta_raw}")
    return pct, " · ".join(tokens)


def download_video_url(
    url: str,
    dest_dir: Path,
    source_id: str,
    *,
    start_sec: float | None = None,
    end_sec: float | None = None,
    concurrent_fragments: int = 8,
    cookies_browser: str = "none",
    on_progress: Callable[[float, str], None] | None = None,
    resolve_dns: bool = True,
) -> DownloadedVideo:
    """Download a remote video (or VOD time window) safely with 8x parallel HLS fragments."""
    try:
        safe_url = validate_public_url(url, resolve_dns=resolve_dns)
    except SSRFError:
        raise

    platform = detect_url_platform(safe_url)
    meta = fetch_url_metadata(
        safe_url,
        cookies_browser=cookies_browser,
        resolve_dns=resolve_dns,
    )
    ytdlp = find_ytdlp()
    dest_dir.mkdir(parents=True, exist_ok=True)
    out_template = str(dest_dir / f"{source_id}.%(ext)s")

    cmd = build_ytdlp_download_argv(
        ytdlp,
        safe_url,
        out_template,
        start_sec=start_sec,
        end_sec=end_sec,
        concurrent_fragments=concurrent_fragments,
        cookies_browser=cookies_browser,
    )

    if on_progress is None:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=7200, check=False)
        if proc.returncode != 0:
            raise DownloadError(f"yt-dlp download failed: {proc.stderr.strip()[:400]}")
    else:
        stderr_tail: list[str] = []
        with subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        ) as proc:
            assert proc.stdout is not None
            for raw_line in proc.stdout:
                parsed = _parse_progress_line(raw_line)
                if parsed is not None:
                    on_progress(parsed[0], parsed[1])
                elif raw_line.strip():
                    stderr_tail.append(raw_line.strip())
                    if len(stderr_tail) > 15:
                        stderr_tail.pop(0)
            ret = proc.wait(timeout=7200)
        if ret != 0:
            detail = " | ".join(stderr_tail)[-400:]
            raise DownloadError(f"yt-dlp download failed ({ret}): {detail}")

    expected = dest_dir / f"{source_id}.mp4"
    if not expected.is_file():
        matches = sorted(
            p for p in dest_dir.glob(f"{source_id}.*") if not p.name.endswith(".part")
        )
        if not matches:
            raise DownloadError("yt-dlp exited cleanly but no downloaded media file was found.")
        expected = matches[0]

    duration_s = float(meta.get("duration") or 0.0)
    raw_heatmap = meta.get("heatmap")
    raw_chapters = meta.get("chapters") if isinstance(meta.get("chapters"), list) else []

    if isinstance(raw_heatmap, list) and raw_heatmap:
        heatmap: list[dict[str, Any]] | None = raw_heatmap
    else:
        heatmap = chapters_to_heatmap(raw_chapters, duration_s)

    # Shift heatmap timestamps if a partial VOD range [start_sec, end_sec] was clipped
    if heatmap and start_sec is not None and start_sec > 0:
        shifted: list[dict[str, Any]] = []
        limit_s = (end_sec - start_sec) if (end_sec and end_sec > start_sec) else duration_s
        for pt in heatmap:
            try:
                h0 = float(pt.get("start_time", 0.0)) - start_sec
                h1 = float(pt.get("end_time", 0.0)) - start_sec
                val = float(pt.get("value", 0.0))
            except (TypeError, ValueError):
                continue
            if h1 <= 0 or h0 >= limit_s:
                continue
            shifted.append(
                {
                    "start_time": round(max(0.0, h0), 2),
                    "end_time": round(min(limit_s, h1), 2),
                    "value": val,
                }
            )
        heatmap = shifted or None

    return DownloadedVideo(
        path=expected,
        title=str(meta.get("title") or expected.stem)[:255],
        channel=str(meta.get("channel") or meta.get("uploader") or "")[:160],
        heatmap=heatmap,
        duration_s=duration_s,
        platform=platform,
        chapters=raw_chapters,
    )
