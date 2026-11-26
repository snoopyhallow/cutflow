"""Build canonical TimelineProject EDL v1 drafts with zero-touch arcs, transitions & styling."""

from __future__ import annotations

import re

from ..audio.align import WordTiming
from ..audio.bgm import select_bgm_track_for_profile
from ..audio.media import MediaInfo
from ..edl.schema import (
    AudioTrack,
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
    TransitionKindLiteral,
    TransitionSfxLiteral,
    VideoSlice,
    VideoTrack,
)
from ..workspace.profiles import CreatorProfile
from .highlights import HighlightCandidate

_VALID_PRESETS = {
    "bold_pop",
    "karaoke_fill",
    "clean_lower",
    "boxed",
    "cinema_neon_glow",
    "viral_punch_glow",
}
_VALID_REVEAL = {"group", "progressive", "single_word"}

CINEMA_NEON_PALETTE: list[str] = [
    "#4F7CFF",  # Electric Royal Blue (JJ_EDIT signature)
    "#4ADE80",  # Cinema Emerald Neon
    "#FBBF24",  # Warm Amber Gold
    "#F472B6",  # Neon Rose Magenta
    "#F87171",  # Crimson Glow
]

_NUM_OR_MONEY_RE = re.compile(
    r"(\$?\d[\d,.]*%?|\b(?:million|billion|thousand|hundred|hours?|years?|first|last)\b)",
    re.I,
)
_DANGER_ACTION_RE = re.compile(
    r"\b(steals?|stolen|dead|died|kill(?:ed)?|poison(?:ed)?|arrest|choking|dying"
    r"|blood|devil|gun|crash|win(?:s)?|lost)\b",
    re.I,
)
_HYPE_EMPHASIS_RE = re.compile(
    r"\b(never|always|impossible|insane|crazy|literally|finally|perfect|best|worst|really|stop|wait)\b",
    re.I,
)


def infer_word_glow_color(word_text: str) -> str | None:
    """Assign semantic neon punch-word glow colors automatically (MrBeast Shorts style)."""
    cleaned = word_text.strip()
    if not cleaned:
        return None
    if _DANGER_ACTION_RE.search(cleaned):
        return "#F87171"  # Coral Red
    if _NUM_OR_MONEY_RE.search(cleaned):
        return "#4ADE80"  # Neon Green
    if cleaned.endswith(("?", "!")) or _HYPE_EMPHASIS_RE.search(cleaned):
        return "#FBBF24"  # Electric Gold
    if len(re.sub(r"\W+", "", cleaned)) >= 8 and cleaned.isupper():
        return "#C084FC"  # Violet Glow
    return None


def _resolve_slice_transitions(
    profile: CreatorProfile,
    gap_ms: int,
) -> tuple[TransitionKindLiteral, TransitionSfxLiteral]:
    if profile.transition_style != "none":
        t_kind: TransitionKindLiteral = profile.transition_style
    elif gap_ms >= 1500:
        t_kind = "dip_black" if profile.content_mode == "cinema" else "flash_white"
    else:
        t_kind = "none"

    if profile.transition_sfx != "none":
        t_sfx: TransitionSfxLiteral = profile.transition_sfx
    elif t_kind == "flash_white":
        t_sfx = "whoosh_flash"
    elif t_kind == "dip_black" and profile.content_mode == "cinema":
        t_sfx = "cinema_hit"
    else:
        t_sfx = "none"
    return t_kind, t_sfx


