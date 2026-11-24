"""Sequential clip-scoped forced alignment + 20ms RMS audio-onset word timing clamp."""

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


def _frame_rms_envelope(wav_path: Path, window_ms: int = 20) -> tuple[np.ndarray, int]:
    """Compute mono RMS energy in ``window_ms`` buckets. Returns ``(rms_array, window_ms)``."""
    sr, samples = read_mono_pcm_f32(wav_path)
    if samples.size == 0 or sr <= 0:
        return np.zeros(0, dtype=np.float32), window_ms

    step = max(1, int(round(sr * (window_ms / 1000.0))))
    usable = (samples.size // step) * step
    if usable == 0:
        val = float(np.sqrt(np.mean(samples * samples)))
        return np.array([val], dtype=np.float32), window_ms

    blocks = samples[:usable].reshape(-1, step)
    rms = np.sqrt(np.mean(blocks * blocks, axis=1)).astype(np.float32)
    return rms, window_ms


def align_words_to_audio(
    words: list[WordTiming],
    wav_path: Path,
    *,
    window_ms: int = 20,
    max_shift_ms: int = 1800,
    onset_ratio: float = 0.22,
    min_word_ms: int = 60,
) -> list[WordTiming]:
    """Clamp Whisper silence-stretched word timestamps onto real 20ms speech energy onsets.

    Eliminates the classic 0.5-2.0s early subtitle pop-in where ASR stretches the first word
    of an utterance backwards across dead air before the speaker actually talks.
    """
    if not words:
        return []

    rms, step_ms = _frame_rms_envelope(wav_path, window_ms=window_ms)
    if rms.size == 0:
        return list(words)

    noise_floor = float(np.percentile(rms, 15))
    global_peak = float(np.percentile(rms, 95))
    if global_peak <= noise_floor + 1e-5:
        return list(words)

    aligned: list[WordTiming] = []
    n_frames = int(rms.size)

    for w in words:
        start_ms = max(0, int(w.start_ms))
        end_ms = max(start_ms + min_word_ms, int(w.end_ms))

        f0 = max(0, min(n_frames - 1, start_ms // step_ms))
        f1 = max(f0 + 1, min(n_frames, (end_ms + step_ms - 1) // step_ms))
        segment = rms[f0:f1]

        if segment.size >= 3:
            local_peak = float(np.max(segment))
            threshold = max(
                noise_floor * 2.2,
                noise_floor + (local_peak - noise_floor) * onset_ratio,
                noise_floor + (global_peak - noise_floor) * 0.08,
            )

            # Snap start forward if the opening frame(s) are silent dead air
            if float(segment[0]) < threshold and local_peak >= threshold:
                above = np.flatnonzero(segment >= threshold)
                if above.size > 0:
                    onset_offset_frames = int(above[0])
                    if onset_offset_frames > 0:
                        candidate_start = (f0 + onset_offset_frames) * step_ms - step_ms
                        candidate_start = min(candidate_start, start_ms + max_shift_ms)
                        candidate_start = min(candidate_start, end_ms - min_word_ms)
                        if candidate_start > start_ms:
                            start_ms = candidate_start

            # Trim excessive trailing dead air (>400ms past last speech frame)
            above_all = np.flatnonzero(segment >= threshold * 0.85)
            if above_all.size > 0:
                last_active_ms = (f0 + int(above_all[-1]) + 1) * step_ms + 160
                if end_ms - last_active_ms > 400:
                    end_ms = max(start_ms + min_word_ms, last_active_ms)

        if aligned and start_ms < aligned[-1].end_ms:
            start_ms = aligned[-1].end_ms
            end_ms = max(start_ms + min_word_ms, end_ms)

        aligned.append(
            WordTiming(
                text=w.text,
                start_ms=start_ms,
                end_ms=end_ms,
                speaker=w.speaker,
                confidence=w.confidence,
            )
        )

    return aligned


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
