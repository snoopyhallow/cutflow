"""Pure deterministic EDL operations: TimelineMapper, blade cuts, multi-track NLE ops, patches."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from .schema import (
    AudioClipItem,
    BgmTrack,
    BRollClip,
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
_UNSET = object()


@dataclass(slots=True)
class TimelinePoint:
    """Resolved source state at an output timeline timestamp."""

    is_cold_open: bool
    is_gap: bool
    source_ms: int
    clip: VideoSlice | None = None


class TimelineMapper:
    """Maps between output ``timelineMs`` and original ``sourceMs`` across cuts, gaps, & speed."""

    def __init__(self, edl: TimelineProject) -> None:
        self.edl = edl
        co = edl.tracks.video.cold_open
        self.cold_open_ms: int = co.duration_ms if (co is not None and co.enabled) else 0
        self._spans: list[tuple[int, int, VideoSlice]] = []
        cursor = self.cold_open_ms
        for clip in edl.tracks.video.clips:
            t0 = (
                max(cursor, int(clip.timeline_start_ms))
                if clip.timeline_start_ms is not None
                else cursor
            )
            t1 = t0 + clip.duration_ms
            self._spans.append((t0, t1, clip))
            cursor = t1
        self.total_duration_ms: int = cursor

    @property
    def spans(self) -> list[tuple[int, int, VideoSlice]]:
        return list(self._spans)

    def resolve_at(self, timeline_ms: int) -> TimelinePoint:
        """Resolve ``(is_cold_open, is_gap, source_ms, clip)`` for any output timestamp."""
        t = max(0, min(self.total_duration_ms, int(timeline_ms)))
        co = self.edl.tracks.video.cold_open
        if co is not None and co.enabled and t < self.cold_open_ms:
            return TimelinePoint(True, False, co.source_start_ms + t, None)

        for t_start, t_end, clip in self._spans:
            if t < t_start:
                return TimelinePoint(False, True, clip.source_start_ms, clip)
            if t_start <= t <= t_end:
                if clip.freeze_duration_ms > 0:
                    return TimelinePoint(False, False, clip.source_start_ms, clip)
                rel_src = int(round((t - t_start) * max(0.25, float(clip.speed))))
                if clip.reverse:
                    src_ms = max(clip.source_start_ms, clip.source_end_ms - rel_src)
                else:
                    src_ms = min(clip.source_end_ms, clip.source_start_ms + rel_src)
                return TimelinePoint(False, False, src_ms, clip)

        last = self._spans[-1][2]
        end_src = last.source_start_ms if last.reverse else last.source_end_ms
        return TimelinePoint(False, False, end_src, last)

    def timeline_to_source(self, timeline_ms: int) -> tuple[bool, int]:
        """Return ``(is_cold_open, source_ms)`` for any output timeline timestamp."""
        pt = self.resolve_at(timeline_ms)
        return pt.is_cold_open, pt.source_ms

    def source_to_timeline(self, source_ms: int) -> int | None:
        """Map a main-body source timestamp to output timeline ms, or None if blade-cut out."""
        for t_start, _, clip in self._spans:
            if clip.source_start_ms <= source_ms <= clip.source_end_ms:
                if clip.freeze_duration_ms > 0:
                    return t_start
                spd = max(0.25, float(clip.speed))
                offset = (
                    (clip.source_end_ms - source_ms)
                    if clip.reverse
                    else (source_ms - clip.source_start_ms)
                )
                return t_start + int(round(offset / spd))
        return None


def _sync_framing_to_duration(edl: TimelineProject) -> None:
    """Keep framing segments contiguous and spanning ``[0, total_duration_ms]``."""
    new_total = max(MIN_SLICE_MS, TimelineMapper(edl).total_duration_ms)
    segs = [f for f in edl.tracks.video.framing if f.timeline_end_ms > f.timeline_start_ms]
    if not segs:
        segs = [
            FramingSegment(
                id="f_default",
                timeline_start_ms=0,
                timeline_end_ms=new_total,
                mode="fit",
            )
        ]
    segs[0].timeline_start_ms = 0
    kept: list[FramingSegment] = []
    for seg in segs:
        if seg.timeline_start_ms >= new_total:
            break
        seg.timeline_end_ms = min(new_total, max(seg.timeline_start_ms + 1, seg.timeline_end_ms))
        kept.append(seg)
    if not kept:
        kept = [segs[0].model_copy(update={"timeline_start_ms": 0, "timeline_end_ms": new_total})]
    kept[-1].timeline_end_ms = new_total
    for i in range(len(kept) - 1):
        kept[i].timeline_end_ms = kept[i + 1].timeline_start_ms
    edl.tracks.video.framing = [f for f in kept if f.timeline_end_ms > f.timeline_start_ms]


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


def apply_blade_cut(edl: TimelineProject, cut_start_ms: int, cut_end_ms: int) -> TimelineProject:
    """Non-destructively delete ``[cut_start_ms, cut_end_ms]`` from the main video track.

    Deterministically splits/removes covered video slices and ripples all
    downstream framing segments, subtitle words, mute ranges, overlays, B-roll, and audio clips.
    """
    mapper = TimelineMapper(edl)
    body_start = mapper.cold_open_ms
    c_start = max(body_start, int(cut_start_ms))
    c_end = min(mapper.total_duration_ms, int(cut_end_ms))
    removed = c_end - c_start
    if removed < MIN_SLICE_MS:
        raise ValueError("Blade cut must remove at least 100ms inside the main clip body.")
    if (mapper.total_duration_ms - body_start) - removed < MIN_SLICE_MS:
        raise ValueError("Cannot delete the entire clip; at least 100ms must remain.")

    next_edl = edl.model_copy(deep=True)
    new_clips: list[VideoSlice] = []

    for (s_t0, s_t1, _), clip in zip(mapper.spans, next_edl.tracks.video.clips, strict=False):
        if s_t1 <= c_start:
            new_clips.append(clip)
            continue
        if s_t0 >= c_end:
            if clip.timeline_start_ms is not None:
                clip = clip.model_copy(
                    update={"timeline_start_ms": max(0, clip.timeline_start_ms - removed)}
                )
            new_clips.append(clip)
            continue

        spd = max(0.25, float(clip.speed))
        if s_t0 < c_start:
            left_tl_dur = c_start - s_t0
            if left_tl_dur >= MIN_SLICE_MS:
                if clip.freeze_duration_ms > 0:
                    new_clips.append(clip.model_copy(update={"freeze_duration_ms": left_tl_dur}))
                else:
                    src_delta = max(MIN_SLICE_MS, int(round(left_tl_dur * spd)))
                    if clip.reverse:
                        new_s0 = max(clip.source_start_ms, clip.source_end_ms - src_delta)
                        if clip.source_end_ms > new_s0:
                            new_clips.append(clip.model_copy(update={"source_start_ms": new_s0}))
                    else:
                        new_e0 = min(clip.source_end_ms, clip.source_start_ms + src_delta)
                        if new_e0 > clip.source_start_ms:
                            new_clips.append(clip.model_copy(update={"source_end_ms": new_e0}))

        if s_t1 > c_end:
            right_tl_offset = c_end - s_t0
            right_tl_dur = s_t1 - c_end
            if right_tl_dur >= MIN_SLICE_MS:
                right_tl_start = (
                    c_start if (s_t0 >= c_start and clip.timeline_start_ms is not None) else None
                )
                if clip.freeze_duration_ms > 0:
                    new_clips.append(
                        clip.model_copy(
                            update={
                                "id": f"{clip.id}_{uuid.uuid4().hex[:4]}",
                                "freeze_duration_ms": right_tl_dur,
                                "timeline_start_ms": right_tl_start,
                                "transition_in": "none",
                                "transition_sfx": "none",
                            }
                        )
                    )
                else:
                    src_offset = int(round(right_tl_offset * spd))
                    if clip.reverse:
                        new_e1 = max(
                            clip.source_start_ms + MIN_SLICE_MS, clip.source_end_ms - src_offset
                        )
                        if new_e1 > clip.source_start_ms:
                            new_clips.append(
                                clip.model_copy(
                                    update={
                                        "id": f"{clip.id}_{uuid.uuid4().hex[:4]}",
                                        "source_end_ms": new_e1,
                                        "timeline_start_ms": right_tl_start,
                                        "transition_in": "none",
                                        "transition_sfx": "none",
                                    }
                                )
                            )
                    else:
                        new_s1 = min(
                            clip.source_end_ms - MIN_SLICE_MS, clip.source_start_ms + src_offset
                        )
                        if clip.source_end_ms > new_s1:
                            new_clips.append(
                                clip.model_copy(
                                    update={
                                        "id": f"{clip.id}_{uuid.uuid4().hex[:4]}",
                                        "source_start_ms": new_s1,
                                        "timeline_start_ms": right_tl_start,
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
        next_edl.tracks.video.framing = new_framing
    _sync_framing_to_duration(next_edl)

    # Ripple subtitle words & mute ranges
    new_words: list[SubtitleWord] = []
    for word in next_edl.tracks.subtitles.words:
        shifted = _shift_interval(word.start_ms, word.end_ms, c_start, c_end)
        if shifted is not None and (shifted[1] - shifted[0]) >= MIN_WORD_MS:
            new_words.append(word.model_copy(update={"start_ms": shifted[0], "end_ms": shifted[1]}))
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
            end_clamped = min(new_total, shifted[1])
            if end_clamped > shifted[0]:
                new_overlays.append(
                    ov.model_copy(update={"start_ms": shifted[0], "end_ms": end_clamped})
                )
    next_edl.tracks.overlays = new_overlays

    # Ripple V2 B-Roll clips
    new_broll: list[BRollClip] = []
    for br in next_edl.tracks.video.broll:
        shifted = _shift_interval(
            br.timeline_start_ms, br.timeline_start_ms + br.duration_ms, c_start, c_end
        )
        if shifted is not None and (shifted[1] - shifted[0]) >= MIN_SLICE_MS:
            new_broll.append(br.model_copy(update={"timeline_start_ms": shifted[0]}))
    next_edl.tracks.video.broll = new_broll

    # Ripple A1/A3 audio clips
    new_audio_clips: list[AudioClipItem] = []
    for ac in next_edl.tracks.audio.clips:
        shifted = _shift_interval(
            ac.timeline_start_ms, ac.timeline_start_ms + ac.duration_ms, c_start, c_end
        )
        if shifted is not None and (shifted[1] - shifted[0]) >= MIN_WORD_MS:
            new_audio_clips.append(ac.model_copy(update={"timeline_start_ms": shifted[0]}))
    next_edl.tracks.audio.clips = new_audio_clips

    return next_edl


def split_clip_at(edl: TimelineProject, split_at_ms: int) -> TimelineProject:
    """Split the V1 clip covering ``split_at_ms`` into two clips without deleting frames."""
    t = int(split_at_ms)
    mapper = TimelineMapper(edl)
    next_edl = edl.model_copy(deep=True)
    out: list[VideoSlice] = []
    did_split = False

    for (s_t0, s_t1, _), clip in zip(mapper.spans, next_edl.tracks.video.clips, strict=False):
        if not did_split and s_t0 + MIN_SLICE_MS <= t <= s_t1 - MIN_SLICE_MS:
            left_tl_dur = t - s_t0
            right_tl_dur = s_t1 - t
            if clip.freeze_duration_ms > 0:
                left = clip.model_copy(update={"freeze_duration_ms": left_tl_dur})
                right = clip.model_copy(
                    update={
                        "id": f"{clip.id}_{uuid.uuid4().hex[:4]}",
                        "freeze_duration_ms": right_tl_dur,
                        "timeline_start_ms": None,
                        "transition_in": "none",
                        "transition_sfx": "none",
                    }
                )
                out.extend([left, right])
                did_split = True
                continue

            spd = max(0.25, float(clip.speed))
            src_split_delta = int(round(left_tl_dur * spd))
            if clip.reverse:
                pivot = clip.source_end_ms - src_split_delta
                if (
                    clip.source_start_ms + MIN_SLICE_MS
                    <= pivot
                    <= clip.source_end_ms - MIN_SLICE_MS
                ):
                    left = clip.model_copy(update={"source_start_ms": pivot})
                    right = clip.model_copy(
                        update={
                            "id": f"{clip.id}_{uuid.uuid4().hex[:4]}",
                            "source_end_ms": pivot,
                            "timeline_start_ms": None,
                            "transition_in": "none",
                            "transition_sfx": "none",
                        }
                    )
                    out.extend([left, right])
                    did_split = True
                    continue
            else:
                pivot = clip.source_start_ms + src_split_delta
                if (
                    clip.source_start_ms + MIN_SLICE_MS
                    <= pivot
                    <= clip.source_end_ms - MIN_SLICE_MS
                ):
                    left = clip.model_copy(update={"source_end_ms": pivot})
                    right = clip.model_copy(
                        update={
                            "id": f"{clip.id}_{uuid.uuid4().hex[:4]}",
                            "source_start_ms": pivot,
                            "timeline_start_ms": None,
                            "transition_in": "none",
                            "transition_sfx": "none",
                        }
                    )
                    out.extend([left, right])
                    did_split = True
                    continue
        out.append(clip)

    if not did_split:
        raise ValueError("Move playhead at least 100ms inside a video clip to split.")
    next_edl.tracks.video.clips = out
    _sync_framing_to_duration(next_edl)
    return next_edl


def delete_clip(edl: TimelineProject, clip_id: str, *, ripple: bool = True) -> TimelineProject:
    """Delete a V1 clip (either rippling downstream tracks or leaving a free-position gap)."""
    clips = edl.tracks.video.clips
    if len(clips) <= 1:
        raise ValueError("At least one clip must remain on the main video track.")
    mapper = TimelineMapper(edl)
    idx = next((i for i, c in enumerate(clips) if c.id == clip_id), None)
    if idx is None:
        raise ValueError(f"Clip {clip_id!r} not found.")

    s_t0, s_t1, _ = mapper.spans[idx]
    if ripple:
        return apply_blade_cut(edl, s_t0, s_t1)

    next_edl = edl.model_copy(deep=True)
    nxt_span_start = mapper.spans[idx + 1][0] if idx + 1 < len(mapper.spans) else None
    remaining: list[VideoSlice] = []
    for i, c in enumerate(next_edl.tracks.video.clips):
        if i == idx:
            continue
        if i == idx + 1 and nxt_span_start is not None:
            c = c.model_copy(update={"timeline_start_ms": nxt_span_start})
        remaining.append(c)
    next_edl.tracks.video.clips = remaining
    _sync_framing_to_duration(next_edl)
    return next_edl


def _remap_tracks_after_clip_edit(
    before_edl: TimelineProject,
    next_edl: TimelineProject,
    edited_idx: int,
) -> None:
    """Keep subtitle words, overlays, B-roll, and audio clips synced after clip trim/speed."""
    before_mapper = TimelineMapper(before_edl)
    after_mapper = TimelineMapper(next_edl)
    before_spans = before_mapper.spans
    after_spans = after_mapper.spans
    if not before_spans or len(before_spans) != len(after_spans):
        return

    body_start = before_mapper.cold_open_ms
    old_total = before_mapper.total_duration_ms
    new_total = after_mapper.total_duration_ms

    remapped_words: list[SubtitleWord] = []
    for w in next_edl.tracks.subtitles.words:
        if w.end_ms <= body_start:
            clamped_e = min(new_total, w.end_ms)
            if clamped_e - w.start_ms >= MIN_WORD_MS:
                remapped_words.append(w.model_copy(update={"end_ms": clamped_e}))
            continue

        mid = 0.5 * (w.start_ms + w.end_ms)
        span_idx = len(before_spans) - 1
        for k, (_bt0, bt1, _) in enumerate(before_spans):
            if mid <= bt1:
                span_idx = k
                break

        bt0, _bt1, b_clip = before_spans[span_idx]
        at0, at1, a_clip = after_spans[span_idx]
        if span_idx != edited_idx:
            shift = at0 - bt0
            ns = max(0, w.start_ms + shift)
            ne = min(new_total, w.end_ms + shift)
            if ne - ns >= MIN_WORD_MS:
                remapped_words.append(w.model_copy(update={"start_ms": ns, "end_ms": ne}))
            continue

        if b_clip.freeze_duration_ms > 0 or a_clip.freeze_duration_ms > 0:
            ns = max(at0, min(at1 - MIN_WORD_MS, at0 + (w.start_ms - bt0)))
            ne = min(at1, max(ns + MIN_WORD_MS, at0 + (w.end_ms - bt0)))
            if ne - ns >= MIN_WORD_MS:
                remapped_words.append(w.model_copy(update={"start_ms": ns, "end_ms": ne}))
            continue

        b_spd = max(0.25, float(b_clip.speed))
        a_spd = max(0.25, float(a_clip.speed))
        rel_s = w.start_ms - bt0
        rel_e = w.end_ms - bt0
        if b_clip.reverse:
            src_hi = b_clip.source_end_ms - rel_s * b_spd
            src_lo = b_clip.source_end_ms - rel_e * b_spd
        else:
            src_lo = b_clip.source_start_ms + rel_s * b_spd
            src_hi = b_clip.source_start_ms + rel_e * b_spd

        c_lo = max(float(a_clip.source_start_ms), src_lo)
        c_hi = min(float(a_clip.source_end_ms), src_hi)
        if (c_hi - c_lo) / a_spd < MIN_WORD_MS:
            continue

        if a_clip.reverse:
            ns = at0 + int(round((a_clip.source_end_ms - c_hi) / a_spd))
            ne = at0 + int(round((a_clip.source_end_ms - c_lo) / a_spd))
        else:
            ns = at0 + int(round((c_lo - a_clip.source_start_ms) / a_spd))
            ne = at0 + int(round((c_hi - a_clip.source_start_ms) / a_spd))

        ns = max(at0, min(max(at0, at1 - MIN_WORD_MS), ns))
        ne = min(at1, max(ns + MIN_WORD_MS, ne))
        if ne - ns >= MIN_WORD_MS:
            remapped_words.append(w.model_copy(update={"start_ms": ns, "end_ms": ne}))

    remapped_words.sort(key=lambda item: (item.start_ms, item.end_ms))
    next_edl.tracks.subtitles.words = remapped_words

    old_edit_end = before_spans[edited_idx][1]
    tail_delta = after_spans[edited_idx][1] - old_edit_end
    if tail_delta != 0:
        for br in next_edl.tracks.video.broll:
            if br.timeline_start_ms >= old_edit_end:
                br.timeline_start_ms = max(0, br.timeline_start_ms + tail_delta)
        for ac in next_edl.tracks.audio.clips:
            if ac.timeline_start_ms >= old_edit_end:
                ac.timeline_start_ms = max(0, ac.timeline_start_ms + tail_delta)

    kept_overlays: list[OverlayItem] = []
    for ov in next_edl.tracks.overlays:
        if ov.start_ms == 0 and ov.end_ms >= max(250, old_total - 50):
            kept_overlays.append(ov.model_copy(update={"end_ms": max(250, new_total)}))
        elif ov.start_ms >= old_edit_end and tail_delta != 0:
            ns = max(0, ov.start_ms + tail_delta)
            ne = min(new_total, ov.end_ms + tail_delta)
            if ne - ns >= 150:
                kept_overlays.append(ov.model_copy(update={"start_ms": ns, "end_ms": ne}))
        else:
            clamped_end = min(new_total, ov.end_ms)
            if clamped_end > ov.start_ms:
                kept_overlays.append(ov.model_copy(update={"end_ms": clamped_end}))
    next_edl.tracks.overlays = kept_overlays


def set_cold_open(
    edl: TimelineProject,
    *,
    enabled: bool,
    source_start_ms: int | None = None,
    duration_ms: int | None = None,
    fade_out_ms: int | None = None,
) -> TimelineProject:
    """Enable, disable, or resize the Cold-Open teaser while shifting body words & tracks."""
    before_mapper = TimelineMapper(edl)
    old_co = before_mapper.cold_open_ms
    old_total = before_mapper.total_duration_ms
    next_edl = edl.model_copy(deep=True)
    prev_block = edl.tracks.video.cold_open

    if not enabled:
        next_edl.tracks.video.cold_open = None
        new_co = 0
    else:
        first_clip = next_edl.tracks.video.clips[0]
        default_src = int(
            round(
                first_clip.source_start_ms
                + (first_clip.source_end_ms - first_clip.source_start_ms) * 0.6
            )
        )
        resolved_src = max(
            0,
            int(
                source_start_ms
                if source_start_ms is not None
                else (prev_block.source_start_ms if prev_block is not None else default_src)
            ),
        )
        resolved_dur = max(
            500,
            min(
                4000,
                int(
                    duration_ms
                    if duration_ms is not None
                    else (prev_block.duration_ms if prev_block is not None else 1500)
                ),
            ),
        )
        resolved_fade = max(
            0,
            min(
                1000,
                int(
                    fade_out_ms
                    if fade_out_ms is not None
                    else (prev_block.fade_out_ms if prev_block is not None else 120)
                ),
            ),
        )
        next_edl.tracks.video.cold_open = ColdOpenBlock(
            enabled=True,
            source_start_ms=resolved_src,
            duration_ms=resolved_dur,
            fade_out_ms=resolved_fade,
        )
        new_co = resolved_dur

    delta = new_co - old_co
    if delta == 0:
        _sync_framing_to_duration(next_edl)
        return next_edl

    for clip in next_edl.tracks.video.clips:
        if clip.timeline_start_ms is not None:
            clip.timeline_start_ms = max(new_co, clip.timeline_start_ms + delta)

    new_total = TimelineMapper(next_edl).total_duration_ms

    shifted_words: list[SubtitleWord] = []
    for w in next_edl.tracks.subtitles.words:
        if old_co > 0 and w.end_ms <= old_co:
            continue
        ns = max(new_co, w.start_ms + delta)
        ne = min(new_total, max(ns + MIN_WORD_MS, w.end_ms + delta))
        if ns < new_total and ne - ns >= MIN_WORD_MS:
            shifted_words.append(w.model_copy(update={"start_ms": ns, "end_ms": ne}))
    next_edl.tracks.subtitles.words = shifted_words

    shifted_mutes: list[tuple[int, int]] = []
    for m0, m1 in next_edl.tracks.subtitles.mute_ranges:
        nm0 = max(0, m0 + delta)
        nm1 = min(new_total, m1 + delta)
        if nm1 > nm0:
            shifted_mutes.append((nm0, nm1))
    next_edl.tracks.subtitles.mute_ranges = shifted_mutes

    for seg in next_edl.tracks.video.framing:
        if seg.timeline_start_ms > 0:
            seg.timeline_start_ms = max(1, seg.timeline_start_ms + delta)
        if seg.timeline_end_ms < old_total:
            seg.timeline_end_ms = max(seg.timeline_start_ms + 1, seg.timeline_end_ms + delta)
    _sync_framing_to_duration(next_edl)

    shifted_overlays: list[OverlayItem] = []
    for ov in next_edl.tracks.overlays:
        if ov.start_ms == 0 and ov.end_ms >= max(250, old_total - 50):
            shifted_overlays.append(ov.model_copy(update={"end_ms": max(250, new_total)}))
        elif ov.start_ms == 0:
            clamped_end = min(new_total, max(200, ov.end_ms))
            shifted_overlays.append(ov.model_copy(update={"end_ms": clamped_end}))
        else:
            ns = max(0, min(max(0, new_total - 200), ov.start_ms + delta))
            ne = min(new_total, max(ns + 200, ov.end_ms + delta))
            if ne > ns:
                shifted_overlays.append(ov.model_copy(update={"start_ms": ns, "end_ms": ne}))
    next_edl.tracks.overlays = shifted_overlays

    for br in next_edl.tracks.video.broll:
        if old_co == 0 or br.timeline_start_ms >= old_co:
            br.timeline_start_ms = max(0, br.timeline_start_ms + delta)
    for ac in next_edl.tracks.audio.clips:
        if old_co == 0 or ac.timeline_start_ms >= old_co:
            ac.timeline_start_ms = max(0, ac.timeline_start_ms + delta)

    return next_edl


def trim_clip_edges(
    edl: TimelineProject,
    clip_id: str,
    *,
    source_start_ms: int | None = None,
    source_end_ms: int | None = None,
    timeline_start_ms: Any = _UNSET,
) -> TimelineProject:
    """Trim source in/out bounds (and optional timeline gap start) while syncing words."""
    next_edl = edl.model_copy(deep=True)
    idx = next((i for i, c in enumerate(next_edl.tracks.video.clips) if c.id == clip_id), None)
    if idx is None:
        raise ValueError(f"Clip {clip_id!r} not found.")
    target = next_edl.tracks.video.clips[idx]

    new_s0 = target.source_start_ms if source_start_ms is None else max(0, int(source_start_ms))
    new_e0 = (
        target.source_end_ms
        if source_end_ms is None
        else max(new_s0 + MIN_SLICE_MS, int(source_end_ms))
    )
    if new_e0 - new_s0 < MIN_SLICE_MS:
        raise ValueError("Clip duration must be at least 100ms.")
    target.source_start_ms = new_s0
    target.source_end_ms = new_e0
    if timeline_start_ms is not _UNSET:
        target.timeline_start_ms = (
            None if timeline_start_ms is None else max(0, int(timeline_start_ms))
        )
    _remap_tracks_after_clip_edit(edl, next_edl, idx)
    _sync_framing_to_duration(next_edl)
    return next_edl


def duplicate_clip(edl: TimelineProject, clip_id: str) -> TimelineProject:
    """Duplicate a V1 clip immediately after the original."""
    next_edl = edl.model_copy(deep=True)
    idx = next((i for i, c in enumerate(next_edl.tracks.video.clips) if c.id == clip_id), None)
    if idx is None:
        raise ValueError(f"Clip {clip_id!r} not found.")
    orig = next_edl.tracks.video.clips[idx]
    copy = orig.model_copy(
        update={
            "id": f"{orig.id}_dup_{uuid.uuid4().hex[:4]}",
            "timeline_start_ms": None,
            "label": f"{orig.label} (Copy)".strip() if orig.label else "Scene Copy",
        }
    )
    next_edl.tracks.video.clips.insert(idx + 1, copy)
    _sync_framing_to_duration(next_edl)
    return next_edl


def set_clip_speed(
    edl: TimelineProject,
    clip_id: str,
    speed: float,
    *,
    reverse: bool | None = None,
) -> TimelineProject:
    """Set playback speed (0.25x-4.0x) and optional reverse flag while remapping words."""
    next_edl = edl.model_copy(deep=True)
    idx = next((i for i, c in enumerate(next_edl.tracks.video.clips) if c.id == clip_id), None)
    if idx is None:
        raise ValueError(f"Clip {clip_id!r} not found.")
    target = next_edl.tracks.video.clips[idx]
    target.speed = round(max(0.25, min(4.0, float(speed))), 3)
    target.freeze_duration_ms = 0
    if reverse is not None:
        target.reverse = bool(reverse)
    _remap_tracks_after_clip_edit(edl, next_edl, idx)
    _sync_framing_to_duration(next_edl)
    return next_edl


def freeze_frame_at(
    edl: TimelineProject,
    timeline_ms: int,
    duration_ms: int = 2000,
) -> TimelineProject:
    """Insert a CapCut-style freeze-frame hold slice at ``timeline_ms``."""
    hold_ms = max(200, min(30000, int(duration_ms)))
    mapper = TimelineMapper(edl)
    pt = mapper.resolve_at(timeline_ms)
    if pt.clip is None or pt.is_cold_open or pt.is_gap:
        raise ValueError("Move playhead onto an active video clip to insert a freeze frame.")

    target_idx = next(i for i, c in enumerate(edl.tracks.video.clips) if c.id == pt.clip.id)
    s_t0, s_t1, orig_clip = mapper.spans[target_idx]
    next_edl = edl.model_copy(deep=True)
    freeze_src = max(0, pt.source_ms)
    freeze_slice = VideoSlice(
        id=f"frz_{uuid.uuid4().hex[:6]}",
        source_start_ms=freeze_src,
        source_end_ms=freeze_src + 100,
        source_id=orig_clip.source_id,
        label="Freeze Frame",
        freeze_duration_ms=hold_ms,
        muted=True,
    )

    # Split surrounding clip if playhead is strictly inside it, else insert adjacent
    insert_pos = target_idx + 1
    if s_t0 + MIN_SLICE_MS <= timeline_ms <= s_t1 - MIN_SLICE_MS:
        next_edl = split_clip_at(next_edl, timeline_ms)
        insert_pos = target_idx + 1
        next_edl.tracks.video.clips.insert(insert_pos, freeze_slice)
    elif timeline_ms <= s_t0 + MIN_SLICE_MS:
        insert_pos = target_idx
        next_edl.tracks.video.clips.insert(insert_pos, freeze_slice)
    else:
        insert_pos = target_idx + 1
        next_edl.tracks.video.clips.insert(insert_pos, freeze_slice)

    # Ripple downstream pinned clips, words, overlays, B-roll, & audio clips forward by hold_ms
    for c in next_edl.tracks.video.clips[insert_pos + 1 :]:
        if c.timeline_start_ms is not None:
            c.timeline_start_ms += hold_ms
    for w in next_edl.tracks.subtitles.words:
        if w.start_ms >= timeline_ms:
            w.start_ms += hold_ms
            w.end_ms += hold_ms
        elif w.end_ms > timeline_ms:
            w.end_ms += hold_ms
    for ov in next_edl.tracks.overlays:
        if ov.start_ms >= timeline_ms:
            ov.start_ms += hold_ms
            ov.end_ms += hold_ms
        elif ov.end_ms > timeline_ms:
            ov.end_ms += hold_ms
    for br in next_edl.tracks.video.broll:
        if br.timeline_start_ms >= timeline_ms:
            br.timeline_start_ms += hold_ms
    for ac in next_edl.tracks.audio.clips:
        if ac.timeline_start_ms >= timeline_ms:
            ac.timeline_start_ms += hold_ms

    _sync_framing_to_duration(next_edl)
    return next_edl


def detach_clip_audio(edl: TimelineProject, clip_id: str) -> TimelineProject:
    """Detach embedded audio from a V1 clip onto an independent A1 AudioClipItem."""
    mapper = TimelineMapper(edl)
    idx = next((i for i, c in enumerate(edl.tracks.video.clips) if c.id == clip_id), None)
    if idx is None:
        raise ValueError(f"Clip {clip_id!r} not found.")
    s_t0, _, orig = mapper.spans[idx]
    if orig.audio_detached:
        return edl.model_copy(deep=True)

    next_edl = edl.model_copy(deep=True)
    target = next_edl.tracks.video.clips[idx]
    target.audio_detached = True
    detached_item = AudioClipItem(
        id=f"aud_{uuid.uuid4().hex[:6]}",
        kind="detached",
        source_id=orig.source_id or edl.source_id,
        label=f"{orig.label or 'Scene'} Audio",
        source_start_ms=orig.source_start_ms,
        source_end_ms=orig.source_end_ms,
        timeline_start_ms=s_t0,
        speed=orig.speed,
        gain_db=orig.gain_db,
        muted=orig.muted,
        fade_in_ms=orig.fade_in_ms,
        fade_out_ms=orig.fade_out_ms,
    )
    next_edl.tracks.audio.clips.append(detached_item)
    return next_edl


def add_broll_clip(
    edl: TimelineProject,
    *,
    source_id: str,
    source_start_ms: int = 0,
    source_end_ms: int = 4000,
    timeline_start_ms: int = 0,
    label: str = "B-Roll",
    box: NormalizedBox | None = None,
) -> TimelineProject:
    next_edl = edl.model_copy(deep=True)
    s0 = max(0, int(source_start_ms))
    e0 = max(s0 + MIN_SLICE_MS, int(source_end_ms))
    br = BRollClip(
        id=f"br_{uuid.uuid4().hex[:6]}",
        source_id=source_id,
        label=label,
        source_start_ms=s0,
        source_end_ms=e0,
        timeline_start_ms=max(0, int(timeline_start_ms)),
        box=(box.clamped() if box else NormalizedBox(x=0.56, y=0.06, w=0.38, h=0.28)),
    )
    next_edl.tracks.video.broll.append(br)
    return next_edl


def delete_broll_clip(edl: TimelineProject, broll_id: str) -> TimelineProject:
    next_edl = edl.model_copy(deep=True)
    next_edl.tracks.video.broll = [b for b in next_edl.tracks.video.broll if b.id != broll_id]
    return next_edl


def add_audio_clip(
    edl: TimelineProject,
    *,
    kind: str = "sfx",
    asset_id: str | None = None,
    source_id: str | None = None,
    label: str = "SFX",
    source_start_ms: int = 0,
    source_end_ms: int = 1200,
    timeline_start_ms: int = 0,
    gain_db: float = -3.0,
) -> TimelineProject:
    next_edl = edl.model_copy(deep=True)
    s0 = max(0, int(source_start_ms))
    e0 = max(s0 + MIN_WORD_MS, int(source_end_ms))
    clip_kind = kind if kind in ("detached", "sfx", "audio") else "sfx"
    ac = AudioClipItem(
        id=f"ac_{uuid.uuid4().hex[:6]}",
        kind=clip_kind,  # type: ignore[arg-type]
        asset_id=asset_id,
        source_id=source_id,
        label=label,
        source_start_ms=s0,
        source_end_ms=e0,
        timeline_start_ms=max(0, int(timeline_start_ms)),
        gain_db=max(-60.0, min(12.0, float(gain_db))),
    )
    next_edl.tracks.audio.clips.append(ac)
    return next_edl


def delete_audio_clip(edl: TimelineProject, audio_clip_id: str) -> TimelineProject:
    next_edl = edl.model_copy(deep=True)
    next_edl.tracks.audio.clips = [a for a in next_edl.tracks.audio.clips if a.id != audio_clip_id]
    return next_edl


def add_overlay_item(
    edl: TimelineProject,
    *,
    kind: str = "seam_card_white",
    text: str = "Headline Hook",
    start_ms: int = 0,
    end_ms: int | None = None,
    y_anchor: str = "split_seam",
    scale: float = 1.0,
) -> TimelineProject:
    next_edl = edl.model_copy(deep=True)
    total = max(1000, TimelineMapper(next_edl).total_duration_ms)
    s0 = max(0, min(total - 250, int(start_ms)))
    e0 = min(total, max(s0 + 250, int(end_ms) if end_ms is not None else min(total, s0 + 3500)))
    ov = OverlayItem(
        id=f"ov_{uuid.uuid4().hex[:6]}",
        kind=kind,  # type: ignore[arg-type]
        text=text,
        start_ms=s0,
        end_ms=e0,
        y_anchor=y_anchor if y_anchor in ("split_seam", "top", "bottom") else "split_seam",  # type: ignore[arg-type]
        scale=max(0.4, min(2.5, float(scale))),
    )
    next_edl.tracks.overlays.append(ov)
    return next_edl


def delete_overlay_item(edl: TimelineProject, overlay_id: str) -> TimelineProject:
    next_edl = edl.model_copy(deep=True)
    next_edl.tracks.overlays = [o for o in next_edl.tracks.overlays if o.id != overlay_id]
    return next_edl


def duplicate_overlay_item(edl: TimelineProject, overlay_id: str) -> TimelineProject:
    next_edl = edl.model_copy(deep=True)
    orig = next((o for o in next_edl.tracks.overlays if o.id == overlay_id), None)
    if orig is None:
        raise ValueError(f"Overlay {overlay_id!r} not found.")
    copy = orig.model_copy(
        update={
            "id": f"ov_{uuid.uuid4().hex[:6]}",
            "y_offset_ratio": max(-0.48, min(0.48, orig.y_offset_ratio + 0.05)),
        }
    )
    next_edl.tracks.overlays.append(copy)
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
            nxt_mode = right_mode if right_mode in ("split", "fit", "centre", "crop") else seg.mode
            right_cam = seg.cam_box or (
                NormalizedBox(x=0.02, y=0.28, w=0.24, h=0.26) if nxt_mode == "split" else None
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
    """Automatically jump-cut dead-air pauses >= ``min_gap_ms`` inside the main clip body."""
    mapper = TimelineMapper(edl)
    body_start = mapper.cold_open_ms
    total_ms = mapper.total_duration_ms
    if total_ms - body_start < min_gap_ms + 400:
        return edl.model_copy(deep=True), 0, 0

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

    gaps: list[tuple[int, int]] = []
    cursor = body_start
    for occ_s, occ_e in occupied:
        if occ_s - cursor >= min_gap_ms:
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

        elif kind == "split_clip":
            at_ms = int(op["splitAtMs"])
            current = split_clip_at(current, at_ms)
            summaries.append(f"Split clip at {at_ms / 1000:.2f}s")

        elif kind == "delete_clip":
            cid = str(op["clipId"])
            ripple = bool(op.get("ripple", True))
            current = delete_clip(current, cid, ripple=ripple)
            summaries.append(f"{'Ripple deleted' if ripple else 'Deleted'} clip {cid}")

        elif kind == "duplicate_clip":
            cid = str(op["clipId"])
            current = duplicate_clip(current, cid)
            summaries.append(f"Duplicated clip {cid}")

        elif kind == "set_clip_speed":
            cid = str(op.get("clipId") or current.tracks.video.clips[0].id)
            spd = float(op.get("speed", 1.0))
            rev = op.get("reverse")
            current = set_clip_speed(
                current, cid, spd, reverse=bool(rev) if isinstance(rev, bool) else None
            )
            summaries.append(f"Clip speed → {spd:.2f}×")

        elif kind == "freeze_frame":
            at_ms = int(op.get("timelineMs", 0))
            dur = int(op.get("durationMs", 2000))
            current = freeze_frame_at(current, at_ms, dur)
            summaries.append(f"Freeze frame ({dur / 1000:.1f}s) at {at_ms / 1000:.1f}s")

        elif kind == "detach_audio":
            cid = str(op.get("clipId") or current.tracks.video.clips[0].id)
            current = detach_clip_audio(current, cid)
            summaries.append(f"Detached audio from {cid}")

        elif kind == "set_clip_audio":
            cid = str(op.get("clipId") or current.tracks.video.clips[0].id)
            clip_target = next((c for c in current.tracks.video.clips if c.id == cid), None)
            if clip_target is not None:
                if op.get("gainDb") is not None:
                    clip_target.gain_db = max(-60.0, min(12.0, float(op["gainDb"])))
                if isinstance(op.get("muted"), bool):
                    clip_target.muted = op["muted"]
                if op.get("fadeInMs") is not None:
                    clip_target.fade_in_ms = max(0, min(5000, int(op["fadeInMs"])))
                if op.get("fadeOutMs") is not None:
                    clip_target.fade_out_ms = max(0, min(5000, int(op["fadeOutMs"])))
                summaries.append(f"Updated clip {cid} audio")

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

        elif kind == "add_overlay":
            ov_kind = str(op.get("kind") or "seam_card_white")
            if ov_kind not in (
                "seam_card_white",
                "hook_banner_dark",
                "cta_pill",
                "pov_top_bar",
                "watermark_tag",
                "cinema_credit",
            ):
                ov_kind = "seam_card_white"
            current = add_overlay_item(
                current,
                kind=ov_kind,
                text=str(op.get("text") or "Headline"),
                start_ms=int(op.get("startMs", 0)),
                end_ms=int(op["endMs"]) if op.get("endMs") is not None else None,
                y_anchor=str(op.get("yAnchor") or "split_seam"),
                scale=float(op.get("scale", 1.0)),
            )
            summaries.append(f"Added overlay '{op.get('text', 'Headline')}'")

        elif kind == "update_overlay":
            oid = str(op.get("overlayId") or "")
            ov_target = next((o for o in current.tracks.overlays if o.id == oid), None)
            if ov_target is None and current.tracks.overlays:
                ov_target = current.tracks.overlays[0]
            if ov_target is not None:
                if "text" in op and op["text"] is not None:
                    ov_target.text = str(op["text"])
                if op.get("startMs") is not None:
                    ov_target.start_ms = max(0, int(op["startMs"]))
                if op.get("endMs") is not None:
                    ov_target.end_ms = max(ov_target.start_ms + 100, int(op["endMs"]))
                if op.get("scale") is not None:
                    ov_target.scale = max(0.4, min(2.5, float(op["scale"])))
                if op.get("opacity") is not None:
                    ov_target.opacity = max(0.1, min(1.0, float(op["opacity"])))
                if op.get("xOffsetRatio") is not None:
                    ov_target.x_offset_ratio = max(-0.5, min(0.5, float(op["xOffsetRatio"])))
                if op.get("yOffsetRatio") is not None:
                    ov_target.y_offset_ratio = max(-0.5, min(0.5, float(op["yOffsetRatio"])))
                summaries.append(f"Updated overlay '{ov_target.text[:28]}'")

        elif kind == "delete_overlay":
            oid = str(op.get("overlayId") or "").strip()
            ov_kind_filter = str(op.get("kind") or "").strip()
            before_count = len(current.tracks.overlays)
            if oid == "all":
                current.tracks.overlays = []
            elif oid:
                current.tracks.overlays = [o for o in current.tracks.overlays if o.id != oid]
            elif ov_kind_filter:
                current.tracks.overlays = [
                    o for o in current.tracks.overlays if o.kind != ov_kind_filter
                ]
            else:
                # Default: remove hook/headline overlays
                current.tracks.overlays = [
                    o
                    for o in current.tracks.overlays
                    if o.kind not in ("seam_card_white", "hook_banner_dark", "pov_top_bar")
                ]
            removed_n = before_count - len(current.tracks.overlays)
            if removed_n > 0:
                summaries.append(f"Removed {removed_n} overlay(s)")

        elif kind == "set_cold_open":
            if op.get("enabled") is False:
                current = set_cold_open(current, enabled=False)
                summaries.append("Cold-open → off")
            else:
                src_raw = op.get("sourceStartMs")
                dur_raw = op.get("durationMs")
                fade_raw = op.get("fadeOutMs")
                current = set_cold_open(
                    current,
                    enabled=True,
                    source_start_ms=int(src_raw) if src_raw is not None else None,
                    duration_ms=int(dur_raw) if dur_raw is not None else None,
                    fade_out_ms=int(fade_raw) if fade_raw is not None else None,
                )
                assert current.tracks.video.cold_open is not None
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
                aud.gain_db = max(-60.0, min(24.0, float(op["gainDb"])))
            if isinstance(op.get("dialogueEnhance"), bool):
                aud.dialogue_enhance = op["dialogueEnhance"]
            if isinstance(op.get("muteOriginal"), bool):
                aud.mute_original = op["muteOriginal"]
            if op.get("normalizeLufs") is not None:
                aud.normalize_lufs = max(-24.0, min(-8.0, float(op["normalizeLufs"])))
            summaries.append(f"Dialogue audio → {aud.gain_db:+.1f} dB")

        elif kind == "set_bgm":
            asset_id = str(op.get("assetId") or "").strip()
            if op.get("enabled") is False or ("assetId" in op and not asset_id):
                current.tracks.audio.bgm = None
                summaries.append("BGM → off")
            else:
                prev_bgm = current.tracks.audio.bgm
                eff_id = asset_id or (prev_bgm.asset_id if prev_bgm else "dark_cinema_pulse")
                current.tracks.audio.bgm = BgmTrack(
                    asset_id=eff_id,
                    gain_db=max(
                        -60.0,
                        min(
                            12.0,
                            float(op.get("gainDb", prev_bgm.gain_db if prev_bgm else -16.0)),
                        ),
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

        elif kind == "add_sfx":
            sfx_id = str(op.get("assetId") or "whoosh_flash")
            at_ms = int(op.get("timelineStartMs", 0))
            current = add_audio_clip(
                current,
                kind="sfx",
                asset_id=sfx_id,
                label=str(op.get("label") or sfx_id),
                source_start_ms=0,
                source_end_ms=int(op.get("durationMs", 900)),
                timeline_start_ms=at_ms,
                gain_db=float(op.get("gainDb", -4.0)),
            )
            summaries.append(f"Added SFX '{sfx_id}' at {at_ms / 1000:.1f}s")

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
                        80, min(800, int(op["transitionDurationMs"]))
                    )
                if op.get("transitionSfx") in ("none", "whoosh_flash", "cinema_hit"):
                    target_clip.transition_sfx = op["transitionSfx"]
                summaries.append(f"Slice {target_clip.id} transition → {target_clip.transition_in}")

    return current, before, summaries
