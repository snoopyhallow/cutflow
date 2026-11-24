"""ASS subtitle generator supporting progressive, group, and single_word reveal modes."""

from __future__ import annotations

import re
from pathlib import Path

from ..edl.schema import SubtitleTrack, SubtitleWord, TimelineProject

_PROFANITY_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b(f)(u)(c)(k)(\w*)\b", re.IGNORECASE), r"\1***\5"),
    (re.compile(r"\b(s)(h)(i)(t)(\w*)\b", re.IGNORECASE), r"\1***\5"),
    (re.compile(r"\b(b)(i)(t)(c)(h)(\w*)\b", re.IGNORECASE), r"\1****\6"),
    (re.compile(r"\b(a)(s)(s)(h)(o)(l)(e)(\w*)\b", re.IGNORECASE), r"\1******\8"),
    (re.compile(r"\b(m)(o)(t)(h)(e)(r)(f)(u)(c)(k)(\w*)\b", re.IGNORECASE), r"\1*********\11"),
    (re.compile(r"\b(c)(u)(n)(t)(\w*)\b", re.IGNORECASE), r"\1***\5"),
    (re.compile(r"\b(d)(i)(c)(k)(\w*)\b", re.IGNORECASE), r"\1***\5"),
]


def censor_word(text: str) -> str:
    """Mask profanity cleanly while preserving leading character & punctuation."""
    out = text
    for pattern, repl in _PROFANITY_PATTERNS:
        out = pattern.sub(repl, out)
    return out


def hex_to_ass_bgr(hex_color: str, alpha: int = 0) -> str:
    """Convert ``#RRGGBB`` to libass ``&HAABBGGRR`` color token."""
    cleaned = hex_color.strip().lstrip("#")
    if len(cleaned) != 6:
        cleaned = "FFFFFF"
    rr = cleaned[0:2].upper()
    gg = cleaned[2:4].upper()
    bb = cleaned[4:6].upper()
    aa = f"{max(0, min(255, int(alpha))):02X}"
    return f"&H{aa}{bb}{gg}{rr}"


def format_ass_time(ms: int) -> str:
    """Format milliseconds into ASS timestamp ``H:MM:SS.cc`` (centiseconds)."""
    clamped = max(0, int(ms))
    centis = (clamped // 10) % 100
    total_sec = clamped // 1000
    sec = total_sec % 60
    total_min = total_sec // 60
    minute = total_min % 60
    hour = total_min // 60
    return f"{hour}:{minute:02d}:{sec:02d}.{centis:02d}"


def _escape_ass_text(text: str) -> str:
    return text.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}").replace("\n", r"\N")


def _is_muted(word: SubtitleWord, mute_ranges: list[tuple[int, int]]) -> bool:
    mid = (word.start_ms + word.end_ms) // 2
    return any(m0 <= mid <= m1 for m0, m1 in mute_ranges)


def _group_words(
    words: list[SubtitleWord], max_words: int = 3, max_gap_ms: int = 650
) -> list[list[SubtitleWord]]:
    if not words:
        return []
    groups: list[list[SubtitleWord]] = []
    cur: list[SubtitleWord] = [words[0]]
    for w in words[1:]:
        gap = w.start_ms - cur[-1].end_ms
        ends_sentence = cur[-1].text.rstrip().endswith((".", "!", "?"))
        if len(cur) >= max_words or gap > max_gap_ms or ends_sentence:
            groups.append(cur)
            cur = [w]
        else:
            cur.append(w)
    if cur:
        groups.append(cur)
    return groups


