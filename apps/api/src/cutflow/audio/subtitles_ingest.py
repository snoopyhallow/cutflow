"""Instant embedded subtitle extraction (.mkv/.mp4 SRT/ASS/VTT) & SDH-cleaned word timing."""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
from pathlib import Path

from ..ai.transcription import TranscriptResult, TranscriptSegment
from .align import WordTiming
from .media import MediaInfo, SubtitleStreamInfo, lang_matches

log = logging.getLogger(__name__)

_SRT_TIMECODE_RE = re.compile(
    r"(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{2,3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{2,3})"
)
_ASS_DIALOGUE_RE = re.compile(
    r"^Dialogue:\s*\d+,(\d+):(\d{2}):(\d{2})\.(\d{2}),(\d+):(\d{2}):(\d{2})\.(\d{2}),([^,]*),([^,]*),\d+,\d+,\d+,[^,]*,(.*)$"
)
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_ASS_OVERRIDE_RE = re.compile(r"\{[^}]*\}")
_SDH_BRACKET_RE = re.compile(r"\[[^\]]*\]|\([^)]*\)")
_SPEAKER_PREFIX_RE = re.compile(r"^[A-Z][A-Z0-9 _.-]{1,22}:\s*")
_MUSIC_NOTES_RE = re.compile(r"[♪♫]+")


def _hms_to_ms(hh: str | None, mm: str, ss: str, frac: str) -> int:
    hours = int(hh) if hh else 0
    mins = int(mm)
    secs = int(ss)
    ms = int(frac) * 10 if len(frac) == 2 else int(frac[:3])
    return ((hours * 3600) + (mins * 60) + secs) * 1000 + ms


def clean_dialogue_cue_text(raw: str) -> str:
    """Strip HTML/ASS styling, music cues, speaker prefixes, and SDH sound-effect brackets."""
    text = raw.replace(r"\N", " ").replace(r"\n", " ").replace(r"\h", " ")
    text = _ASS_OVERRIDE_RE.sub("", text)
    text = _HTML_TAG_RE.sub("", text)
    # Skip cues that are purely music lyrics wrapped in ♪
    if "♪" in text or "♫" in text:
        stripped = _MUSIC_NOTES_RE.sub("", text).strip()
        if not stripped or raw.strip().startswith(("♪", "♫")):
            return ""
        text = stripped
    text = _SDH_BRACKET_RE.sub(" ", text)

    cleaned_lines: list[str] = []
    for line in text.splitlines():
        ln = line.strip().lstrip("-–—").strip()
        ln = _SPEAKER_PREFIX_RE.sub("", ln).strip()
        if ln:
            cleaned_lines.append(ln)

    joined = re.sub(r"\s+", " ", " ".join(cleaned_lines)).strip()
    return joined


def words_from_cue_text(text: str, start_ms: int, end_ms: int) -> list[WordTiming]:
    """Split a subtitle cue into character-weighted WordTiming items within [start_ms, end_ms]."""
    tokens = [tok for tok in text.split() if tok]
    if not tokens:
        return []
    span_ms = max(len(tokens) * 65, end_ms - start_ms)
    weights = [
        max(1, len(re.sub(r"\W+", "", t)) + (2 if t.endswith((".", "!", "?", ",")) else 0))
        for t in tokens
    ]
    total_w = sum(weights)

    words: list[WordTiming] = []
    cursor = max(0, int(start_ms))
    for idx, (tok, w) in enumerate(zip(tokens, weights, strict=True)):
        if idx == len(tokens) - 1:
            w_end = max(cursor + 60, start_ms + span_ms)
        else:
            dur = max(60, int(round(span_ms * (w / total_w))))
            w_end = cursor + dur
        words.append(WordTiming(text=tok, start_ms=cursor, end_ms=w_end))
        cursor = w_end
    return words


