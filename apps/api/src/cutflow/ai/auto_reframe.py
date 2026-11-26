"""Zero-touch per-shot camera cut detector & OpenCV face-tracked close-up reframer."""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
from pathlib import Path
from typing import Literal

import cv2
import numpy as np

from ..edl.schema import FramingSegment, NormalizedBox, VideoSlice

log = logging.getLogger(__name__)

_PTS_TIME_RE = re.compile(r"pts_time:(\d+(?:\.\d+)?)")
_MIN_SHOT_MS = 900


def detect_shot_cuts_ms(
    media_path: Path,
    *,
    start_ms: int,
    duration_ms: int,
    threshold: float = 0.28,
) -> list[int]:
    """Return sorted clip-relative shot-cut offsets in ``(0, duration_ms)`` via FFmpeg select."""
    if duration_ms < _MIN_SHOT_MS * 2 or not media_path.is_file():
        return []
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return []

    cmd = [
        ffmpeg,
        "-hide_banner",
        "-ss",
        f"{max(0, start_ms) / 1000.0:.3f}",
        "-t",
        f"{duration_ms / 1000.0:.3f}",
        "-i",
        str(media_path),
        "-vf",
        f"scale=320:-2,select='gt(scene,{threshold:.2f})',showinfo",
        "-an",
        "-f",
        "null",
        "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError):
        return []

    cuts: list[int] = []
    for match in _PTS_TIME_RE.finditer(proc.stderr or ""):
        rel_ms = int(round(float(match.group(1)) * 1000.0))
        if rel_ms < _MIN_SHOT_MS or rel_ms > duration_ms - _MIN_SHOT_MS:
            continue
        if cuts and rel_ms - cuts[-1] < _MIN_SHOT_MS:
            continue
        cuts.append(rel_ms)
    return cuts


def _load_cascades() -> list[cv2.CascadeClassifier]:
    cascades: list[cv2.CascadeClassifier] = []
    base = getattr(cv2, "data", None)
    haar_dir = Path(base.haarcascades) if base is not None else None
    if haar_dir is None or not haar_dir.is_dir():
        return cascades
    for name in ("haarcascade_frontalface_default.xml", "haarcascade_profileface.xml"):
        p = haar_dir / name
        if p.is_file():
            clf = cv2.CascadeClassifier(str(p))
            if not clf.empty():
                cascades.append(clf)
    return cascades


def detect_face_focus_on_image(
    bgr_frame: np.ndarray,
    *,
    source_crop_box: NormalizedBox | None = None,
    base_zoom: float = 1.15,
) -> tuple[float, float, float]:
    """Detect primary actor face in ``bgr_frame`` and return ``(pan_x, pan_y, zoom)``."""
    h, w = bgr_frame.shape[:2]
    if h < 32 or w < 32:
        return 0.5, 0.45, base_zoom

    work = bgr_frame
    if source_crop_box is not None:
        cb = source_crop_box.clamped()
        x0 = max(0, min(w - 16, int(round(cb.x * w))))
        y0 = max(0, min(h - 16, int(round(cb.y * h))))
        cw = max(16, min(w - x0, int(round(cb.w * w))))
        ch = max(16, min(h - y0, int(round(cb.h * h))))
        work = bgr_frame[y0 : y0 + ch, x0 : x0 + cw]

    wh, ww = work.shape[:2]
    scale = min(1.0, 640.0 / max(ww, 1))
    small = (
        cv2.resize(work, (max(32, int(round(ww * scale))), max(32, int(round(wh * scale)))))
        if scale < 1.0
        else work
    )
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    sh, sw = gray.shape[:2]

    best_box: tuple[int, int, int, int] | None = None
    best_area = 0
    for clf in _load_cascades():
        faces = clf.detectMultiScale(
            gray,
            scaleFactor=1.12,
            minNeighbors=4,
            minSize=(max(20, int(sh * 0.08)), max(20, int(sh * 0.08))),
        )
        for fx, fy, fw, fh in faces:
            area = int(fw) * int(fh)
            if area > best_area:
                best_area = area
                best_box = (int(fx), int(fy), int(fw), int(fh))
        if best_box is not None:
            break

    if best_box is None:
        return 0.5, 0.44, round(base_zoom, 3)

    fx, fy, fw, fh = best_box
    cx_norm = (fx + fw * 0.5) / max(1, sw)
    # Frame actor's eyes near upper-third so chest captions sit cleanly below chin
    cy_norm = ((fy + fh * 0.42) / max(1, sh))
    face_h_ratio = fh / max(1, sh)

    if face_h_ratio < 0.22:
        zoom = max(base_zoom, 1.26)
    elif face_h_ratio < 0.34:
        zoom = max(base_zoom, 1.16)
    else:
        zoom = 1.06

    pan_x = round(max(0.10, min(0.90, cx_norm)), 4)
    pan_y = round(max(0.14, min(0.82, cy_norm)), 4)
    return pan_x, pan_y, round(min(2.0, zoom), 3)


def _sample_video_frame(media_path: Path, timestamp_ms: int) -> np.ndarray | None:
    if not media_path.is_file():
        return None
    cap = cv2.VideoCapture(str(media_path))
    if not cap.isOpened():
        return None
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, float(max(0, timestamp_ms)))
        ok, frame = cap.read()
        return frame if ok and frame is not None else None
    finally:
        cap.release()


