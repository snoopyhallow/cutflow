"""AI pipeline primitives: Multi-signal Hype Curve, hybrid Whisper, cached LLM, EDL builder."""

from .auto_reframe import auto_reframe_slices, detect_face_focus_on_image, detect_shot_cuts_ms
from .coeditor import CoEditorResult, generate_post_copy, run_coeditor
from .edl_builder import CINEMA_NEON_PALETTE, build_clip_edl, infer_word_glow_color
from .highlights import HighlightCandidate, detect_webcam_box, discover_highlights
from .hype import HotWindow, HypePoint, build_hype_curve, select_hot_windows
from .llm import LLMError, complete_json, parse_json_payload
from .transcription import (
    TranscriptResult,
    TranscriptSegment,
    chunk_compact_transcript,
    encode_compact_transcript,
    transcribe_hot_windows,
    transcribe_wav,
)

__all__ = [
    "CINEMA_NEON_PALETTE",
    "CoEditorResult",
    "HighlightCandidate",
    "HotWindow",
    "HypePoint",
    "LLMError",
    "TranscriptResult",
    "TranscriptSegment",
    "auto_reframe_slices",
    "build_clip_edl",
    "build_hype_curve",
    "chunk_compact_transcript",
    "complete_json",
    "detect_face_focus_on_image",
    "detect_shot_cuts_ms",
    "detect_webcam_box",
    "discover_highlights",
    "encode_compact_transcript",
    "generate_post_copy",
    "infer_word_glow_color",
    "parse_json_payload",
    "run_coeditor",
    "select_hot_windows",
    "transcribe_hot_windows",
    "transcribe_wav",
]
