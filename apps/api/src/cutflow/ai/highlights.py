"""Brief-tuned highlight & seam title card discovery plus Vision webcam detection."""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass
from pathlib import Path

from ..edl.schema import NormalizedBox
from ..workspace.profiles import CreatorProfile
from .hype import HypePoint
from .llm import LLMError, complete_json
from .transcription import TranscriptResult, encode_compact_transcript

log = logging.getLogger(__name__)


@dataclass(slots=True)
class HighlightCandidate:
    start_ms: int
    end_ms: int
    score: int
    title: str
    seam_title: str
    reason: str
    cold_open_source_ms: int | None = None


def _heuristic_hype_highlights(
    hype_curve: list[HypePoint],
    duration_ms: int,
    profile: CreatorProfile,
    source_title: str,
) -> list[HighlightCandidate]:
    """Deterministic fallback selector using Hype Curve peaks when no LLM key is present."""
    if duration_ms <= 0:
        return []

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
                reason="Selected full clip segment from audio energy envelope.",
                cold_open_source_ms=min(max(0, duration_ms - 1600), peak_ms),
            )
        ]

    ranked = sorted(hype_curve, key=lambda p: p.score, reverse=True)
    chosen: list[HighlightCandidate] = []
    for pt in ranked:
        if len(chosen) >= max_clips:
            break
        peak_ms = int(round(pt.start_s * 1000.0))
        # Lead-in 60% before climax peak, 40% reaction aftermath
        s_ms = max(0, peak_ms - int(target_ms * 0.6))
        e_ms = min(duration_ms, s_ms + target_ms)
        s_ms = max(0, e_ms - target_ms)
        if any(not (e_ms <= c.start_ms or s_ms >= c.end_ms) for c in chosen):
            continue
        rank_num = len(chosen) + 1
        base_title = (source_title or profile.name or "Clip").strip()[:60]
        chosen.append(
            HighlightCandidate(
                start_ms=s_ms,
                end_ms=e_ms,
                score=max(60, min(99, int(round(65 + pt.score * 33)))),
                title=f"{base_title} — Moment #{rank_num}",
                seam_title=f"{base_title} (Peak #{rank_num})",
                reason=f"High-energy audio/hype peak at {pt.start_s:.1f}s (score {pt.score:.2f}).",
                cold_open_source_ms=min(max(s_ms, e_ms - 1600), peak_ms),
            )
        )

    if not chosen:
        chosen.append(
            HighlightCandidate(
                start_ms=0,
                end_ms=min(duration_ms, target_ms),
                score=75,
                title=(source_title or "Highlight Clip")[:80],
                seam_title=(source_title or "Highlight Clip")[:80],
                reason="Default opening highlight segment.",
                cold_open_source_ms=min(max(0, min(duration_ms, target_ms) - 1600), target_ms // 2),
            )
        )
    chosen.sort(key=lambda c: c.score, reverse=True)
    return chosen


def discover_highlights(
    transcript: TranscriptResult,
    hype_curve: list[HypePoint],
    duration_ms: int,
    profile: CreatorProfile,
    *,
    source_title: str = "",
) -> list[HighlightCandidate]:
    """Discover ranked viral clips via configured LLM, with deterministic Hype Curve fallback."""
    if not transcript.segments:
        return _heuristic_hype_highlights(hype_curve, duration_ms, profile, source_title)

    compact_tx = encode_compact_transcript(transcript.segments)
    top_peaks = sorted(hype_curve, key=lambda p: p.score, reverse=True)[:10]
    peaks_hint = ", ".join(f"{p.start_s:.1f}s ({p.score:.2f})" for p in top_peaks)

    system_prompt = (
        "You are an expert short-form video editor selecting viral TikTok/Shorts/Reels clips. "
        "Return STRICT JSON object: {\"clips\": [{\"startSec\": number, \"endSec\": number, "
        "\"score\": int 1..100, \"title\": string, \"seamTitle\": string (punchy 5-10 word "
        "Title Case hook card), \"reason\": string, \"coldOpenSec\": number}]}. "
        "Never exceed video duration. Prefer complete punchlines and clean sentence boundaries."
    )
    user_prompt = (
        f"Source title: {source_title or 'Untitled VOD'}\n"
        f"Total duration: {duration_ms / 1000.0:.1f}s\n"
        f"Creator profile: {profile.name} ({profile.creator_name or 'Creator'})\n"
        f"Editorial brief: {profile.brief}\n"
        f"Editor boundaries: {profile.editor_boundaries or 'None'}\n"
        f"Duration window: {profile.min_duration_s:.0f}s to {profile.max_duration_s:.0f}s\n"
        f"Max clips: {profile.max_clips}\n"
        f"Top hype peaks: {peaks_hint or 'none'}\n\n"
        f"Transcript:\n{compact_tx}"
    )

    try:
        payload = complete_json(user_prompt, system_prompt=system_prompt, role="scan")
        raw_clips = payload.get("clips") if isinstance(payload, dict) else payload
        if not isinstance(raw_clips, list):
            raise LLMError("LLM highlight response did not contain a clips list.")

        results: list[HighlightCandidate] = []
        for item in raw_clips[: profile.max_clips]:
            if not isinstance(item, dict):
                continue
            s_ms = max(0, int(round(float(item.get("startSec", 0.0)) * 1000.0)))
            e_ms = min(duration_ms, int(round(float(item.get("endSec", 0.0)) * 1000.0)))
            if e_ms - s_ms < 2000:
                continue
            co_raw = item.get("coldOpenSec")
            co_ms = (
                max(s_ms, min(e_ms - 600, int(round(float(co_raw) * 1000.0))))
                if co_raw is not None
                else None
            )
            title = str(item.get("title") or source_title or "Highlight Clip").strip()[:140]
            seam_title = str(item.get("seamTitle") or title).strip()[:120]
            results.append(
                HighlightCandidate(
                    start_ms=s_ms,
                    end_ms=e_ms,
                    score=max(1, min(100, int(item.get("score", 80)))),
                    title=title,
                    seam_title=seam_title,
                    reason=str(item.get("reason") or "").strip()[:300],
                    cold_open_source_ms=co_ms,
                )
            )
        if results:
            results.sort(key=lambda c: c.score, reverse=True)
            return results
    except Exception as exc:
        log.info("Highlight LLM skipped/fallback (%s); using Hype Curve selector.", exc)

    return _heuristic_hype_highlights(hype_curve, duration_ms, profile, source_title)


def detect_webcam_box(frame_jpg_path: Path, profile: CreatorProfile) -> NormalizedBox | None:
    """Detect a streamer facecam bounding box via Vision LLM when split framing is desired."""
    if profile.layout_mode in ("fit", "centre", "crop"):
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
