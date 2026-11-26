"""2x supersampled Pillow RGBA overlays (POV Bar, Seam Card, Watermark, Credits & Borders)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from ..edl.schema import OverlayItem

_FONT_CANDIDATES: tuple[str, ...] = (
    "Montserrat-ExtraBold.ttf",
    "Inter-Bold.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/calibrib.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
)


@dataclass(slots=True)
class RenderedOverlay:
    overlay_id: str
    png_path: Path
    width: int
    height: int
    x_px: int
    y_px: int
    start_s: float
    end_s: float


def _load_bold_font(size_px: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in _FONT_CANDIDATES:
        path = Path(candidate)
        if path.is_file():
            try:
                return ImageFont.truetype(str(path), size=size_px)
            except OSError:
                continue
    for name in ("segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size=size_px)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size_px)
    except TypeError:
        return ImageFont.load_default()


def _wrap_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    max_width_px: int,
    max_lines: int,
) -> list[str]:
    words = text.strip().split()
    if not words:
        return []

    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        trial = f"{current} {word}"
        bbox = draw.textbbox((0, 0), trial, font=font)
        if (bbox[2] - bbox[0]) <= max_width_px:
            current = trial
        else:
            lines.append(current)
            current = word
            if len(lines) >= max_lines - 1:
                break

    used = sum(len(line.split()) for line in lines)
    remainder = words[used:]
    if remainder:
        last_line = " ".join(remainder)
        bbox = draw.textbbox((0, 0), last_line, font=font)
        while (bbox[2] - bbox[0]) > max_width_px and len(last_line) > 6:
            last_line = last_line[:-4].rstrip() + "..."
            bbox = draw.textbbox((0, 0), last_line, font=font)
        lines.append(last_line)

    return lines[:max_lines]


def _apply_opacity(img: Image.Image, opacity: float) -> Image.Image:
    clamped = max(0.05, min(1.0, float(opacity)))
    if clamped >= 0.998:
        return img
    r, g, b, a = img.split()
    a = a.point(lambda p: int(round(p * clamped)))
    return Image.merge("RGBA", (r, g, b, a))


def compute_overlay_x_px(
    overlay: OverlayItem,
    *,
    out_w: int,
    card_w: int,
) -> int:
    """Compute top-left X pixel anchor supporting 2D horizontal ``x_offset_ratio``."""
    if card_w >= out_w:
        return 0
    center_x = (out_w // 2) + int(round(out_w * overlay.x_offset_ratio))
    left_x = center_x - (card_w // 2)
    return max(0, min(out_w - card_w, left_x))


def compute_overlay_y_px(
    overlay: OverlayItem,
    *,
    out_h: int,
    card_h: int,
    split_ratio: float,
) -> int:
    """Compute top-left Y pixel anchor for an overlay card on the output canvas."""
    if overlay.kind == "pov_top_bar":
        return max(0, min(max(0, out_h - card_h), int(round(out_h * overlay.y_offset_ratio))))

    offset_px = int(round(out_h * overlay.y_offset_ratio))
    if overlay.y_anchor == "split_seam":
        center_y = int(round(out_h * split_ratio)) + offset_px
    elif overlay.y_anchor == "top":
        center_y = int(round(out_h * 0.11)) + offset_px
    else:
        center_y = int(round(out_h * 0.85)) + offset_px

    top_y = center_y - (card_h // 2)
    return max(12, min(max(12, out_h - card_h - 12), top_y))


def _render_pov_top_bar(
    overlay: OverlayItem,
    out_png: Path,
    *,
    out_w: int,
    out_h: int,
) -> RenderedOverlay:
    """Render flush full-width white POV header bar (JJ_EDIT Cinema Square style)."""
    ss = 2
    font_px_1x = max(20, int(round(out_w * 0.040)))
    font = _load_bold_font(font_px_1x * ss)

    pad_x = int(round(out_w * 0.05)) * ss
    pad_y = int(round(out_w * 0.026)) * ss
    canvas_w = out_w * ss
    max_text_w = canvas_w - pad_x * 2

    scratch = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    scratch_draw = ImageDraw.Draw(scratch)
    lines = _wrap_text(scratch_draw, overlay.text.upper(), font, max_text_w, overlay.max_lines)
    if not lines:
        lines = [overlay.text.strip().upper() or "POV"]

    line_metrics: list[tuple[str, int, int]] = []
    for line in lines:
        bbox = scratch_draw.textbbox((0, 0), line, font=font)
        line_metrics.append((line, int(bbox[2] - bbox[0]), int(bbox[3] - bbox[1])))

    line_gap = int(round(font_px_1x * 0.28)) * ss
    text_block_h = sum(h for _, _, h in line_metrics) + line_gap * max(0, len(line_metrics) - 1)
    bar_h = text_block_h + pad_y * 2
    shadow_h = max(6, int(round(out_w * 0.012)) * ss)
    canvas_h = bar_h + shadow_h

    shadow_layer = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow_layer)
    shadow_draw.rectangle((0, 0, canvas_w, bar_h + shadow_h // 2), fill=(0, 0, 0, 110))
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=max(4, shadow_h // 3)))

    bar_layer = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    bar_draw = ImageDraw.Draw(bar_layer)
    bar_draw.rectangle((0, 0, canvas_w, bar_h), fill=(255, 255, 255, 252))
    bar_draw.line(
        [(0, bar_h - ss), (canvas_w, bar_h - ss)],
        fill=(212, 212, 216, 255),
        width=max(2, ss),
    )

    cursor_y = pad_y
    for line, line_w, line_h in line_metrics:
        bbox = bar_draw.textbbox((0, 0), line, font=font)
        x = (canvas_w - line_w) // 2 - int(bbox[0])
        y = cursor_y - int(bbox[1])
        bar_draw.text((x, y), line, font=font, fill=(12, 12, 15, 255))
        cursor_y += line_h + line_gap

    composed_2x = _apply_opacity(Image.alpha_composite(shadow_layer, bar_layer), overlay.opacity)
    final_w = out_w
    final_h = max(2, canvas_h // ss)
    final_img = composed_2x.resize((final_w, final_h), resample=Image.Resampling.LANCZOS)

    out_png.parent.mkdir(parents=True, exist_ok=True)
    final_img.save(out_png, format="PNG", optimize=True)
    y_px = compute_overlay_y_px(overlay, out_h=out_h, card_h=final_h, split_ratio=0.35)

    return RenderedOverlay(
        overlay_id=overlay.id,
        png_path=out_png,
        width=final_w,
        height=final_h,
        x_px=0,
        y_px=y_px,
        start_s=round(overlay.start_ms / 1000.0, 3),
        end_s=round(overlay.end_ms / 1000.0, 3),
    )


def _render_watermark_tag(
    overlay: OverlayItem,
    out_png: Path,
    *,
    out_w: int,
    out_h: int,
    split_ratio: float,
) -> RenderedOverlay:
    """Render translucent wide-spaced uppercase watermark with soft shadow (no pill box)."""
    ss = 2
    font_px_1x = max(14, int(round(out_w * 0.026)))
    font = _load_bold_font(font_px_1x * ss)
    text_str = overlay.text.strip().upper()[:36] or "CUTFLOW"
    char_gap = max(2, int(round(font_px_1x * 0.24)) * ss)
    pad = max(12, int(round(out_w * 0.018)) * ss)

    scratch = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    s_draw = ImageDraw.Draw(scratch)
    glyphs: list[tuple[str, int, int, int, int]] = []
    max_h = 0
    for ch in text_str:
        if ch == " ":
            glyphs.append((" ", int(round(font_px_1x * 0.35)) * ss, 0, 0, 0))
            continue
        bbox = s_draw.textbbox((0, 0), ch, font=font)
        gw = int(bbox[2] - bbox[0])
        gh = int(bbox[3] - bbox[1])
        max_h = max(max_h, gh)
        glyphs.append((ch, gw, gh, int(bbox[0]), int(bbox[1])))

    total_w = sum(g[1] for g in glyphs) + char_gap * max(0, len(glyphs) - 1)
    canvas_w = max(16, total_w + pad * 2)
    canvas_h = max(16, max_h + pad * 2)

    shadow_layer = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    sh_draw = ImageDraw.Draw(shadow_layer)
    fg_layer = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    fg_draw = ImageDraw.Draw(fg_layer)

    cursor_x = pad
    base_y = pad
    for ch, gw, _gh, bx0, by0 in glyphs:
        if ch != " ":
            sh_draw.text(
                (cursor_x - bx0, base_y - by0 + ss * 2),
                ch,
                font=font,
                fill=(0, 0, 0, 175),
            )
            fg_draw.text(
                (cursor_x - bx0, base_y - by0),
                ch,
                font=font,
                fill=(255, 255, 255, 245),
            )
        cursor_x += gw + char_gap

    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=max(3, ss * 3)))
    composed_2x = _apply_opacity(Image.alpha_composite(shadow_layer, fg_layer), overlay.opacity)

    final_w = max(2, canvas_w // ss)
    final_h = max(2, canvas_h // ss)
    final_img = composed_2x.resize((final_w, final_h), resample=Image.Resampling.LANCZOS)

    out_png.parent.mkdir(parents=True, exist_ok=True)
    final_img.save(out_png, format="PNG", optimize=True)

    x_px = compute_overlay_x_px(overlay, out_w=out_w, card_w=final_w)
    y_px = compute_overlay_y_px(overlay, out_h=out_h, card_h=final_h, split_ratio=split_ratio)
    return RenderedOverlay(
        overlay_id=overlay.id,
        png_path=out_png,
        width=final_w,
        height=final_h,
        x_px=x_px,
        y_px=y_px,
        start_s=round(overlay.start_ms / 1000.0, 3),
        end_s=round(overlay.end_ms / 1000.0, 3),
    )


def render_overlay_png(
    overlay: OverlayItem,
    out_png: Path,
    *,
    out_w: int,
    out_h: int,
    split_ratio: float = 0.35,
) -> RenderedOverlay:
    """Render an anti-aliased 2x supersampled RGBA PNG card and return placement metadata."""
    if overlay.kind == "pov_top_bar":
        return _render_pov_top_bar(overlay, out_png, out_w=out_w, out_h=out_h)
    if overlay.kind == "watermark_tag":
        return _render_watermark_tag(
            overlay, out_png, out_w=out_w, out_h=out_h, split_ratio=split_ratio
        )

    ss = 2  # 2x supersampling for silky rounded corners & crisp typography
    if overlay.kind == "cinema_credit":
        font_scale = 0.029
    elif overlay.kind == "cta_pill":
        font_scale = 0.036
    else:
        font_scale = 0.044
    font_px_1x = max(16, int(round(out_w * font_scale)))
    font = _load_bold_font(font_px_1x * ss)

    pad_x = int(round(out_w * (0.028 if overlay.kind == "cinema_credit" else 0.036))) * ss
    pad_y = int(round(out_w * (0.014 if overlay.kind == "cinema_credit" else 0.022))) * ss
    shadow_pad = int(round(out_w * 0.022)) * ss
    max_card_w = int(round(out_w * 0.88)) * ss
    max_text_w = max_card_w - (pad_x * 2)

    scratch = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    scratch_draw = ImageDraw.Draw(scratch)
    display_text = (
        f"FILM · {overlay.text.strip().upper()}"
        if overlay.kind == "cinema_credit" and "·" not in overlay.text
        else overlay.text
    )
    lines = _wrap_text(scratch_draw, display_text, font, max_text_w, overlay.max_lines)
    if not lines:
        lines = [display_text.strip() or " "]

    line_metrics: list[tuple[str, int, int]] = []
    for line in lines:
        bbox = scratch_draw.textbbox((0, 0), line, font=font)
        line_metrics.append((line, int(bbox[2] - bbox[0]), int(bbox[3] - bbox[1])))

    line_gap = int(round(font_px_1x * 0.30)) * ss
    text_block_w = max(w for _, w, _ in line_metrics)
    text_block_h = sum(h for _, _, h in line_metrics) + line_gap * max(0, len(line_metrics) - 1)

    card_w = min(max_card_w, text_block_w + pad_x * 2)
    card_h = text_block_h + pad_y * 2
    canvas_w = card_w + shadow_pad * 2
    canvas_h = card_h + shadow_pad * 2

    is_pill = overlay.kind in ("cta_pill", "cinema_credit")
    radius = int(round(out_w * (0.04 if is_pill else 0.024))) * ss
    rect = (shadow_pad, shadow_pad, shadow_pad + card_w, shadow_pad + card_h)

    if overlay.kind == "seam_card_white":
        fill = (255, 255, 255, 250)
        outline = (226, 232, 240, 255)
        text_color = (15, 23, 42, 255)
        shadow_color = (0, 0, 0, 120)
    elif overlay.kind == "cta_pill":
        fill = (245, 158, 11, 248)
        outline = (253, 230, 138, 255)
        text_color = (9, 9, 11, 255)
        shadow_color = (0, 0, 0, 140)
    elif overlay.kind == "cinema_credit":
        fill = (9, 9, 11, 204)
        outline = (255, 255, 255, 76)
        text_color = (244, 244, 245, 248)
        shadow_color = (0, 0, 0, 135)
    else:  # hook_banner_dark
        fill = (12, 12, 15, 234)
        outline = (255, 255, 255, 64)
        text_color = (250, 250, 250, 255)
        shadow_color = (0, 0, 0, 140)

    # Render blurred drop shadow first
    shadow_layer = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow_layer)
    dy = max(4, int(round(out_w * 0.006)) * ss)
    shadow_rect = (rect[0], rect[1] + dy, rect[2], rect[3] + dy)
    shadow_draw.rounded_rectangle(shadow_rect, radius=radius, fill=shadow_color)
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=max(6, shadow_pad // 3)))

    card_layer = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    card_draw = ImageDraw.Draw(card_layer)
    stroke_w = max(2, ss if overlay.kind == "cinema_credit" else ss * 2)
    card_draw.rounded_rectangle(
        rect,
        radius=radius,
        fill=fill,
        outline=outline,
        width=stroke_w,
    )

    cursor_y = shadow_pad + pad_y
    for line, line_w, line_h in line_metrics:
        bbox = card_draw.textbbox((0, 0), line, font=font)
        x = shadow_pad + (card_w - line_w) // 2 - int(bbox[0])
        y = cursor_y - int(bbox[1])
        card_draw.text((x, y), line, font=font, fill=text_color)
        cursor_y += line_h + line_gap

    composed_2x = _apply_opacity(Image.alpha_composite(shadow_layer, card_layer), overlay.opacity)
    final_w = max(2, canvas_w // ss)
    final_h = max(2, canvas_h // ss)
    final_img = composed_2x.resize((final_w, final_h), resample=Image.Resampling.LANCZOS)

    out_png.parent.mkdir(parents=True, exist_ok=True)
    final_img.save(out_png, format="PNG", optimize=True)

    x_px = compute_overlay_x_px(overlay, out_w=out_w, card_w=final_w)
    y_px = compute_overlay_y_px(overlay, out_h=out_h, card_h=final_h, split_ratio=split_ratio)

    return RenderedOverlay(
        overlay_id=overlay.id,
        png_path=out_png,
        width=final_w,
        height=final_h,
        x_px=x_px,
        y_px=y_px,
        start_s=round(overlay.start_ms / 1000.0, 3),
        end_s=round(overlay.end_ms / 1000.0, 3),
    )


def render_border_frame_png(
    border_style: str,
    out_png: Path,
    *,
    out_w: int,
    out_h: int,
) -> Path | None:
    """Render 2x supersampled inner rounded cinema border PNG (JJ_EDIT style)."""
    if border_style not in ("thin_rounded", "double_cinema"):
        return None

    ss = 2
    cw = out_w * ss
    ch = out_h * ss
    short_side = min(out_w, out_h)
    inset = max(14, int(round(short_side * 0.022))) * ss
    radius = max(18, int(round(short_side * 0.036))) * ss
    stroke = max(2, int(round(short_side * 0.0024)) * ss)

    canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    outer_rect = (inset, inset, cw - inset, ch - inset)
    draw.rounded_rectangle(
        outer_rect,
        radius=radius,
        fill=None,
        outline=(255, 255, 255, 148),
        width=stroke,
    )

    if border_style == "thin_rounded":
        # Signature top-center bright white accent indicator bar (JJ_EDIT cinema frame)
        bar_w = max(40 * ss, int(round(out_w * 0.15)) * ss)
        bar_h = max(stroke + ss, int(round(short_side * 0.0045)) * ss)
        bx0 = (cw - bar_w) // 2
        by0 = inset - (bar_h // 2)
        draw.rounded_rectangle(
            (bx0, by0, bx0 + bar_w, by0 + bar_h),
            radius=max(2, bar_h // 2),
            fill=(255, 255, 255, 238),
        )
    else:  # double_cinema
        gap = max(6 * ss, int(round(short_side * 0.009)) * ss)
        inner_rect = (inset + gap, inset + gap, cw - inset - gap, ch - inset - gap)
        inner_radius = max(10, radius - gap)
        draw.rounded_rectangle(
            inner_rect,
            radius=inner_radius,
            fill=None,
            outline=(255, 255, 255, 84),
            width=max(2, stroke - ss),
        )

    final_img = canvas.resize((out_w, out_h), resample=Image.Resampling.LANCZOS)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    final_img.save(out_png, format="PNG", optimize=True)
    return out_png
