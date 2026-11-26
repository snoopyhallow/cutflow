"""Pure deterministic EDL operations: TimelineMapper, blade cuts, rolling word edits, patches."""

from __future__ import annotations

import uuid
from typing import Any

from .schema import (
    BgmTrack,
    ColdOpenBlock,
    FramingSegment,
    NormalizedBox,
    OverlayItem,
    SubtitleWord,
    TimelineProject,
    VideoSlice,
)

MIN_WORD_MS = 60
MIN_SLICE_MS = 100


class TimelineMapper:
    """Maps between output ``timelineMs`` and original ``sourceMs`` across cuts."""

    def __init__(self, edl: TimelineProject) -> None:
        self.edl = edl
        co = edl.tracks.video.cold_open
        self.cold_open_ms: int = co.duration_ms if (co is not None and co.enabled) else 0
        self._spans: list[tuple[int, int, VideoSlice]] = []
        cursor = self.cold_open_ms
        for clip in edl.tracks.video.clips:
            end = cursor + clip.duration_ms
            self._spans.append((cursor, end, clip))
            cursor = end
        self.total_duration_ms: int = cursor

    def timeline_to_source(self, timeline_ms: int) -> tuple[bool, int]:
        """Return ``(is_cold_open, source_ms)`` for any output timeline timestamp."""
        t = max(0, min(self.total_duration_ms, int(timeline_ms)))
        co = self.edl.tracks.video.cold_open
        if co is not None and co.enabled and t < self.cold_open_ms:
            return True, co.source_start_ms + t
        for t_start, t_end, clip in self._spans:
            if t_start <= t <= t_end:
                return False, clip.source_start_ms + (t - t_start)
        last = self._spans[-1][2]
        return False, last.source_end_ms

    def source_to_timeline(self, source_ms: int) -> int | None:
        """Map a main-body source timestamp to output timeline ms, or None if blade-cut out."""
        for t_start, _, clip in self._spans:
            if clip.source_start_ms <= source_ms <= clip.source_end_ms:
                return t_start + (source_ms - clip.source_start_ms)
        return None


def _shift_interval(
    start_ms: int, end_ms: int, cut_start_ms: int, cut_end_ms: int
) -> tuple[int, int] | None:
    """Adjust ``[start_ms, end_ms]`` when ``[cut_start_ms, cut_end_ms]`` is deleted."""
    removed = cut_end_ms - cut_start_ms
    if end_ms <= cut_start_ms:
        return start_ms, end_ms
    if start_ms >= cut_end_ms:
        return start_ms - removed, end_ms - removed
    if start_ms >= cut_start_ms and end_ms <= cut_end_ms:
        return None  # Entirely inside the cut region.
    new_start = min(start_ms, cut_start_ms)
    new_end = (end_ms - removed) if end_ms > cut_end_ms else cut_start_ms
    return (new_start, new_end) if new_end > new_start else None


