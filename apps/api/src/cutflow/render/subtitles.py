"""ASS subtitle generator supporting standard, karaoke, cinema_neon_glow & viral_punch_glow."""

from __future__ import annotations

import re
from pathlib import Path

from ..ai.edl_builder import CINEMA_NEON_PALETTE, infer_word_glow_color
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

_UPPERCASE_PRESETS = frozenset(
    {"bold_pop", "karaoke_fill", "cinema_neon_glow", "viral_punch_glow"}
)


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


def _styles_for_preset(
    track: SubtitleTrack, play_res_x: int, play_res_y: int
) -> tuple[list[str], int]:
    style = track.style
    font_scale = 0.058 if style.preset == "cinema_neon_glow" else 0.068
    base_font = int(round(play_res_x * font_scale * style.font_size_scale))
    font_size = max(24, min(140, base_font))
    margin_v = max(24, int(round(play_res_y * track.margin_v_ratio)))
    margin_lr = max(32, int(round(play_res_x * 0.06)))
    font_name = style.font.replace("-", " ").split()[0] if style.font else "Arial"

    if style.preset in ("cinema_neon_glow", "viral_punch_glow"):
        is_cinema = style.preset == "cinema_neon_glow"
        spacing = round(
            max(2.5, style.letter_spacing or 3.5)
            if is_cinema
            else max(0.5, style.letter_spacing or 1.0),
            1,
        )
        glow_hex = (
            style.color_palette[0]
            if style.color_palette
            else (style.accent_color or "#4F7CFF")
        )
        glow_col = hex_to_ass_bgr(glow_hex, 68)
        glow_outline = max(6, round(font_size * 0.13))
        core_primary = hex_to_ass_bgr(style.primary_color, 0)
        core_secondary = hex_to_ass_bgr(style.accent_color, 0)
        core_outline_col = hex_to_ass_bgr(style.outline_color, 40 if is_cinema else 0)
        core_outline_w = 0 if is_cinema else max(1, round(font_size * 0.035))
        core_shadow = max(2, round(font_size * 0.045))
        back_col = "&H96000000"

        glow_line = (
            f"Style: GlowLayer,{font_name},{font_size},{glow_col},{glow_col},{glow_col},&HFF000000,"
            f"-1,0,0,0,100,100,{spacing},0,1,{glow_outline},0,2,"
            f"{margin_lr},{margin_lr},{margin_v},1"
        )
        core_line = (
            f"Style: CoreLayer,{font_name},{font_size},{core_primary},{core_secondary},"
            f"{core_outline_col},{back_col},-1,0,0,0,100,100,{spacing},0,1,"
            f"{core_outline_w},{core_shadow},2,{margin_lr},{margin_lr},{margin_v},1"
        )
        return [glow_line, core_line], font_size

    primary = hex_to_ass_bgr(style.primary_color, 0)
    secondary = hex_to_ass_bgr(style.accent_color, 0)
    if style.preset == "karaoke_fill":
        # In libass \kf karaoke, PrimaryColour is swept fill and SecondaryColour is pre-sweep.
        primary, secondary = secondary, primary
    outline_col = hex_to_ass_bgr(style.outline_color, 0)
    back_col = "&H80000000"

    border_style = 1
    outline_w = max(2, round(font_size * 0.085))
    shadow = max(1, round(font_size * 0.04))
    spacing_std = round(max(0.0, float(style.letter_spacing)), 1)
    if style.preset == "boxed":
        border_style = 3
        outline_w = max(8, round(font_size * 0.16))
        back_col = "&H40000000"
        shadow = 0
    elif style.preset == "clean_lower":
        outline_w = max(2, round(font_size * 0.055))
        shadow = 2

    line = (
        f"Style: Default,{font_name},{font_size},{primary},{secondary},{outline_col},{back_col},"
        f"-1,0,0,0,100,100,{spacing_std},0,{border_style},{outline_w},{shadow},2,"
        f"{margin_lr},{margin_lr},{margin_v},1"
    )
    return [line], font_size


