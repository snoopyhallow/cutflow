"""Brief-tuned highlight, Cinema story-arc & POV hook discovery plus Vision webcam detection."""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..edl.schema import NormalizedBox
from ..workspace.profiles import CreatorProfile
from .hype import HypePoint
from .llm import LLMError, complete_json
from .transcription import TranscriptResult, chunk_compact_transcript

log = logging.getLogger(__name__)

_VALID_MOODS = frozenset({"dark_cinema", "upbeat_gaming", "suspense", "emotional"})


@dataclass(slots=True)
class HighlightCandidate:
    start_ms: int
    end_ms: int
    score: int
    title: str
    seam_title: str
    reason: str
    cold_open_source_ms: int | None = None
    slices: list[tuple[int, int]] | None = None
    pov_hook: str = ""
    mood: str = "dark_cinema"


def _default_mood(profile: CreatorProfile) -> str:
    return "dark_cinema" if profile.content_mode == "cinema" else "upbeat_gaming"


def _heuristic_hype_highlights(
    hype_curve: list[HypePoint],
    duration_ms: int,
    profile: CreatorProfile,
    source_title: str,
) -> list[HighlightCandidate]:
    """Deterministic fallback selector using Hype Curve peaks when no LLM key is present."""
    if duration_ms <= 0:
        return []

    mood = _default_mood(profile)
    is_cinema = profile.content_mode == "cinema"
    target_ms = int(round(((profile.min_duration_s + profile.max_duration_s) / 2.0) * 1000.0))
    target_ms = max(4000, min(duration_ms, target_ms))
    max_clips = max(1, min(profile.max_clips, max(1, duration_ms // max(target_ms, 1) + 1)))

    if duration_ms <= int(profile.max_duration_s * 1000):
        peak_pt = max(hype_curve, key=lambda p: p.score, default=None)
        peak_ms = int(peak_pt.start_s * 1000) if peak_pt else max(0, duration_ms // 2)
        clean_title = (source_title or profile.name or "Highlight Clip").strip()[:90]
        return [
            HighlightCandidate(
                start_ms=0,
                end_ms=duration_ms,
                score=85,
                title=clean_title,
                seam_title=clean_title,
                reason="Selected full clip segment from dialogue/energy envelope.",
                cold_open_source_ms=None if is_cinema else min(max(0, duration_ms - 1600), peak_ms),
                pov_hook=f"POV: {clean_title.upper()[:42]}",
                mood=mood,
            )
        ]

    ranked = sorted(hype_curve, key=lambda p: p.score, reverse=True)
    chosen: list[HighlightCandidate] = []
    for pt in ranked:
        if len(chosen) >= max_clips:
            break
        peak_ms = int(round(pt.start_s * 1000.0))
        # Cinema leaves extra trailing breath/stare after payoff; Stream leads 60% into climax
        lead_ratio = 0.52 if is_cinema else 0.60
        s_ms = max(0, peak_ms - int(target_ms * lead_ratio))
        e_ms = min(duration_ms, s_ms + target_ms)
        s_ms = max(0, e_ms - target_ms)
        if any(not (e_ms <= c.start_ms or s_ms >= c.end_ms) for c in chosen):
            continue
        rank_num = len(chosen) + 1
        base_title = (source_title or profile.name or "Clip").strip()[:60]
        kind_lbl = "Scene" if is_cinema else "Moment"
        peak_lbl = "Dramatic dialogue" if is_cinema else "High-energy hype"
        chosen.append(
            HighlightCandidate(
                start_ms=s_ms,
                end_ms=e_ms,
                score=max(60, min(99, int(round(65 + pt.score * 33)))),
                title=f"{base_title} — {kind_lbl} #{rank_num}",
                seam_title=f"{base_title} (#{rank_num})",
                reason=f"{peak_lbl} peak at {pt.start_s:.1f}s (score {pt.score:.2f}).",
                cold_open_source_ms=None if is_cinema else min(max(s_ms, e_ms - 1600), peak_ms),
                pov_hook=f"POV: {base_title.upper()[:42]}",
                mood=mood,
            )
        )

    if not chosen:
        end_cap = min(duration_ms, target_ms)
        co_fallback = None if is_cinema else min(max(0, end_cap - 1600), target_ms // 2)
        chosen.append(
            HighlightCandidate(
                start_ms=0,
                end_ms=end_cap,
                score=75,
                title=(source_title or "Highlight Clip")[:80],
                seam_title=(source_title or "Highlight Clip")[:80],
                reason="Default opening highlight segment.",
                cold_open_source_ms=co_fallback,
                pov_hook=f"POV: {(source_title or 'WATCH THIS').upper()[:42]}",
                mood=mood,
            )
        )
    chosen.sort(key=lambda c: c.score, reverse=True)
    return chosen


def _parse_candidate_item(
    item: dict[str, Any],
    *,
    duration_ms: int,
    source_title: str,
    default_mood: str,
) -> HighlightCandidate | None:
    raw_slices = item.get("slices")
    parsed_slices: list[tuple[int, int]] = []
    if isinstance(raw_slices, list):
        for sl in raw_slices:
            if not isinstance(sl, dict):
                continue
            try:
                sl_s = max(0, int(round(float(sl.get("startSec", 0.0)) * 1000.0)))
                sl_e = min(duration_ms, int(round(float(sl.get("endSec", 0.0)) * 1000.0)))
            except (TypeError, ValueError):
                continue
            if sl_e - sl_s >= 1200:
                parsed_slices.append((sl_s, sl_e))
        parsed_slices.sort(key=lambda pair: pair[0])

    if parsed_slices:
        s_ms = parsed_slices[0][0]
        e_ms = parsed_slices[-1][1]
    else:
        s_ms = max(0, int(round(float(item.get("startSec", 0.0)) * 1000.0)))
        e_ms = min(duration_ms, int(round(float(item.get("endSec", 0.0)) * 1000.0)))

    if e_ms - s_ms < 2000:
        return None

    co_raw = item.get("coldOpenSec")
    co_ms = (
        max(s_ms, min(e_ms - 600, int(round(float(co_raw) * 1000.0))))
        if co_raw is not None
        else None
    )
    title = str(item.get("title") or source_title or "Highlight Clip").strip()[:140]
    seam_title = str(item.get("seamTitle") or title).strip()[:120]
    pov_raw = str(item.get("povHook") or "").strip()
    if pov_raw and not pov_raw.upper().startswith("POV:"):
        pov_raw = f"POV: {pov_raw}"
    pov_hook = (pov_raw or f"POV: {seam_title}").upper()[:64]
    mood_raw = str(item.get("mood") or default_mood).strip().lower()
    mood = mood_raw if mood_raw in _VALID_MOODS else default_mood

    return HighlightCandidate(
        start_ms=s_ms,
        end_ms=e_ms,
        score=max(1, min(100, int(item.get("score", 80)))),
        title=title,
        seam_title=seam_title,
        reason=str(item.get("reason") or "").strip()[:300],
        cold_open_source_ms=co_ms,
        slices=parsed_slices if len(parsed_slices) > 1 else None,
        pov_hook=pov_hook,
        mood=mood,
    )


def discover_highlights(
    transcript: TranscriptResult,
    hype_curve: list[HypePoint],
    duration_ms: int,
    profile: CreatorProfile,
    *,
    source_title: str = "",
) -> list[HighlightCandidate]:
    """Discover ranked viral clips or multi-scene cinema arcs across the full runtime."""
    if not transcript.segments:
        return _heuristic_hype_highlights(hype_curve, duration_ms, profile, source_title)

    is_cinema = profile.content_mode == "cinema"
    default_mood = _default_mood(profile)
    act_chunks = chunk_compact_transcript(transcript.segments, chunk_chars=26_000, max_chunks=5)
    if not act_chunks:
        return _heuristic_hype_highlights(hype_curve, duration_ms, profile, source_title)

    top_peaks = sorted(hype_curve, key=lambda p: p.score, reverse=True)[:12]
    peaks_hint = ", ".join(f"{p.start_s:.1f}s ({p.score:.2f})" for p in top_peaks)

    if is_cinema:
        system_prompt = (
            "You are an elite viral Cinema & TV Shorts editor (JJ_EDIT style). "
            "Select gripping confrontations, cold comebacks, power shifts, and emotional payoffs. "
            "Leave 1.0-1.8s of trailing silence/stare after the final punchline so tension lands. "
            "Either select one continuous scene OR stitch 2-4 sub-slices (`slices`) cutting dead "
            "exposition into a cohesive story arc up to max_duration_s (up to 180s). "
            "Return STRICT JSON: {\"clips\": [{\"startSec\": number, \"endSec\": number, "
            "\"slices\": [{\"startSec\": number, \"endSec\": number}], \"score\": int 1..100, "
            "\"title\": string, \"seamTitle\": string, \"povHook\": string "
            "(e.g. 'POV: HE ALMOST DIED.'), \"mood\": 'dark_cinema'|'suspense'|'emotional', "
            "\"reason\": string}]}."
        )
    else:
        system_prompt = (
            "You are an expert short-form video editor selecting viral Shorts/TikTok/Reels clips. "
            "Return STRICT JSON object: {\"clips\": [{\"startSec\": number, \"endSec\": number, "
            "\"slices\": [{\"startSec\": number, \"endSec\": number}], \"score\": int 1..100, "
            "\"title\": string, \"seamTitle\": string (punchy 5-10 word Title Case hook card), "
            "\"povHook\": string, \"mood\": 'upbeat_gaming'|'suspense', \"reason\": string, "
            "\"coldOpenSec\": number}]}. Never exceed video duration. Prefer complete punchlines."
        )

    per_act_limit = max(2, min(profile.max_clips, (profile.max_clips // len(act_chunks)) + 2))
    collected: list[HighlightCandidate] = []

    try:
        for act_idx, chunk_tx in enumerate(act_chunks, start=1):
            act_header = (
                f"Act chunk {act_idx}/{len(act_chunks)}\n" if len(act_chunks) > 1 else ""
            )
            user_prompt = (
                f"{act_header}"
                f"Source title: {source_title or 'Untitled Media'}\n"
                f"Content mode: {profile.content_mode}\n"
                f"Total duration: {duration_ms / 1000.0:.1f}s\n"
                f"Creator profile: {profile.name} ({profile.creator_name or 'Creator'})\n"
                f"Editorial brief: {profile.brief}\n"
                f"Editor boundaries: {profile.editor_boundaries or 'None'}\n"
                f"Duration window: {profile.min_duration_s:.0f}s to {profile.max_duration_s:.0f}s\n"
                f"Max clips for this pass: {per_act_limit}\n"
                f"Top hype/cadence peaks: {peaks_hint or 'none'}\n\n"
                f"Transcript:\n{chunk_tx}"
            )
            payload = complete_json(user_prompt, system_prompt=system_prompt, role="scan")
            raw_clips = payload.get("clips") if isinstance(payload, dict) else payload
            if not isinstance(raw_clips, list):
                raise LLMError("LLM highlight response did not contain a clips list.")

            for item in raw_clips[:per_act_limit]:
                if not isinstance(item, dict):
                    continue
                cand = _parse_candidate_item(
                    item,
                    duration_ms=duration_ms,
                    source_title=source_title,
                    default_mood=default_mood,
                )
                if cand is not None:
                    collected.append(cand)

        if collected:
            collected.sort(key=lambda c: c.score, reverse=True)
            deduped: list[HighlightCandidate] = []
            for cand in collected:
                if len(deduped) >= profile.max_clips:
                    break
                # Skip candidates overlapping >35% with an already chosen higher-scoring clip
                overlaps = any(
                    max(0, min(cand.end_ms, ex.end_ms) - max(cand.start_ms, ex.start_ms))
                    > 0.35 * min(cand.end_ms - cand.start_ms, ex.end_ms - ex.start_ms)
                    for ex in deduped
                )
                if not overlaps:
                    deduped.append(cand)
            if deduped:
                return deduped
    except Exception as exc:
        log.info("Highlight LLM skipped/fallback (%s); using Hype Curve selector.", exc)

    return _heuristic_hype_highlights(hype_curve, duration_ms, profile, source_title)


def detect_webcam_box(frame_jpg_path: Path, profile: CreatorProfile) -> NormalizedBox | None:
    """Detect a streamer facecam bounding box via Vision LLM when split framing is desired."""
    if profile.content_mode == "cinema" or profile.layout_mode in ("fit", "centre", "crop"):
        return None
    if not frame_jpg_path.is_file():
        return None

    try:
        image_b64 = base64.b64encode(frame_jpg_path.read_bytes()).decode("ascii")
        resp = complete_json(
            "Locate the streamer facecam rectangle in this video frame. "
            "Return JSON: {\"hasWebcam\": boolean, \"x\": float, \"y\": float, "
            "\"w\": float, \"h\": float} in normalized 0..1 coordinates.",
            system_prompt="You are a computer vision layout detector. Output strict JSON only.",
            role="editor",
            image_b64=image_b64,
        )
        if isinstance(resp, dict) and resp.get("hasWebcam"):
            box = NormalizedBox(
                x=float(resp["x"]),
                y=float(resp["y"]),
                w=float(resp["w"]),
                h=float(resp["h"]),
            ).clamped()
            return box
        return None
    except Exception as exc:
        log.debug("Vision webcam detection skipped (%s).", exc)
        if profile.layout_mode == "split":
            return NormalizedBox(x=0.02, y=0.28, w=0.24, h=0.26)
        return None
