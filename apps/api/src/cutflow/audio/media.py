"""FFprobe stream inspection, 5.1 dialogue mix, letterbox cropdetect, WAV, slices & filmstrips."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

_TEXT_SUBTITLE_CODECS = frozenset(
    {"subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "ttml"}
)
_COPY_SAFE_MP4_VIDEO_CODECS = frozenset({"h264", "avc1", "hevc", "hvc1", "av1"})
_CROP_RE = re.compile(r"crop=(\d+):(\d+):(\d+):(\d+)")

_LANG_ALIASES: dict[str, tuple[str, ...]] = {
    "en": ("en", "eng", "english"),
    "es": ("es", "spa", "spanish"),
    "ja": ("ja", "jpn", "japanese"),
    "ko": ("ko", "kor", "korean"),
    "fr": ("fr", "fre", "fra", "french"),
    "de": ("de", "ger", "deu", "german"),
    "pt": ("pt", "por", "portuguese"),
    "zh": ("zh", "chi", "zho", "chinese"),
}


class MediaError(RuntimeError):
    """Raised when ffprobe or ffmpeg fails on a media asset."""


@dataclass(slots=True, frozen=True)
class SubtitleStreamInfo:
    rel_index: int
    stream_index: int
    codec_name: str
    language: str
    title: str
    forced: bool = False
    hearing_impaired: bool = False


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
    audio_channels: int = 2
    preferred_audio_rel_index: int = 0
    audio_language: str = ""
    subtitle_streams: tuple[SubtitleStreamInfo, ...] = ()


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


def lang_matches(stream_lang: str, preferred_lang: str = "en") -> bool:
    s = (stream_lang or "").strip().lower()
    p = (preferred_lang or "en").strip().lower()
    if not s or not p:
        return False
    aliases = _LANG_ALIASES.get(p[:2], (p, p[:2]))
    return s in aliases or any(s.startswith(f"{a}-") or s.startswith(f"{a}_") for a in aliases)


def dialogue_downmix_filter(channels: int) -> str | None:
    """Return a stereo downmix filter boosting 5.1/7.1 Front-Center (FC) dialogue."""
    if channels >= 6:
        return "pan=stereo|c0=0.70*FC+0.30*FL+0.15*BL|c1=0.70*FC+0.30*FR+0.15*BR"
    return None


def _select_audio_stream(
    audio_streams: list[dict], preferred_lang: str
) -> tuple[int, dict | None]:
    if not audio_streams:
        return 0, None
    best_idx = 0
    best_score = -10_000
    for rel_idx, stream in enumerate(audio_streams):
        tags = stream.get("tags") or {}
        disposition = stream.get("disposition") or {}
        lang = str(tags.get("language") or tags.get("LANG") or "").lower()
        title = str(tags.get("title") or "").lower()
        channels = int(stream.get("channels") or 2)

        score = 0
        if lang_matches(lang, preferred_lang):
            score += 100
        elif not lang:
            score += 15
        if any(bad in title for bad in ("commentary", "director", "descriptive", "karaoke")):
            score -= 80
        if disposition.get("visual_impaired") or disposition.get("comment"):
            score -= 80
        if disposition.get("default"):
            score += 10
        if channels >= 6:
            score += 5  # Dedicated 5.1 mix gives clean FC center dialogue channel

        if score > best_score:
            best_score = score
            best_idx = rel_idx

    return best_idx, audio_streams[best_idx]


def probe_media(path: Path, *, preferred_lang: str = "en") -> MediaInfo:
    """Inspect video, multi-track audio, and embedded text subtitle streams via ffprobe."""
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
    if v_stream is None:
        raise MediaError(f"No video stream found in {target.name}")

    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
    audio_rel_idx, a_stream = _select_audio_stream(audio_streams, preferred_lang)

    sub_infos: list[SubtitleStreamInfo] = []
    sub_streams = [s for s in streams if s.get("codec_type") == "subtitle"]
    for rel_idx, s_stream in enumerate(sub_streams):
        codec_name = str(s_stream.get("codec_name") or "").lower()
        if codec_name not in _TEXT_SUBTITLE_CODECS:
            continue
        tags = s_stream.get("tags") or {}
        disp = s_stream.get("disposition") or {}
        title = str(tags.get("title") or "")
        sdh = bool(disp.get("hearing_impaired")) or any(
            tok in title.lower() for tok in ("sdh", "cc", "hearing")
        )
        sub_infos.append(
            SubtitleStreamInfo(
                rel_index=rel_idx,
                stream_index=int(s_stream.get("index") or 0),
                codec_name=codec_name,
                language=str(tags.get("language") or tags.get("LANG") or "").lower(),
                title=title,
                forced=bool(disp.get("forced")) or "forced" in title.lower(),
                hearing_impaired=sdh,
            )
        )

    dur_raw = fmt.get("duration") or v_stream.get("duration") or "0"
    try:
        duration_ms = max(0, int(round(float(dur_raw) * 1000.0)))
    except ValueError:
        duration_ms = 0

    fps = _parse_rational_fps(v_stream.get("avg_frame_rate") or v_stream.get("r_frame_rate"))
    if fps <= 0 or fps > 240:
        fps = 30.0

    a_tags = (a_stream.get("tags") or {}) if a_stream else {}
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
        audio_channels=max(1, int(a_stream.get("channels") or 2)) if a_stream else 0,
        preferred_audio_rel_index=audio_rel_idx,
        audio_language=str(a_tags.get("language") or a_tags.get("LANG") or "").lower(),
        subtitle_streams=tuple(sub_infos),
    )


def detect_active_video_box(
    source_path: Path,
    media: MediaInfo,
) -> dict[str, float] | None:
    """Detect hardcoded black letterbox/pillarbox bars via FFmpeg cropdetect at 20%/50%/80%."""
    if media.duration_ms < 2000 or media.width < 64 or media.height < 64:
        return None
    ffmpeg = _require_binary("ffmpeg")
    boxes: list[tuple[int, int, int, int]] = []

    for frac in (0.20, 0.50, 0.80):
        ts_s = max(0.0, (media.duration_ms * frac) / 1000.0)
        cmd = [
            ffmpeg,
            "-hide_banner",
            "-ss",
            f"{ts_s:.3f}",
            "-i",
            str(source_path),
            "-frames:v",
            "5",
            "-vf",
            "cropdetect=limit=24:round=2:reset=0",
            "-f",
            "null",
            "-",
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20, check=False)
        matches = _CROP_RE.findall(proc.stderr or "")
        if matches:
            w_s, h_s, x_s, y_s = matches[-1]
            cw, ch, cx, cy = int(w_s), int(h_s), int(x_s), int(y_s)
            if cw > 0 and ch > 0:
                boxes.append((cx, cy, cx + cw, cy + ch))

    if not boxes:
        return None

    # Union active regions across sample points so dark single shots never over-crop
    x0 = max(0, min(b[0] for b in boxes))
    y0 = max(0, min(b[1] for b in boxes))
    x1 = min(media.width, max(b[2] for b in boxes))
    y1 = min(media.height, max(b[3] for b in boxes))
    act_w = x1 - x0
    act_h = y1 - y0

    if act_w <= 0 or act_h <= 0:
        return None

    w_ratio = act_w / media.width
    h_ratio = act_h / media.height

    # Only strip when meaningful letterbox/pillarbox bars (>= 6%) exist and scene isn't pitch black
    if (w_ratio > 0.94 and h_ratio > 0.94) or (w_ratio * h_ratio < 0.42):
        return None

    return {
        "x": round(x0 / media.width, 4),
        "y": round(y0 / media.height, 4),
        "w": round(w_ratio, 4),
        "h": round(h_ratio, 4),
    }


def extract_wav_16k(
    source_path: Path,
    out_wav: Path,
    *,
    start_ms: int | None = None,
    duration_ms: int | None = None,
    audio_rel_index: int = 0,
    audio_channels: int = 2,
    center_dialogue_boost: bool = False,
) -> Path:
    """Extract 16kHz mono 16-bit PCM WAV (with optional 5.1 FC dialogue isolation)."""
    ffmpeg = _require_binary("ffmpeg")
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    if start_ms is not None and start_ms > 0:
        cmd.extend(["-ss", f"{start_ms / 1000.0:.3f}"])
    cmd.extend(["-i", str(source_path)])
    if duration_ms is not None and duration_ms > 0:
        cmd.extend(["-t", f"{duration_ms / 1000.0:.3f}"])

    cmd.extend(["-vn", "-map", f"0:a:{max(0, int(audio_rel_index))}?"])
    fc_pan = dialogue_downmix_filter(audio_channels) if center_dialogue_boost else None
    if fc_pan:
        cmd.extend(["-af", fc_pan])

    cmd.extend(
        [
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
    audio_rel_index: int = 0,
    audio_codec: str = "aac",
    audio_channels: int = 2,
    video_codec: str = "h264",
    center_dialogue_boost: bool = False,
) -> tuple[Path, int]:
    """Create a fast MP4 clip slice with browser-safe stereo AAC for .mkv/5.1 sources.

    Preserves zero-copy `-c:v copy` (and `-c:a copy` when already stereo AAC), while
    automatically transcoding AC-3/DTS/FLAC/5.1 movie audio to 192k stereo AAC with
    Front-Center dialogue isolation so browser `<video>` preview and post-archive exports
    never go silent.
    """
    ffmpeg = _require_binary("ffmpeg")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    slice_start = max(0, int(clip_start_ms) - max(0, int(handle_ms)))
    slice_end = int(clip_end_ms) + max(0, int(handle_ms))
    if source_duration_ms is not None and source_duration_ms > 0:
        slice_end = min(source_duration_ms, slice_end)
    slice_dur = max(500, slice_end - slice_start)

    v_copy = video_codec.strip().lower() in _COPY_SAFE_MP4_VIDEO_CODECS or not video_codec
    a_can_copy = (
        audio_codec.strip().lower() == "aac"
        and audio_channels <= 2
        and not center_dialogue_boost
    )

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
        f"0:a:{max(0, int(audio_rel_index))}?",
    ]

    if v_copy:
        cmd.extend(["-c:v", "copy"])
    else:
        cmd.extend(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"])

    if a_can_copy:
        cmd.extend(["-c:a", "copy"])
    else:
        fc_pan = dialogue_downmix_filter(audio_channels) if center_dialogue_boost else None
        if fc_pan:
            cmd.extend(["-af", fc_pan])
        else:
            cmd.extend(["-ac", "2"])
        cmd.extend(["-c:a", "aac", "-b:a", "192k", "-ar", "48000"])

    cmd.extend(
        [
            "-movflags",
            "+faststart",
            "-avoid_negative_ts",
            "make_zero",
            str(out_path),
        ]
    )
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180, check=False)
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


def extract_filmstrip_jpeg(
    source_path: Path,
    out_jpg: Path,
    *,
    start_ms: int = 0,
    duration_ms: int = 10_000,
    frames: int = 8,
    thumb_height: int = 88,
) -> Path:
    """Generate a lightweight horizontal 8-frame filmstrip JPEG for NLE timeline tracks."""
    ffmpeg = _require_binary("ffmpeg")
    out_jpg.parent.mkdir(parents=True, exist_ok=True)
    dur_s = max(0.5, duration_ms / 1000.0)
    n_frames = max(2, min(16, int(frames)))
    fps_expr = f"{n_frames / dur_s:.4f}"

    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{max(0, start_ms) / 1000.0:.3f}",
        "-t",
        f"{dur_s:.3f}",
        "-i",
        str(source_path),
        "-vf",
        f"fps={fps_expr},scale=-2:{thumb_height},tile={n_frames}x1",
        "-frames:v",
        "1",
        "-q:v",
        "5",
        str(out_jpg),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    if proc.returncode != 0 or not out_jpg.is_file():
        raise MediaError(f"Filmstrip extraction failed: {proc.stderr.strip()}")
    return out_jpg
