"""Build canonical TimelineProject EDL v1 drafts from discovered highlights & aligned words."""

from __future__ import annotations

from ..audio.align import WordTiming
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
    VideoSlice,
    VideoTrack,
)
from ..workspace.profiles import CreatorProfile
from .highlights import HighlightCandidate

_VALID_PRESETS = {"bold_pop", "karaoke_fill", "clean_lower", "boxed"}
_VALID_REVEAL = {"group", "progressive", "single_word"}


def build_clip_edl(
    *,
    project_id: str,
    source_id: str,
    media: MediaInfo,
    profile: CreatorProfile,
    candidate: HighlightCandidate,
    aligned_clip_words: list[WordTiming],
    cam_box: NormalizedBox | None = None,
    loudness_lufs: float = -14.0,
) -> TimelineProject:
    """Assemble a schema-valid EDL v1 document with output-relative word & overlay timings."""
    clip_start = max(0, int(candidate.start_ms))
    max_end = media.duration_ms or candidate.end_ms
    clip_end = max(clip_start + 500, min(max_end, int(candidate.end_ms)))
    body_dur = clip_end - clip_start

    cold_open: ColdOpenBlock | None = None
    cold_open_ms = 0
    if profile.cold_open_enabled and body_dur >= 8000:
        co_dur = max(500, min(4000, int(profile.cold_open_duration_ms)))
        co_src = candidate.cold_open_source_ms
        if co_src is None:
            co_src = clip_start + int(body_dur * 0.65)
        co_src = max(clip_start, min(clip_end - co_dur, co_src))
        cold_open = ColdOpenBlock(
            enabled=True,
            source_start_ms=co_src,
            duration_ms=co_dur,
            fade_out_ms=120,
        )
        cold_open_ms = co_dur

    total_duration_ms = cold_open_ms + body_dur

    # Framing mode: split when cam_box present (or explicitly split), otherwise fit/centre/crop
    if cam_box is not None:
        framing_mode = "split"
    elif profile.layout_mode in ("fit", "centre", "crop"):
        framing_mode = profile.layout_mode
    else:
        framing_mode = "fit"

    framing = [
        FramingSegment(
            id="f1",
            timeline_start_ms=0,
            timeline_end_ms=total_duration_ms,
            mode=framing_mode,  # type: ignore[arg-type]
            split_ratio=max(0.20, min(0.65, float(profile.split_ratio))),
            cam_box=cam_box,
            game_box=None,
        )
    ]

    # Map clip-relative aligned words into output timelineMs (offset by cold_open_ms)
    subtitle_words: list[SubtitleWord] = []
    for idx, w in enumerate(aligned_clip_words, start=1):
        s_ms = cold_open_ms + max(0, int(w.start_ms))
        e_ms = min(total_duration_ms, cold_open_ms + max(w.start_ms + 60, int(w.end_ms)))
        if e_ms <= s_ms or s_ms >= total_duration_ms:
            continue
        subtitle_words.append(
            SubtitleWord(
                id=f"w{idx}",
                text=w.text,
                start_ms=s_ms,
                end_ms=e_ms,
                speaker=w.speaker,
            )
        )

    preset = profile.caption_style if profile.caption_style in _VALID_PRESETS else "bold_pop"
    reveal = profile.reveal_mode if profile.reveal_mode in _VALID_REVEAL else "progressive"

    overlays: list[OverlayItem] = []
    if profile.title_card_style != "off" and candidate.seam_title.strip():
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
            ratio="9:16",
            quality="1080p",
            speed_preset="final",
            fps=fps,
            loudness_lufs=loudness_lufs,
        ),
        tracks=TimelineTracks(
            video=VideoTrack(
                cold_open=cold_open,
                clips=[
                    VideoSlice(
                        id="v1",
                        source_start_ms=clip_start,
                        source_end_ms=clip_end,
                    )
                ],
                framing=framing,
            ),
            audio=AudioTrack(gain_db=0.0, normalize_lufs=loudness_lufs, bgm=None),
            subtitles=SubtitleTrack(
                enabled=profile.burn_captions,
                style=SubtitleStyle(
                    preset=preset,  # type: ignore[arg-type]
                    reveal_mode=reveal,  # type: ignore[arg-type]
                    font="Montserrat-ExtraBold",
                    font_size_scale=1.0,
                    primary_color="#FFFFFF",
                    accent_color="#FFE500",
                    outline_color="#000000",
                ),
                censor_profanity=profile.censor_profanity,
                margin_v_ratio=0.22,
                mute_ranges=[],
                words=subtitle_words,
            ),
            overlays=overlays,
        ),
    )
