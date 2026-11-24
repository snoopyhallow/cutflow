"""100Hz waveform peaks.json generator and 2-second RMS energy scanner for Hype Curves."""

from __future__ import annotations

import json
import wave
from pathlib import Path
from typing import Any

import numpy as np


def read_mono_pcm_f32(wav_path: Path) -> tuple[int, np.ndarray]:
    """Read a 16-bit PCM WAV file into float32 mono samples normalized to [-1.0, 1.0]."""
    with wave.open(str(wav_path), "rb") as wf:
        channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if sample_width != 2:
        raise ValueError(f"Expected 16-bit PCM WAV (sampwidth=2), got {sample_width}.")
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return sample_rate, samples


def compute_peaks_100hz(wav_path: Path, *, rate_hz: int = 100) -> dict[str, Any]:
    """Generate compact 100Hz amplitude envelope (peaks & RMS in [0, 1]) for canvas waveforms."""
    sr, samples = read_mono_pcm_f32(wav_path)
    if samples.size == 0 or sr <= 0:
        return {"rateHz": rate_hz, "durationMs": 0, "peaks": [], "rms": []}

    step = max(1, int(round(sr / rate_hz)))
    usable = (samples.size // step) * step
    if usable == 0:
        peak_val = float(np.max(np.abs(samples)))
        rms_val = float(np.sqrt(np.mean(samples * samples)))
        return {
            "rateHz": rate_hz,
            "durationMs": int(round(samples.size * 1000.0 / sr)),
            "peaks": [round(peak_val, 4)],
            "rms": [round(rms_val, 4)],
        }

    blocks = samples[:usable].reshape(-1, step)
    peaks = np.max(np.abs(blocks), axis=1)
    rms = np.sqrt(np.mean(blocks * blocks, axis=1))

    # Normalize peak envelope against 99th percentile so loud peaks stay crisp
    ref = float(np.percentile(peaks, 99)) if peaks.size else 1.0
    scale = 1.0 / max(ref, 1e-4)
    peaks_norm = np.clip(peaks * scale, 0.0, 1.0)
    rms_norm = np.clip(rms * scale, 0.0, 1.0)

    return {
        "rateHz": rate_hz,
        "durationMs": int(round(samples.size * 1000.0 / sr)),
        "peaks": [round(float(v), 3) for v in peaks_norm],
        "rms": [round(float(v), 3) for v in rms_norm],
    }


def write_peaks_json(wav_path: Path, out_json: Path, *, rate_hz: int = 100) -> Path:
    data = compute_peaks_100hz(wav_path, rate_hz=rate_hz)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    return out_json


def compute_rms_windows(
    wav_path: Path, *, window_s: float = 2.0
) -> list[tuple[float, float, float]]:
    """Return ``[(start_s, end_s, normalized_energy_0_to_1), ...]`` across the full WAV."""
    sr, samples = read_mono_pcm_f32(wav_path)
    if samples.size == 0 or sr <= 0:
        return []

    win_samples = max(1, int(round(sr * window_s)))
    n_windows = max(1, int(np.ceil(samples.size / win_samples)))
    energies = np.zeros(n_windows, dtype=np.float32)

    for idx in range(n_windows):
        seg = samples[idx * win_samples : (idx + 1) * win_samples]
        if seg.size > 0:
            energies[idx] = float(np.sqrt(np.mean(seg * seg)))

    mean = float(np.mean(energies))
    std = float(np.std(energies))
    if std < 1e-6:
        z_norm = np.full_like(energies, 0.5)
    else:
        # Map z-score [-1.0, +3.0] -> [0.0, 1.0] so sudden loud bursts stand out clearly
        z = (energies - mean) / std
        z_norm = np.clip((z + 1.0) / 4.0, 0.0, 1.0)

    total_s = samples.size / sr
    out: list[tuple[float, float, float]] = []
    for idx, score in enumerate(z_norm):
        s0 = idx * window_s
        s1 = min(total_s, (idx + 1) * window_s)
        out.append((round(s0, 3), round(s1, 3), round(float(score), 4)))
    return out