def auto_reframe_slices(
    slices: list[VideoSlice],
    *,
    default_media_path: Path,
    media_by_source: dict[str, Path] | None = None,
    cold_open_ms: int = 0,
    source_crop_box: NormalizedBox | None = None,
    mode: Literal["centre", "crop", "fit"] = "crop",
    fit_backdrop: Literal["blur", "black"] = "blur",
    base_zoom: float = 1.15,
) -> list[FramingSegment]:
    """Generate per-shot face-tracked ``FramingSegment`` keyframes tiling the full timeline."""
    total_body_ms = sum(sl.duration_ms for sl in slices)
    total_ms = max(100, cold_open_ms + total_body_ms)

    if mode == "fit":
        return [
            FramingSegment(
                id="f1",
                timeline_start_ms=0,
                timeline_end_ms=total_ms,
                mode="fit",
                fit_backdrop=fit_backdrop,
                source_crop_box=source_crop_box,
            )
        ]

    raw_segments: list[FramingSegment] = []
    timeline_cursor = cold_open_ms

    for sl in slices:
        media_path = (
            media_by_source.get(sl.source_id, default_media_path)
            if (media_by_source and sl.source_id)
            else default_media_path
        )
        cuts = detect_shot_cuts_ms(
            media_path,
            start_ms=sl.source_start_ms,
            duration_ms=sl.duration_ms,
        )
        points = [0, *cuts, sl.duration_ms]
        for idx in range(len(points) - 1):
            rel_s0, rel_s1 = points[idx], points[idx + 1]
            if rel_s1 - rel_s0 < 100:
                continue
            mid_src_ms = sl.source_start_ms + (rel_s0 + rel_s1) // 2
            frame = _sample_video_frame(media_path, mid_src_ms)
            if frame is not None:
                pan_x, pan_y, zoom = detect_face_focus_on_image(
                    frame,
                    source_crop_box=source_crop_box,
                    base_zoom=base_zoom,
                )
            else:
                pan_x, pan_y, zoom = 0.5, 0.45, base_zoom

            is_first = not raw_segments and timeline_cursor == cold_open_ms
            t0 = 0 if is_first else (timeline_cursor + rel_s0)
            t1 = timeline_cursor + rel_s1
            raw_segments.append(
                FramingSegment(
                    id=f"f{len(raw_segments) + 1}",
                    timeline_start_ms=t0,
                    timeline_end_ms=max(t0 + 100, t1),
                    mode=mode,
                    fit_backdrop=fit_backdrop,
                    pan_x=pan_x,
                    pan_y=pan_y,
                    zoom=zoom,
                    source_crop_box=source_crop_box,
                )
            )
        timeline_cursor += sl.duration_ms

    if not raw_segments:
        return [
            FramingSegment(
                id="f1",
                timeline_start_ms=0,
                timeline_end_ms=total_ms,
                mode=mode,
                fit_backdrop=fit_backdrop,
                pan_x=0.5,
                pan_y=0.45,
                zoom=base_zoom,
                source_crop_box=source_crop_box,
            )
        ]

    # Coalesce adjacent shots with nearly identical focus so framing never micro-jitters
    merged: list[FramingSegment] = [raw_segments[0]]
    for seg in raw_segments[1:]:
        prev = merged[-1]
        if (
            abs(seg.pan_x - prev.pan_x) < 0.06
            and abs(seg.pan_y - prev.pan_y) < 0.06
            and abs(seg.zoom - prev.zoom) < 0.08
        ):
            merged[-1] = prev.model_copy(update={"timeline_end_ms": seg.timeline_end_ms})
        else:
            merged.append(seg.model_copy(update={"id": f"f{len(merged) + 1}"}))

    merged[0].timeline_start_ms = 0
    merged[-1].timeline_end_ms = total_ms
    for i in range(len(merged) - 1):
        merged[i].timeline_end_ms = merged[i + 1].timeline_start_ms
    return [m for m in merged if m.timeline_end_ms > m.timeline_start_ms]
