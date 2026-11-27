"""AutoClip-parity word timing normalization + 20ms RMS audio-onset alignment."""

from __future__ import annotations

import gc
import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .peaks import read_mono_pcm_f32

log = logging.getLogger(__name__)


@dataclass(slots=True)
class WordTiming:
    text: str
    start_ms: int
    end_ms: int
    speaker: str | None = None
    confidence: float | None = None


def normalize_word_timings(
    words: list[WordTiming],
    *,
    min_word_ms: int = 120,
) -> list[WordTiming]:
    """Return strictly monotonic, non-overlapping word timings (ported from AutoClip).

    Whisper occasionally collapses consecutive rapid words onto the exact same timestamp
    (e.g. ``7020 -> 7020``). Spreading tied/collapsed runs proportionally across their
    available span before the next word prevents cascading rightward drift across a clip.
    """
    if not words:
        return []

    result = [
        WordTiming(
            text=w.text,
            start_ms=max(0, int(w.start_ms)),
            end_ms=max(max(0, int(w.start_ms)), int(w.end_ms)),
            speaker=w.speaker,
            confidence=w.confidence,
        )
        for w in words
    ]

    n = len(result)
    i = 0
    while i < n:
        j = i
        run_start = result[i].start_ms
        run_max_end = result[i].end_ms
        while j + 1 < n and result[j + 1].start_ms <= run_start + 1:
            j += 1
            if result[j].end_ms > run_max_end:
                run_max_end = result[j].end_ms

        if j > i:
            next_start = result[j + 1].start_ms if j + 1 < n else None
            count = j - i + 1
            if run_max_end > run_start + 1:
                run_end = run_max_end
                if next_start is not None and next_start > run_start:
                    run_end = min(run_end, next_start)
            elif next_start is not None and next_start > run_start:
                run_end = min(next_start, run_start + count * 250)
            else:
                run_end = run_start + count * min_word_ms

            weights = [max(1, len(result[k].text.strip())) for k in range(i, j + 1)]
            total_weight = sum(weights)
            span = max(10 * count, run_end - run_start)
            cursor = run_start
            for offset, k in enumerate(range(i, j + 1)):
                if k == j:
                    slice_end = run_end
                else:
                    slice_end = cursor + int(round(span * (weights[offset] / total_weight)))
                result[k].start_ms = cursor
                result[k].end_ms = max(cursor, slice_end)
                cursor = result[k].end_ms
            i = j + 1
        else:
            i += 1

    # Enforce strict non-overlap without pushing subsequent words past their real starts
    for idx, word in enumerate(result):
        if idx > 0 and word.start_ms < result[idx - 1].end_ms:
            prev = result[idx - 1]
            if word.start_ms > prev.start_ms:
                prev.end_ms = word.start_ms
            else:
                word.start_ms = prev.end_ms
        if word.end_ms < word.start_ms:
            word.end_ms = word.start_ms

    # Apply readable minimum duration ONLY into genuine free space before the next word
    floor_ms = max(60, int(min_word_ms))
    for idx, word in enumerate(result):
        target_end = word.start_ms + floor_ms
        if idx + 1 < n:
            next_start = result[idx + 1].start_ms
            if word.end_ms > next_start:
                word.end_ms = max(word.start_ms + 40, next_start)
            target_end = min(target_end, next_start)
        if word.end_ms < target_end:
            word.end_ms = target_end
        if word.end_ms <= word.start_ms:
            word.end_ms = word.start_ms + 40

    return result


