"""Milestone 3 tests: ASS 3 reveal modes, 2x Pillow RGBA overlays, real FFmpeg render & API."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from cutflow.ai import TranscriptResult, TranscriptSegment
from cutflow.audio import WordTiming, extract_frame_jpeg, probe_media
from cutflow.db import JobRow, get_session
from cutflow.db.models import new_id
from cutflow.edl import (
    ColdOpenBlock,
    NormalizedBox,
    OverlayItem,
    SubtitleWord,
    TimelineProject,
    apply_blade_cut,
)
from cutflow.render import (
    censor_word,
    generate_ass_subtitles,
    render_edl_to_mp4,
    render_overlay_png,
)
from cutflow.workspace import profiles as profile_store
from cutflow.workspace.jobs import run_job_pipeline_sync

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "edl-schema"
    / "fixtures"
    / "sample_streamer_clip.edl.json"
)


def _load_fixture() -> TimelineProject:
    return TimelineProject.model_validate(json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))


def _make_dark_video(dest: Path, duration_s: int = 12) -> Path:
    """Generate a dark navy 640x360 MP4 with audible 440Hz sine tone for pixel-verified renders."""
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"color=c=#102030:s=640x360:r=30:d={duration_s}",
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency=440:sample_rate=44100:duration={duration_s}",
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
        "96k",
        str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    assert proc.returncode == 0, f"ffmpeg dark sample failed: {proc.stderr}"
    return dest


def test_ass_subtitle_reveal_modes_profanity_and_mute_ranges() -> None:
    assert censor_word("fucking") == "f***ing"
    assert censor_word("shit!") == "s***!"

    edl = _load_fixture()
    edl.tracks.subtitles.words = [
        SubtitleWord(id="w1", text="No", start_ms=1000, end_ms=1300),
        SubtitleWord(id="w2", text="fucking", start_ms=1300, end_ms=1700),
        SubtitleWord(id="w3", text="way!", start_ms=1700, end_ms=2200),
        SubtitleWord(id="w4", text="MutedWord", start_ms=5000, end_ms=5600),
    ]
    edl.tracks.subtitles.mute_ranges = [(4900, 5700)]
    edl.tracks.subtitles.censor_profanity = True

    # 1. Progressive mode reveals words one-by-one (no future word early pop-in)
    edl.tracks.subtitles.style.reveal_mode = "progressive"
    prog = generate_ass_subtitles(edl)
    dial_prog = [ln for ln in prog.splitlines() if ln.startswith("Dialogue:")]
    assert len(dial_prog) == 3  # MutedWord excluded
    assert "F***ING" not in dial_prog[0]
    assert "NO" in dial_prog[0]
    assert "F***ING" in dial_prog[1] and "WAY!" not in dial_prog[1]
    assert "WAY!" in dial_prog[2]
    assert "MUTEDWORD" not in prog.upper()

    # 2. Group mode displays the full 3-word phrase simultaneously
    edl.tracks.subtitles.style.reveal_mode = "group"
    grp = generate_ass_subtitles(edl)
    dial_grp = [ln for ln in grp.splitlines() if ln.startswith("Dialogue:")]
    assert len(dial_grp) == 3
    assert "WAY!" in dial_grp[0]

    # 3. Single-word mode shows one word per event
    edl.tracks.subtitles.style.reveal_mode = "single_word"
    single = generate_ass_subtitles(edl)
    dial_single = [ln for ln in single.splitlines() if ln.startswith("Dialogue:")]
    assert len(dial_single) == 3
    assert "NO" in dial_single[0] and "F***ING" not in dial_single[0]


def test_pillow_seam_card_white_hook_and_cta_rendering(tmp_path: Path) -> None:
    out_w, out_h = 720, 1280
    split_ratio = 0.35

    for kind, anchor in (
        ("seam_card_white", "split_seam"),
        ("hook_banner_dark", "top"),
        ("cta_pill", "bottom"),
    ):
        ov = OverlayItem(
            id=f"ov_{kind}",
            kind=kind,  # type: ignore[arg-type]
            text="Streamer Can't Believe The Gas Prices In GTA 6",
            start_ms=0,
            end_ms=10_000,
            y_anchor=anchor,  # type: ignore[arg-type]
        )
        rendered = render_overlay_png(
            ov,
            tmp_path / f"{kind}.png",
            out_w=out_w,
            out_h=out_h,
            split_ratio=split_ratio,
        )
        assert rendered.png_path.is_file()
        img = Image.open(rendered.png_path)
        assert img.mode == "RGBA"
        assert img.size == (rendered.width, rendered.height)
        # Outer corner stays transparent (anti-aliased rounded card + shadow margin)
        assert img.getpixel((0, 0))[3] == 0

        if kind == "seam_card_white":
            center_y = rendered.y_px + rendered.height / 2
            expected_seam_y = out_h * split_ratio
            assert abs(center_y - expected_seam_y) <= 4
            # Verify crisp white pixels inside the card border region
            r, g, b, a = img.getpixel((rendered.width // 2, rendered.height // 5))
            assert a > 200 and (r > 200 or (r < 60 and g < 60))


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe required for real render verification")
def test_real_ffmpeg_blade_cut_split_screen_seam_card_and_ass_render(tmp_path: Path) -> None:
    src = _make_dark_video(tmp_path / "dark_source.mp4", duration_s=12)

    edl = _load_fixture()
    edl.source_duration_ms = 12_000
    edl.source_width = 640
    edl.source_height = 360
    edl.output.ratio = "9:16"
    edl.output.quality = "720p"
    edl.output.speed_preset = "draft"
    edl.output.fps = 30
    edl.tracks.video.cold_open = ColdOpenBlock(
        enabled=True, source_start_ms=8000, duration_ms=1000, fade_out_ms=120
    )
    edl.tracks.video.clips[0].source_start_ms = 1000
    edl.tracks.video.clips[0].source_end_ms = 10_000
    edl.tracks.video.framing[0].timeline_end_ms = 10_000
    edl.tracks.video.framing[0].mode = "split"
    edl.tracks.video.framing[0].split_ratio = 0.35
    edl.tracks.video.framing[0].cam_box = NormalizedBox(x=0.05, y=0.1, w=0.35, h=0.35)
    edl.tracks.overlays[0].end_ms = 10_000
    edl.tracks.subtitles.words = [
        SubtitleWord(id="w1", text="WAIT", start_ms=1500, end_ms=2200),
        SubtitleWord(id="w2", text="WHAT?!", start_ms=2200, end_ms=3200),
    ]

    # Apply a mid-clip blade cut removing [4000ms..6500ms] -> 2 video slices + 1.0s cold open = 7.5s
    cut_edl = apply_blade_cut(edl, 4000, 6500)
    assert len(cut_edl.tracks.video.clips) == 2

    out_mp4 = tmp_path / "rendered_clip.mp4"
    plan = render_edl_to_mp4(
        cut_edl,
        media_path=src,
        output_path=out_mp4,
        scratch_dir=tmp_path / "scratch",
        prefer_nvenc=False,
    )
    assert out_mp4.is_file()
    assert plan.ass_path is not None and plan.ass_path.is_file()
    assert len(plan.overlays) == 1

    info = probe_media(out_mp4)
    assert (info.width, info.height) == (720, 1280)
    assert info.has_audio is True
    assert 6800 <= info.duration_ms <= 8200

    # Visual frame check: extract a frame at t=2.0s and verify the white seam card rendered at y=35%
    frame_jpg = extract_frame_jpeg(out_mp4, tmp_path / "frame.jpg", timestamp_ms=2000)
    img = Image.open(frame_jpg).convert("RGB")
    seam_y = int(round(img.height * 0.35))
    # Scan vertical band around seam center for bright white pixels (card background on dark video)
    bright_pixels = 0
    for y in range(max(0, seam_y - 35), min(img.height, seam_y + 35)):
        r, g, b = img.getpixel((img.width // 2, y))
        if r > 220 and g > 220 and b > 220:
            bright_pixels += 1
    assert bright_pixels >= 10, f"Expected white seam card near y={seam_y}, found {bright_pixels}px"


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe required for post-archive export test")
def test_export_api_download_delete_and_post_archive_render(
    client: TestClient, tmp_path: Path
) -> None:
    src = _make_dark_video(tmp_path / "archive_test.mp4", duration_s=8)

    with src.open("rb") as fh:
        up = client.post(
            "/api/v1/sources/upload",
            files={"file": ("archive_test.mp4", fh, "video/mp4")},
            data={"auto_clip": "false"},
        )
    assert up.status_code == 201
    source_id = up.json()["source"]["id"]

    job_id = new_id("job")
    with get_session() as session:
        session.add(
            JobRow(
                id=job_id,
                source_id=source_id,
                profile_id=profile_store.list_profiles()[0].id,
                status="queued",
                stage="queued",
                progress=0.0,
                settings_json={"trigger": "test"},
            )
        )

    def fake_asr(_wav: Path, **_kwargs: Any) -> TranscriptResult:
        words = [WordTiming(text="BANGER!", start_ms=1000, end_ms=2500)]
        return TranscriptResult(
            language="en",
            provider="stub",
            segments=[TranscriptSegment(start_ms=1000, end_ms=2500, text="BANGER!", words=words)],
            words=words,
        )

    project_id = run_job_pipeline_sync(job_id, transcriber=fake_asr)[0]

    # Archive the raw VOD FIRST (deletes raw source MP4!)
    arch = client.post(f"/api/v1/sources/{source_id}/archive")
    assert arch.status_code == 200
    assert arch.json()["archived"] is True

    # Export MUST still succeed cleanly using the preserved lossless clip_slice.mp4!
    exp = client.post(
        f"/api/v1/projects/{project_id}/export",
        json={"ratio": "9:16", "quality": "720p", "speedPreset": "draft"},
    )
    assert exp.status_code == 201, exp.text
    exp_data = exp.json()
    export_id = exp_data["id"]
    assert exp_data["sizeBytes"] > 10_000
    assert exp_data["quality"] == "720p"
    assert exp_data["speedPreset"] == "draft"

    listed = client.get("/api/v1/exports")
    assert listed.status_code == 200
    assert any(item["id"] == export_id for item in listed.json())

    dl = client.get(f"/api/v1/exports/{export_id}/download")
    assert dl.status_code == 200
    assert dl.headers["content-type"] == "video/mp4"
    assert len(dl.content) == exp_data["sizeBytes"]

    removed = client.delete(f"/api/v1/exports/{export_id}")
    assert removed.status_code == 204
    assert client.get(f"/api/v1/exports/{export_id}/download").status_code == 404