def _emit_cinema_neon_events(
    visible_words: list[SubtitleWord],
    track: SubtitleTrack,
    fmt_word_fn: object,
) -> list[str]:
    """Emit Layer 0 blurred neon aura + Layer 1 crisp core text (JJ_EDIT cinema style)."""
    fmt = fmt_word_fn  # callable(str) -> str
    palette = list(track.style.color_palette) if track.style.color_palette else CINEMA_NEON_PALETTE
    primary_bgr = hex_to_ass_bgr(track.style.primary_color, 0)
    reveal_mode = track.style.reveal_mode
    events: list[str] = []

    if reveal_mode == "single_word":
        color_idx = 0
        prev_word: SubtitleWord | None = None
        for w in visible_words:
            if prev_word is not None and (
                w.start_ms - prev_word.end_ms >= 420
                or prev_word.text.rstrip().endswith((".", "!", "?"))
            ):
                color_idx = (color_idx + 1) % len(palette)
            neon_hex = w.glow_color or palette[color_idx % len(palette)]
            glow_bgr = hex_to_ass_bgr(neon_hex, 64)
            s = format_ass_time(w.start_ms)
            e = format_ass_time(w.start_ms + max(60, w.end_ms - w.start_ms))
            tok = fmt(w.text)  # type: ignore[operator]
            events.append(
                f"Dialogue: 0,{s},{e},GlowLayer,,0,0,0,,"
                f"{{\\fad(65,50)\\blur12\\1c{glow_bgr}\\3c{glow_bgr}}}{tok}"
            )
            events.append(
                f"Dialogue: 1,{s},{e},CoreLayer,,0,0,0,,"
                f"{{\\fad(65,50)\\blur0.6\\1c{primary_bgr}}}{tok}"
            )
            prev_word = w
        return events

    groups = _group_words(visible_words, max_words=4, max_gap_ms=580)
    color_idx = 0
    for g_idx, group in enumerate(groups):
        if g_idx > 0:
            prev_last = groups[g_idx - 1][-1]
            gap = group[0].start_ms - prev_last.end_ms
            if gap >= 380 or prev_last.text.rstrip().endswith((".", "!", "?")) or g_idx % 2 == 0:
                color_idx = (color_idx + 1) % len(palette)
        group_neon_hex = palette[color_idx % len(palette)]

        for active_idx, active_word in enumerate(group):
            ev_start = active_word.start_ms
            if active_idx + 1 < len(group):
                ev_end = max(ev_start + 60, group[active_idx + 1].start_ms)
            else:
                ev_end = max(ev_start + 60, active_word.end_ms)

            fad_in = 75 if active_idx == 0 else 0
            fad_out = 55 if active_idx == len(group) - 1 else 0
            fad_tag = f"\\fad({fad_in},{fad_out})" if (fad_in or fad_out) else ""

            shown = group[: active_idx + 1] if reveal_mode == "progressive" else group
            glow_parts: list[str] = []
            core_parts: list[str] = []
            for idx, item in enumerate(shown):
                tok = fmt(item.text)  # type: ignore[operator]
                w_hex = item.glow_color or group_neon_hex
                w_glow_bgr = hex_to_ass_bgr(w_hex, 64)
                w_tint_bgr = hex_to_ass_bgr(w_hex, 0)
                glow_parts.append(f"{{\\1c{w_glow_bgr}\\3c{w_glow_bgr}}}{tok}")
                if idx == active_idx:
                    core_parts.append(f"{{\\1c{primary_bgr}}}{tok}")
                else:
                    core_parts.append(f"{{\\1c{w_tint_bgr}}}{tok}")

            s_ts = format_ass_time(ev_start)
            e_ts = format_ass_time(ev_end)
            events.append(
                f"Dialogue: 0,{s_ts},{e_ts},GlowLayer,,0,0,0,,"
                f"{{{fad_tag}\\blur12}}{' '.join(glow_parts)}"
            )
            events.append(
                f"Dialogue: 1,{s_ts},{e_ts},CoreLayer,,0,0,0,,"
                f"{{{fad_tag}\\blur0.6}}{' '.join(core_parts)}"
            )
    return events


