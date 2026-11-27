"""Zero-buffer FFmpeg EDL v1 compiler: multi-track, speed/freeze, reframe, ASS glow, & mixer."""

from __future__ import annotations

import functools
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from ..audio.bgm import resolve_bgm_asset_path, resolve_sfx_path
from ..audio.media import MediaError, probe_media
from ..edl.ops import TimelineMapper
from ..edl.schema import FramingSegment, NormalizedBox, TimelineProject
from .overlays import RenderedOverlay, render_border_frame_png, render_overlay_png
from .subtitles import write_ass_file

_RESOLUTION_MAP: dict[str, dict[str, tuple[int, int]]] = {
    "9:16": {
        "720p": (720, 1280),
        "1080p": (1080, 1920),
        "1440p": (1440, 2560),
        "4k": (2160, 3840),
    },
    "4:5": {
        "720p": (720, 900),
        "1080p": (1080, 1350),
        "1440p": (1440, 1800),
        "4k": (2160, 2700),
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
class _SegmentSpec:
    source_start_ms: int
    raw_source_duration_ms: int
    duration_ms: int
    is_cold_open: bool
    is_gap: bool = False
    speed: float = 1.0
    reverse: bool = False
    freeze_duration_ms: int = 0
    gain_db: float = 0.0
    muted: bool = False
    audio_detached: bool = False
    audio_fade_in_ms: int = 0
    audio_fade_out_ms: int = 0
    source_id: str | None = None
    transition_in: str = "none"
    transition_duration_ms: int = 220
    transition_sfx: str = "none"


@dataclass(slots=True)
class CompiledFfmpegPlan:
    argv: list[str]
    output_path: Path
    width: int
    height: int
    duration_ms: int
    encoder: str
    ass_path: Path | None = None
    border_path: Path | None = None
    bgm_path: Path | None = None
    overlays: list[RenderedOverlay] = field(default_factory=list)


def resolve_output_dimensions(ratio: str, quality: str) -> tuple[int, int]:
    by_ratio = _RESOLUTION_MAP.get(ratio, _RESOLUTION_MAP["9:16"])
    return by_ratio.get(quality, by_ratio["1080p"])


def escape_ffmpeg_filter_path(path: Path) -> str:
    """Escape a filesystem path cleanly for libass ``ass=filename='...'`` on Windows & POSIX."""
    posix = path.resolve().as_posix()
    return posix.replace("\\", "/").replace(":", r"\:").replace("'", r"\'")


def _build_atempo_filters(speed: float) -> list[str]:
    """Chain FFmpeg ``atempo`` stages (each bounded in [0.5, 2.0]) for ``0.25x..4.0x``."""
    rem = max(0.25, min(4.0, float(speed)))
    if abs(rem - 1.0) < 0.005:
        return []
    stages: list[str] = []
    while rem > 2.0 + 1e-6:
        stages.append("atempo=2.0")
        rem /= 2.0
    while rem < 0.5 - 1e-6:
        stages.append("atempo=0.5")
        rem /= 0.5
    if abs(rem - 1.0) >= 0.005:
        stages.append(f"atempo={rem:.4f}")
    return stages


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


def _encoder_args(*, speed_preset: str, quality: str, prefer_nvenc: bool) -> tuple[str, list[str]]:
    if prefer_nvenc and nvenc_is_usable():
        if speed_preset == "draft":
            return "h264_nvenc", ["-c:v", "h264_nvenc", "-preset", "p3", "-cq", "24"]
        return "h264_nvenc", ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "19"]

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


def _build_framing_segment_filters(
    in_label: str,
    out_label: str,
    framing: FramingSegment,
    *,
    out_w: int,
    out_h: int,
    tag: str,
) -> list[str]:
    """Build FFmpeg filtergraph nodes transforming ``[in_label]`` into ``[out_label]``."""
    parts: list[str] = []
    cur_in = in_label

    if framing.source_crop_box is not None:
        sc = framing.source_crop_box.clamped()
        if sc.w < 0.998 or sc.h < 0.998 or sc.x > 0.001 or sc.y > 0.001:
            cropped_lbl = f"vsc_{tag}"
            parts.append(
                f"[{cur_in}]crop=trunc(iw*{sc.w:.4f}/2)*2:trunc(ih*{sc.h:.4f}/2)*2:"
                f"iw*{sc.x:.4f}:ih*{sc.y:.4f}[{cropped_lbl}]"
            )
            cur_in = cropped_lbl

    if framing.mode == "split" and framing.cam_box is not None:
        cam = framing.cam_box.clamped()
        top_h = max(2, (int(round(out_h * framing.split_ratio)) // 2) * 2)
        bot_h = max(2, out_h - top_h)
        parts.append(f"[{cur_in}]split=2[vt_in_{tag}][vb_in_{tag}]")
        parts.append(
            f"[vt_in_{tag}]crop=iw*{cam.w:.4f}:ih*{cam.h:.4f}:iw*{cam.x:.4f}:ih*{cam.y:.4f},"
            f"scale={out_w}:{top_h}:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{top_h}[vt_{tag}]"
        )
        if framing.game_box is not None:
            gb = framing.game_box.clamped()
            bot_crop = f"crop=iw*{gb.w:.4f}:ih*{gb.h:.4f}:iw*{gb.x:.4f}:ih*{gb.y:.4f},"
        else:
            bot_crop = ""
        parts.append(
            f"[vb_in_{tag}]{bot_crop}"
            f"scale={out_w}:{bot_h}:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{bot_h}[vb_{tag}]"
        )
        parts.append(f"[vt_{tag}][vb_{tag}]vstack=inputs=2,format=yuv420p,setsar=1[{out_label}]")
    elif framing.mode == "fit":
        if framing.fit_backdrop == "black":
            parts.append(
                f"[{cur_in}]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,"
                f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:color=black,"
                f"format=yuv420p,setsar=1[{out_label}]"
            )
        else:
            parts.append(f"[{cur_in}]split=2[vbg_in_{tag}][vfg_in_{tag}]")
            parts.append(
                f"[vbg_in_{tag}]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,"
                f"crop={out_w}:{out_h},gblur=sigma=24[vbg_{tag}]"
            )
            parts.append(
                f"[vfg_in_{tag}]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease[vfg_{tag}]"
            )
            parts.append(
                f"[vbg_{tag}][vfg_{tag}]overlay=(W-w)/2:(H-h)/2,"
                f"format=yuv420p,setsar=1[{out_label}]"
            )
    else:
        zoom = max(1.0, min(2.5, float(framing.zoom)))
        pan_x = max(0.0, min(1.0, float(framing.pan_x)))
        pan_y = max(0.0, min(1.0, float(framing.pan_y)))
        scaled_w = max(out_w, (int(round(out_w * zoom)) // 2) * 2)
        scaled_h = max(out_h, (int(round(out_h * zoom)) // 2) * 2)
        parts.append(
            f"[{cur_in}]scale={scaled_w}:{scaled_h}:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{out_h}:(iw-{out_w})*{pan_x:.4f}:(ih-{out_h})*{pan_y:.4f},"
            f"format=yuv420p,setsar=1[{out_label}]"
        )
    return parts


def compile_edl_to_ffmpeg(
    edl: TimelineProject,
    *,
    media_path: Path,
    output_path: Path,
    scratch_dir: Path,
    input_origin_ms: int = 0,
    source_media_map: dict[str, tuple[Path, int]] | None = None,
    has_audio: bool = True,
    prefer_nvenc: bool = True,
    ffmpeg_bin: str | None = None,
) -> CompiledFfmpegPlan:
    """Compile a canonical ``TimelineProject`` EDL v1 into an explicit FFmpeg argv plan."""
    ffmpeg = ffmpeg_bin or shutil.which("ffmpeg")
    if not ffmpeg:
        raise RenderError("ffmpeg was not found on PATH.")

    scratch_dir.mkdir(parents=True, exist_ok=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    out_w, out_h = resolve_output_dimensions(edl.output.ratio, edl.output.quality)
    base_src_w = max(2, (int(edl.source_width or 1920) // 2) * 2)
    base_src_h = max(2, (int(edl.source_height or 1080) // 2) * 2)
    fps = edl.output.fps
    mapper = TimelineMapper(edl)
    total_dur_ms = mapper.total_duration_ms
    total_dur_s = max(0.2, total_dur_ms / 1000.0)

    # 1. Build ordered timeline segments: Cold-Open + optional free-position gaps + V1 clips
    segments: list[_SegmentSpec] = []
    co = edl.tracks.video.cold_open
    cursor_ms = 0
    if co is not None and co.enabled:
        segments.append(
            _SegmentSpec(
                source_start_ms=co.source_start_ms,
                raw_source_duration_ms=co.duration_ms,
                duration_ms=co.duration_ms,
                is_cold_open=True,
                audio_fade_out_ms=co.fade_out_ms,
                source_id=edl.source_id,
            )
        )
        cursor_ms = co.duration_ms

    for idx_c, (s_t0, _s_t1, clip) in enumerate(mapper.spans):
        if s_t0 - cursor_ms >= 50:
            gap_ms = s_t0 - cursor_ms
            segments.append(
                _SegmentSpec(
                    source_start_ms=0,
                    raw_source_duration_ms=gap_ms,
                    duration_ms=gap_ms,
                    is_cold_open=False,
                    is_gap=True,
                    muted=True,
                )
            )
            cursor_ms = s_t0

        is_first_overall = idx_c == 0 and len(segments) == 0
        segments.append(
            _SegmentSpec(
                source_start_ms=clip.source_start_ms,
                raw_source_duration_ms=clip.raw_source_duration_ms,
                duration_ms=clip.duration_ms,
                is_cold_open=False,
                speed=clip.speed,
                reverse=clip.reverse,
                freeze_duration_ms=clip.freeze_duration_ms,
                gain_db=clip.gain_db,
                muted=clip.muted,
                audio_detached=clip.audio_detached,
                audio_fade_in_ms=clip.fade_in_ms,
                audio_fade_out_ms=clip.fade_out_ms,
                source_id=clip.source_id or edl.source_id,
                transition_in="none" if is_first_overall else clip.transition_in,
                transition_duration_ms=clip.transition_duration_ms,
                transition_sfx="none" if is_first_overall else clip.transition_sfx,
            )
        )
        cursor_ms = s_t0 + clip.duration_ms

    argv: list[str] = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    filter_parts: list[str] = []
    next_input_idx = 0
    needs_norm_scale = any(seg.is_gap for seg in segments) or bool(
        source_media_map and len(source_media_map) > 1
    )

    for idx, seg in enumerate(segments):
        dur_s = max(0.06, seg.duration_ms / 1000.0)
        if seg.is_gap:
            filter_parts.append(
                f"color=c=black:s={base_src_w}x{base_src_h}:r={fps}:d={dur_s:.3f},"
                f"format=yuv420p,setsar=1[vseg{idx}]"
            )
            filter_parts.append(
                f"anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:{dur_s:.3f}[aseg{idx}]"
            )
            continue

        seg_media, seg_origin_ms = (
            source_media_map.get(seg.source_id, (media_path, input_origin_ms))
            if (source_media_map and seg.source_id)
            else (media_path, input_origin_ms)
        )
        rel_start_s = max(0.0, (seg.source_start_ms - seg_origin_ms) / 1000.0)
        read_dur_s = (
            0.12 if seg.freeze_duration_ms > 0 else max(0.1, seg.raw_source_duration_ms / 1000.0)
        )
        in_idx = next_input_idx
        next_input_idx += 1
        argv.extend(["-ss", f"{rel_start_s:.3f}", "-t", f"{read_dur_s:.3f}", "-i", str(seg_media)])

        if seg.freeze_duration_ms > 0:
            v_chain = (
                f"[{in_idx}:v]trim=duration=0.04,setpts=PTS-STARTPTS,"
                f"tpad=stop_mode=clone:stop_duration={dur_s:.3f},"
                f"trim=0:{dur_s:.3f},setpts=PTS-STARTPTS,fps={fps},setsar=1"
            )
        else:
            v_chain = f"[{in_idx}:v]setpts=PTS-STARTPTS"
            if seg.reverse:
                v_chain += ",reverse,setpts=PTS-STARTPTS"
            if abs(seg.speed - 1.0) >= 0.005:
                v_chain += f",setpts=PTS/{seg.speed:.4f}"
            v_chain += f",fps={fps},setsar=1"

        if needs_norm_scale:
            v_chain += f",scale={base_src_w}:{base_src_h},format=yuv420p,setsar=1"

        # Incoming transition fade-in on head of this slice (preserves exact timeline duration!)
        if idx > 0 and seg.transition_in in ("flash_white", "dip_black", "dissolve"):
            in_col = "white" if seg.transition_in == "flash_white" else "black"
            in_d = min(0.30, max(0.05, (seg.transition_duration_ms / 1000.0) * 0.55))
            if dur_s > in_d * 1.8:
                v_chain += f",fade=t=in:st=0:d={in_d:.3f}:color={in_col}"

        # Outgoing transition fade-out on tail of this slice if next slice requests a transition
        if idx + 1 < len(segments):
            nxt = segments[idx + 1]
            if nxt.transition_in in ("flash_white", "dip_black", "dissolve"):
                out_col = "white" if nxt.transition_in == "flash_white" else "black"
                out_d = min(0.30, max(0.05, (nxt.transition_duration_ms / 1000.0) * 0.45))
                if dur_s > out_d * 2.2:
                    out_st = dur_s - out_d
                    v_chain += f",fade=t=out:st={out_st:.3f}:d={out_d:.3f}:color={out_col}"

        filter_parts.append(f"{v_chain}[vseg{idx}]")

        silent_seg = (
            not has_audio
            or seg.freeze_duration_ms > 0
            or seg.muted
            or seg.audio_detached
            or seg.gain_db <= -59.5
        )
        if not silent_seg:
            a_steps = [
                f"[{in_idx}:a]asetpts=PTS-STARTPTS",
                "aresample=48000",
                "aformat=channel_layouts=stereo",
            ]
            if seg.reverse:
                a_steps.extend(["areverse", "asetpts=PTS-STARTPTS"])
            a_steps.extend(_build_atempo_filters(seg.speed))
            if abs(seg.gain_db) > 0.05:
                a_steps.append(f"volume={seg.gain_db:.1f}dB")
            if seg.audio_fade_in_ms > 0 and seg.duration_ms > seg.audio_fade_in_ms:
                a_steps.append(f"afade=t=in:st=0:d={seg.audio_fade_in_ms / 1000.0:.3f}")
            if seg.audio_fade_out_ms > 0 and seg.duration_ms > seg.audio_fade_out_ms:
                fade_st = (seg.duration_ms - seg.audio_fade_out_ms) / 1000.0
                a_steps.append(
                    f"afade=t=out:st={fade_st:.3f}:d={seg.audio_fade_out_ms / 1000.0:.3f}"
                )
            a_steps.extend([f"apad=whole_dur={dur_s:.3f}", f"atrim=0:{dur_s:.3f}"])
            filter_parts.append(f"{','.join(a_steps)}[aseg{idx}]")
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

    # 2. Framing transformation (supports single-segment & multi-segment shot keyframes)
    framing_segments = edl.tracks.video.framing
    split_ratio = framing_segments[0].split_ratio
    if len(framing_segments) == 1:
        filter_parts.extend(
            _build_framing_segment_filters(
                cur_v, "vframed", framing_segments[0], out_w=out_w, out_h=out_h, tag="f0"
            )
        )
        cur_v = "vframed"
    else:
        k = len(framing_segments)
        split_outs = "".join(f"[vf_src_{i}]" for i in range(k))
        filter_parts.append(f"[{cur_v}]split={k}{split_outs}")
        framed_outs: list[str] = []
        for i, f_seg in enumerate(framing_segments):
            s_sec = max(0.0, f_seg.timeline_start_ms / 1000.0)
            e_sec = max(s_sec + 0.05, f_seg.timeline_end_ms / 1000.0)
            trimmed_lbl = f"vf_trim_{i}"
            out_lbl = f"vf_out_{i}"
            filter_parts.append(
                f"[vf_src_{i}]trim=start={s_sec:.3f}:end={e_sec:.3f},"
                f"setpts=PTS-STARTPTS[{trimmed_lbl}]"
            )
            filter_parts.extend(
                _build_framing_segment_filters(
                    trimmed_lbl, out_lbl, f_seg, out_w=out_w, out_h=out_h, tag=f"f{i}"
                )
            )
            framed_outs.append(f"[{out_lbl}]")
        filter_parts.append(f"{''.join(framed_outs)}concat=n={k}:v=1:a=0[vframed]")
        cur_v = "vframed"

    # 2b. Optional V2 B-Roll / Picture-in-Picture overlays
    extra_audio_stems: list[str] = []
    detached_voice_stems: list[str] = []

    for br_idx, br in enumerate(edl.tracks.video.broll):
        br_media, br_origin = (
            source_media_map.get(br.source_id, (media_path, input_origin_ms))
            if source_media_map
            else (media_path, input_origin_ms)
        )
        if not br_media.is_file():
            continue
        box = (br.box or NormalizedBox(x=0.56, y=0.06, w=0.38, h=0.28)).clamped()
        bw = max(2, (int(round(out_w * box.w)) // 2) * 2)
        bh = max(2, (int(round(out_h * box.h)) // 2) * 2)
        bx = int(round(out_w * box.x))
        by = int(round(out_h * box.y))
        rel_s = max(0.0, (br.source_start_ms - br_origin) / 1000.0)
        raw_s = max(0.1, (br.source_end_ms - br.source_start_ms) / 1000.0)
        t_start_s = max(0.0, br.timeline_start_ms / 1000.0)
        br_dur_s = max(0.06, br.duration_ms / 1000.0)
        t_end_s = t_start_s + br_dur_s

        br_in = next_input_idx
        next_input_idx += 1
        argv.extend(["-ss", f"{rel_s:.3f}", "-t", f"{raw_s:.3f}", "-i", str(br_media)])

        br_lbl = f"vbr{br_idx}"
        out_br_lbl = f"vbr_comp{br_idx}"
        alpha_step = (
            f",format=rgba,colorchannelmixer=aa={br.opacity:.3f}"
            if br.opacity < 0.995
            else ",format=yuv420p"
        )
        filter_parts.append(
            f"[{br_in}:v]setpts=(PTS-STARTPTS)/{br.speed:.4f}+{t_start_s:.3f}/TB,"
            f"fps={fps},scale={bw}:{bh}:force_original_aspect_ratio=increase,"
            f"crop={bw}:{bh}{alpha_step}[{br_lbl}]"
        )
        filter_parts.append(
            f"[{cur_v}][{br_lbl}]overlay=x={bx}:y={by}:eof_action=pass:"
            f"enable='between(t,{t_start_s:.3f},{t_end_s:.3f})'[{out_br_lbl}]"
        )
        cur_v = out_br_lbl

        if not br.muted and br.gain_db > -59.5 and has_audio:
            delay_ms = max(0, int(br.timeline_start_ms))
            br_a_lbl = f"abr{br_idx}"
            a_steps = [
                f"[{br_in}:a]asetpts=PTS-STARTPTS",
                "aresample=48000",
                "aformat=channel_layouts=stereo",
                *_build_atempo_filters(br.speed),
                f"volume={br.gain_db:.1f}dB",
                f"adelay={delay_ms}|{delay_ms}",
                f"apad=whole_dur={total_dur_s:.3f}",
                f"atrim=0:{total_dur_s:.3f}",
            ]
            filter_parts.append(f"{','.join(a_steps)}[{br_a_lbl}]")
            extra_audio_stems.append(br_a_lbl)

    # 3. Optional Crisp HD Cinema Color Grade + Micro-Contrast Sharpen
    if edl.output.cinema_grade == "crisp_hd":
        filter_parts.append(
            f"[{cur_v}]eq=contrast=1.06:saturation=1.08:brightness=-0.01,"
            f"unsharp=5:5:0.65:5:5:0.0[vgrade]"
        )
        cur_v = "vgrade"

    # 4. Optional 2x Supersampled Inner Rounded Cinema Border Frame
    border_path: Path | None = None
    if edl.output.border_style != "none":
        border_path = render_border_frame_png(
            edl.output.border_style,
            scratch_dir / "border_frame.png",
            out_w=out_w,
            out_h=out_h,
        )
        if border_path is not None:
            argv.extend(["-i", str(border_path)])
            filter_parts.append(f"[{cur_v}][{next_input_idx}:v]overlay=x=0:y=0[vborder]")
            cur_v = "vborder"
            next_input_idx += 1

    # 5. Render & composite 2x supersampled Pillow RGBA overlays (POV Bar, Seam Card, Watermark)
    rendered_overlays: list[RenderedOverlay] = []
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

    # 6. Burn ASS subtitles (standard / karaoke / cinema_neon_glow / viral_punch_glow)
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

    # 7. Studio Audio Mixer: Dialogue + Detached A1 + A3 Multi-SFX + Looped BGM + Loudnorm
    audio_cfg = edl.tracks.audio

    # 7a. Render explicit A1 (detached) & A3 (SFX / audio) clips
    for ac_idx, ac in enumerate(audio_cfg.clips):
        if ac.muted or ac.gain_db <= -59.5:
            continue
        ac_path: Path | None = None
        ac_origin = 0
        if ac.asset_id:
            ac_path = resolve_sfx_path(ac.asset_id)
            if ac_path is None:
                resolved_b = resolve_bgm_asset_path(ac.asset_id)
                if resolved_b is not None:
                    ac_path = resolved_b[0]
        elif ac.source_id:
            ac_media, ac_origin = (
                source_media_map.get(ac.source_id, (media_path, input_origin_ms))
                if source_media_map
                else (media_path, input_origin_ms)
            )
            if ac_media.is_file():
                ac_path = ac_media
        if ac_path is None or not ac_path.is_file():
            continue

        rel_s = max(0.0, (ac.source_start_ms - ac_origin) / 1000.0)
        raw_s = max(0.06, (ac.source_end_ms - ac.source_start_ms) / 1000.0)
        ac_dur_s = max(0.06, ac.duration_ms / 1000.0)
        delay_ms = max(0, int(ac.timeline_start_ms))

        ac_in = next_input_idx
        next_input_idx += 1
        argv.extend(["-ss", f"{rel_s:.3f}", "-t", f"{raw_s:.3f}", "-i", str(ac_path)])
        ac_lbl = f"aaclip{ac_idx}"
        a_steps = [
            f"[{ac_in}:a]asetpts=PTS-STARTPTS",
            "aresample=48000",
            "aformat=channel_layouts=stereo",
            *_build_atempo_filters(ac.speed),
        ]
        if abs(ac.gain_db) > 0.05:
            a_steps.append(f"volume={ac.gain_db:.1f}dB")
        if ac.fade_in_ms > 0 and ac.duration_ms > ac.fade_in_ms:
            a_steps.append(f"afade=t=in:st=0:d={ac.fade_in_ms / 1000.0:.3f}")
        if ac.fade_out_ms > 0 and ac.duration_ms > ac.fade_out_ms:
            fo_st = max(0.0, ac_dur_s - ac.fade_out_ms / 1000.0)
            a_steps.append(f"afade=t=out:st={fo_st:.3f}:d={ac.fade_out_ms / 1000.0:.3f}")
        a_steps.extend(
            [
                f"adelay={delay_ms}|{delay_ms}",
                f"apad=whole_dur={total_dur_s:.3f}",
                f"atrim=0:{total_dur_s:.3f}",
            ]
        )
        filter_parts.append(f"{','.join(a_steps)}[{ac_lbl}]")
        if ac.kind == "detached":
            detached_voice_stems.append(ac_lbl)
        else:
            extra_audio_stems.append(ac_lbl)

    if detached_voice_stems:
        dv_inputs = "".join(f"[{s}]" for s in [cur_a, *detached_voice_stems])
        n_dv = 1 + len(detached_voice_stems)
        filter_parts.append(
            f"{dv_inputs}amix=inputs={n_dv}:duration=first:dropout_transition=0:normalize=0[avoice_pre]"
        )
        cur_a = "avoice_pre"

    voice_muted = audio_cfg.mute_original or audio_cfg.gain_db <= -59.5
    voice_chain: list[str] = []
    if voice_muted:
        voice_chain.append("volume=0")
    else:
        if audio_cfg.dialogue_enhance:
            voice_chain.append("highpass=f=85,lowpass=f=13500,equalizer=f=2800:t=q:w=1.2:g=3.5")
        if abs(audio_cfg.gain_db) > 0.05:
            voice_chain.append(f"volume={audio_cfg.gain_db:.1f}dB")

    if voice_chain:
        filter_parts.append(f"[{cur_a}]{','.join(voice_chain)}[avoice]")
        cur_a = "avoice"

    # Optional Transition SFX hits delayed to exact cut timestamps
    sfx_labels: list[str] = [*extra_audio_stems]
    cut_cursor_ms = 0
    for idx, seg in enumerate(segments):
        if idx > 0 and seg.transition_sfx != "none":
            sfx_file = resolve_sfx_path(seg.transition_sfx)
            if sfx_file is not None:
                lead_ms = 120 if seg.transition_sfx == "whoosh_flash" else 40
                delay_ms = max(0, cut_cursor_ms - lead_ms)
                argv.extend(["-i", str(sfx_file)])
                sfx_lbl = f"asfx{len(sfx_labels)}"
                filter_parts.append(
                    f"[{next_input_idx}:a]aresample=48000,aformat=channel_layouts=stereo,"
                    f"volume=-5.5dB,adelay={delay_ms}|{delay_ms},"
                    f"apad=whole_dur={total_dur_s:.3f},atrim=0:{total_dur_s:.3f}[{sfx_lbl}]"
                )
                sfx_labels.append(sfx_lbl)
                next_input_idx += 1
        cut_cursor_ms += seg.duration_ms

    # Optional Looped BGM Bed + Sidechain Auto-Ducking under active dialogue
    bgm_path: Path | None = None
    bgm_label: str | None = None
    if audio_cfg.bgm is not None and audio_cfg.bgm.gain_db > -59.5:
        bgm_cfg = audio_cfg.bgm
        resolved_bgm = resolve_bgm_asset_path(bgm_cfg.asset_id)
        if resolved_bgm is not None:
            bgm_path, _ = resolved_bgm
            offset_s = max(0.0, bgm_cfg.start_offset_ms / 1000.0)
            argv.extend(
                [
                    "-stream_loop",
                    "-1",
                    "-ss",
                    f"{offset_s:.3f}",
                    "-t",
                    f"{total_dur_s:.3f}",
                    "-i",
                    str(bgm_path),
                ]
            )
            bgm_filters = [
                "aresample=48000",
                "aformat=channel_layouts=stereo",
                "asetpts=PTS-STARTPTS",
                f"volume={bgm_cfg.gain_db:.1f}dB",
            ]
            if bgm_cfg.fade_in_ms > 0:
                bgm_filters.append(f"afade=t=in:st=0:d={bgm_cfg.fade_in_ms / 1000.0:.3f}")
            if bgm_cfg.fade_out_ms > 0 and total_dur_ms > bgm_cfg.fade_out_ms + 200:
                fo_st = (total_dur_ms - bgm_cfg.fade_out_ms) / 1000.0
                fo_d = bgm_cfg.fade_out_ms / 1000.0
                bgm_filters.append(f"afade=t=out:st={fo_st:.3f}:d={fo_d:.3f}")
            bgm_filters.append(f"apad=whole_dur={total_dur_s:.3f}")
            bgm_filters.append(f"atrim=0:{total_dur_s:.3f}")
            filter_parts.append(f"[{next_input_idx}:a]{','.join(bgm_filters)}[abgm_pre]")
            next_input_idx += 1

            if bgm_cfg.ducking_enabled and (has_audio or detached_voice_stems) and not voice_muted:
                filter_parts.append(f"[{cur_a}]asplit=2[avoice_main][avoice_sc]")
                filter_parts.append(
                    "[abgm_pre][avoice_sc]sidechaincompress="
                    "threshold=0.025:ratio=6:attack=35:release=480[abgm_ready]"
                )
                cur_a = "avoice_main"
                bgm_label = "abgm_ready"
            else:
                bgm_label = "abgm_pre"

    stems = [cur_a, *([bgm_label] if bgm_label else []), *sfx_labels]
    if len(stems) > 1:
        stem_inputs = "".join(f"[{s}]" for s in stems)
        filter_parts.append(
            f"{stem_inputs}amix=inputs={len(stems)}:"
            f"duration=first:dropout_transition=0:normalize=0[amixed]"
        )
        cur_a = "amixed"

    if voice_muted and bgm_label is None and not sfx_labels:
        # Preserve true silence when everything is muted instead of loudnorm boosting noise floor
        filter_parts.append(f"[{cur_a}]volume=0[aout]")
    else:
        lufs = audio_cfg.normalize_lufs or edl.output.loudness_lufs
        filter_parts.append(f"[{cur_a}]loudnorm=I={lufs:.1f}:TP=-1.5:LRA=11[aout]")
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
        duration_ms=total_dur_ms,
        encoder=encoder,
        ass_path=ass_path,
        border_path=border_path,
        bgm_path=bgm_path,
        overlays=rendered_overlays,
    )


def render_edl_to_mp4(
    edl: TimelineProject,
    *,
    media_path: Path,
    output_path: Path,
    scratch_dir: Path,
    input_origin_ms: int = 0,
    source_media_map: dict[str, tuple[Path, int]] | None = None,
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
        source_media_map=source_media_map,
        has_audio=has_audio,
        prefer_nvenc=prefer_nvenc,
    )
    proc = subprocess.run(plan.argv, capture_output=True, text=True, timeout=1800, check=False)
    if proc.returncode != 0 or not output_path.is_file() or output_path.stat().st_size == 0:
        raise RenderError(f"FFmpeg render failed ({proc.returncode}): {proc.stderr.strip()[-600:]}")
    return plan