def apply_blade_cut(
    edl: TimelineProject, cut_start_ms: int, cut_end_ms: int
) -> TimelineProject:
    """Non-destructively delete ``[cut_start_ms, cut_end_ms]`` from the main video track.

    Deterministically splits/removes covered video slices and ripples all
    downstream framing segments, subtitle words, mute ranges, and overlays.
    """
    mapper = TimelineMapper(edl)
    body_start = mapper.cold_open_ms
    c_start = max(body_start, int(cut_start_ms))
    c_end = min(mapper.total_duration_ms, int(cut_end_ms))
    if c_end - c_start < MIN_SLICE_MS:
        raise ValueError("Blade cut must remove at least 100ms inside the main clip body.")
    if (mapper.total_duration_ms - body_start) - (c_end - c_start) < MIN_SLICE_MS:
        raise ValueError("Cannot delete the entire clip; at least 100ms must remain.")

    next_edl = edl.model_copy(deep=True)
    new_clips: list[VideoSlice] = []
    cursor = body_start
    for clip in next_edl.tracks.video.clips:
        s_t0 = cursor
        s_t1 = cursor + clip.duration_ms
        cursor = s_t1

        if s_t1 <= c_start or s_t0 >= c_end:
            new_clips.append(clip)
            continue

        # Left surviving portion before cut (preserves source_id, label, and incoming transition)
        if s_t0 < c_start:
            left_dur = c_start - s_t0
            if left_dur >= MIN_SLICE_MS:
                new_clips.append(
                    clip.model_copy(
                        update={
                            "source_end_ms": clip.source_start_ms + left_dur,
                        }
                    )
                )
        # Right surviving portion after cut (preserves source_id, clean hard cut across deleted gap)
        if s_t1 > c_end:
            right_offset = c_end - s_t0
            right_dur = s_t1 - c_end
            if right_dur >= MIN_SLICE_MS:
                new_clips.append(
                    clip.model_copy(
                        update={
                            "id": f"{clip.id}_{uuid.uuid4().hex[:4]}",
                            "source_start_ms": clip.source_start_ms + right_offset,
                            "transition_in": "none",
                            "transition_sfx": "none",
                        }
                    )
                )

    if not new_clips:
        raise ValueError("Blade cut produced zero remaining video slices.")

    next_edl.tracks.video.clips = new_clips
    new_total = TimelineMapper(next_edl).total_duration_ms

    # Ripple framing segments
    new_framing: list[FramingSegment] = []
    for seg in next_edl.tracks.video.framing:
        shifted = _shift_interval(seg.timeline_start_ms, seg.timeline_end_ms, c_start, c_end)
        if shifted is not None:
            new_framing.append(
                seg.model_copy(
                    update={"timeline_start_ms": shifted[0], "timeline_end_ms": shifted[1]}
                )
            )
    if new_framing:
        new_framing[0].timeline_start_ms = 0
        new_framing[-1].timeline_end_ms = new_total
        for i in range(len(new_framing) - 1):
            new_framing[i].timeline_end_ms = new_framing[i + 1].timeline_start_ms
        next_edl.tracks.video.framing = [
            f for f in new_framing if f.timeline_end_ms > f.timeline_start_ms
        ]

    # Ripple subtitle words & mute ranges
    new_words: list[SubtitleWord] = []
    for word in next_edl.tracks.subtitles.words:
        shifted = _shift_interval(word.start_ms, word.end_ms, c_start, c_end)
        if shifted is not None and (shifted[1] - shifted[0]) >= MIN_WORD_MS:
            new_words.append(
                word.model_copy(update={"start_ms": shifted[0], "end_ms": shifted[1]})
            )
    next_edl.tracks.subtitles.words = new_words

    new_mutes: list[tuple[int, int]] = []
    for m_start, m_end in next_edl.tracks.subtitles.mute_ranges:
        shifted = _shift_interval(m_start, m_end, c_start, c_end)
        if shifted is not None:
            new_mutes.append(shifted)
    next_edl.tracks.subtitles.mute_ranges = new_mutes

    # Ripple overlays
    new_overlays: list[OverlayItem] = []
    for ov in next_edl.tracks.overlays:
        shifted = _shift_interval(ov.start_ms, ov.end_ms, c_start, c_end)
        if shifted is not None:
            new_overlays.append(
                ov.model_copy(
                    update={
                        "start_ms": shifted[0],
                        "end_ms": min(new_total, shifted[1]),
                    }
                )
            )
    next_edl.tracks.overlays = new_overlays
    return next_edl


def update_word_timing(
    edl: TimelineProject,
    word_id: str,
    start_ms: int,
    end_ms: int,
    *,
    rolling_adjacent: bool = True,
) -> TimelineProject:
    """Adjust one word's time stops with optional Premiere-style rolling edit on neighbours."""
    next_edl = edl.model_copy(deep=True)
    words = next_edl.tracks.subtitles.words
    idx = next((i for i, w in enumerate(words) if w.id == word_id), None)
    if idx is None:
        raise ValueError(f"Word {word_id!r} not found.")

    total_ms = TimelineMapper(next_edl).total_duration_ms
    new_start = max(0, min(total_ms - MIN_WORD_MS, int(start_ms)))
    new_end = max(new_start + MIN_WORD_MS, min(total_ms, int(end_ms)))

    if idx > 0:
        prev = words[idx - 1]
        if new_start < prev.end_ms:
            if rolling_adjacent and new_start >= prev.start_ms + MIN_WORD_MS:
                prev.end_ms = new_start
            else:
                new_start = prev.end_ms
                new_end = max(new_start + MIN_WORD_MS, new_end)

    if idx + 1 < len(words):
        nxt = words[idx + 1]
        if new_end > nxt.start_ms:
            if rolling_adjacent and new_end <= nxt.end_ms - MIN_WORD_MS:
                nxt.start_ms = new_end
            else:
                new_end = max(new_start + MIN_WORD_MS, nxt.start_ms)

    words[idx].start_ms = new_start
    words[idx].end_ms = new_end
    return next_edl


