"""Reproducible hardware benchmark runner generating Markdown tables for README & CI."""

from __future__ import annotations

import platform
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..audio import (
    WordTiming,
    align_words_to_audio,
    extract_lossless_clip_slice,
    extract_wav_16k,
    probe_media,
    write_peaks_json,
)
from ..edl import (
    AudioTrack,
    ColdOpenBlock,
    FramingSegment,
    NormalizedBox,
    OutputSpec,
    OverlayItem,
    SubtitleStyle,
    SubtitleTrack,
    SubtitleWord,
    TimelineProject,
    TimelineTracks,
    VideoSlice,
    VideoTrack,
    apply_blade_cut,
)
from ..render import nvenc_is_usable, render_edl_to_mp4


@dataclass(slots=True)
class BenchmarkRow:
    stage: str
    elapsed_ms: float
    notes: str


def _generate_benchmark_source(
    dest: Path, duration_s: int = 12, width: int = 1920, height: int = 1080
) -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg was not found on PATH.")
    audio_expr = (
        "aevalsrc="
        "if(lt(t\\,1.5)\\,0\\,if(lt(t\\,6.0)\\,0.7*sin(2*PI*440*t)\\,0.2*sin(2*PI*330*t)))"
        f":s=44100:d={duration_s}"
    )
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"testsrc2=size={width}x{height}:rate=30:duration={duration_s}",
        "-f",
        "lavfi",
        "-i",
        audio_expr,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "30",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"Benchmark video generation failed: {proc.stderr.strip()}")
    return dest


def _sample_edl(
    duration_ms: int, width: int, height: int, quality: str, speed: str
) -> TimelineProject:
    base = TimelineProject(
        schema_version=1,
        project_id="bench_clip",
        source_id="bench_src",
        title="CutFlow Benchmark — Split Screen & Seam Card",
        status="draft",
        source_duration_ms=duration_ms,
        source_width=width,
        source_height=height,
        output=OutputSpec(
            ratio="9:16",
            quality=quality,  # type: ignore[arg-type]
            speed_preset=speed,  # type: ignore[arg-type]
            fps=30,
            loudness_lufs=-14.0,
        ),
        tracks=TimelineTracks(
            video=VideoTrack(
                cold_open=ColdOpenBlock(
                    enabled=True,
                    source_start_ms=max(0, duration_ms - 3000),
                    duration_ms=1200,
                    fade_out_ms=120,
                ),
                clips=[VideoSlice(id="v1", source_start_ms=500, source_end_ms=duration_ms - 500)],
                framing=[
                    FramingSegment(
                        id="f1",
                        timeline_start_ms=0,
                        timeline_end_ms=duration_ms + 200,
                        mode="split",
                        split_ratio=0.35,
                        cam_box=NormalizedBox(x=0.02, y=0.25, w=0.26, h=0.28),
                    )
                ],
            ),
            audio=AudioTrack(gain_db=0.0, normalize_lufs=-14.0),
            subtitles=SubtitleTrack(
                enabled=True,
                style=SubtitleStyle(preset="bold_pop", reveal_mode="progressive"),
                censor_profanity=True,
                margin_v_ratio=0.22,
                mute_ranges=[],
                words=[
                    SubtitleWord(id="w1", text="CutFlow", start_ms=1500, end_ms=2100),
                    SubtitleWord(id="w2", text="Bench", start_ms=2100, end_ms=2800),
                    SubtitleWord(id="w3", text="Mode!", start_ms=2800, end_ms=3600),
                ],
            ),
            overlays=[
                OverlayItem(
                    id="ov1",
                    kind="seam_card_white",
                    text="CutFlow Real Hardware Benchmark Clip",
                    start_ms=0,
                    end_ms=duration_ms + 200,
                    y_anchor="split_seam",
                )
            ],
        ),
    )
    return apply_blade_cut(base, 4000, 6000)


