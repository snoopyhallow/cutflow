"""Phase 1 verification: 3-way multi-track EDL schema, NLE ops, Blank Projects, & FFmpeg render."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import jsonschema
import pytest
from fastapi.testclient import TestClient

from cutflow.app import create_app
from cutflow.audio.media import probe_media
from cutflow.edl import (
    TimelineMapper,
    TimelineProject,
    add_audio_clip,
    add_broll_clip,
    add_overlay_item,
    apply_edl_patch,
    delete_clip,
    detach_clip_audio,
    duplicate_clip,
    freeze_frame_at,
    set_clip_speed,
    split_clip_at,
    trim_clip_edges,
)
from cutflow.edl.schema import (
    AudioTrack,
    FramingSegment,
    OutputSpec,
    SubtitleTrack,
    TimelineTracks,
    VideoSlice,
    VideoTrack,
)
from cutflow.render import render_edl_to_mp4

SCHEMA_PATH = (
    Path(__file__).resolve().parents[3] / "packages" / "edl-schema" / "timeline.v1.schema.json"
)


def _sample_edl() -> TimelineProject:
    return TimelineProject(
        schema_version=1,
        project_id="clip_p1_test",
        source_id="src_p1",
        title="Phase 1 Multi-Track Test",
        source_duration_ms=8000,
        source_width=640,
        source_height=360,
        output=OutputSpec(ratio="9:16", quality="720p", speed_preset="draft", fps=30),
        tracks=TimelineTracks(
            video=VideoTrack(
                cold_open=None,
                clips=[
                    VideoSlice(
                        id="s1",
                        source_start_ms=0,
                        source_end_ms=4000,
                        source_id="src_p1",
                        label="Scene 1",
                    )
                ],
                framing=[
                    FramingSegment(
                        id="f1",
                        timeline_start_ms=0,
                        timeline_end_ms=4000,
                        mode="fit",
                    )
                ],
            ),
            audio=AudioTrack(gain_db=0.0, normalize_lufs=-14.0),
            subtitles=SubtitleTrack(enabled=True, words=[]),
            overlays=[],
        ),
    )


def _synth_test_video(dest: Path, duration_s: float = 4.0) -> Path:
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None
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
            f"testsrc=size=640x360:rate=30:duration={duration_s:.1f}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:sample_rate=48000:duration={duration_s:.1f}",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(dest),
        ],
        check=True,
        capture_output=True,
    )
    return dest


def test_multitrack_edl_validates_against_canonical_json_schema() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    edl = _sample_edl()
    edl = split_clip_at(edl, 2000)
    assert len(edl.tracks.video.clips) == 2
    c2_id = edl.tracks.video.clips[1].id

    edl = set_clip_speed(edl, c2_id, 2.0)
    # 2000ms + (2000ms / 2.0) = 3000ms
    assert TimelineMapper(edl).total_duration_ms == 3000

    edl = detach_clip_audio(edl, edl.tracks.video.clips[0].id)
    assert edl.tracks.video.clips[0].audio_detached is True
    assert len(edl.tracks.audio.clips) == 1
    assert edl.tracks.audio.clips[0].kind == "detached"

    edl = add_broll_clip(
        edl, source_id="src_p1", source_start_ms=500, source_end_ms=2000, timeline_start_ms=300
    )
    edl = add_audio_clip(edl, kind="sfx", asset_id="whoosh_flash", timeline_start_ms=1900)
    edl = add_overlay_item(edl, kind="seam_card_white", text="Headline Hook", scale=1.35)
    edl.tracks.audio.gain_db = -60.0

    canonical = edl.to_canonical_dict()
    jsonschema.validate(instance=canonical, schema=schema)


def test_non_ripple_gap_delete_and_freeze_frame() -> None:
    edl = _sample_edl()
    edl = split_clip_at(edl, 1500)
    edl = split_clip_at(edl, 3000)
    assert len(edl.tracks.video.clips) == 3

    mid_id = edl.tracks.video.clips[1].id
    # Non-ripple delete leaves [1500, 3000] as a 1.5s gap so total duration stays 4000ms!
    gapped = delete_clip(edl, mid_id, ripple=False)
    mapper = TimelineMapper(gapped)
    assert mapper.total_duration_ms == 4000
    pt_gap = mapper.resolve_at(2000)
    assert pt_gap.is_gap is True

    # Freeze frame inserts 1000ms hold
    frozen = freeze_frame_at(gapped, 500, duration_ms=1000)
    assert TimelineMapper(frozen).total_duration_ms == 5000

    # Trim, duplicate, and overlay deletion via apply_edl_patch
    dup = duplicate_clip(gapped, gapped.tracks.video.clips[0].id)
    trimmed = trim_clip_edges(
        dup, dup.tracks.video.clips[0].id, source_start_ms=200, source_end_ms=1200
    )
    with_ov = add_overlay_item(trimmed, kind="seam_card_white", text="Headline Hook")
    patched, _, summaries = apply_edl_patch(
        with_ov,
        [
            {"op": "delete_overlay"},
            {"op": "set_audio", "gainDb": -60.0},
        ],
    )
    assert len(patched.tracks.overlays) == 0
    assert patched.tracks.audio.gain_db == -60.0
    assert any("Removed" in s for s in summaries)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required")
def test_ffmpeg_compiler_renders_speed_gap_broll_sfx_and_true_mute(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CUTFLOW_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CUTFLOW_SKIP_LEGACY_IMPORT", "1")
    monkeypatch.setenv("CUTFLOW_DISABLE_WATCHER", "1")
    from cutflow.audio import ensure_starter_audio_assets

    ensure_starter_audio_assets()
    vid = _synth_test_video(tmp_path / "src.mp4", duration_s=4.0)

    edl = _sample_edl()
    edl = split_clip_at(edl, 2000)
    # 2x speed on second slice + 400ms gap before second slice => 2000 + 400 + 1000 = 3400ms
    c2_id = edl.tracks.video.clips[1].id
    edl = set_clip_speed(edl, c2_id, 2.0)
    edl = trim_clip_edges(edl, c2_id, timeline_start_ms=2400)
    edl = add_broll_clip(
        edl, source_id="src_p1", source_start_ms=0, source_end_ms=1200, timeline_start_ms=200
    )
    edl = add_audio_clip(
        edl, kind="sfx", asset_id="whoosh_flash", timeline_start_ms=500, gain_db=-60.0
    )
    edl = add_overlay_item(edl, kind="seam_card_white", text="Scaled Hook", scale=1.25)
    edl.tracks.audio.gain_db = -60.0  # -infinity dB true silence

    out_mp4 = tmp_path / "rendered_multitrack.mp4"
    plan = render_edl_to_mp4(
        edl,
        media_path=vid,
        output_path=out_mp4,
        scratch_dir=tmp_path / "scratch",
        prefer_nvenc=False,
    )
    assert out_mp4.is_file() and out_mp4.stat().st_size > 1000
    assert plan.duration_ms == 3400
    info = probe_media(out_mp4)
    assert 3100 <= info.duration_ms <= 3700


def test_blank_project_and_local_path_api_routes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CUTFLOW_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CUTFLOW_SKIP_LEGACY_IMPORT", "1")
    monkeypatch.setenv("CUTFLOW_DISABLE_WATCHER", "1")
    monkeypatch.setenv("CUTFLOW_DESKTOP_TOKEN", "secret-desk-tok")

    local_mp4 = tmp_path / "sample_local.mp4"
    if shutil.which("ffmpeg"):
        _synth_test_video(local_mp4, duration_s=2.0)
    else:
        local_mp4.write_bytes(b"\x00\x00\x00\x18ftypmp42")

    app = create_app()
    with TestClient(app) as client:
        # Without desktop token -> 403
        denied = client.post("/api/v1/sources/local-path", json={"path": str(local_mp4)})
        assert denied.status_code == 403

        # With desktop token -> 201 zero-copy import
        ok = client.post(
            "/api/v1/sources/local-path",
            json={"path": str(local_mp4), "title": "Direct Disk Clip"},
            headers={"X-CutFlow-Desktop-Token": "secret-desk-tok"},
        )
        assert ok.status_code == 201
        src_id = ok.json()["source"]["id"]

        # Create Blank Project from imported source
        blank = client.post(
            "/api/v1/projects/blank",
            json={"title": "Manual CapCut Edit", "ratio": "16:9", "sourceId": src_id},
        )
        assert blank.status_code == 201
        proj_id = blank.json()["id"]
        assert blank.json()["edl"]["output"]["ratio"] == "16:9"

        # Stream media fallback directly from SourceRow.path
        media_res = client.get(f"/api/v1/projects/{proj_id}/media")
        assert media_res.status_code == 200

        # Rename, Duplicate, Delete, & SFX listing
        renamed = client.patch(f"/api/v1/projects/{proj_id}", json={"title": "Renamed Cut"})
        assert renamed.status_code == 200
        assert renamed.json()["title"] == "Renamed Cut"

        dup = client.post(f"/api/v1/projects/{proj_id}/duplicate")
        assert dup.status_code == 201
        dup_id = dup.json()["id"]

        sfx = client.get("/api/v1/sfx")
        assert sfx.status_code == 200
        assert len(sfx.json()) >= 2

        del_res = client.delete(f"/api/v1/projects/{dup_id}")
        assert del_res.status_code == 204
