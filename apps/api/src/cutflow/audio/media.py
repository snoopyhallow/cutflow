"""FFprobe inspection, 16kHz WAV extraction, frame grab, and zero-copy lossless clip slicing."""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


class MediaError(RuntimeError):
    """Raised when ffprobe or ffmpeg fails on a media asset."""


@dataclass(slots=True)
class MediaInfo:
    path: Path
    duration_ms: int
    width: int
    height: int
    fps: float
    has_audio: bool
    video_codec: str
    audio_codec: str
    size_bytes: int


def _require_binary(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise MediaError(f"Required binary {name!r} was not found on PATH.")
    return found


def _parse_rational_fps(raw: str | None) -> float:
    if not raw or raw in ("0/0", "N/A"):
        return 30.0
    if "/" in raw:
        num_s, den_s = raw.split("/", 1)
        try:
            num, den = float(num_s), float(den_s)
            return round(num / den, 3) if den > 0 else 30.0
        except ValueError:
            return 30.0
    try:
        return round(float(raw), 3)
    except ValueError:
        return 30.0


def probe_media(path: Path) -> MediaInfo:
    """Inspect a media file using ffprobe (explicit argv list, no shell)."""
    target = Path(path)
    if not target.is_file():
        raise MediaError(f"Media file does not exist: {target}")

    ffprobe = _require_binary("ffprobe")
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(target),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=False)
    if proc.returncode != 0:
        raise MediaError(f"ffprobe failed ({proc.returncode}): {proc.stderr.strip()}")

    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise MediaError(f"Invalid ffprobe JSON output: {exc}") from exc

    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    v_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    a_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if v_stream is None:
        raise MediaError(f"No video stream found in {target.name}")

    dur_raw = fmt.get("duration") or v_stream.get("duration") or "0"
    try:
        duration_ms = max(0, int(round(float(dur_raw) * 1000.0)))
    except ValueError:
        duration_ms = 0

    fps = _parse_rational_fps(v_stream.get("avg_frame_rate") or v_stream.get("r_frame_rate"))
    if fps <= 0 or fps > 240:
        fps = 30.0

    return MediaInfo(
        path=target,
        duration_ms=duration_ms,
        width=max(2, int(v_stream.get("width") or 1920)),
        height=max(2, int(v_stream.get("height") or 1080)),
        fps=fps,
        has_audio=a_stream is not None,
        video_codec=str(v_stream.get("codec_name") or ""),
        audio_codec=str(a_stream.get("codec_name") or "") if a_stream else "",
        size_bytes=target.stat().st_size,
    )


def extract_wav_16k(
    source_path: Path,
    out_wav: Path,
    *,
    start_ms: int | None = None,
    duration_ms: int | None = None,
) -> Path:
    """Extract 16kHz mono 16-bit PCM WAV for Whisper ASR, peaks, hype scan, and alignment."""
    ffmpeg = _require_binary("ffmpeg")
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    if start_ms is not None and start_ms > 0:
        cmd.extend(["-ss", f"{start_ms / 1000.0:.3f}"])
    cmd.extend(["-i", str(source_path)])
    if duration_ms is not None and duration_ms > 0:
        cmd.extend(["-t", f"{duration_ms / 1000.0:.3f}"])
    cmd.extend(
        [
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-acodec",
            "pcm_s16le",
            str(out_wav),
        ]
    )
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=False)
    if proc.returncode != 0 or not out_wav.is_file():
        raise MediaError(f"WAV extraction failed: {proc.stderr.strip()}")
    return out_wav


def extract_lossless_clip_slice(
    source_path: Path,
    out_path: Path,
    *,
    clip_start_ms: int,
    clip_end_ms: int,
    handle_ms: int = 3000,
    source_duration_ms: int | None = None,
) -> tuple[Path, int]:
    """Create a ~0.2s zero-copy lossless stream-copy slice (`-c copy`) with ±handle buffer.

    Returns ``(out_path, slice_start_ms)`` where ``slice_start_ms`` is the origin timestamp
    in the source video. Keeps clips 100% playable & re-editable even after archiving raw VODs.
    """
    ffmpeg = _require_binary("ffmpeg")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    slice_start = max(0, int(clip_start_ms) - max(0, int(handle_ms)))
    slice_end = int(clip_end_ms) + max(0, int(handle_ms))
    if source_duration_ms is not None and source_duration_ms > 0:
        slice_end = min(source_duration_ms, slice_end)
    slice_dur = max(500, slice_end - slice_start)

    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{slice_start / 1000.0:.3f}",
        "-i",
        str(source_path),
        "-t",
        f"{slice_dur / 1000.0:.3f}",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-avoid_negative_ts",
        "make_zero",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
    if proc.returncode != 0 or not out_path.is_file() or out_path.stat().st_size == 0:
        raise MediaError(f"Lossless clip slice failed: {proc.stderr.strip()}")
    return out_path, slice_start


def extract_frame_jpeg(
    source_path: Path,
    out_jpg: Path,
    timestamp_ms: int,
    *,
    max_width: int = 960,
) -> Path:
    """Extract a single JPEG preview frame at ``timestamp_ms``."""
    ffmpeg = _require_binary("ffmpeg")
    out_jpg.parent.mkdir(parents=True, exist_ok=True)
    ts = max(0, int(timestamp_ms)) / 1000.0
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{ts:.3f}",
        "-i",
        str(source_path),
        "-frames:v",
        "1",
        "-vf",
        f"scale='min({max_width},iw)':-2",
        "-q:v",
        "4",
        str(out_jpg),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    if proc.returncode != 0 or not out_jpg.is_file():
        raise MediaError(f"Frame extraction failed: {proc.stderr.strip()}")
    return out_jpg
