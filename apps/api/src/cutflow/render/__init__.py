"""Rendering subsystem: ASS subtitles, 2x Pillow RGBA overlays, and zero-buffer FFmpeg compiler."""

from .compiler import (
    CompiledFfmpegPlan,
    RenderError,
    compile_edl_to_ffmpeg,
    escape_ffmpeg_filter_path,
    nvenc_is_usable,
    render_edl_to_mp4,
    resolve_output_dimensions,
)
from .overlays import RenderedOverlay, compute_overlay_y_px, render_overlay_png
from .subtitles import censor_word, format_ass_time, generate_ass_subtitles, write_ass_file

__all__ = [
    "CompiledFfmpegPlan",
    "RenderError",
    "RenderedOverlay",
    "censor_word",
    "compile_edl_to_ffmpeg",
    "compute_overlay_y_px",
    "escape_ffmpeg_filter_path",
    "format_ass_time",
    "generate_ass_subtitles",
    "nvenc_is_usable",
    "render_edl_to_mp4",
    "render_overlay_png",
    "resolve_output_dimensions",
    "write_ass_file",
]
