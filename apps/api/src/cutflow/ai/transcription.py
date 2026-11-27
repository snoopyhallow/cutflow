"""Hybrid ASR transcription: Groq, GTX 1050 Ti int8 faster-whisper, OpenAI, or Gemini Audio."""

from __future__ import annotations

import base64
import gc
import logging
import tempfile
import wave
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from .. import config
from ..audio.align import WordTiming, align_words_to_audio, normalize_word_timings
from ..audio.peaks import read_mono_pcm_f32
from ..cuda import ensure_cuda_libraries
from ..security import get_secret
from .hype import HotWindow
from .llm import parse_json_payload

log = logging.getLogger(__name__)

_GEMINI_AUDIO_MODELS: tuple[str, ...] = (
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.1-flash-lite",
)

_WHISPER_MODEL_CACHE: dict[tuple[str, str, str], object] = {}


def release_whisper_cache() -> None:
    """Release any cached faster-whisper model from CPU/CUDA memory."""
    if not _WHISPER_MODEL_CACHE:
        return
    _WHISPER_MODEL_CACHE.clear()
    gc.collect()
    try:
        import torch  # type: ignore[import-not-found]

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _get_whisper_model(model_size: str, device: str, compute_type: str) -> object:
    key = (model_size, device, compute_type)
    cached = _WHISPER_MODEL_CACHE.get(key)
    if cached is not None:
        return cached
    release_whisper_cache()
    from faster_whisper import WhisperModel  # type: ignore[import-not-found]

    loaded = WhisperModel(model_size, device=device, compute_type=compute_type)
    _WHISPER_MODEL_CACHE[key] = loaded
    return loaded


@dataclass(slots=True)
class TranscriptSegment:
    start_ms: int
    end_ms: int
    text: str
    words: list[WordTiming] = field(default_factory=list)


@dataclass(slots=True)
class TranscriptResult:
    language: str
    provider: str
    segments: list[TranscriptSegment]
    words: list[WordTiming]


def _segments_from_words(
    words: list[WordTiming], max_gap_ms: int = 1200
) -> list[TranscriptSegment]:
    if not words:
        return []
    segments: list[TranscriptSegment] = []
    bucket: list[WordTiming] = [words[0]]
    for w in words[1:]:
        if w.start_ms - bucket[-1].end_ms > max_gap_ms or len(bucket) >= 18:
            segments.append(
                TranscriptSegment(
                    start_ms=bucket[0].start_ms,
                    end_ms=bucket[-1].end_ms,
                    text=" ".join(item.text for item in bucket),
                    words=bucket,
                )
            )
            bucket = [w]
        else:
            bucket.append(w)
    if bucket:
        segments.append(
            TranscriptSegment(
                start_ms=bucket[0].start_ms,
                end_ms=bucket[-1].end_ms,
                text=" ".join(item.text for item in bucket),
                words=bucket,
            )
        )
    return segments


def _words_from_segment_span(text: str, start_ms: int, end_ms: int) -> list[WordTiming]:
    """Distribute tokens proportionally across ``[start_ms, end_ms]`` when word stops are absent."""
    tokens = [tok for tok in text.strip().split() if tok]
    if not tokens:
        return []
    span = max(len(tokens) * 70, end_ms - start_ms)
    total_chars = max(1, sum(max(1, len(t)) for t in tokens))
    cursor = start_ms
    out: list[WordTiming] = []
    for idx, tok in enumerate(tokens):
        weight = max(1, len(tok)) / total_chars
        dur = max(65, int(round(span * weight)))
        w_end = end_ms if idx == len(tokens) - 1 else min(end_ms, cursor + dur)
        w_end = max(cursor + 60, w_end)
        out.append(WordTiming(text=tok, start_ms=cursor, end_ms=w_end))
        cursor = min(max(start_ms, end_ms - 60), w_end)
    return out


def select_faster_whisper_targets() -> list[tuple[str, str]]:
    """Return ordered ``(device, compute_type)`` targets safe for Pascal GPUs & CPU."""
    ensure_cuda_libraries()
    targets: list[tuple[str, str]] = []
    try:
        import ctranslate2  # type: ignore[import-not-found]

        if ctranslate2.get_cuda_device_count() > 0:
            supported = set(ctranslate2.get_supported_compute_types("cuda"))
            if "float16" in supported:
                targets.append(("cuda", "float16"))
            elif "int8" in supported:
                targets.append(("cuda", "int8"))
            else:
                targets.append(("cuda", "float32"))
    except Exception:
        pass
    targets.append(("cpu", "int8"))
    return targets