def insert_word(
    edl: TimelineProject,
    text: str,
    start_ms: int,
    duration_ms: int = 800,
    speaker: str | None = None,
) -> TimelineProject:
    """Insert a new word (e.g. missed exclamation like 'SIU!') at ``start_ms``."""
    cleaned = text.strip()
    if not cleaned:
        raise ValueError("Word text cannot be empty.")
    next_edl = edl.model_copy(deep=True)
    total_ms = TimelineMapper(next_edl).total_duration_ms
    s = max(0, min(max(0, total_ms - MIN_WORD_MS), int(start_ms)))
    e = min(total_ms, max(s + MIN_WORD_MS, s + max(MIN_WORD_MS, int(duration_ms))))

    word = SubtitleWord(
        id=f"w_{uuid.uuid4().hex[:8]}",
        text=cleaned,
        start_ms=s,
        end_ms=e,
        speaker=speaker,
    )
    words = sorted([*next_edl.tracks.subtitles.words, word], key=lambda w: (w.start_ms, w.end_ms))
    # Prevent overlap with neighbours while keeping inserted word intact.
    for i in range(1, len(words)):
        if words[i].start_ms < words[i - 1].end_ms:
            if words[i].start_ms > words[i - 1].start_ms + MIN_WORD_MS:
                words[i - 1].end_ms = words[i].start_ms
            else:
                words[i].start_ms = words[i - 1].end_ms
                words[i].end_ms = max(words[i].start_ms + MIN_WORD_MS, words[i].end_ms)
    next_edl.tracks.subtitles.words = words
    return next_edl


def delete_word(edl: TimelineProject, word_id: str) -> TimelineProject:
    next_edl = edl.model_copy(deep=True)
    before = len(next_edl.tracks.subtitles.words)
    next_edl.tracks.subtitles.words = [
        w for w in next_edl.tracks.subtitles.words if w.id != word_id
    ]
    if len(next_edl.tracks.subtitles.words) == before:
        raise ValueError(f"Word {word_id!r} not found.")
    return next_edl


def split_framing_segment(
    edl: TimelineProject,
    split_at_ms: int,
    *,
    right_mode: str | None = None,
) -> TimelineProject:
    """Split the framing segment covering ``split_at_ms`` so layouts can switch mid-clip."""
    t = int(split_at_ms)
    next_edl = edl.model_copy(deep=True)
    out: list[FramingSegment] = []
    did_split = False

    for seg in next_edl.tracks.video.framing:
        if (
            not did_split
            and seg.timeline_start_ms + MIN_SLICE_MS <= t <= seg.timeline_end_ms - MIN_SLICE_MS
        ):
            left = seg.model_copy(update={"timeline_end_ms": t})
            nxt_mode = (
                right_mode
                if right_mode in ("split", "fit", "centre", "crop")
                else seg.mode
            )
            right_cam = (
                seg.cam_box
                or (
                    NormalizedBox(x=0.02, y=0.28, w=0.24, h=0.26)
                    if nxt_mode == "split"
                    else None
                )
            )
            right = seg.model_copy(
                update={
                    "id": f"{seg.id}_{uuid.uuid4().hex[:4]}",
                    "timeline_start_ms": t,
                    "mode": nxt_mode,
                    "cam_box": right_cam,
                }
            )
            out.extend([left, right])
            did_split = True
        else:
            out.append(seg)

    if not did_split:
        raise ValueError("Playhead must be at least 100ms inside an existing framing segment.")
    next_edl.tracks.video.framing = out
    return next_edl


