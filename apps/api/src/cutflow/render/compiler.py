"""Zero-buffer FFmpeg EDL v1 compiler with Pillow RGBA overlays, ASS burn-in, and bounded RAM."""

from __future__ import annotations

import functools
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from ..audio.media import MediaError, probe_media
from ..edl.ops import TimelineMapper
from ..edl.schema import TimelineProject
from .overlays import RenderedOverlay, render_overlay_png
from .subtitles import write_ass_file

_RESOLUTION_MAP: dict[str, dict[str, tuple[int, int]]] = {
    "9:16": {
        "720p": (720, 1280),
        "1080p": (1080, 1920),
        "1440p": (1440, 2560),
        "4k": (2160, 3840),
    },
    "1:1": {
        "720p": (720, 720),
        "1080p": (1080, 1080),
        "1440p": (1440, 1440),
        "4k": (2160, 2160),
    },
    "16:9": {
        "720p": (1280, 720),
        "1080p": (1920, 1080),
        "1440p": (2560, 1440),
        "4k": (3840, 2160),
    },
}


class RenderError(RuntimeError):
    """Raised when FFmpeg compilation or execution fails."""


@dataclass(slots=True)
class CompiledFfmpegPlan:
    argv: list[str]
    output_path: Path
    width: int
    height: int
    duration_ms: int
    encoder: str
    ass_path: Path | None = None
    overlays: list[RenderedOverlay] = field(default_factory=list)


def resolve_output_dimensions(ratio: str, quality: str) -> tuple[int, int]:
    by_ratio = _RESOLUTION_MAP.get(ratio, _RESOLUTION_MAP["9:16"])
    return by_ratio.get(quality, by_ratio["1080p"])


def escape_ffmpeg_filter_path(path: Path) -> str:
    """Escape a filesystem path cleanly for libass ``ass=filename='...'`` on Windows & POSIX."""
    posix = path.resolve().as_posix()
    return posix.replace("\\", "/").replace(":", r"\:").replace("'", r"\'")