def _transcribe_cloud_whisper(
    wav_path: Path,
    *,
    endpoint: str,
    api_key: str,
    model: str,
    language: str,
    initial_prompt: str,
    provider_name: str,
) -> TranscriptResult:
    data: dict[str, str | list[str]] = {
        "model": model,
        "response_format": "verbose_json",
        "timestamp_granularities[]": "word",
    }
    if language:
        data["language"] = language
    if initial_prompt:
        data["prompt"] = initial_prompt[:400]

    with wav_path.open("rb") as fh, httpx.Client(timeout=180.0) as client:
        resp = client.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}"},
            data=data,
            files={"file": (wav_path.name, fh, "audio/wav")},
        )
        resp.raise_for_status()
        payload = resp.json()

    words: list[WordTiming] = []
    for item in payload.get("words") or []:
        token = str(item.get("word") or "").strip()
        if not token:
            continue
        s_ms = max(0, int(round(float(item.get("start", 0.0)) * 1000.0)))
        e_ms = max(s_ms + 60, int(round(float(item.get("end", s_ms / 1000.0)) * 1000.0)))
        words.append(WordTiming(text=token, start_ms=s_ms, end_ms=e_ms))

    segments = _segments_from_words(words)
    if not segments:
        for seg in payload.get("segments") or []:
            text = str(seg.get("text") or "").strip()
            if not text:
                continue
            s_ms = max(0, int(round(float(seg.get("start", 0.0)) * 1000.0)))
            e_ms = max(s_ms + 100, int(round(float(seg.get("end", s_ms / 1000.0)) * 1000.0)))
            seg_words = _words_from_segment_span(text, s_ms, e_ms)
            words.extend(seg_words)
            segments.append(
                TranscriptSegment(start_ms=s_ms, end_ms=e_ms, text=text, words=seg_words)
            )

    words = align_words_to_audio(words, wav_path) if words else normalize_word_timings(words)
    segments = _segments_from_words(words) if words else segments
    return TranscriptResult(
        language=str(payload.get("language") or language or "en"),
        provider=provider_name,
        segments=segments,
        words=words,
    )


def _load_whisper_pcm_16k(wav_path: Path) -> object:
    """Decode a 16kHz WAV file into a 1-D float32 numpy array without PyAV ``av.open``.

    Avoids the PyAV >= 19 ``open() got an unexpected keyword argument 'metadata_errors'``
    crash inside ``faster_whisper.audio.decode_audio`` while running with zero subprocesses.
    """
    sr, samples = read_mono_pcm_f32(wav_path)
    if samples.size == 0:
        return samples
    if sr != 16000 and sr > 0:
        import numpy as np

        target_len = max(1, int(round(samples.size * (16000.0 / sr))))
        x_old = np.linspace(0.0, 1.0, num=samples.size, endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=target_len, endpoint=False)
        samples = np.interp(x_new, x_old, samples).astype(np.float32)
    return samples