def _emit_viral_punch_events(
    visible_words: list[SubtitleWord],
    track: SubtitleTrack,
    fmt_word_fn: object,
) -> list[str]:
    """Emit crisp white captions where semantic punch-words bloom with neon halo (MrBeast style)."""
    fmt = fmt_word_fn  # callable(str) -> str
    primary_bgr = hex_to_ass_bgr(track.style.primary_color, 0)
    reveal_mode = track.style.reveal_mode
    events: list[str] = []

    if reveal_mode == "single_word":
        for w in visible_words:
            s = format_ass_time(w.start_ms)
            e = format_ass_time(w.start_ms + max(60, w.end_ms - w.start_ms))
            tok = fmt(w.text)  # type: ignore[operator]
            punch_hex = w.glow_color or infer_word_glow_color(w.text)
            if punch_hex:
                glow_bgr = hex_to_ass_bgr(punch_hex, 58)
                fill_bgr = hex_to_ass_bgr(punch_hex, 0)
                events.append(
                    f"Dialogue: 0,{s},{e},GlowLayer,,0,0,0,,"
                    f"{{\\fad(55,45)\\blur11\\1c{glow_bgr}\\3c{glow_bgr}}}{tok}"
                )
                events.append(
                    f"Dialogue: 1,{s},{e},CoreLayer,,0,0,0,,"
                    f"{{\\fad(55,45)\\1c{fill_bgr}}}{tok}"
                )
            else:
                events.append(
                    f"Dialogue: 1,{s},{e},CoreLayer,,0,0,0,,"
                    f"{{\\fad(55,45)\\1c{primary_bgr}}}{tok}"
                )
        return events

    groups = _group_words(visible_words, max_words=3, max_gap_ms=620)
    for group in groups:
        for active_idx, active_word in enumerate(group):
            ev_start = active_word.start_ms
            if active_idx + 1 < len(group):
                ev_end = max(ev_start + 60, group[active_idx + 1].start_ms)
            else:
                ev_end = max(ev_start + 60, active_word.end_ms)

            fad_in = 65 if active_idx == 0 else 0
            fad_out = 45 if active_idx == len(group) - 1 else 0
            fad_tag = f"\\fad({fad_in},{fad_out})" if (fad_in or fad_out) else ""

            shown = group[: active_idx + 1] if reveal_mode == "progressive" else group
            has_glow = False
            glow_parts: list[str] = []
            core_parts: list[str] = []
            for idx, item in enumerate(shown):
                tok = fmt(item.text)  # type: ignore[operator]
                punch_hex = item.glow_color or infer_word_glow_color(item.text)
                if punch_hex:
                    has_glow = True
                    g_bgr = hex_to_ass_bgr(punch_hex, 56 if idx == active_idx else 88)
                    c_bgr = hex_to_ass_bgr(punch_hex, 0)
                    glow_parts.append(f"{{\\alpha&H38&\\1c{g_bgr}\\3c{g_bgr}}}{tok}")
                    core_parts.append(f"{{\\1c{c_bgr}}}{tok}")
                else:
                    glow_parts.append(f"{{\\alpha&HFF&}}{tok}")
                    core_parts.append(f"{{\\1c{primary_bgr}}}{tok}")

            s_ts = format_ass_time(ev_start)
            e_ts = format_ass_time(ev_end)
            if has_glow:
                events.append(
                    f"Dialogue: 0,{s_ts},{e_ts},GlowLayer,,0,0,0,,"
                    f"{{{fad_tag}\\blur11}}{' '.join(glow_parts)}"
                )
            events.append(
                f"Dialogue: 1,{s_ts},{e_ts},CoreLayer,,0,0,0,,"
                f"{{{fad_tag}}}{' '.join(core_parts)}"
            )
    return events


def generate_ass_subtitles(
    edl: TimelineProject,
    *,
    play_res_x: int = 1080,
    play_res_y: int = 1920,
) -> str:
    """Compile ``edl.tracks.subtitles`` into a complete ASS v4+ script string."""
    track = edl.tracks.subtitles
    style_lines, _ = _styles_for_preset(track, play_res_x, play_res_y)

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
        *style_lines,
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
        if preset in _UPPERCASE_PRESETS:
            txt = txt.upper()
        return _escape_ass_text(txt)

    if preset == "cinema_neon_glow":
        events = _emit_cinema_neon_events(visible_words, track, fmt_word)
        return "\n".join(header + events) + "\n"

    if preset == "viral_punch_glow":
        events = _emit_viral_punch_events(visible_words, track, fmt_word)
        return "\n".join(header + events) + "\n"

    events = []
    if reveal_mode == "single_word":
        for w in visible_words:
            s = format_ass_time(w.start_ms)
            dur_ms = max(60, w.end_ms - w.start_ms)
            e = format_ass_time(w.start_ms + dur_ms)
            if preset == "karaoke_fill":
                cs = max(6, round(dur_ms / 10))
                body = f"{{\\kf{cs}}}{fmt_word(w.text)}"
            else:
                body = f"{pop_tag}{{\\1c{accent_bgr}}}{fmt_word(w.text)}"
            events.append(f"Dialogue: 0,{s},{e},Default,,0,0,0,,{body}")
    elif preset == "karaoke_fill":
        # True libass \kf smooth sweep across each phrase group!
        groups = _group_words(visible_words, max_words=3)
        for group in groups:
            ev_start = group[0].start_ms
            ev_end = max(ev_start + 80, group[-1].end_ms)
            chunks: list[str] = []
            cursor_ms = ev_start
            for w in group:
                gap_ms = max(0, w.start_ms - cursor_ms)
                if gap_ms >= 20:
                    chunks.append(f"{{\\k{max(1, round(gap_ms / 10))}}}")
                dur_ms = max(60, w.end_ms - max(w.start_ms, cursor_ms))
                chunks.append(f"{{\\kf{max(6, round(dur_ms / 10))}}}{fmt_word(w.text)}")
                cursor_ms = max(cursor_ms, w.end_ms)
            events.append(
                f"Dialogue: 0,{format_ass_time(ev_start)},{format_ass_time(ev_end)},"
                f"Default,,0,0,0,,{' '.join(chunks)}"
            )
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