def parse_subtitle_text(
    raw_text: str,
    *,
    language: str = "en",
    provider: str = "embedded_subs",
) -> TranscriptResult:
    """Parse SRT, WebVTT, or ASS subtitle text into clean TranscriptSegments + WordTimings."""
    normalized = raw_text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    segments: list[TranscriptSegment] = []
    all_words: list[WordTiming] = []

    # Check if input is native ASS script
    if "[Events]" in normalized and "Dialogue:" in normalized:
        for line in normalized.splitlines():
            m = _ASS_DIALOGUE_RE.match(line.strip())
            if not m:
                continue
            s_ms = _hms_to_ms(m.group(1), m.group(2), m.group(3), m.group(4))
            e_ms = _hms_to_ms(m.group(5), m.group(6), m.group(7), m.group(8))
            if e_ms <= s_ms:
                continue
            cleaned = clean_dialogue_cue_text(m.group(11))
            if not cleaned:
                continue
            cue_words = words_from_cue_text(cleaned, s_ms, e_ms)
            if cue_words:
                segments.append(
                    TranscriptSegment(
                        start_ms=s_ms,
                        end_ms=max(e_ms, cue_words[-1].end_ms),
                        text=cleaned,
                        words=cue_words,
                    )
                )
                all_words.extend(cue_words)
    else:
        blocks = re.split(r"\n\s*\n", normalized)
        for block in blocks:
            lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
            if not lines or lines[0].upper().startswith(("WEBVTT", "NOTE", "STYLE")):
                continue
            tc_idx = next((i for i, ln in enumerate(lines[:3]) if _SRT_TIMECODE_RE.search(ln)), -1)
            if tc_idx == -1:
                continue
            m = _SRT_TIMECODE_RE.search(lines[tc_idx])
            if not m:
                continue
            s_ms = _hms_to_ms(m.group(1), m.group(2), m.group(3), m.group(4))
            e_ms = _hms_to_ms(m.group(5), m.group(6), m.group(7), m.group(8))
            if e_ms <= s_ms:
                continue
            body_raw = "\n".join(lines[tc_idx + 1 :])
            cleaned = clean_dialogue_cue_text(body_raw)
            if not cleaned:
                continue
            cue_words = words_from_cue_text(cleaned, s_ms, e_ms)
            if cue_words:
                segments.append(
                    TranscriptSegment(
                        start_ms=s_ms,
                        end_ms=max(e_ms, cue_words[-1].end_ms),
                        text=cleaned,
                        words=cue_words,
                    )
                )
                all_words.extend(cue_words)

    segments.sort(key=lambda s: (s.start_ms, s.end_ms))
    all_words.sort(key=lambda w: (w.start_ms, w.end_ms))
    # Prevent slight cue overlaps between consecutive word tokens
    for idx in range(1, len(all_words)):
        if all_words[idx].start_ms < all_words[idx - 1].end_ms:
            if all_words[idx].start_ms > all_words[idx - 1].start_ms + 60:
                all_words[idx - 1].end_ms = all_words[idx].start_ms
            else:
                all_words[idx].start_ms = all_words[idx - 1].end_ms
                all_words[idx].end_ms = max(all_words[idx].start_ms + 60, all_words[idx].end_ms)

    return TranscriptResult(
        language=language or "en",
        provider=provider,
        segments=segments,
        words=all_words,
    )


def select_best_subtitle_stream(
    streams: tuple[SubtitleStreamInfo, ...],
    preferred_lang: str = "en",
) -> SubtitleStreamInfo | None:
    """Rank embedded text subtitle streams, preferring full English dialogue over forced/SDH."""
    if not streams:
        return None
    best: SubtitleStreamInfo | None = None
    best_score = -10_000

    for s in streams:
        score = 0
        if lang_matches(s.language, preferred_lang):
            score += 120
        elif not s.language:
            score += 20
        else:
            score -= 60

        if s.forced:
            score -= 90  # Forced tracks only contain foreign-language signs/lines
        if not s.hearing_impaired:
            score += 15  # Clean dialogue preferred over SDH when both exist
        if "commentary" in s.title.lower():
            score -= 100

        if score > best_score:
            best_score = score
            best = s

    return best if best_score >= 0 else None


def extract_embedded_subtitles(
    source_path: Path,
    media: MediaInfo,
    *,
    preferred_lang: str = "en",
    min_cues: int = 5,
) -> TranscriptResult | None:
    """Extract embedded text subtitles from a .mkv/.mp4 container in <0.5s ($0 ASR cost)."""
    chosen = select_best_subtitle_stream(media.subtitle_streams, preferred_lang=preferred_lang)
    if chosen is None:
        return None

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None

    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source_path),
        "-map",
        f"0:s:{chosen.rel_index}",
        "-f",
        "srt",
        "-",
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=45,
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        log.debug("Embedded subtitle extraction skipped (%s).", proc.stderr.strip()[:160])
        return None

    tx = parse_subtitle_text(
        proc.stdout,
        language=chosen.language or preferred_lang,
        provider="embedded_subs",
    )
    effective_min = 1 if (0 < media.duration_ms < 120_000) else min_cues
    if len(tx.segments) < effective_min:
        log.info(
            "Embedded subtitle track had only %d cues (likely forced-only); falling back to ASR.",
            len(tx.segments),
        )
        return None
    return tx


def load_sidecar_subtitle_file(sub_path: Path, *, language: str = "en") -> TranscriptResult:
    """Load an external .srt, .vtt, or .ass subtitle file."""
    raw = sub_path.read_text(encoding="utf-8", errors="replace")
    return parse_subtitle_text(raw, language=language, provider="sidecar_subs")