def _transcribe_faster_whisper(
    wav_path: Path,
    *,
    model_size: str,
    language: str,
    initial_prompt: str,
    no_speech_threshold: float,
    log_prob_threshold: float,
) -> TranscriptResult:
    ensure_cuda_libraries()
    import faster_whisper as _fw  # type: ignore[import-not-found]  # noqa: F401

    pcm_samples = _load_whisper_pcm_16k(wav_path)
    if getattr(pcm_samples, "size", 0) == 0:
        return TranscriptResult(
            language=language or "en",
            provider="faster_whisper:empty",
            segments=[],
            words=[],
        )

    last_exc: Exception | None = None
    for device, compute_type in select_faster_whisper_targets():
        try:
            model = _get_whisper_model(model_size, device, compute_type)
            # Match AutoClip's exact Whisper decoding parameters:
            # vad_filter=False keeps speech over game audio / movie music without shifting
            # timestamps or requiring onnxruntime; beam_size=5 + hallucination_silence_threshold
            # gives crisp, word-accurate DTW alignment.
            seg_iter, info = model.transcribe(  # type: ignore[attr-defined]
                pcm_samples,  # type: ignore[arg-type]
                language=language or None,
                word_timestamps=True,
                vad_filter=False,
                beam_size=5,
                condition_on_previous_text=True,
                hallucination_silence_threshold=1.5,
                repetition_penalty=1.05,
                no_speech_threshold=no_speech_threshold,
                log_prob_threshold=log_prob_threshold,
                initial_prompt=initial_prompt or None,
            )
            segments: list[TranscriptSegment] = []
            all_words: list[WordTiming] = []
            for seg in seg_iter:
                seg_words: list[WordTiming] = []
                for w in getattr(seg, "words", None) or []:
                    token = str(getattr(w, "word", "")).strip()
                    if not token:
                        continue
                    s_ms = max(0, int(round(float(w.start) * 1000.0)))
                    e_ms = max(s_ms + 60, int(round(float(w.end) * 1000.0)))
                    wt = WordTiming(
                        text=token,
                        start_ms=s_ms,
                        end_ms=e_ms,
                        confidence=getattr(w, "probability", None),
                    )
                    seg_words.append(wt)
                    all_words.append(wt)
                text = str(getattr(seg, "text", "")).strip()
                if text:
                    s_seg = max(0, int(round(float(seg.start) * 1000.0)))
                    e_seg = max(s_seg + 100, int(round(float(seg.end) * 1000.0)))
                    if not seg_words:
                        seg_words = _words_from_segment_span(text, s_seg, e_seg)
                        all_words.extend(seg_words)
                    segments.append(
                        TranscriptSegment(
                            start_ms=s_seg,
                            end_ms=e_seg,
                            text=text,
                            words=seg_words,
                        )
                    )
            all_words = align_words_to_audio(all_words, wav_path)
            segments = _segments_from_words(all_words) if all_words else segments
            lang = str(getattr(info, "language", "") or language or "en")
            return TranscriptResult(
                language=lang,
                provider=f"faster_whisper:{device}:{compute_type}:{model_size}",
                segments=segments,
                words=all_words,
            )
        except Exception as exc:
            release_whisper_cache()
            last_exc = exc
            log.info(
                "faster-whisper (%s/%s) unavailable (%s); trying next target.",
                device,
                compute_type,
                exc,
            )

    raise RuntimeError(f"faster-whisper failed across all targets: {last_exc}")


def _transcribe_gemini_audio(
    wav_path: Path,
    *,
    api_key: str,
    language: str,
    initial_prompt: str = "",
) -> TranscriptResult:
    """Multimodal Gemini WAV transcription fallback when Whisper engines are unavailable."""
    audio_b64 = base64.b64encode(wav_path.read_bytes()).decode("ascii")
    lang_hint = f" Expected language: {language}." if language else ""
    ctx_hint = f" Context/terms: {initial_prompt[:250]}." if initial_prompt else ""
    prompt = (
        "Transcribe all spoken dialogue in this audio accurately with precise start and end "
        "timestamps in seconds." + lang_hint + ctx_hint + " Return STRICT JSON: "
        '{"language": "en", "segments": [{"start": 0.0, "end": 1.8, "text": "spoken phrase"}]}. '
        'If there is no speech, return {"language": "en", "segments": []}.'
    )
    body = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": prompt},
                    {"inline_data": {"mime_type": "audio/wav", "data": audio_b64}},
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json",
        },
    }

    last_exc: Exception | None = None
    with httpx.Client(timeout=120.0) as client:
        for candidate in _GEMINI_AUDIO_MODELS:
            url = (
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{candidate}:generateContent"
            )
            try:
                resp = client.post(url, params={"key": api_key}, json=body)
                if resp.status_code in (404, 429, 503):
                    last_exc = RuntimeError(f"Gemini {candidate} HTTP {resp.status_code}")
                    continue
                resp.raise_for_status()
                cands = resp.json().get("candidates") or []
                if not cands:
                    continue
                raw_text = str(cands[0]["content"]["parts"][0]["text"])
                parsed = parse_json_payload(raw_text)
                if not isinstance(parsed, dict):
                    continue
                segments: list[TranscriptSegment] = []
                all_words: list[WordTiming] = []
                for item in parsed.get("segments") or []:
                    if not isinstance(item, dict):
                        continue
                    txt = str(item.get("text") or "").strip()
                    if not txt:
                        continue
                    s_ms = max(0, int(round(float(item.get("start", 0.0)) * 1000.0)))
                    e_ms = max(
                        s_ms + 120, int(round(float(item.get("end", s_ms / 1000.0 + 1.0)) * 1000.0))
                    )
                    seg_words = _words_from_segment_span(txt, s_ms, e_ms)
                    all_words.extend(seg_words)
                    segments.append(
                        TranscriptSegment(start_ms=s_ms, end_ms=e_ms, text=txt, words=seg_words)
                    )
                return TranscriptResult(
                    language=str(parsed.get("language") or language or "en"),
                    provider=f"gemini:{candidate}",
                    segments=segments,
                    words=all_words,
                )
            except Exception as exc:
                last_exc = exc
                continue
    raise RuntimeError(f"Gemini audio transcription failed: {last_exc}")


