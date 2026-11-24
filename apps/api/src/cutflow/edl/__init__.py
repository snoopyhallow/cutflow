"""Canonical TimelineProject EDL v1 schema and deterministic operations."""

from __future__ import annotations

from .ops import (
    TimelineMapper,
    apply_blade_cut,
    apply_edl_patch,
    auto_tighten_silence,
    delete_word,
    insert_word,
    split_framing_segment,
    update_word_timing,
)
from .schema import (
    AudioTrack,
    BgmTrack,
    ColdOpenBlock,
    FramingSegment,
    NormalizedBox,
    OutputSpec,
    OverlayItem,
    SubtitleStyle,
    SubtitleTrack,
    SubtitleWord,
    TimelineProject,
    TimelineTracks,
    VideoSlice,
    VideoTrack,
)

__all__ = [
    "AudioTrack",
    "BgmTrack",
    "ColdOpenBlock",
    "FramingSegment",
    "NormalizedBox",
    "OutputSpec",
    "OverlayItem",
    "SubtitleStyle",
    "SubtitleTrack",
    "SubtitleWord",
    "TimelineMapper",
    "TimelineProject",
    "TimelineTracks",
    "VideoSlice",
    "VideoTrack",
    "apply_blade_cut",
    "apply_edl_patch",
    "auto_tighten_silence",
    "delete_word",
    "insert_word",
    "split_framing_segment",
    "update_word_timing",
]