def align_words_to_audio(
    words: list[WordTiming],
    wav_path: Path,
    *,
    window_ms: int = 20,
    min_stretch_ms: int = 350,
    min_word_ms: int = 120,
) -> list[WordTiming]:
    """Snap Whisper silence-stretched word starts/ends onto measured voice energy (AutoClip parity).

    Whisper frequently stretches the first word after a pause 0.5-2.5s backwards into silence
    or lets the last word linger into trailing silence. By only clamping words wider than
    ``min_stretch_ms`` and walking backwards from the active vocal core across natural <=240ms
    consonant dips, normal rapid speech stays untouched while pre-speech early pop-ins disappear.
    """
    if not words or not wav_path.is_file():
        return normalize_word_timings(words, min_word_ms=min_word_ms)

    sr, samples = read_mono_pcm_f32(wav_path)
    if samples.size == 0 or sr <= 0:
        return normalize_word_timings(words, min_word_ms=min_word_ms)

    bin_ms = max(10, int(window_ms))
    step = max(1, int(round(sr * (bin_ms / 1000.0))))
    n_bins = int(samples.size // step)
    if n_bins < 5:
        return normalize_word_timings(words, min_word_ms=min_word_ms)

    rms = np.sqrt(np.mean(samples[: n_bins * step].reshape(n_bins, step) ** 2, axis=1)).astype(
        np.float32
    )
    global_floor = float(np.percentile(rms, 15))
    bridge_bins = max(1, int(round(240 / bin_ms)))  # 240ms intra-word consonant dip bridge
    context_bins = max(10, int(round(4000 / bin_ms)))  # ±4.0s local noise floor window

    aligned: list[WordTiming] = []
    for w in words:
        s_ms = max(0, int(w.start_ms))
        e_ms = max(s_ms, int(w.end_ms))
        if (e_ms - s_ms) > min_stretch_ms:
            b0 = max(0, min(n_bins - 1, s_ms // bin_ms))
            b1 = min(n_bins, (e_ms // bin_ms) + 1)
            seg = rms[b0:b1]
            if seg.size >= 5:
                peak = float(np.max(seg))
                lo0 = max(0, b0 - context_bins)
                lo1 = min(n_bins, b1 + context_bins)
                local_floor = float(np.percentile(rms[lo0:lo1], 15))
                thresh = max(0.020, max(global_floor, local_floor) * 2.5, peak * 0.20)
                active = np.flatnonzero(seg >= thresh)
                if active.size > 0:
                    last_a = int(active[-1])
                    run_start = last_a
                    k = int(active.size) - 2
                    while k >= 0 and int(active[k + 1] - active[k]) <= bridge_bins:
                        run_start = int(active[k])
                        k -= 1
                    new_s = (b0 + run_start) * bin_ms - 40
                    new_e = (b0 + last_a + 1) * bin_ms + 60
                    s_ms = max(s_ms, min(e_ms - min_word_ms, new_s))
                    e_ms = min(e_ms, max(s_ms + min_word_ms, new_e))

        aligned.append(
            WordTiming(
                text=w.text,
                start_ms=s_ms,
                end_ms=max(s_ms + 40, e_ms),
                speaker=w.speaker,
                confidence=w.confidence,
            )
        )

    return normalize_word_timings(aligned, min_word_ms=min_word_ms)


def run_clip_scoped_alignment(
    words: list[WordTiming],
    clip_wav_path: Path,
    *,
    mode: str = "auto",
) -> list[WordTiming]:
    """Run optional clip-scoped forced phoneme alignment, release VRAM, then apply 20ms clamp."""
    refined = list(words)
    if mode in ("auto", "stable_ts") and refined:
        try:
            import stable_whisper  # type: ignore[import-not-found]

            text = " ".join(w.text for w in refined)
            model = stable_whisper.load_model("base")
            try:
                res = model.align(str(clip_wav_path), text, language="en")
                extracted: list[WordTiming] = []
                for seg in getattr(res, "segments", []):
                    for sw in getattr(seg, "words", []):
                        token = str(getattr(sw, "word", "")).strip()
                        if not token:
                            continue
                        s_ms = max(0, int(round(float(sw.start) * 1000)))
                        e_ms = max(s_ms + 60, int(round(float(sw.end) * 1000)))
                        extracted.append(WordTiming(text=token, start_ms=s_ms, end_ms=e_ms))
                if extracted:
                    refined = extracted
            finally:
                del model
                gc.collect()
        except ImportError:
            pass
        except Exception as exc:
            log.warning("Clip-scoped stable_whisper alignment skipped: %s", exc)

    return align_words_to_audio(refined, clip_wav_path, window_ms=20)