def auto_tighten_silence(
    edl: TimelineProject,
    *,
    rms_100hz: list[float] | None = None,
    rate_hz: int = 100,
    min_gap_ms: int = 1100,
    pad_ms: int = 160,
    rms_threshold: float = 0.09,
) -> tuple[TimelineProject, int, int]:
    """Automatically jump-cut dead-air pauses >= ``min_gap_ms`` inside the main clip body.

    Applies blade cuts from right-to-left so earlier timestamps never drift mid-pass.
    Returns ``(updated_edl, cuts_applied, total_saved_ms)``.
    """
    mapper = TimelineMapper(edl)
    body_start = mapper.cold_open_ms
    total_ms = mapper.total_duration_ms
    if total_ms - body_start < min_gap_ms + 400:
        return edl.model_copy(deep=True), 0, 0

    # Build occupied speech intervals from subtitle words (if present) or RMS energy bursts
    occupied: list[tuple[int, int]] = []
    body_words = [w for w in edl.tracks.subtitles.words if w.end_ms > body_start]
    if body_words:
        for w in sorted(body_words, key=lambda x: x.start_ms):
            s = max(body_start, w.start_ms - pad_ms)
            e = min(total_ms, w.end_ms + pad_ms)
            if occupied and s <= occupied[-1][1]:
                occupied[-1] = (occupied[-1][0], max(occupied[-1][1], e))
            else:
                occupied.append((s, e))
    elif rms_100hz and rate_hz > 0:
        step_ms = 1000.0 / rate_hz
        in_speech = False
        seg_s = body_start
        for idx, val in enumerate(rms_100hz):
            t_ms = body_start + int(round(idx * step_ms))
            if t_ms > total_ms:
                break
            if val >= rms_threshold and not in_speech:
                in_speech = True
                seg_s = max(body_start, t_ms - pad_ms)
            elif val < rms_threshold and in_speech:
                in_speech = False
                seg_e = min(total_ms, t_ms + pad_ms)
                if occupied and seg_s <= occupied[-1][1]:
                    occupied[-1] = (occupied[-1][0], max(occupied[-1][1], seg_e))
                else:
                    occupied.append((seg_s, seg_e))
        if in_speech:
            occupied.append((seg_s, total_ms))

    if not occupied:
        return edl.model_copy(deep=True), 0, 0

    # Collect candidate silent gaps inside [body_start, total_ms]
    gaps: list[tuple[int, int]] = []
    cursor = body_start
    for occ_s, occ_e in occupied:
        if occ_s - cursor >= min_gap_ms:
            # Verify via RMS envelope (when available) that the gap is genuinely quiet
            is_quiet = True
            if rms_100hz and rate_hz > 0:
                i0 = max(0, int(((cursor - body_start) / 1000.0) * rate_hz))
                i1 = min(len(rms_100hz), int(((occ_s - body_start) / 1000.0) * rate_hz))
                if i1 > i0:
                    avg_rms = sum(rms_100hz[i0:i1]) / (i1 - i0)
                    is_quiet = avg_rms < rms_threshold * 1.6
            if is_quiet:
                gaps.append((cursor, occ_s))
        cursor = max(cursor, occ_e)

    if total_ms - cursor >= min_gap_ms:
        gaps.append((cursor, total_ms))

    if not gaps:
        return edl.model_copy(deep=True), 0, 0

    current = edl.model_copy(deep=True)
    cuts = 0
    saved_ms = 0
    for g_start, g_end in reversed(gaps):
        rem = TimelineMapper(current).total_duration_ms - body_start
        if rem - (g_end - g_start) < 1200:
            continue
        current = apply_blade_cut(current, g_start, g_end)
        cuts += 1
        saved_ms += g_end - g_start

    return current, cuts, saved_ms