def _style_for_preset(
    track: SubtitleTrack, play_res_x: int, play_res_y: int
) -> tuple[str, int]:
    style = track.style
    base_font = int(round(play_res_x * 0.068 * style.font_size_scale))
    font_size = max(24, min(140, base_font))
    margin_v = max(24, int(round(play_res_y * track.margin_v_ratio)))
    margin_lr = max(32, int(round(play_res_x * 0.06)))

    primary = hex_to_ass_bgr(style.primary_color, 0)
    secondary = hex_to_ass_bgr(style.accent_color, 0)
    outline_col = hex_to_ass_bgr(style.outline_color, 0)
    back_col = "&H80000000"

    border_style = 1
    outline_w = max(2, round(font_size * 0.085))
    shadow = max(1, round(font_size * 0.04))
    if style.preset == "boxed":
        border_style = 3
        outline_w = max(8, round(font_size * 0.16))
        back_col = "&H40000000"
        shadow = 0
    elif style.preset == "clean_lower":
        outline_w = max(2, round(font_size * 0.055))
        shadow = 2

    font_name = style.font.replace("-", " ").split()[0] if style.font else "Arial"
    line = (
        f"Style: Default,{font_name},{font_size},{primary},{secondary},{outline_col},{back_col},"
        f"-1,0,0,0,100,100,0,0,{border_style},{outline_w},{shadow},2,"
        f"{margin_lr},{margin_lr},{margin_v},1"
    )
    return line, font_size


def generate_ass_subtitles(
    edl: TimelineProject,
    *,
    play_res_x: int = 1080,
    play_res_y: int = 1920,
) -> str:
    """Compile ``edl.tracks.subtitles`` into a complete ASS v4+ script string."""
    track = edl.tracks.subtitles
    style_line, _ = _style_for_preset(track, play_res_x, play_res_y)

    header = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {play_res_x}",
        f"PlayResY: {play_res_y}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        style_line,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    if not track.enabled or not track.words:
        return "\n".join(header) + "\n"

    visible_words = [w for w in track.words if not _is_muted(w, track.mute_ranges)]
    if not visible_words:
        return "\n".join(header) + "\n"

    accent_bgr = hex_to_ass_bgr(track.style.accent_color, 0)
    primary_bgr = hex_to_ass_bgr(track.style.primary_color, 0)
    reveal_mode = track.style.reveal_mode
    preset = track.style.preset
    pop_tag = r"{\fscx112\fscy112\t(0,90,\fscx100\fscy100)}" if preset == "bold_pop" else ""

    def fmt_word(raw: str) -> str:
        txt = censor_word(raw) if track.censor_profanity else raw
        if preset in ("bold_pop", "karaoke_fill"):
            txt = txt.upper()
        return _escape_ass_text(txt)

    events: list[str] = []

    if reveal_mode == "single_word":
        for w in visible_words:
            s = format_ass_time(w.start_ms)
            e = format_ass_time(max(w.start_ms + 60, w.end_ms))
            body = f"{pop_tag}{{\\1c{accent_bgr}}}{fmt_word(w.text)}"
            events.append(f"Dialogue: 0,{s},{e},Default,,0,0,0,,{body}")
    else:
        groups = _group_words(visible_words, max_words=3)
        for group in groups:
            for active_idx, active_word in enumerate(group):
                ev_start = active_word.start_ms
                if active_idx + 1 < len(group):
                    ev_end = max(ev_start + 60, group[active_idx + 1].start_ms)
                else:
                    ev_end = max(ev_start + 60, active_word.end_ms)

                shown = group[: active_idx + 1] if reveal_mode == "progressive" else group

                parts: list[str] = []
                for idx, item in enumerate(shown):
                    tok = fmt_word(item.text)
                    if idx == active_idx:
                        parts.append(f"{{\\1c{accent_bgr}}}{tok}{{\\1c{primary_bgr}}}")
                    else:
                        parts.append(tok)
                line_text = f"{pop_tag}{' '.join(parts)}"
                events.append(
                    f"Dialogue: 0,{format_ass_time(ev_start)},{format_ass_time(ev_end)},"
                    f"Default,,0,0,0,,{line_text}"
                )

    return "\n".join(header + events) + "\n"


def write_ass_file(
    edl: TimelineProject,
    out_path: Path,
    *,
    play_res_x: int = 1080,
    play_res_y: int = 1920,
) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    content = generate_ass_subtitles(edl, play_res_x=play_res_x, play_res_y=play_res_y)
    out_path.write_text(content, encoding="utf-8")
    return out_path
