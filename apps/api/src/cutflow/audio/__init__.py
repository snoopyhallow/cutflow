"""Audio/media utilities: FFprobe, 16kHz WAV, 100Hz peaks, lossless slices, and 20ms aligner."""

from .align import WordTiming, align_words_to_audio, run_clip_scoped_alignment
from .media import (
    MediaError,
    MediaInfo,
    extract_frame_jpeg,
    extract_lossless_clip_slice,
    extract_wav_16k,
    probe_media,
)
from .peaks import compute_peaks_100hz, compute_rms_windows, read_mono_pcm_f32, write_peaks_json

__all__ = [
    "MediaError",
    "MediaInfo",
    "WordTiming",
    "align_words_to_audio",
    "compute_peaks_100hz",
    "compute_rms_windows",
    "extract_frame_jpeg",
    "extract_lossless_clip_slice",
    "extract_wav_16k",
    "probe_media",
    "read_mono_pcm_f32",
    "run_clip_scoped_alignment",
    "write_peaks_json",
]