@functools.lru_cache(maxsize=1)
def nvenc_is_usable() -> bool:
    """Probe once per process whether ``h264_nvenc`` works with the installed NVIDIA driver."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    proc = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=128x128:d=0.1",
            "-c:v",
            "h264_nvenc",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        timeout=8,
        check=False,
    )
    return proc.returncode == 0


def _encoder_args(
    *, speed_preset: str, quality: str, prefer_nvenc: bool
) -> tuple[str, list[str]]:
    if prefer_nvenc and nvenc_is_usable():
        if speed_preset == "draft":
            return "h264_nvenc", ["-c:v", "h264_nvenc", "-preset", "p3", "-cq", "24"]
        return "h264_nvenc", ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "19"]

    # Bounded lookahead CPU libx264 (safe on 16 GB RAM machines even at 1080p/1440p/4K)
    if speed_preset == "draft":
        return (
            "libx264",
            [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "22",
                "-threads",
                "4",
                "-x264-params",
                "rc-lookahead=15:ref=2",
            ],
        )
    if quality in ("1440p", "4k"):
        return (
            "libx264",
            [
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "18",
                "-threads",
                "4",
                "-x264-params",
                "rc-lookahead=15:ref=2",
            ],
        )
    return (
        "libx264",
        [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-threads",
            "4",
            "-x264-params",
            "rc-lookahead=20:ref=3",
        ],
    )


def compile_edl_to_ffmpeg(
    edl: TimelineProject,
    *,
    media_path: Path,
    output_path: Path,
    scratch_dir: Path,
    input_origin_ms: int = 0,
    has_audio: bool = True,
    prefer_nvenc: bool = True,
    ffmpeg_bin: str | None = None,
) -> CompiledFfmpegPlan:
    """Compile a canonical ``TimelineProject`` EDL v1 into an explicit FFmpeg argv plan.

    Uses zero-buffer per-slice seeked inputs (no split/trim multi-GB RAM buffering),
    Pillow 2x RGBA overlay PNGs, ASS subtitles, and EBU R128 loudness normalization.
    """
    ffmpeg = ffmpeg_bin or shutil.which("ffmpeg")
    if not ffmpeg:
        raise RenderError("ffmpeg was not found on PATH.")

    scratch_dir.mkdir(parents=True, exist_ok=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    out_w, out_h = resolve_output_dimensions(edl.output.ratio, edl.output.quality)
    fps = edl.output.fps
    mapper = TimelineMapper(edl)

    # 1. Build ordered seeked video segments: optional Cold-Open + all blade-cut clips
    segments: list[tuple[int, int, bool, int]] = []  # (src_start_ms, dur_ms, is_cold_open, fade_ms)
    co = edl.tracks.video.cold_open
    if co is not None and co.enabled:
        segments.append((co.source_start_ms, co.duration_ms, True, co.fade_out_ms))
    for clip in edl.tracks.video.clips:
        segments.append((clip.source_start_ms, clip.duration_ms, False, 0))

    argv: list[str] = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    filter_parts: list[str] = []

    for idx, (src_start_ms, dur_ms, is_co, fade_ms) in enumerate(segments):
        rel_start_s = max(0.0, (src_start_ms - input_origin_ms) / 1000.0)
        dur_s = max(0.1, dur_ms / 1000.0)
        argv.extend(["-ss", f"{rel_start_s:.3f}", "-t", f"{dur_s:.3f}", "-i", str(media_path)])

        filter_parts.append(f"[{idx}:v]setpts=PTS-STARTPTS,fps={fps},setsar=1[vseg{idx}]")
        if has_audio:
            a_chain = (
                f"[{idx}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo"
            )
            if is_co and fade_ms > 0 and dur_ms > fade_ms:
                fade_st = (dur_ms - fade_ms) / 1000.0
                a_chain += f",afade=t=out:st={fade_st:.3f}:d={fade_ms / 1000.0:.3f}"
            filter_parts.append(f"{a_chain}[aseg{idx}]")
        else:
            filter_parts.append(
                f"anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:{dur_s:.3f}[aseg{idx}]"
            )

    n_segs = len(segments)
    if n_segs == 1:
        cur_v = "vseg0"
        cur_a = "aseg0"
    else:
        concat_inputs = "".join(f"[vseg{i}][aseg{i}]" for i in range(n_segs))
        filter_parts.append(f"{concat_inputs}concat=n={n_segs}:v=1:a=1[vcat][acat]")
        cur_v = "vcat"
        cur_a = "acat"

    # 2. Framing transformation (split / fit / centre / crop)
    framing = edl.tracks.video.framing[0]
    split_ratio = framing.split_ratio
    if framing.mode == "split" and framing.cam_box is not None:
        cam = framing.cam_box.clamped()
        top_h = max(2, (int(round(out_h * split_ratio)) // 2) * 2)
        bot_h = max(2, out_h - top_h)

        filter_parts.append(f"[{cur_v}]split=2[vtop_in][vbot_in]")
        filter_parts.append(
            f"[vtop_in]crop=iw*{cam.w:.4f}:ih*{cam.h:.4f}:iw*{cam.x:.4f}:ih*{cam.y:.4f},"
            f"scale={out_w}:{top_h}:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{top_h}[vtop]"
        )
        if framing.game_box is not None:
            gb = framing.game_box.clamped()
            bot_crop = f"crop=iw*{gb.w:.4f}:ih*{gb.h:.4f}:iw*{gb.x:.4f}:ih*{gb.y:.4f},"
        else:
            bot_crop = ""
        filter_parts.append(
            f"[vbot_in]{bot_crop}"
            f"scale={out_w}:{bot_h}:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{bot_h}[vbot]"
        )
        filter_parts.append("[vtop][vbot]vstack=inputs=2[vframed]")
        cur_v = "vframed"
    elif framing.mode == "fit":
        filter_parts.append(f"[{cur_v}]split=2[vbg_in][vfg_in]")
        filter_parts.append(
            f"[vbg_in]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{out_h},gblur=sigma=24[vbg]"
        )
        filter_parts.append(
            f"[vfg_in]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease[vfg]"
        )
        filter_parts.append("[vbg][vfg]overlay=(W-w)/2:(H-h)/2[vframed]")
        cur_v = "vframed"
    else:
        # centre / crop
        filter_parts.append(
            f"[{cur_v}]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{out_h}[vframed]"
        )
        cur_v = "vframed"

    # 3. Render & composite 2x supersampled Pillow RGBA overlays
    rendered_overlays: list[RenderedOverlay] = []
    next_input_idx = n_segs
    for ov_idx, ov in enumerate(edl.tracks.overlays):
        if not ov.text.strip():
            continue
        ov_png = scratch_dir / f"overlay_{ov_idx}.png"
        rendered = render_overlay_png(
            ov,
            ov_png,
            out_w=out_w,
            out_h=out_h,
            split_ratio=split_ratio,
        )
        rendered_overlays.append(rendered)
        argv.extend(["-i", str(ov_png)])
        out_label = f"vov{ov_idx}"
        filter_parts.append(
            f"[{cur_v}][{next_input_idx}:v]overlay=x={rendered.x_px}:y={rendered.y_px}:"
            f"enable='between(t,{rendered.start_s:.3f},{rendered.end_s:.3f})'[{out_label}]"
        )
        cur_v = out_label
        next_input_idx += 1

    # 4. Burn ASS subtitles (progressive / group / single_word)
    ass_path: Path | None = None
    if edl.tracks.subtitles.enabled and edl.tracks.subtitles.words:
        ass_path = write_ass_file(
            edl,
            scratch_dir / "captions.ass",
            play_res_x=out_w,
            play_res_y=out_h,
        )
        escaped = escape_ffmpeg_filter_path(ass_path)
        filter_parts.append(f"[{cur_v}]ass=filename='{escaped}'[vsub]")
        cur_v = "vsub"

    # 5. Audio gain + EBU R128 loudness normalization
    audio_filters: list[str] = []
    if abs(edl.tracks.audio.gain_db) > 0.05:
        audio_filters.append(f"volume={edl.tracks.audio.gain_db:.1f}dB")
    lufs = edl.tracks.audio.normalize_lufs or edl.output.loudness_lufs
    audio_filters.append(f"loudnorm=I={lufs:.1f}:TP=-1.5:LRA=11")
    filter_parts.append(f"[{cur_a}]{','.join(audio_filters)}[aout]")
    cur_a = "aout"

    encoder, enc_args = _encoder_args(
        speed_preset=edl.output.speed_preset,
        quality=edl.output.quality,
        prefer_nvenc=prefer_nvenc,
    )

    argv.extend(["-filter_complex", ";".join(filter_parts)])
    argv.extend(["-map", f"[{cur_v}]", "-map", f"[{cur_a}]"])
    argv.extend(enc_args)
    argv.extend(
        [
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            str(output_path),
        ]
    )

    return CompiledFfmpegPlan(
        argv=argv,
        output_path=output_path,
        width=out_w,
        height=out_h,
        duration_ms=mapper.total_duration_ms,
        encoder=encoder,
        ass_path=ass_path,
        overlays=rendered_overlays,
    )


def render_edl_to_mp4(
    edl: TimelineProject,
    *,
    media_path: Path,
    output_path: Path,
    scratch_dir: Path,
    input_origin_ms: int = 0,
    prefer_nvenc: bool = True,
) -> CompiledFfmpegPlan:
    """Compile and execute FFmpeg to render ``edl`` into a playable H.264/AAC MP4."""
    try:
        info = probe_media(media_path)
        has_audio = info.has_audio
    except MediaError:
        has_audio = True

    plan = compile_edl_to_ffmpeg(
        edl,
        media_path=media_path,
        output_path=output_path,
        scratch_dir=scratch_dir,
        input_origin_ms=input_origin_ms,
        has_audio=has_audio,
        prefer_nvenc=prefer_nvenc,
    )
    proc = subprocess.run(plan.argv, capture_output=True, text=True, timeout=1800, check=False)
    if proc.returncode != 0 or not output_path.is_file() or output_path.stat().st_size == 0:
        raise RenderError(f"FFmpeg render failed ({proc.returncode}): {proc.stderr.strip()[-600:]}")
    return plan
