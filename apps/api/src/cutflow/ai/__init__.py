"""AI pipeline primitives: Multi-signal Hype Curve, hybrid Whisper, cached LLM, EDL builder."""

from .coeditor import CoEditorResult, generate_post_copy, run_coeditor
from .edl_builder import build_clip_edl
from .highlights import HighlightCandidate, detect_webcam_box, discover_highlights
from .hype import HotWindow, HypePoint, build_hype_curve, select_hot_windows
from .llm import LLMError, complete_json, parse_json_payload
from .transcription import (
    TranscriptResult,
    TranscriptSegment,
    encode_compact_transcript,
    transcribe_wav,
)

__all__ = [
    "CoEditorResult",
    "HighlightCandidate",
    "HotWindow",
    "HypePoint",
    "LLMError",
    "TranscriptResult",
    "TranscriptSegment",
    "build_clip_edl",
    "build_hype_curve",
    "complete_json",
    "detect_webcam_box",
    "discover_highlights",
    "encode_compact_transcript",
    "generate_post_copy",
    "parse_json_payload",
    "run_coeditor",
    "select_hot_windows",
    "transcribe_wav",
]
