"""Multi-Signal Hype Curve engine fusing YouTube heatmaps with 2s WAV RMS burst scores."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..audio.peaks import compute_rms_windows


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
    """Average normalized YouTube heatmap values overlapping ``[start_s, end_s]``."""
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


def build_hype_curve(
    wav_path: Path,
    heatmap: list[dict[str, Any]] | None = None,
    *,
    window_s: float = 2.0,
) -> list[HypePoint]:
    """Fuse normalized YouTube heatmap (when present) with 2-second WAV RMS bursts."""
    rms_windows = compute_rms_windows(wav_path, window_s=window_s)
    if not rms_windows:
        return []

    has_heatmap = bool(heatmap)
    curve: list[HypePoint] = []
    for start_s, end_s, rms_score in rms_windows:
        if has_heatmap and heatmap is not None:
            hm_score = _sample_heatmap(heatmap, start_s, end_s)
            fused = 0.55 * hm_score + 0.45 * rms_score
        else:
            fused = rms_score
        curve.append(HypePoint(start_s=start_s, end_s=end_s, score=round(fused, 4)))
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