def run_benchmark(
    *, duration_s: int = 12, include_final_1080p: bool = True
) -> dict[str, Any]:
    """Execute end-to-end CutFlow pipeline stages on a synthetic 1080p clip and measure timings."""
    rows: list[BenchmarkRow] = []

    with tempfile.TemporaryDirectory(prefix="cutflow_bench_") as tmp:
        root = Path(tmp)
        src = _generate_benchmark_source(root / "bench_1080p.mp4", duration_s=duration_s)

        t0 = time.perf_counter()
        info = probe_media(src)
        rows.append(
            BenchmarkRow(
                "FFprobe Metadata",
                (time.perf_counter() - t0) * 1000,
                f"{info.width}×{info.height} @ {info.fps:.0f}fps",
            )
        )

        t0 = time.perf_counter()
        wav = extract_wav_16k(src, root / "bench_16k.wav")
        rows.append(
            BenchmarkRow("16 kHz Mono WAV Extract", (time.perf_counter() - t0) * 1000, "PCM s16le")
        )

        t0 = time.perf_counter()
        peaks_path = write_peaks_json(wav, root / "peaks.json", rate_hz=100)
        kb = peaks_path.stat().st_size / 1024
        rows.append(
            BenchmarkRow(
                "100 Hz Waveform Peaks", (time.perf_counter() - t0) * 1000, f"{kb:.1f} KB JSON"
            )
        )

        t0 = time.perf_counter()
        aligned = align_words_to_audio(
            [WordTiming(text="WHOA!", start_ms=0, end_ms=2600)], wav, window_ms=20
        )
        rows.append(
            BenchmarkRow(
                "20ms RMS Onset Alignment",
                (time.perf_counter() - t0) * 1000,
                f"Snapped 0ms → {aligned[0].start_ms}ms",
            )
        )

        t0 = time.perf_counter()
        slice_path, _ = extract_lossless_clip_slice(
            src,
            root / "clip_slice.mp4",
            clip_start_ms=500,
            clip_end_ms=info.duration_ms - 500,
            source_duration_ms=info.duration_ms,
        )
        slice_mb = slice_path.stat().st_size / (1024 * 1024)
        rows.append(
            BenchmarkRow(
                "Zero-Copy Lossless Slice (-c copy)",
                (time.perf_counter() - t0) * 1000,
                f"{slice_mb:.2f} MB stream copy",
            )
        )

        # 720p Draft Render (Cold-Open + Blade Cut + Split Screen + Seam Card + ASS)
        draft_edl = _sample_edl(info.duration_ms, info.width, info.height, "720p", "draft")
        t0 = time.perf_counter()
        draft_plan = render_edl_to_mp4(
            draft_edl,
            media_path=src,
            output_path=root / "draft_720p.mp4",
            scratch_dir=root / "scratch_draft",
        )
        draft_mb = draft_plan.output_path.stat().st_size / (1024 * 1024)
        rows.append(
            BenchmarkRow(
                "Render 720p Draft (9:16 Split + Card + ASS)",
                (time.perf_counter() - t0) * 1000,
                f"{draft_plan.encoder}, {draft_mb:.2f} MB",
            )
        )

        if include_final_1080p:
            final_edl = _sample_edl(info.duration_ms, info.width, info.height, "1080p", "final")
            t0 = time.perf_counter()
            final_plan = render_edl_to_mp4(
                final_edl,
                media_path=src,
                output_path=root / "final_1080p.mp4",
                scratch_dir=root / "scratch_final",
            )
            final_mb = final_plan.output_path.stat().st_size / (1024 * 1024)
            rows.append(
                BenchmarkRow(
                    "Render 1080p Final (9:16 Split + Card + ASS)",
                    (time.perf_counter() - t0) * 1000,
                    f"{final_plan.encoder}, {final_mb:.2f} MB",
                )
            )

    md_lines = [
        "| Pipeline Stage | Measured Time | Notes |",
        "| :--- | ---: | :--- |",
    ]
    for r in rows:
        ms = r.elapsed_ms
        time_str = f"{ms / 1000:.2f} s" if ms >= 1000 else f"{ms:.0f} ms"
        md_lines.append(f"| {r.stage} | {time_str} | {r.notes} |")

    return {
        "platform": platform.platform(),
        "nvencUsable": nvenc_is_usable(),
        "durationS": duration_s,
        "rows": [
            {"stage": r.stage, "elapsedMs": round(r.elapsed_ms, 2), "notes": r.notes}
            for r in rows
        ],
        "markdown": "\n".join(md_lines),
    }
