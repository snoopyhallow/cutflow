"""Multi-source Theme Mashup compiler (Clip 1 style multi-movie/multi-VOD compilations)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .. import config, paths
from ..ai.edl_builder import CINEMA_NEON_PALETTE
from ..audio.bgm import select_bgm_track_for_profile
from ..db import ClipProjectRow, JobRow, SourceRow, get_session
from ..db.models import new_id
from ..edl import TimelineMapper, TimelineProject
from ..edl.schema import (
    AudioTrack,
    FramingSegment,
    OutputSpec,
    OverlayItem,
    SubtitleStyle,
    SubtitleTrack,
    SubtitleWord,
    TimelineTracks,
    TransitionKindLiteral,
    TransitionSfxLiteral,
    VideoSlice,
    VideoTrack,
)
from . import profiles as profile_store


def create_mashup_project(
    project_ids: list[str],
    *,
    title: str = "Theme Mashup",
    pov_hook: str = "",
    profile_id: str | None = None,
    transition_style: TransitionKindLiteral = "flash_white",
    transition_sfx: TransitionSfxLiteral = "whoosh_flash",
    max_slice_duration_ms: int = 35_000,
) -> dict[str, Any]:
    """Stitch multiple ClipProjects (even across different movie/VOD sources) into one EDL."""
    unique_ids = [pid for pid in dict.fromkeys(project_ids) if pid.strip()]
    if len(unique_ids) < 2:
        raise ValueError("Select at least 2 clips to compile a mashup.")

    cfg = config.load()
    loaded: list[tuple[ClipProjectRow, TimelineProject]] = []
    with get_session() as session:
        for pid in unique_ids:
            row = session.get(ClipProjectRow, pid)
            if row is None:
                raise KeyError(f"Clip project {pid!r} not found.")
            loaded.append((row, TimelineProject.model_validate(row.edl_json)))

        primary_row, primary_edl = loaded[0]
        primary_source = session.get(SourceRow, primary_row.source_id)
        primary_job_id = primary_row.job_id
        resolved_profile_id = profile_id or primary_edl.profile_id

    profile = (
        profile_store.get_profile(resolved_profile_id)
        if resolved_profile_id
        else None
    ) or profile_store.list_profiles()[0]

    mashup_id = new_id("clip")
    mashup_slices: list[VideoSlice] = []
    mashup_framing: list[FramingSegment] = []
    mashup_words: list[SubtitleWord] = []
    cursor_ms = 0

    for idx, (row, sub_edl) in enumerate(loaded, start=1):
        sub_cold = (
            sub_edl.tracks.video.cold_open.duration_ms
            if (sub_edl.tracks.video.cold_open and sub_edl.tracks.video.cold_open.enabled)
            else 0
        )
        src_clip = sub_edl.tracks.video.clips[0]
        dur_ms = min(max_slice_duration_ms, src_clip.duration_ms)
        if dur_ms < 500:
            continue

        t_in: TransitionKindLiteral = "none" if idx == 1 else transition_style
        t_sfx: TransitionSfxLiteral = "none" if idx == 1 else transition_sfx

        mashup_slices.append(
            VideoSlice(
                id=f"m{idx}",
                source_start_ms=src_clip.source_start_ms,
                source_end_ms=src_clip.source_start_ms + dur_ms,
                source_id=src_clip.source_id or row.source_id,
                label=(row.title or f"Clip {idx}")[:42],
                transition_in=t_in,
                transition_duration_ms=220 if t_in == "flash_white" else 260,
                transition_sfx=t_sfx,
            )
        )

        # Carry over the source clip's framing segment onto [cursor_ms, cursor_ms + dur_ms]
        base_f = sub_edl.tracks.video.framing[0]
        mashup_framing.append(
            base_f.model_copy(
                update={
                    "id": f"mf{idx}",
                    "timeline_start_ms": cursor_ms,
                    "timeline_end_ms": cursor_ms + dur_ms,
                }
            )
        )

        # Shift words belonging to [sub_cold, sub_cold + dur_ms] onto mashup timeline
        for w in sub_edl.tracks.subtitles.words:
            rel_s = w.start_ms - sub_cold
            rel_e = w.end_ms - sub_cold
            if rel_e <= 0 or rel_s >= dur_ms:
                continue
            ws = cursor_ms + max(0, rel_s)
            we = cursor_ms + min(dur_ms, max(rel_s + 60, rel_e))
            if we > ws:
                mashup_words.append(
                    SubtitleWord(
                        id=f"mw{len(mashup_words) + 1}",
                        text=w.text,
                        start_ms=ws,
                        end_ms=we,
                        speaker=w.speaker,
                        glow_color=w.glow_color,
                    )
                )

        cursor_ms += dur_ms

    if len(mashup_slices) < 2:
        raise ValueError("Not enough valid video slices to build mashup.")

    total_ms = cursor_ms
    mashup_framing[0].timeline_start_ms = 0
    mashup_framing[-1].timeline_end_ms = total_ms

    overlays: list[OverlayItem] = []
    hook_txt = (pov_hook or title).strip()
    if hook_txt:
        if not hook_txt.upper().startswith("POV:"):
            hook_txt = f"POV: {hook_txt}"
        overlays.append(
            OverlayItem(
                id="ov_pov",
                kind="pov_top_bar",
                text=hook_txt.upper()[:72],
                start_ms=0,
                end_ms=min(total_ms, 3600),
                y_anchor="top",
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
                end_ms=total_ms,
                y_anchor="bottom",
                y_offset_ratio=0.06,
                opacity=profile.watermark_opacity,
                max_lines=1,
            )
        )

    is_cinema = profile.content_mode == "cinema"
    preset = (
        profile.caption_style
        if profile.caption_style != "bold_pop" or not is_cinema
        else "cinema_neon_glow"
    )

    out_ratio = (
        profile.default_ratio if (profile.default_ratio != "9:16" or not is_cinema) else "1:1"
    )
    out_border = (
        "thin_rounded" if (is_cinema and profile.border_style == "none") else profile.border_style
    )
    out_grade = (
        "crisp_hd" if (is_cinema and profile.cinema_grade == "off") else profile.cinema_grade
    )
    out_margin = (
        0.40 if preset in ("cinema_neon_glow", "viral_punch_glow") else profile.margin_v_ratio
    )

    edl = TimelineProject(
        schema_version=1,
        project_id=mashup_id,
        source_id=primary_row.source_id,
        profile_id=profile.id,
        title=title.strip()[:160] or "Theme Mashup",
        status="draft",
        source_duration_ms=primary_source.duration_ms if primary_source else total_ms,
        source_width=(primary_source.width if primary_source else None) or 1920,
        source_height=(primary_source.height if primary_source else None) or 1080,
        output=OutputSpec(
            ratio=out_ratio,
            quality="1080p",
            speed_preset="final",
            fps=60,
            loudness_lufs=cfg.export.loudness_lufs,
            border_style=out_border,
            cinema_grade=out_grade,
        ),
        tracks=TimelineTracks(
            video=VideoTrack(
                cold_open=None,
                clips=mashup_slices,
                framing=mashup_framing,
            ),
            audio=AudioTrack(
                gain_db=0.0,
                normalize_lufs=cfg.export.loudness_lufs,
                dialogue_enhance=profile.dialogue_enhance or is_cinema,
                bgm=select_bgm_track_for_profile(profile),
            ),
            subtitles=SubtitleTrack(
                enabled=profile.burn_captions,
                style=SubtitleStyle(
                    preset=preset,  # type: ignore[arg-type]
                    reveal_mode=profile.reveal_mode,
                    font="Montserrat-ExtraBold",
                    font_size_scale=1.0,
                    primary_color="#FFFFFF",
                    accent_color="#4F7CFF" if preset == "cinema_neon_glow" else "#FFE500",
                    outline_color="#000000",
                    letter_spacing=3.5 if preset == "cinema_neon_glow" else 0.5,
                    color_palette=list(CINEMA_NEON_PALETTE) if preset == "cinema_neon_glow" else [],
                ),
                censor_profanity=profile.censor_profanity,
                margin_v_ratio=out_margin,
                mute_ranges=[],
                words=mashup_words,
            ),
            overlays=overlays,
        ),
    )

    # Reuse primary clip's proxy/peaks for quick browser preview
    proxy_path = primary_row.proxy_path or ""
    peaks_path = primary_row.peaks_path or ""
    if proxy_path and Path(proxy_path).is_file():
        clip_dir = paths.work_dir() / primary_row.source_id / "clips" / mashup_id
        clip_dir.mkdir(parents=True, exist_ok=True)
        src_thumb = Path(proxy_path).parent / "thumb.jpg"
        if src_thumb.is_file():
            (clip_dir / "thumb.jpg").write_bytes(src_thumb.read_bytes())

    with get_session() as session:
        row = ClipProjectRow(
            id=mashup_id,
            job_id=primary_job_id,
            source_id=primary_row.source_id,
            rank=1,
            score=95,
            title=edl.title,
            reason=f"Compiled {len(mashup_slices)}-scene mashup ({transition_style}).",
            status="draft",
            proxy_path=proxy_path,
            peaks_path=peaks_path,
            edl_json=edl.to_canonical_dict(),
        )
        session.add(row)
        session.flush()
        # Store per-clip slice origin map on the job if needed
        job = session.get(JobRow, primary_job_id)
        if job is not None:
            settings = dict(job.settings_json or {})
            origins = dict(settings.get("sliceOriginByProject") or {})
            origins[mashup_id] = int(origins.get(primary_row.id, 0))
            settings["sliceOriginByProject"] = origins
            job.settings_json = settings

        return {
            "id": row.id,
            "jobId": row.job_id,
            "sourceId": row.source_id,
            "title": row.title,
            "totalDurationMs": TimelineMapper(edl).total_duration_ms,
            "sliceCount": len(mashup_slices),
            "wordCount": len(mashup_words),
            "edl": edl.to_canonical_dict(),
        }
