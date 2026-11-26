"""Multi-Signal Hype Curve engine (Stream RMS/Heatmap fusion + Cinema Speech-Cadence scoring)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from ..audio.peaks import compute_rms_windows

if TYPE_CHECKING:
    from .transcription import TranscriptSegment


@dataclass(slots=True)
class HypePoint:
    start_s: float
    end_s: float
    score: float

    def to_dict(self) -> dict[str, float]:
        return {"startS": self.start_s, "endS": self.end_s, "score": self.score}


@dataclass(slots=True)
class HotWindow:
    start_ms: int
    end_ms: int
    peak_score: float


def _sample_heatmap(heatmap: list[dict[str, Any]], start_s: float, end_s: float) -> float:
    """Average normalized YouTube/Chapter heatmap values overlapping ``[start_s, end_s]``."""
    vals: list[float] = []
    for entry in heatmap:
        try:
            h0 = float(entry.get("start_time", 0.0))
            h1 = float(entry.get("end_time", h0))
            val = float(entry.get("value", 0.0))
        except (TypeError, ValueError):
            continue
        if h1 >= start_s and h0 <= end_s:
            vals.append(max(0.0, min(1.0, val)))
    return sum(vals) / len(vals) if vals else 0.0


def _dialogue_cadence_score(
    segments: list[TranscriptSegment] | None,
    start_s: float,
    end_s: float,
) -> float:
    """Score dramatic dialogue density & tension cues inside ``[start_s, end_s]``."""
    if not segments:
        return 0.0
    w_start_ms = int(start_s * 1000) - 1500
    w_end_ms = int(end_s * 1000) + 1500
    word_count = 0
    dramatic_punct = 0
    for seg in segments:
        if seg.end_ms < w_start_ms or seg.start_ms > w_end_ms:
            continue
        words = seg.text.split()
        word_count += len(words)
        if any(p in seg.text for p in ("?", "!", "...", "—")):
            dramatic_punct += 1
    if word_count == 0:
        return 0.0
    span_s = max(1.0, (w_end_ms - w_start_ms) / 1000.0)
    wps = word_count / span_s
    # Ideal dramatic exchange cadence is ~1.3 to 3.8 words/sec + tension punctuation
    cadence = min(1.0, wps / 2.8) if wps <= 3.8 else max(0.35, 1.0 - (wps - 3.8) * 0.12)
    bonus = min(0.25, dramatic_punct * 0.10)
    return min(1.0, cadence * 0.78 + bonus)


def build_hype_curve(
    wav_path: Path,
    heatmap: list[dict[str, Any]] | None = None,
    *,
    window_s: float = 2.0,
    content_mode: Literal["stream", "cinema"] = "stream",
    dialogue_segments: list[TranscriptSegment] | None = None,
) -> list[HypePoint]:
    """Build normalized Hype Curve tailored for either high-energy streams or dramatic cinema."""
    rms_windows = compute_rms_windows(wav_path, window_s=window_s)
    if not rms_windows:
        return []

    has_heatmap = bool(heatmap)
    has_dialogue = bool(dialogue_segments)
    curve: list[HypePoint] = []

    for idx, (start_s, end_s, rms_score) in enumerate(rms_windows):
        if content_mode == "cinema":
            # Dynamic contrast rewards sharp dramatic pauses/stares adjacent to crisp dialogue
            prev_rms = rms_windows[idx - 1][2] if idx > 0 else rms_score
            next_rms = rms_windows[idx + 1][2] if idx + 1 < len(rms_windows) else rms_score
            contrast = min(1.0, (abs(rms_score - prev_rms) + abs(rms_score - next_rms)) * 1.15)
            # Moderate vocal band [0.22..0.78] preferred over pure saturation >0.92 explosions
            vocal_band = (
                min(1.0, rms_score * 1.35)
                if rms_score <= 0.78
                else max(0.55, 1.0 - (rms_score - 0.78) * 1.1)
            )
            cinema_audio = 0.62 * vocal_band + 0.38 * contrast
            if has_dialogue:
                dlg = _dialogue_cadence_score(dialogue_segments, start_s, end_s)
                fused = 0.58 * dlg + 0.42 * cinema_audio
            else:
                fused = cinema_audio
            if has_heatmap and heatmap is not None:
                hm_score = _sample_heatmap(heatmap, start_s, end_s)
                fused = 0.40 * hm_score + 0.60 * fused
        else:
            if has_heatmap and heatmap is not None:
                hm_score = _sample_heatmap(heatmap, start_s, end_s)
                fused = 0.55 * hm_score + 0.45 * rms_score
            else:
                fused = rms_score

        clamped = round(max(0.0, min(1.0, fused)), 4)
        curve.append(HypePoint(start_s=start_s, end_s=end_s, score=clamped))
    return curve


def select_hot_windows(
    curve: list[HypePoint],
    duration_ms: int,
    *,
    long_vod_threshold_ms: int = 25 * 60 * 1000,
    max_windows: int = 18,
    window_span_ms: int = 75_000,
) -> list[HotWindow]:
    """Return full video for short files, or top non-overlapping hot windows for long VODs."""
    total_ms = max(0, int(duration_ms))
    if total_ms == 0:
        return []
    if total_ms <= long_vod_threshold_ms or not curve:
        peak = max((pt.score for pt in curve), default=0.5)
        return [HotWindow(start_ms=0, end_ms=total_ms, peak_score=round(peak, 4))]

    half = window_span_ms // 2
    ranked = sorted(curve, key=lambda p: p.score, reverse=True)
    chosen: list[HotWindow] = []

    for pt in ranked:
        if len(chosen) >= max_windows:
            break
        center_ms = int(round(((pt.start_s + pt.end_s) / 2.0) * 1000.0))
        w_start = max(0, center_ms - half)
        w_end = min(total_ms, w_start + window_span_ms)
        w_start = max(0, w_end - window_span_ms)
        if any(not (w_end <= c.start_ms or w_start >= c.end_ms) for c in chosen):
            continue
        chosen.append(HotWindow(start_ms=w_start, end_ms=w_end, peak_score=pt.score))

    chosen.sort(key=lambda w: w.start_ms)
    return chosen