def transcribe_wav(
    wav_path: Path,
    *,
    initial_prompt: str = "",
    settings: config.Settings | None = None,
) -> TranscriptResult:
    """Transcribe a 16kHz WAV file via Groq -> faster-whisper (int8) -> OpenAI -> Gemini Audio."""
    cfg = settings or config.load()
    align_cfg = cfg.alignment
    file_size = wav_path.stat().st_size

    # 1. Groq Whisper (ultra-fast cloud ASR when groq key is configured and file <= 24 MB)
    groq_key = get_secret("groq")
    if groq_key and file_size <= 24 * 1024 * 1024:
        try:
            return _transcribe_cloud_whisper(
                wav_path,
                endpoint="https://api.groq.com/openai/v1/audio/transcriptions",
                api_key=groq_key,
                model="whisper-large-v3-turbo",
                language=align_cfg.language,
                initial_prompt=initial_prompt,
                provider_name="groq:whisper-large-v3-turbo",
            )
        except Exception as exc:
            log.warning("Groq Whisper failed (%s); falling back.", exc)

    # 2. Local faster-whisper (GTX 1050 Ti int8 / CPU int8 automatic fallback)
    try:
        return _transcribe_faster_whisper(
            wav_path,
            model_size=align_cfg.whisper_model or "small",
            language=align_cfg.language,
            initial_prompt=initial_prompt,
            no_speech_threshold=align_cfg.no_speech_threshold,
            log_prob_threshold=align_cfg.log_prob_threshold,
        )
    except ImportError:
        log.info("faster-whisper is not installed; checking cloud fallbacks.")
    except Exception as exc:
        log.warning("Local faster-whisper failed (%s); checking cloud fallbacks.", exc)

    # 3. OpenAI Whisper fallback
    openai_key = get_secret("openai")
    if openai_key and file_size <= 24 * 1024 * 1024:
        try:
            return _transcribe_cloud_whisper(
                wav_path,
                endpoint="https://api.openai.com/v1/audio/transcriptions",
                api_key=openai_key,
                model="whisper-1",
                language=align_cfg.language,
                initial_prompt=initial_prompt,
                provider_name="openai:whisper-1",
            )
        except Exception as exc:
            log.warning("OpenAI Whisper failed (%s).", exc)

    # 4. Google Gemini Multimodal Audio fallback
    gemini_key = get_secret("gemini")
    if gemini_key and file_size <= 18 * 1024 * 1024:
        try:
            return _transcribe_gemini_audio(
                wav_path,
                api_key=gemini_key,
                language=align_cfg.language,
                initial_prompt=initial_prompt,
            )
        except Exception as exc:
            log.warning("Gemini audio transcription failed (%s).", exc)

    return TranscriptResult(
        language=align_cfg.language or "en",
        provider="none",
        segments=[],
        words=[],
    )


def _slice_wav_segment(src_wav: Path, dest_wav: Path, start_ms: int, end_ms: int) -> Path:
    """Slice ``[start_ms, end_ms]`` out of a 16-bit PCM WAV file purely in Python."""
    with wave.open(str(src_wav), "rb") as reader:
        params = reader.getparams()
        sr = params.framerate
        f_start = max(0, min(params.nframes, int(round((start_ms / 1000.0) * sr))))
        f_end = max(f_start, min(params.nframes, int(round((end_ms / 1000.0) * sr))))
        reader.setpos(f_start)
        frames = reader.readframes(f_end - f_start)

    with wave.open(str(dest_wav), "wb") as writer:
        writer.setnchannels(params.nchannels)
        writer.setsampwidth(params.sampwidth)
        writer.setframerate(sr)
        writer.writeframes(frames)
    return dest_wav