def apply_edl_patch(
    edl: TimelineProject, ops: list[dict[str, Any]]
) -> tuple[TimelineProject, TimelineProject, list[str]]:
    """Apply typed EDL operations and return ``(next_edl, before_snapshot, summaries)``."""
    before = edl.model_copy(deep=True)
    current = edl.model_copy(deep=True)
    summaries: list[str] = []

    for op in ops:
        kind = str(op.get("op") or "").lower()
        if kind == "blade_cut":
            c_start = int(op["cutStartMs"])
            c_end = int(op["cutEndMs"])
            current = apply_blade_cut(current, c_start, c_end)
            summaries.append(f"Cut {c_start / 1000:.1f}–{c_end / 1000:.1f}s")

        elif kind == "set_subtitles":
            subs = current.tracks.subtitles
            if isinstance(op.get("enabled"), bool):
                subs.enabled = op["enabled"]
                summaries.append(f"Subtitles → {'on' if subs.enabled else 'off'}")
            if isinstance(op.get("censorProfanity"), bool):
                subs.censor_profanity = op["censorProfanity"]
                summaries.append(f"Profanity filter → {'on' if subs.censor_profanity else 'off'}")
            if op.get("revealMode") in ("group", "progressive", "single_word"):
                subs.style.reveal_mode = op["revealMode"]
                summaries.append(f"Reveal mode → {subs.style.reveal_mode}")
            if op.get("preset") in (
                "bold_pop",
                "karaoke_fill",
                "clean_lower",
                "boxed",
                "cinema_neon_glow",
                "viral_punch_glow",
            ):
                subs.style.preset = op["preset"]
                summaries.append(f"Caption preset → {subs.style.preset}")
            if op.get("marginVRatio") is not None:
                subs.margin_v_ratio = max(0.05, min(0.85, float(op["marginVRatio"])))
                summaries.append(f"Caption height → {round(subs.margin_v_ratio * 100)}%")

        elif kind == "insert_word":
            current = insert_word(
                current,
                text=str(op["text"]),
                start_ms=int(op["startMs"]),
                duration_ms=int(op.get("durationMs", 800)),
            )
            summaries.append(f"Inserted '{op['text']}' at {int(op['startMs']) / 1000:.1f}s")

        elif kind == "update_word_timing":
            current = update_word_timing(
                current,
                word_id=str(op["wordId"]),
                start_ms=int(op["startMs"]),
                end_ms=int(op["endMs"]),
            )
            summaries.append(f"Aligned word {op['wordId']}")

        elif kind == "delete_word":
            current = delete_word(current, word_id=str(op["wordId"]))
            summaries.append(f"Deleted word {op['wordId']}")

        elif kind == "set_seam_title":
            text = str(op.get("text") or "").strip()
            total = TimelineMapper(current).total_duration_ms
            existing = next(
                (o for o in current.tracks.overlays if o.kind == "seam_card_white"), None
            )
            if not text:
                current.tracks.overlays = [
                    o for o in current.tracks.overlays if o.kind != "seam_card_white"
                ]
                summaries.append("Removed seam title card")
            elif existing is not None:
                existing.text = text
                summaries.append(f"Seam title → '{text}'")
            else:
                current.tracks.overlays.append(
                    OverlayItem(
                        id=f"ov_{uuid.uuid4().hex[:6]}",
                        kind="seam_card_white",
                        text=text,
                        start_ms=0,
                        end_ms=max(1000, total),
                        y_anchor="split_seam",
                    )
                )
                summaries.append(f"Added seam title '{text}'")

        elif kind == "set_cold_open":
            if op.get("enabled") is False:
                current.tracks.video.cold_open = None
                summaries.append("Cold-open → off")
            else:
                current.tracks.video.cold_open = ColdOpenBlock(
                    enabled=True,
                    source_start_ms=max(0, int(op["sourceStartMs"])),
                    duration_ms=max(500, min(4000, int(op.get("durationMs", 1500)))),
                )
                summaries.append(f"Cold-open → {current.tracks.video.cold_open.duration_ms}ms")

        elif kind == "set_framing":
            seg_idx = int(op.get("segmentIndex", 0))
            segs = current.tracks.video.framing
            seg = segs[max(0, min(len(segs) - 1, seg_idx))]
            if op.get("mode") in ("split", "fit", "centre", "crop"):
                seg.mode = op["mode"]
            if op.get("splitRatio") is not None:
                seg.split_ratio = max(0.20, min(0.65, float(op["splitRatio"])))
            if op.get("panX") is not None:
                seg.pan_x = max(0.0, min(1.0, float(op["panX"])))
            if op.get("panY") is not None:
                seg.pan_y = max(0.0, min(1.0, float(op["panY"])))
            if op.get("zoom") is not None:
                seg.zoom = max(1.0, min(2.5, float(op["zoom"])))
            if op.get("fitBackdrop") in ("blur", "black"):
                seg.fit_backdrop = op["fitBackdrop"]
            if isinstance(op.get("camBox"), dict):
                seg.cam_box = NormalizedBox.model_validate(op["camBox"]).clamped()
            summaries.append(f"Framing → {seg.mode}")

        elif kind == "split_framing":
            current = split_framing_segment(
                current,
                int(op["splitAtMs"]),
                right_mode=op.get("mode"),
            )
            summaries.append(f"Split framing at {int(op['splitAtMs']) / 1000:.1f}s")

        elif kind == "tighten_silence":
            min_gap = int(op.get("minGapMs", 1100))
            current, cuts, saved = auto_tighten_silence(current, min_gap_ms=min_gap)
            if cuts > 0:
                summaries.append(f"Tightened {cuts} silent gap(s) (-{saved / 1000:.1f}s)")

        elif kind == "set_audio":
            aud = current.tracks.audio
            if op.get("gainDb") is not None:
                aud.gain_db = max(-24.0, min(24.0, float(op["gainDb"])))
            if isinstance(op.get("dialogueEnhance"), bool):
                aud.dialogue_enhance = op["dialogueEnhance"]
            if isinstance(op.get("muteOriginal"), bool):
                aud.mute_original = op["muteOriginal"]
            if op.get("normalizeLufs") is not None:
                aud.normalize_lufs = max(-24.0, min(-8.0, float(op["normalizeLufs"])))
            summaries.append("Updated dialogue audio settings")

        elif kind == "set_bgm":
            asset_id = str(op.get("assetId") or "").strip()
            if op.get("enabled") is False or (
                "assetId" in op and not asset_id
            ):
                current.tracks.audio.bgm = None
                summaries.append("BGM → off")
            else:
                prev_bgm = current.tracks.audio.bgm
                eff_id = asset_id or (prev_bgm.asset_id if prev_bgm else "dark_cinema_pulse")
                current.tracks.audio.bgm = BgmTrack(
                    asset_id=eff_id,
                    gain_db=max(
                        -36.0,
                        min(0.0, float(op.get("gainDb", prev_bgm.gain_db if prev_bgm else -16.0))),
                    ),
                    ducking_enabled=bool(
                        op.get(
                            "duckingEnabled",
                            prev_bgm.ducking_enabled if prev_bgm else True,
                        )
                    ),
                    start_offset_ms=max(
                        0,
                        int(
                            op.get(
                                "startOffsetMs",
                                prev_bgm.start_offset_ms if prev_bgm else 0,
                            )
                        ),
                    ),
                    fade_in_ms=max(
                        0,
                        min(
                            5000,
                            int(op.get("fadeInMs", prev_bgm.fade_in_ms if prev_bgm else 500)),
                        ),
                    ),
                    fade_out_ms=max(
                        0,
                        min(
                            5000,
                            int(op.get("fadeOutMs", prev_bgm.fade_out_ms if prev_bgm else 1000)),
                        ),
                    ),
                )
                summaries.append(f"BGM → {eff_id}")

        elif kind == "set_output":
            out_spec = current.output
            if op.get("ratio") in ("9:16", "4:5", "1:1", "16:9"):
                out_spec.ratio = op["ratio"]
            if op.get("quality") in ("720p", "1080p", "1440p", "4k"):
                out_spec.quality = op["quality"]
            if op.get("speedPreset") in ("draft", "final"):
                out_spec.speed_preset = op["speedPreset"]
            if op.get("borderStyle") in ("none", "thin_rounded", "double_cinema"):
                out_spec.border_style = op["borderStyle"]
            if op.get("cinemaGrade") in ("off", "crisp_hd"):
                out_spec.cinema_grade = op["cinemaGrade"]
            summaries.append(f"Output → {out_spec.ratio} ({out_spec.border_style})")

        elif kind == "set_slice_transition":
            clips = current.tracks.video.clips
            clip_id = str(op.get("clipId") or "")
            target_clip = next((c for c in clips if c.id == clip_id), None)
            if target_clip is None and op.get("clipIndex") is not None:
                c_idx = max(0, min(len(clips) - 1, int(op["clipIndex"])))
                target_clip = clips[c_idx]
            if target_clip is not None:
                if op.get("transitionIn") in ("none", "flash_white", "dip_black", "dissolve"):
                    target_clip.transition_in = op["transitionIn"]
                if op.get("transitionDurationMs") is not None:
                    target_clip.transition_duration_ms = max(
                        80, min(1000, int(op["transitionDurationMs"]))
                    )
                if op.get("transitionSfx") in ("none", "whoosh_flash", "cinema_hit"):
                    target_clip.transition_sfx = op["transitionSfx"]
                summaries.append(
                    f"Slice {target_clip.id} transition → {target_clip.transition_in}"
                )

    return current, before, summaries
