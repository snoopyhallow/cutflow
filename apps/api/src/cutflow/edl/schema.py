"""Pydantic v2 models mirroring ``packages/edl-schema/timeline.v1.schema.json``."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

_EDL_CONFIG = ConfigDict(
    alias_generator=to_camel,
    populate_by_name=True,
    extra="forbid",
)

RatioLiteral = Literal["9:16", "4:5", "1:1", "16:9"]
BorderStyleLiteral = Literal["none", "thin_rounded", "double_cinema"]
CinemaGradeLiteral = Literal["off", "crisp_hd"]
TransitionKindLiteral = Literal["none", "flash_white", "dip_black", "dissolve"]
TransitionSfxLiteral = Literal["none", "whoosh_flash", "cinema_hit"]
SubtitlePresetLiteral = Literal[
    "bold_pop",
    "karaoke_fill",
    "clean_lower",
    "boxed",
    "cinema_neon_glow",
    "viral_punch_glow",
]
OverlayKindLiteral = Literal[
    "seam_card_white",
    "hook_banner_dark",
    "cta_pill",
    "pov_top_bar",
    "watermark_tag",
    "cinema_credit",
]


class EdlModel(BaseModel):
    model_config = _EDL_CONFIG


class NormalizedBox(EdlModel):
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    w: float = Field(ge=0.05, le=1.0)
    h: float = Field(ge=0.05, le=1.0)

    def clamped(self) -> NormalizedBox:
        w = max(0.05, min(1.0, self.w))
        h = max(0.05, min(1.0, self.h))
        x = max(0.0, min(1.0 - w, self.x))
        y = max(0.0, min(1.0 - h, self.y))
        return NormalizedBox(x=round(x, 4), y=round(y, 4), w=round(w, 4), h=round(h, 4))


class OutputSpec(EdlModel):
    ratio: RatioLiteral = "9:16"
    quality: Literal["720p", "1080p", "1440p", "4k"] = "1080p"
    speed_preset: Literal["draft", "final"] = "final"
    fps: int = Field(default=60, ge=15, le=120)
    loudness_lufs: float = Field(default=-14.0, ge=-36.0, le=-5.0)
    border_style: BorderStyleLiteral = "none"
    cinema_grade: CinemaGradeLiteral = "off"


class ColdOpenBlock(EdlModel):
    enabled: bool = True
    source_start_ms: int = Field(ge=0)
    duration_ms: int = Field(default=1500, ge=500, le=4000)
    fade_out_ms: int = Field(default=120, ge=0, le=500)


class VideoSlice(EdlModel):
    id: str = Field(min_length=1)
    source_start_ms: int = Field(ge=0)
    source_end_ms: int = Field(ge=1)
    source_id: str | None = None
    label: str = ""
    transition_in: TransitionKindLiteral = "none"
    transition_duration_ms: int = Field(default=220, ge=80, le=800)
    transition_sfx: TransitionSfxLiteral = "none"

    @property
    def duration_ms(self) -> int:
        return self.source_end_ms - self.source_start_ms

    @model_validator(mode="after")
    def _check_bounds(self) -> VideoSlice:
        if self.source_end_ms <= self.source_start_ms:
            raise ValueError("sourceEndMs must be greater than sourceStartMs.")
        return self


class FramingSegment(EdlModel):
    id: str = Field(min_length=1)
    timeline_start_ms: int = Field(ge=0)
    timeline_end_ms: int = Field(ge=1)
    mode: Literal["split", "fit", "centre", "crop"] = "split"
    split_ratio: float = Field(default=0.35, ge=0.20, le=0.65)
    cam_box: NormalizedBox | None = None
    game_box: NormalizedBox | None = None
    fit_backdrop: Literal["blur", "black"] = "blur"
    pan_x: float = Field(default=0.5, ge=0.0, le=1.0)
    pan_y: float = Field(default=0.5, ge=0.0, le=1.0)
    zoom: float = Field(default=1.0, ge=1.0, le=2.5)
    source_crop_box: NormalizedBox | None = None

    @model_validator(mode="after")
    def _check_bounds(self) -> FramingSegment:
        if self.timeline_end_ms <= self.timeline_start_ms:
            raise ValueError("timelineEndMs must be greater than timelineStartMs.")
        return self


class VideoTrack(EdlModel):
    cold_open: ColdOpenBlock | None = None
    clips: list[VideoSlice] = Field(min_length=1)
    framing: list[FramingSegment] = Field(min_length=1)


class BgmTrack(EdlModel):
    asset_id: str = Field(min_length=1)
    gain_db: float = Field(default=-16.0, ge=-48.0, le=12.0)
    ducking_enabled: bool = True
    start_offset_ms: int = Field(default=0, ge=0)
    fade_in_ms: int = Field(default=500, ge=0, le=5000)
    fade_out_ms: int = Field(default=1000, ge=0, le=5000)


class AudioTrack(EdlModel):
    gain_db: float = Field(default=0.0, ge=-24.0, le=24.0)
    normalize_lufs: float = Field(default=-14.0, ge=-36.0, le=-5.0)
    dialogue_enhance: bool = False
    mute_original: bool = False
    bgm: BgmTrack | None = None


class SubtitleStyle(EdlModel):
    preset: SubtitlePresetLiteral = "bold_pop"
    reveal_mode: Literal["group", "progressive", "single_word"] = "progressive"
    font: str = Field(default="Montserrat-ExtraBold", min_length=1)
    font_size_scale: float = Field(default=1.0, ge=0.5, le=2.0)
    primary_color: str = Field(default="#FFFFFF", pattern=r"^#[0-9A-Fa-f]{6}$")
    accent_color: str = Field(default="#FFE500", pattern=r"^#[0-9A-Fa-f]{6}$")
    outline_color: str = Field(default="#000000", pattern=r"^#[0-9A-Fa-f]{6}$")
    letter_spacing: float = Field(default=0.0, ge=0.0, le=12.0)
    color_palette: list[str] = Field(default_factory=list)


class SubtitleWord(EdlModel):
    id: str = Field(min_length=1)
    text: str = Field(min_length=1)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=1)
    speaker: str | None = None
    glow_color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")

    @model_validator(mode="after")
    def _check_bounds(self) -> SubtitleWord:
        if self.end_ms <= self.start_ms:
            raise ValueError("Word endMs must be greater than startMs.")
        return self


class SubtitleTrack(EdlModel):
    enabled: bool = True
    style: SubtitleStyle = Field(default_factory=SubtitleStyle)
    censor_profanity: bool = True
    margin_v_ratio: float = Field(default=0.22, ge=0.05, le=0.85)
    mute_ranges: list[tuple[int, int]] = Field(default_factory=list)
    words: list[SubtitleWord] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_mute_ranges(self) -> SubtitleTrack:
        for start, end in self.mute_ranges:
            if start < 0 or end <= start:
                raise ValueError(f"Invalid subtitle mute range [{start}, {end}].")
        return self


class OverlayItem(EdlModel):
    id: str = Field(min_length=1)
    kind: OverlayKindLiteral = "seam_card_white"
    text: str = ""
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=1)
    y_anchor: Literal["split_seam", "top", "bottom"] = "split_seam"
    y_offset_ratio: float = Field(default=0.0, ge=-0.5, le=0.5)
    x_offset_ratio: float = Field(default=0.0, ge=-0.5, le=0.5)
    opacity: float = Field(default=1.0, ge=0.1, le=1.0)
    max_lines: int = Field(default=2, ge=1, le=4)

    @model_validator(mode="after")
    def _check_bounds(self) -> OverlayItem:
        if self.end_ms <= self.start_ms:
            raise ValueError("Overlay endMs must be greater than startMs.")
        return self


class TimelineTracks(EdlModel):
    video: VideoTrack
    audio: AudioTrack = Field(default_factory=AudioTrack)
    subtitles: SubtitleTrack = Field(default_factory=SubtitleTrack)
    overlays: list[OverlayItem] = Field(default_factory=list)


class TimelineProject(EdlModel):
    schema_version: Literal[1] = 1
    project_id: str = Field(min_length=1)
    source_id: str = Field(min_length=1)
    profile_id: str | None = None
    title: str = ""
    status: Literal["draft", "approved", "exported", "posted", "archived"] = "draft"
    source_duration_ms: int = Field(default=0, ge=0)
    source_width: int = Field(default=1920, ge=2)
    source_height: int = Field(default=1080, ge=2)
    output: OutputSpec = Field(default_factory=OutputSpec)
    tracks: TimelineTracks

    def to_canonical_dict(self) -> dict:
        """Serialize to canonical camelCase EDL JSON matching ``timeline.v1.schema.json``."""
        return self.model_dump(by_alias=True, mode="json")