def build_clip_edl(
    *,
    project_id: str,
    source_id: str,
    media: MediaInfo,
    profile: CreatorProfile,
    candidate: HighlightCandidate,
    aligned_clip_words: list[WordTiming],
    cam_box: NormalizedBox | None = None,
    source_crop_box: NormalizedBox | None = None,
    precomputed_framing: list[FramingSegment] | None = None,
    source_title: str = "",
    loudness_lufs: float = -14.0,
) -> TimelineProject:
    """Assemble a schema-valid EDL v1 document with zero-touch arcs, transitions & styling."""
    max_end = media.duration_ms or candidate.end_ms

    # 1. Assemble single VideoSlice or Multi-Slice Story Arc (up to 180s+)
    video_slices: list[VideoSlice] = []
    if candidate.slices and len(candidate.slices) >= 2:
        prev_end: int | None = None
        for idx, (raw_s, raw_e) in enumerate(candidate.slices, start=1):
            s0 = max(0, int(raw_s))
            e0 = max(s0 + 500, min(max_end, int(raw_e)))
            if idx == 1:
                t_in: TransitionKindLiteral = "none"
                t_sfx: TransitionSfxLiteral = "none"
            else:
                gap = max(0, s0 - (prev_end or s0))
                t_in, t_sfx = _resolve_slice_transitions(profile, gap)
            video_slices.append(
                VideoSlice(
                    id=f"v{idx}",
                    source_start_ms=s0,
                    source_end_ms=e0,
                    label=f"Scene {idx}",
                    transition_in=t_in,
                    transition_duration_ms=220 if t_in == "flash_white" else 280,
                    transition_sfx=t_sfx,
                )
            )
            prev_end = e0
    else:
        clip_start = max(0, int(candidate.start_ms))
        clip_end = max(clip_start + 500, min(max_end, int(candidate.end_ms)))
        video_slices.append(
            VideoSlice(
                id="v1",
                source_start_ms=clip_start,
                source_end_ms=clip_end,
                label="Scene 1",
            )
        )

    body_dur = sum(sl.duration_ms for sl in video_slices)
    first_start = video_slices[0].source_start_ms
    last_end = video_slices[-1].source_end_ms

    # 2. Optional Cold-Open Flash-Forward (disabled automatically on Cinema profiles)
    cold_open: ColdOpenBlock | None = None
    cold_open_ms = 0
    if profile.cold_open_enabled and profile.content_mode != "cinema" and body_dur >= 8000:
        co_dur = max(500, min(4000, int(profile.cold_open_duration_ms)))
        co_src = candidate.cold_open_source_ms
        if co_src is None:
            co_src = first_start + int((last_end - first_start) * 0.65)
        co_src = max(first_start, min(last_end - co_dur, co_src))
        cold_open = ColdOpenBlock(
            enabled=True,
            source_start_ms=co_src,
            duration_ms=co_dur,
            fade_out_ms=120,
        )
        cold_open_ms = co_dur

    total_duration_ms = cold_open_ms + body_dur

    # 3. Framing keyframes (uses per-shot face-tracked keyframes when provided)
    effective_cam = cam_box or profile.cam_box
    if precomputed_framing:
        framing = precomputed_framing
    else:
        if profile.layout_mode in ("split", "auto_split") and effective_cam is not None:
            framing_mode = "split"
        elif profile.layout_mode == "split" and effective_cam is None:
            effective_cam = NormalizedBox(x=0.02, y=0.28, w=0.24, h=0.26)
            framing_mode = "split"
        elif profile.layout_mode == "auto_reframe":
            framing_mode = "crop" if profile.content_mode == "cinema" else "centre"
            effective_cam = None
        elif profile.layout_mode in ("fit", "centre", "crop"):
            framing_mode = profile.layout_mode
            effective_cam = None
        else:
            framing_mode = "fit"
            effective_cam = None

        is_cinema_crop = profile.content_mode == "cinema" and framing_mode in ("centre", "crop")
        default_zoom = 1.14 if is_cinema_crop else 1.0
        framing = [
            FramingSegment(
                id="f1",
                timeline_start_ms=0,
                timeline_end_ms=total_duration_ms,
                mode=framing_mode,  # type: ignore[arg-type]
                split_ratio=max(0.20, min(0.65, float(profile.split_ratio))),
                cam_box=effective_cam,
                game_box=None,
                fit_backdrop=profile.fit_backdrop,
                pan_x=0.5,
                pan_y=0.45 if default_zoom > 1.0 else 0.5,
                zoom=default_zoom,
                source_crop_box=source_crop_box,
            )
        ]

    # 4. Subtitle styling + automatic semantic punch-word / neon palette configuration
    preset = profile.caption_style if profile.caption_style in _VALID_PRESETS else "bold_pop"
    reveal = profile.reveal_mode if profile.reveal_mode in _VALID_REVEAL else "progressive"
    is_punch_glow = preset == "viral_punch_glow"
    is_cinema_glow = preset == "cinema_neon_glow"

    subtitle_words: list[SubtitleWord] = []
    for idx, w in enumerate(aligned_clip_words, start=1):
        s_ms = cold_open_ms + max(0, int(w.start_ms))
        e_ms = min(total_duration_ms, cold_open_ms + max(w.start_ms + 60, int(w.end_ms)))
        if e_ms <= s_ms or s_ms >= total_duration_ms:
            continue
        glow = infer_word_glow_color(w.text) if is_punch_glow else None
        subtitle_words.append(
            SubtitleWord(
                id=f"w{idx}",
                text=w.text,
                start_ms=s_ms,
                end_ms=e_ms,
                speaker=w.speaker,
                glow_color=glow,
            )
        )

    # 5. Zero-touch Overlays: POV top bar / Seam card + Persistent Watermark + Cinema Credit
    overlays: list[OverlayItem] = []
    if profile.title_card_style == "pov_top_bar":
        pov_text = (candidate.pov_hook or candidate.seam_title or candidate.title).strip()
        if pov_text and not pov_text.upper().startswith("POV:"):
            pov_text = f"POV: {pov_text}"
        if pov_text:
            overlays.append(
                OverlayItem(
                    id="ov_pov",
                    kind="pov_top_bar",
                    text=pov_text.upper()[:72],
                    start_ms=0,
                    end_ms=min(total_duration_ms, 3600),
                    y_anchor="top",
                    y_offset_ratio=0.0,
                    max_lines=2,
                )
            )
    elif profile.title_card_style != "off" and candidate.seam_title.strip():
        kind = (
            "hook_banner_dark"
            if profile.title_card_style == "hook_banner_dark"
            else "seam_card_white"
        )
        overlays.append(
            OverlayItem(
                id="ov1",
                kind=kind,  # type: ignore[arg-type]
                text=candidate.seam_title.strip(),
                start_ms=0,
                end_ms=total_duration_ms,
                y_anchor="split_seam" if kind == "seam_card_white" else "top",
                y_offset_ratio=0.0,
                max_lines=2,
            )
        )

    if profile.watermark_text.strip():
        overlays.append(
            OverlayItem(
                id="ov_wm",
                kind="watermark_tag",
                text=profile.watermark_text.strip()[:36],
                start_ms=0,
                end_ms=total_duration_ms,
                y_anchor="bottom",
                y_offset_ratio=0.06,
                x_offset_ratio=0.0,
                opacity=profile.watermark_opacity,
                max_lines=1,
            )
        )

    if profile.show_cinema_credit and source_title.strip():
        overlays.append(
            OverlayItem(
                id="ov_credit",
                kind="cinema_credit",
                text=source_title.strip()[:60],
                start_ms=0,
                end_ms=min(total_duration_ms, 5000),
                y_anchor="bottom",
                y_offset_ratio=-0.04,
                opacity=0.88,
                max_lines=1,
            )
        )

    if profile.cta_mode != "off" and profile.cta_text.strip():
        cta_start = max(0, total_duration_ms - 3500)
        overlays.append(
            OverlayItem(
                id="ov_cta",
                kind="cta_pill",
                text=profile.cta_text.strip(),
                start_ms=cta_start,
                end_ms=total_duration_ms,
                y_anchor="bottom",
                y_offset_ratio=0.0,
                max_lines=1,
            )
        )

    fps = max(15, min(120, int(round(media.fps or 30.0))))

    return TimelineProject(
        schema_version=1,
        project_id=project_id,
        source_id=source_id,
        profile_id=profile.id,
        title=candidate.title,
        status="draft",
        source_duration_ms=media.duration_ms,
        source_width=media.width,
        source_height=media.height,
        output=OutputSpec(
            ratio=profile.default_ratio,
            quality="1080p",
            speed_preset="final",
            fps=fps,
            loudness_lufs=loudness_lufs,
            border_style=profile.border_style,
            cinema_grade=profile.cinema_grade,
        ),
        tracks=TimelineTracks(
            video=VideoTrack(
                cold_open=cold_open,
                clips=video_slices,
                framing=framing,
            ),
            audio=AudioTrack(
                gain_db=0.0,
                normalize_lufs=loudness_lufs,
                dialogue_enhance=profile.dialogue_enhance,
                mute_original=False,
                bgm=select_bgm_track_for_profile(profile, mood_hint=candidate.mood),
            ),
            subtitles=SubtitleTrack(
                enabled=profile.burn_captions,
                style=SubtitleStyle(
                    preset=preset,  # type: ignore[arg-type]
                    reveal_mode=reveal,  # type: ignore[arg-type]
                    font="Montserrat-ExtraBold",
                    font_size_scale=1.0,
                    primary_color="#FFFFFF",
                    accent_color="#4F7CFF" if is_cinema_glow else "#FFE500",
                    outline_color="#000000",
                    letter_spacing=3.5 if is_cinema_glow else 0.5,
                    color_palette=list(CINEMA_NEON_PALETTE) if is_cinema_glow else [],
                ),
                censor_profanity=profile.censor_profanity,
                margin_v_ratio=profile.margin_v_ratio,
                mute_ranges=[],
                words=subtitle_words,
            ),
            overlays=overlays,
        ),
    )