def _transcribe_windows_faster_whisper_single_load(
    wav_path: Path,
    windows: list[HotWindow],
    *,
    initial_prompt: str,
    settings: config.Settings,
) -> TranscriptResult:
    """Load WhisperModel ONCE and transcribe all hot windows directly from 16kHz float32 PCM."""
    ensure_cuda_libraries()
    from faster_whisper import WhisperModel  # type: ignore[import-not-found]

    sr, full_samples = read_mono_pcm_f32(wav_path)
    if full_samples.size == 0 or sr <= 0:
        return TranscriptResult(
            language="en", provider="faster_whisper:empty", segments=[], words=[]
        )

    align_cfg = settings.alignment
    model_size = align_cfg.whisper_model or "small"
    last_exc: Exception | None = None

    for device, compute_type in select_faster_whisper_targets():
        model = None
        try:
            model = WhisperModel(model_size, device=device, compute_type=compute_type)
            merged_words: list[WordTiming] = []
            detected_lang = align_cfg.language or "en"

            for win in windows:
                if win.end_ms - win.start_ms < 400:
                    continue
                i0 = max(0, min(full_samples.size, int(round((win.start_ms / 1000.0) * sr))))
                i1 = max(i0, min(full_samples.size, int(round((win.end_ms / 1000.0) * sr))))
                chunk = full_samples[i0:i1]
                if chunk.size < int(sr * 0.25):
                    continue
                if sr != 16000:
                    import numpy as np

                    target_len = max(1, int(round(chunk.size * (16000.0 / sr))))
                    chunk = np.interp(
                        np.linspace(0.0, 1.0, num=target_len, endpoint=False),
                        np.linspace(0.0, 1.0, num=chunk.size, endpoint=False),
                        chunk,
                    ).astype(np.float32)

                seg_iter, info = model.transcribe(
                    chunk,
                    language=align_cfg.language or None,
                    word_timestamps=True,
                    vad_filter=False,
                    beam_size=5,
                    condition_on_previous_text=True,
                    hallucination_silence_threshold=1.5,
                    repetition_penalty=1.05,
                    no_speech_threshold=align_cfg.no_speech_threshold,
                    log_prob_threshold=align_cfg.log_prob_threshold,
                    initial_prompt=initial_prompt or None,
                )
                if getattr(info, "language", ""):
                    detected_lang = str(info.language)

                offset = win.start_ms
                for seg in seg_iter:
                    seg_words_found = False
                    for w in getattr(seg, "words", None) or []:
                        token = str(getattr(w, "word", "")).strip()
                        if not token:
                            continue
                        seg_words_found = True
                        s_ms = offset + max(0, int(round(float(w.start) * 1000.0)))
                        e_ms = max(s_ms + 60, offset + int(round(float(w.end) * 1000.0)))
                        merged_words.append(
                            WordTiming(
                                text=token,
                                start_ms=s_ms,
                                end_ms=e_ms,
                                confidence=getattr(w, "probability", None),
                            )
                        )
                    if not seg_words_found:
                        text = str(getattr(seg, "text", "")).strip()
                        if text:
                            s_seg = offset + max(0, int(round(float(seg.start) * 1000.0)))
                            e_seg = max(s_seg + 100, offset + int(round(float(seg.end) * 1000.0)))
                            merged_words.extend(_words_from_segment_span(text, s_seg, e_seg))

            merged_words.sort(key=lambda w: (w.start_ms, w.end_ms))
            aligned_words = align_words_to_audio(merged_words, wav_path)
            return TranscriptResult(
                language=detected_lang,
                provider=f"faster_whisper:{device}:{compute_type}:{model_size}",
                segments=_segments_from_words(aligned_words),
                words=aligned_words,
            )
        except Exception as exc:
            last_exc = exc
            log.info(
                "faster-whisper window scan (%s/%s) failed (%s); trying next target.",
                device,
                compute_type,
                exc,
            )
        finally:
            if model is not None:
                del model
            gc.collect()
            try:
                import torch  # type: ignore[import-not-found]

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

    raise RuntimeError(f"faster-whisper hot-window scan failed: {last_exc}")


