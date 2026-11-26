"""Phase 2 tests: 3-way EDL schema, 180s story arcs, OpenCV shot reframing, and Theme Mashups."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import jsonschema
import numpy as np
import pytest
from fastapi.testclient import TestClient

from cutflow.ai import (
    HighlightCandidate,
    auto_reframe_slices,
    build_clip_edl,
    detect_face_focus_on_image,
    detect_shot_cuts_ms,
    infer_word_glow_color,
)
from cutflow.audio import MediaInfo, WordTiming, probe_media
from cutflow.db import ClipProjectRow, JobRow, SourceRow, get_session
from cutflow.edl import TimelineMapper, TimelineProject
from cutflow.edl.schema import BgmTrack, NormalizedBox, VideoSlice
from cutflow.workspace.profiles import CreatorProfile

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = REPO_ROOT / "packages" / "edl-schema" / "timeline.v1.schema.json"


def test_story_arc_edl_builder_and_json_schema_parity() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    profile = CreatorProfile(
        id="jj-cinema",
        name="Cinema & TV Edits",
        content_mode="cinema",
        default_ratio="4:5",
        layout_mode="auto_reframe",
        border_style="thin_rounded",
        cinema_grade="crisp_hd",
        title_card_style="pov_top_bar",
        watermark_text="JJ_EDIT",
        watermark_opacity=0.80,
        show_cinema_credit=True,
        caption_style="viral_punch_glow",
        margin_v_ratio=0.40,
        dialogue_enhance=True,
        cold_open_enabled=False,
        min_duration_s=25.0,
        max_duration_s=180.0,
    )
    media = MediaInfo(
        path=Path("movie.mkv"),
        duration_ms=7_200_000,
        width=1920,
        height=1080,
        fps=60.0,
        has_audio=True,
        video_codec="h264",
        audio_codec="ac3",
        size_bytes=1024,
        audio_channels=6,
    )
    # 3-scene 165-second YouTube Short story arc across 3 movie scenes
    cand = HighlightCandidate(
        start_ms=10_000,
        end_ms=260_000,
        slices=[(10_000, 65_000), (95_000, 155_000), (210_000, 260_000)],
        score=96,
        title="Monsieur Bond Wins",
        seam_title="Monsieur Bond Wins",
        pov_hook="POV: HE ALMOST DIED.",
        mood="dark_cinema",
        reason="Full poker + poison + comeback arc.",
    )
    words = [
        WordTiming(text="AFTER", start_ms=500, end_ms=900),
        WordTiming(text="100", start_ms=920, end_ms=1300),
        WordTiming(text="POISONED", start_ms=60_000, end_ms=60_700),
        WordTiming(text="REALLY?", start_ms=120_000, end_ms=120_800),
    ]

    edl = build_clip_edl(
        project_id="clip_arc_001",
        source_id="src_movie_001",
        media=media,
        profile=profile,
        candidate=cand,
        aligned_clip_words=words,
        source_crop_box=NormalizedBox(x=0.0, y=0.12, w=1.0, h=0.76),
        source_title="Casino Royale (2006)",
    )
    edl.tracks.audio.bgm = BgmTrack(
        asset_id="dark_cinema_pulse",
        gain_db=-16.0,
        ducking_enabled=True,
        start_offset_ms=8400,
        fade_in_ms=500,
        fade_out_ms=1200,
    )

    canonical = edl.to_canonical_dict()
    jsonschema.validate(instance=canonical, schema=schema)

    assert TimelineMapper(edl).total_duration_ms == 165_000
    assert len(edl.tracks.video.clips) == 3
    assert edl.tracks.video.clips[0].transition_in == "none"
    assert edl.tracks.video.clips[1].transition_in == "dip_black"
    assert edl.tracks.video.clips[1].transition_sfx == "cinema_hit"
    assert edl.output.ratio == "4:5"
    assert edl.output.border_style == "thin_rounded"
    assert edl.output.cinema_grade == "crisp_hd"
    assert edl.tracks.audio.dialogue_enhance is True

    # Semantic punch-word glow colors inferred automatically
    assert infer_word_glow_color("100") == "#4ADE80"
    assert infer_word_glow_color("POISONED") == "#F87171"
    assert infer_word_glow_color("REALLY?") == "#FBBF24"
    assert edl.tracks.subtitles.words[1].glow_color == "#4ADE80"
    assert edl.tracks.subtitles.words[2].glow_color == "#F87171"

    kinds = [ov.kind for ov in edl.tracks.overlays]
    assert "pov_top_bar" in kinds
    assert "watermark_tag" in kinds
    assert "cinema_credit" in kinds


@pytest.mark.skipif(not HAS_FFMPEG, reason="FFmpeg required for shot cut + mashup test")
def test_opencv_shot_reframe_and_multisource_mashup_render(
    client: TestClient,
    tmp_path: Path,
) -> None:
    # 1. Direct image focus helper respects letterbox sourceCropBox
    synth_img = np.zeros((720, 1280, 3), dtype=np.uint8)
    pan_x, pan_y, zoom = detect_face_focus_on_image(
        synth_img,
        source_crop_box=NormalizedBox(x=0.0, y=0.12, w=1.0, h=0.76),
        base_zoom=1.18,
    )
    assert 0.0 <= pan_x <= 1.0
    assert 0.0 <= pan_y <= 1.0
    assert zoom >= 1.15

    # 2. Build two distinct 4s MP4 movies (Movie A has a sharp shot cut at 2.0s; Movie B is emerald)
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None
    movie_a = tmp_path / "movie_a.mp4"
    movie_b = tmp_path / "movie_b.mp4"

    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=navy:s=640x360:r=24:d=2.0",
            "-f",
            "lavfi",
            "-i",
            "color=c=crimson:s=640x360:r=24:d=2.0",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=330:sample_rate=44100:duration=4.0",
            "-filter_complex",
            "[0:v][1:v]concat=n=2:v=1:a=0[v]",
            "-map",
            "[v]",
            "-map",
            "2:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(movie_a),
        ],
        check=True,
        timeout=45,
    )
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=darkgreen:s=640x360:r=24:d=4.0",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=520:sample_rate=44100:duration=4.0",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(movie_b),
        ],
        check=True,
        timeout=45,
    )

    cuts = detect_shot_cuts_ms(movie_a, start_ms=0, duration_ms=4000, threshold=0.25)
    assert any(1800 <= c <= 2200 for c in cuts)

    slices = [VideoSlice(id="v1", source_start_ms=0, source_end_ms=4000)]
    reframed = auto_reframe_slices(slices, default_media_path=movie_a, mode="crop")
    assert reframed[0].timeline_start_ms == 0
    assert reframed[-1].timeline_end_ms == 4000

    # 3. Seed 2 ClipProjects from 2 different movie sources and compile + export a Mashup!
    base_edl_a = TimelineProject.model_validate(
        {
            "schemaVersion": 1,
            "projectId": "clip_a",
            "sourceId": "src_a",
            "title": "Lucifer Scene",
            "output": {
                "ratio": "1:1",
                "quality": "720p",
                "speedPreset": "draft",
                "fps": 24,
                "loudnessLufs": -14.0,
            },
            "tracks": {
                "video": {
                    "coldOpen": None,
                    "clips": [{"id": "v1", "sourceStartMs": 0, "sourceEndMs": 2500}],
                    "framing": [
                        {"id": "f1", "timelineStartMs": 0, "timelineEndMs": 2500, "mode": "crop"}
                    ],
                },
                "audio": {"gainDb": 0.0, "normalizeLufs": -14.0, "bgm": None},
                "subtitles": {
                    "enabled": True,
                    "style": {
                        "preset": "bold_pop",
                        "revealMode": "progressive",
                        "font": "Arial",
                        "fontSizeScale": 1.0,
                        "primaryColor": "#FFFFFF",
                        "accentColor": "#FFE500",
                        "outlineColor": "#000000",
                    },
                    "censorProfanity": True,
                    "marginVRatio": 0.35,
                    "muteRanges": [],
                    "words": [{"id": "w1", "text": "LUCIFER.", "startMs": 300, "endMs": 1200}],
                },
                "overlays": [],
            },
        }
    )
    base_edl_b = base_edl_a.model_copy(
        deep=True,
        update={"project_id": "clip_b", "source_id": "src_b", "title": "Hancock Scene"},
    )
    base_edl_b.tracks.subtitles.words[0].text = "STOP IT!"

    with get_session() as session:
        session.add(SourceRow(id="src_a", source_type="inbox", path=str(movie_a), title="Movie A"))
        session.add(SourceRow(id="src_b", source_type="inbox", path=str(movie_b), title="Movie B"))
        session.flush()
        session.add(JobRow(id="job_a", source_id="src_a", status="done", settings_json={}))
        session.add(JobRow(id="job_b", source_id="src_b", status="done", settings_json={}))
        session.flush()
        session.add(
            ClipProjectRow(
                id="clip_a",
                job_id="job_a",
                source_id="src_a",
                rank=1,
                score=90,
                title="Lucifer Scene",
                edl_json=base_edl_a.to_canonical_dict(),
            )
        )
        session.add(
            ClipProjectRow(
                id="clip_b",
                job_id="job_b",
                source_id="src_b",
                rank=1,
                score=88,
                title="Hancock Scene",
                edl_json=base_edl_b.to_canonical_dict(),
            )
        )

    resp = client.post(
        "/api/v1/projects/mashup",
        json={
            "projectIds": ["clip_a", "clip_b"],
            "title": "When They Deal With Bratty Kids",
            "povHook": "When they deal with bratty kids:",
            "transitionStyle": "flash_white",
            "transitionSfx": "whoosh_flash",
        },
    )
    assert resp.status_code == 201
    mash = resp.json()
    assert mash["sliceCount"] == 2
    assert mash["totalDurationMs"] == 5000
    assert mash["edl"]["tracks"]["video"]["clips"][0]["sourceId"] == "src_a"
    assert mash["edl"]["tracks"]["video"]["clips"][1]["sourceId"] == "src_b"
    assert mash["edl"]["tracks"]["video"]["clips"][1]["transitionIn"] == "flash_white"
    assert mash["edl"]["tracks"]["overlays"][0]["kind"] == "pov_top_bar"

    # Export multi-source mashup to MP4 via FFmpeg
    exp_resp = client.post(
        f"/api/v1/projects/{mash['id']}/export",
        json={"ratio": "1:1", "quality": "720p", "speedPreset": "draft"},
    )
    assert exp_resp.status_code == 201
    exp_data = exp_resp.json()
    assert exp_data["ratio"] == "1:1"
    assert exp_data["durationMs"] == 5000

    dl_mp4 = tmp_path / "mashup_out.mp4"
    dl_mp4.write_bytes(client.get(f"/api/v1/exports/{exp_data['id']}/download").content)
    out_info = probe_media(dl_mp4)
    assert out_info.width == 720 and out_info.height == 720
    assert 4500 <= out_info.duration_ms <= 5500
