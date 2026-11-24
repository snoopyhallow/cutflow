"""2x supersampled Pillow RGBA overlay renderer (White Seam Title Card, Hook Banner, CTA Pill)."""

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


def compute_overlay_y_px(
    overlay: OverlayItem,
    *,
    out_h: int,
    card_h: int,
    split_ratio: float,
) -> int:
    """Compute top-left Y pixel anchor for an overlay card on the output canvas."""
    offset_px = int(round(out_h * overlay.y_offset_ratio))
    if overlay.y_anchor == "split_seam":
        center_y = int(round(out_h * split_ratio)) + offset_px
    elif overlay.y_anchor == "top":
        center_y = int(round(out_h * 0.11)) + offset_px
    else:
        center_y = int(round(out_h * 0.85)) + offset_px

    top_y = center_y - (card_h // 2)
    return max(12, min(out_h - card_h - 12, top_y))


def render_overlay_png(
    overlay: OverlayItem,
    out_png: Path,
    *,
    out_w: int,
    out_h: int,
    split_ratio: float = 0.35,
) -> RenderedOverlay:
    """Render an anti-aliased 2x supersampled RGBA PNG card and return placement metadata."""
    ss = 2  # 2x supersampling for silky rounded corners & crisp typography
    font_px_1x = max(18, int(round(out_w * (0.044 if overlay.kind != "cta_pill" else 0.036))))
    font = _load_bold_font(font_px_1x * ss)

    pad_x = int(round(out_w * 0.036)) * ss
    pad_y = int(round(out_w * 0.022)) * ss
    shadow_pad = int(round(out_w * 0.022)) * ss
    max_card_w = int(round(out_w * 0.88)) * ss
    max_text_w = max_card_w - (pad_x * 2)

    scratch = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    scratch_draw = ImageDraw.Draw(scratch)
    lines = _wrap_text(scratch_draw, overlay.text, font, max_text_w, overlay.max_lines)
    if not lines:
        lines = [overlay.text.strip() or " "]

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

    radius = int(round(out_w * (0.024 if overlay.kind != "cta_pill" else 0.04))) * ss
    rect = (shadow_pad, shadow_pad, shadow_pad + card_w, shadow_pad + card_h)

    if overlay.kind == "seam_card_white":
        fill = (255, 255, 255, 250)
        outline = (226, 232, 240, 255)
        text_color = (15, 23, 42, 255)
        shadow_color = (0, 0, 0, 120)
    elif overlay.kind == "cta_pill":
        fill = (99, 102, 241, 245)
        outline = (165, 180, 252, 255)
        text_color = (255, 255, 255, 255)
        shadow_color = (0, 0, 0, 130)
    else:  # hook_banner_dark
        fill = (11, 13, 18, 228)
        outline = (99, 102, 241, 220)
        text_color = (248, 250, 252, 255)
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
    card_draw.rounded_rectangle(
        rect,
        radius=radius,
        fill=fill,
        outline=outline,
        width=max(2, ss * 2),
    )

    cursor_y = shadow_pad + pad_y
    for line, line_w, line_h in line_metrics:
        bbox = card_draw.textbbox((0, 0), line, font=font)
        x = shadow_pad + (card_w - line_w) // 2 - int(bbox[0])
        y = cursor_y - int(bbox[1])
        card_draw.text((x, y), line, font=font, fill=text_color)
        cursor_y += line_h + line_gap

    composed_2x = Image.alpha_composite(shadow_layer, card_layer)
    final_w = max(2, canvas_w // ss)
    final_h = max(2, canvas_h // ss)
    final_img = composed_2x.resize((final_w, final_h), resample=Image.Resampling.LANCZOS)

    out_png.parent.mkdir(parents=True, exist_ok=True)
    final_img.save(out_png, format="PNG", optimize=True)

    x_px = max(0, (out_w - final_w) // 2)
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