def transcribe_hot_windows(
    wav_path: Path,
    windows: list[HotWindow] | None = None,
    *,
    initial_prompt: str = "",
    settings: config.Settings | None = None,
    transcriber_fn=None,
) -> TranscriptResult:
    """Transcribe either the full WAV or only selected multi-signal hot windows on long VODs."""
    cfg = settings or config.load()
    runner = transcriber_fn or transcribe_wav
    if not windows:
        return runner(wav_path, initial_prompt=initial_prompt, settings=cfg)

    # Single full-span window -> call runner directly when small OR use single-load faster-whisper
    if len(windows) == 1 and windows[0].start_ms == 0:
        if transcriber_fn is not None or wav_path.stat().st_size <= 24 * 1024 * 1024:
            return runner(wav_path, initial_prompt=initial_prompt, settings=cfg)
        try:
            return _transcribe_windows_faster_whisper_single_load(
                wav_path, windows, initial_prompt=initial_prompt, settings=cfg
            )
        except Exception as exc:
            log.warning("Single-load faster-whisper failed on large WAV (%s).", exc)
            return runner(wav_path, initial_prompt=initial_prompt, settings=cfg)

    # Multiple hot windows without custom test stub and no Groq cloud key -> load Whisper ONCE!
    if transcriber_fn is None and not get_secret("groq"):
        try:
            return _transcribe_windows_faster_whisper_single_load(
                wav_path, windows, initial_prompt=initial_prompt, settings=cfg
            )
        except Exception as exc:
            log.warning("Single-load faster-whisper window scan fell back (%s).", exc)

    merged_segments: list[TranscriptSegment] = []
    merged_words: list[WordTiming] = []
    detected_lang = "en"
    provider_used = "none"

    with tempfile.TemporaryDirectory(prefix="cutflow_asr_win_") as tmp:
        tmp_dir = Path(tmp)
        for idx, win in enumerate(windows):
            if win.end_ms - win.start_ms < 500:
                continue
            chunk_wav = _slice_wav_segment(
                wav_path, tmp_dir / f"win_{idx}.wav", win.start_ms, win.end_ms
            )
            sub = runner(chunk_wav, initial_prompt=initial_prompt, settings=settings)
            if sub.language:
                detected_lang = sub.language
            if sub.provider != "none":
                provider_used = sub.provider

            offset = win.start_ms
            for w in sub.words:
                merged_words.append(
                    WordTiming(
                        text=w.text,
                        start_ms=w.start_ms + offset,
                        end_ms=w.end_ms + offset,
                        speaker=w.speaker,
                        confidence=w.confidence,
                    )
                )
            for seg in sub.segments:
                seg_words = [
                    WordTiming(
                        text=sw.text,
                        start_ms=sw.start_ms + offset,
                        end_ms=sw.end_ms + offset,
                        speaker=sw.speaker,
                        confidence=sw.confidence,
                    )
                    for sw in seg.words
                ]
                merged_segments.append(
                    TranscriptSegment(
                        start_ms=seg.start_ms + offset,
                        end_ms=seg.end_ms + offset,
                        text=seg.text,
                        words=seg_words,
                    )
                )

    merged_words.sort(key=lambda w: (w.start_ms, w.end_ms))
    merged_segments.sort(key=lambda s: (s.start_ms, s.end_ms))
    return TranscriptResult(
        language=detected_lang,
        provider=provider_used,
        segments=merged_segments,
        words=merged_words,
    )


def encode_compact_transcript(segments: list[TranscriptSegment], max_chars: int = 24_000) -> str:
    """Compact ``[MM:SS.d] text`` encoding saving ~35% tokens versus verbose JSON."""
    lines: list[str] = []
    total = 0
    for seg in segments:
        s = seg.start_ms / 1000.0
        mm = int(s // 60)
        ss = s % 60
        line = f"[{mm:02d}:{ss:04.1f}] {seg.text.strip()}"
        if total + len(line) + 1 > max_chars:
            break
        lines.append(line)
        total += len(line) + 1
    return "\n".join(lines)


def chunk_compact_transcript(
    segments: list[TranscriptSegment],
    *,
    chunk_chars: int = 26_000,
    max_chunks: int = 6,
) -> list[str]:
    """Split long 2-hour movie/VOD transcripts into Act chunks so climaxes are never truncated."""
    if not segments:
        return []
    chunks: list[str] = []
    bucket: list[str] = []
    bucket_len = 0

    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        s = seg.start_ms / 1000.0
        mm = int(s // 60)
        ss = s % 60
        line = f"[{mm:02d}:{ss:04.1f}] {text}"
        if bucket and bucket_len + len(line) + 1 > chunk_chars:
            chunks.append("\n".join(bucket))
            if len(chunks) >= max_chunks:
                return chunks
            overlap = bucket[-2:] if len(bucket) >= 2 else bucket[-1:]
            bucket = list(overlap)
            bucket_len = sum(len(x) + 1 for x in bucket)
        bucket.append(line)
        bucket_len += len(line) + 1

    if bucket and len(chunks) < max_chunks:
        chunks.append("\n".join(bucket))
    return chunks
