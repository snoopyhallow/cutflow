"""Phase 3 tests: BGM/SFX library, dual-layer neon ASS, POV/border PNGs & zero-touch FFmpeg mix."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from cutflow.audio import (
    ensure_starter_audio_assets,
    extract_frame_jpeg,
    find_bgm_start_offset_ms,
    list_bgm_assets,
    probe_media,
    resolve_sfx_path,
)
from cutflow.db import ClipProjectRow, JobRow, SourceRow, get_session
from cutflow.edl import (
    BgmTrack,
    FramingSegment,
    NormalizedBox,
    OutputSpec,
    OverlayItem,
    SubtitleStyle,
    SubtitleTrack,
    SubtitleWord,
    TimelineProject,
    VideoSlice,
)
from cutflow.render import (
    generate_ass_subtitles,
    render_border_frame_png,
    render_edl_to_mp4,
    render_overlay_png,
)

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


def _make_drop_wav_bytes(sr: int = 16000, quiet_s: int = 4, loud_s: int = 8) -> bytes:
    """Build a 12s WAV whose first 4s are near-silent and 4s..12s drop into a loud beat."""
    quiet = np.zeros(sr * quiet_s, dtype=np.float32)
    t = np.linspace(0.0, loud_s, sr * loud_s, endpoint=False, dtype=np.float32)
    loud = 0.75 * np.sin(2.0 * np.pi * 110.0 * t)
    pcm = (np.concatenate([quiet, loud]) * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def test_bgm_starter_pack_drop_offset_and_api_crud(client: TestClient, tmp_path: Path) -> None:
    ensure_starter_audio_assets()
    assert resolve_sfx_path("whoosh_flash") is not None
    assert resolve_sfx_path("cinema_hit") is not None

    assets = list_bgm_assets()
    ids = {a.id for a in assets}
    assert {"dark_cinema_pulse", "upbeat_challenge_drive"}.issubset(ids)

    # Beat-drop scanner skips dead 4s intro and lands cleanly on the 4000ms onset
    drop_wav = tmp_path / "intro_drop.wav"
    wav_bytes = _make_drop_wav_bytes()
    drop_wav.write_bytes(wav_bytes)
    offset_ms = find_bgm_start_offset_ms(drop_wav, duration_ms=12_000)
    assert 3500 <= offset_ms <= 5000

    # REST API: list, upload custom BGM, stream media, protect builtins, delete custom
    listed = client.get("/api/v1/bgm")
    assert listed.status_code == 200
    assert len(listed.json()) >= 2

    up = client.post(
        "/api/v1/bgm/upload",
        files={"file": ("synth_drop.wav", io.BytesIO(wav_bytes), "audio/wav")},
        data={"name": "Synth Drop Test", "mood": "dark_cinema"},
    )
    assert up.status_code == 201, up.text
    uploaded = up.json()
    assert uploaded["mood"] == "dark_cinema"
    assert uploaded["builtin"] is False
    assert 3500 <= uploaded["dropOffsetMs"] <= 5000

    stream = client.get(f"/api/v1/bgm/{uploaded['id']}/media")
    assert stream.status_code == 200
    assert stream.headers["content-type"].startswith("audio/")
    assert len(stream.content) == len(wav_bytes)

    # Built-in starter beds cannot be deleted
    forbid = client.delete("/api/v1/bgm/dark_cinema_pulse")
    assert forbid.status_code == 400

    # Custom uploaded BGM deletes cleanly
    deleted = client.delete(f"/api/v1/bgm/{uploaded['id']}")
    assert deleted.status_code == 204
    assert client.get(f"/api/v1/bgm/{uploaded['id']}/media").status_code == 404


def test_dual_layer_cinema_neon_glow_and_viral_punch_glow_ass() -> None:
    edl = _load_fixture()
    edl.tracks.subtitles = SubtitleTrack(
        enabled=True,
        style=SubtitleStyle(
            preset="cinema_neon_glow",
            reveal_mode="group",
            letter_spacing=3.5,
            color_palette=["#4F7CFF", "#4ADE80"],
        ),
        margin_v_ratio=0.42,
        words=[
            SubtitleWord(id="w1", text="Real", start_ms=500, end_ms=900),
            SubtitleWord(id="w2", text="eyes.", start_ms=900, end_ms=1400),
            SubtitleWord(id="w3", text="Realize", start_ms=2100, end_ms=2600),
            SubtitleWord(id="w4", text="lies.", start_ms=2600, end_ms=3200),
        ],
    )
    ass_cinema = generate_ass_subtitles(edl, play_res_x=1080, play_res_y=1080)
    assert "Style: GlowLayer," in ass_cinema
    assert "Style: CoreLayer," in ass_cinema
    assert r"\blur12" in ass_cinema
    assert r"\blur0.6" in ass_cinema
    # Both #4F7CFF (BGR FF7C4F) and #4ADE80 (BGR 80DE4A) appear as phrases rotate!
    assert "FF7C4F" in ass_cinema
    assert "80DE4A" in ass_cinema

    # Viral Punch Glow: punch words ($1,000,000, DEAD) emit Layer 0 glow while filler stays clean
    edl.tracks.subtitles.style.preset = "viral_punch_glow"
    edl.tracks.subtitles.words = [
        SubtitleWord(id="p1", text="He", start_ms=200, end_ms=450),
        SubtitleWord(id="p2", text="won", start_ms=450, end_ms=750),
        SubtitleWord(id="p3", text="$1,000,000", start_ms=750, end_ms=1400, glow_color="#4ADE80"),
    ]
    ass_punch = generate_ass_subtitles(edl, play_res_x=1080, play_res_y=1920)
    assert "Dialogue: 0," in ass_punch
    assert "Dialogue: 1," in ass_punch
    assert r"\alpha&HFF&" in ass_punch
    assert "80DE4A" in ass_punch


def test_pov_top_bar_2d_watermark_cinema_credit_and_border_frames(tmp_path: Path) -> None:
    out_w, out_h = 1080, 1080

    pov = OverlayItem(
        id="ov_pov",
        kind="pov_top_bar",
        text="POV: MOVIES SHOWING THE DARK SIDE",
        start_ms=0,
        end_ms=3500,
        y_anchor="top",
    )
    pov_res = render_overlay_png(pov, tmp_path / "pov.png", out_w=out_w, out_h=out_h)
    assert pov_res.x_px == 0
    assert pov_res.y_px == 0
    assert pov_res.width == out_w
    pov_img = Image.open(pov_res.png_path)
    # Top-left of flush POV bar is crisp opaque white
    r, g, b, a = pov_img.getpixel((12, 12))
    assert r > 245 and g > 245 and b > 245 and a > 240

    wm = OverlayItem(
        id="ov_wm",
        kind="watermark_tag",
        text="JJ_EDIT",
        start_ms=0,
        end_ms=8000,
        y_anchor="bottom",
        x_offset_ratio=0.25,
        y_offset_ratio=0.05,
        opacity=0.65,
    )
    wm_res = render_overlay_png(wm, tmp_path / "wm.png", out_w=out_w, out_h=out_h)
    # Shifted right of center because x_offset_ratio == +0.25
    assert wm_res.x_px > out_w // 2

    credit = OverlayItem(
        id="ov_cred",
        kind="cinema_credit",
        text="Nightcrawler (2014)",
        start_ms=0,
        end_ms=4000,
        y_anchor="bottom",
    )
    cred_res = render_overlay_png(credit, tmp_path / "credit.png", out_w=out_w, out_h=out_h)
    assert cred_res.png_path.is_file()

    thin_png = render_border_frame_png(
        "thin_rounded", tmp_path / "thin.png", out_w=out_w, out_h=out_h
    )
    dbl_png = render_border_frame_png(
        "double_cinema", tmp_path / "dbl.png", out_w=out_w, out_h=out_h
    )
    assert thin_png is not None and thin_png.is_file()
    assert dbl_png is not None and dbl_png.is_file()
    border_img = Image.open(thin_png)
    # Center of frame stays 100% transparent so video is unobstructed
    assert border_img.getpixel((out_w // 2, out_h // 2))[3] == 0
    # Top-center accent indicator bar has bright white alpha
    inset_y = int(round(out_h * 0.022))
    assert border_img.getpixel((out_w // 2, inset_y))[3] > 180


def test_edl_patch_bgm_audio_output_and_transitions(client: TestClient) -> None:
    raw_edl = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    raw_edl["projectId"] = "clip_p3_patch"
    with get_session() as session:
        session.add(SourceRow(id="src_p3", source_type="upload", path="demo.mp4", title="P3"))
        session.flush()
        session.add(JobRow(id="job_p3", source_id="src_p3", status="done", settings_json={}))
        session.flush()
        session.add(
            ClipProjectRow(
                id="clip_p3_patch",
                job_id="job_p3",
                source_id="src_p3",
                rank=1,
                score=92,
                title="P3 Patch",
                edl_json=raw_edl,
            )
        )

    resp = client.post(
        "/api/v1/projects/clip_p3_patch/patch",
        json={
            "ops": [
                {
                    "op": "set_output",
                    "ratio": "1:1",
                    "borderStyle": "thin_rounded",
                    "cinemaGrade": "crisp_hd",
                },
                {"op": "set_audio", "dialogueEnhance": True, "gainDb": 1.5},
                {
                    "op": "set_bgm",
                    "assetId": "dark_cinema_pulse",
                    "gainDb": -15.0,
                    "duckingEnabled": True,
                },
                {
                    "op": "set_slice_transition",
                    "clipIndex": 0,
                    "transitionIn": "flash_white",
                    "transitionSfx": "whoosh_flash",
                },
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    updated = resp.json()["edl"]
    assert updated["output"]["ratio"] == "1:1"
    assert updated["output"]["borderStyle"] == "thin_rounded"
    assert updated["output"]["cinemaGrade"] == "crisp_hd"
    assert updated["tracks"]["audio"]["dialogueEnhance"] is True
    assert updated["tracks"]["audio"]["bgm"]["assetId"] == "dark_cinema_pulse"
    assert updated["tracks"]["video"]["clips"][0]["transitionIn"] == "flash_white"


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe required for Phase 3 render test")
def test_real_ffmpeg_cinema_square_glow_transitions_border_and_ducked_bgm(
    tmp_path: Path,
) -> None:
    ensure_starter_audio_assets()
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None

    # Create a 10s 16:9 source with baked letterbox bars & speech-like tone bursts
    src_mp4 = tmp_path / "cinema_src.mp4"
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
            "color=c=#142238:s=640x360:r=30:d=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=320:sample_rate=44100:duration=10",
            "-vf",
            "drawbox=x=0:y=0:w=640:h=44:color=black:t=fill,"
            "drawbox=x=0:y=316:w=640:h=44:color=black:t=fill",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(src_mp4),
        ],
        check=True,
    )

    edl = _load_fixture()
    edl.source_duration_ms = 10_000
    edl.source_width = 640
    edl.source_height = 360
    edl.output = OutputSpec(
        ratio="1:1",
        quality="720p",
        speed_preset="draft",
        fps=30,
        loudness_lufs=-14.0,
        border_style="thin_rounded",
        cinema_grade="crisp_hd",
    )
    edl.tracks.video.cold_open = None
    edl.tracks.video.clips = [
        VideoSlice(
            id="s1",
            source_start_ms=500,
            source_end_ms=3500,
            label="Scene 1",
        ),
        VideoSlice(
            id="s2",
            source_start_ms=5500,
            source_end_ms=8500,
            label="Scene 2",
            transition_in="flash_white",
            transition_duration_ms=260,
            transition_sfx="whoosh_flash",
        ),
    ]
    edl.tracks.video.framing = [
        FramingSegment(
            id="f1",
            timeline_start_ms=0,
            timeline_end_ms=6000,
            mode="crop",
            pan_x=0.35,
            pan_y=0.45,
            zoom=1.16,
            source_crop_box=NormalizedBox(x=0.0, y=0.125, w=1.0, h=0.75),
        )
    ]
    edl.tracks.audio.dialogue_enhance = True
    edl.tracks.audio.bgm = BgmTrack(
        asset_id="dark_cinema_pulse",
        gain_db=-15.0,
        ducking_enabled=True,
        start_offset_ms=0,
        fade_in_ms=400,
        fade_out_ms=800,
    )
    edl.tracks.overlays = [
        OverlayItem(
            id="ov_pov",
            kind="pov_top_bar",
            text="POV: WHEN REALITY HITS",
            start_ms=0,
            end_ms=2500,
            y_anchor="top",
        ),
        OverlayItem(
            id="ov_wm",
            kind="watermark_tag",
            text="JJ_EDIT",
            start_ms=0,
            end_ms=6000,
            y_anchor="bottom",
            y_offset_ratio=0.06,
            opacity=0.80,
        ),
    ]
    edl.tracks.subtitles = SubtitleTrack(
        enabled=True,
        style=SubtitleStyle(
            preset="cinema_neon_glow",
            reveal_mode="progressive",
            letter_spacing=3.5,
            color_palette=["#4F7CFF", "#4ADE80"],
        ),
        margin_v_ratio=0.40,
        words=[
            SubtitleWord(id="w1", text="Everything", start_ms=600, end_ms=1300),
            SubtitleWord(id="w2", text="changed.", start_ms=1300, end_ms=2100),
            SubtitleWord(id="w3", text="Look", start_ms=3400, end_ms=4000),
            SubtitleWord(id="w4", text="closer.", start_ms=4000, end_ms=4900),
        ],
    )

    out_mp4 = tmp_path / "cinema_square_out.mp4"
    plan = render_edl_to_mp4(
        edl,
        media_path=src_mp4,
        output_path=out_mp4,
        scratch_dir=tmp_path / "scratch",
        prefer_nvenc=False,
    )
    assert out_mp4.is_file()
    assert plan.border_path is not None and plan.border_path.is_file()
    assert plan.bgm_path is not None and plan.bgm_path.is_file()
    assert plan.ass_path is not None and plan.ass_path.is_file()

    info = probe_media(out_mp4)
    assert (info.width, info.height) == (720, 720)
    assert info.has_audio is True
    # Zero-drift transitions preserve exact 6.0s duration!
    assert 5750 <= info.duration_ms <= 6250

    # Check frame at t=0.5s: top POV white banner is visible at y=16
    f_pov = Image.open(
        extract_frame_jpeg(out_mp4, tmp_path / "f_pov.jpg", timestamp_ms=500)
    ).convert("RGB")
    r0, g0, b0 = f_pov.getpixel((60, 16))
    assert r0 > 215 and g0 > 215 and b0 > 215

    # Check frame at t=3.00s cut boundary: flash_white drives luma well above mid-clip
    f_mid = Image.open(
        extract_frame_jpeg(out_mp4, tmp_path / "f_mid.jpg", timestamp_ms=1800)
    ).convert("RGB")
    f_cut = Image.open(
        extract_frame_jpeg(out_mp4, tmp_path / "f_cut.jpg", timestamp_ms=3010)
    ).convert("RGB")
    mid_luma = sum(f_mid.getpixel((360, 200))) / 3.0
    cut_luma = sum(f_cut.getpixel((360, 200))) / 3.0
    assert cut_luma > mid_luma + 60.0


def test_phase5_idempotent_zero_touch_starter_profiles_and_edl_defaults(
    cutflow_home: Path,
) -> None:
    from cutflow import db
    from cutflow.ai.edl_builder import build_clip_edl
    from cutflow.ai.highlights import HighlightCandidate
    from cutflow.audio.align import WordTiming
    from cutflow.audio.media import MediaInfo
    from cutflow.workspace import profiles as profile_store

    db.init_db()
    # Simulate an older pre-v0.3 database that only had General Gaming Streamer
    legacy_only = profile_store.default_profiles()[0]
    profile_store.upsert_profile(legacy_only)
    assert [p.id for p in profile_store.list_profiles()] == ["general-gaming-streamer"]

    # Upgrade boot idempotently seeds Cinema & TV Edits and Viral Gaming Challenge
    seeded = profile_store.seed_and_import_profiles(
        autoclip_profiles_file=Path("/__nonexistent__")
    )
    seeded_ids = {p.id for p in seeded}
    assert "cinema-tv-edits" in seeded_ids
    assert "viral-gaming-challenge" in seeded_ids

    cinema_prof = profile_store.get_profile("cinema-tv-edits")
    gaming_prof = profile_store.get_profile("viral-gaming-challenge")
    assert cinema_prof is not None and cinema_prof.auto_export is False
    assert gaming_prof is not None and gaming_prof.auto_export is False

    # Verify zero-touch Cinema EDL gets 1:1, thin_rounded, crisp_hd, neon glow, POV & BGM
    edl = build_clip_edl(
        project_id="clip_zt_cinema",
        source_id="src_movie",
        media=MediaInfo(
            path=Path("movie.mkv"),
            duration_ms=120_000,
            width=1920,
            height=1080,
            fps=24.0,
            has_audio=True,
            video_codec="h264",
            audio_codec="ac3",
            size_bytes=1_000_000,
        ),
        profile=cinema_prof,
        candidate=HighlightCandidate(
            start_ms=10_000,
            end_ms=42_000,
            score=95,
            title="The Moment He Knew",
            seam_title="When Reality Hits",
            reason="Climactic realization.",
            pov_hook="POV: HE KNEW ALL ALONG",
            slices=[(10_000, 24_000), (30_000, 42_000)],
            mood="dark_cinema",
        ),
        aligned_clip_words=[
            WordTiming(text="You", start_ms=500, end_ms=900),
            WordTiming(text="knew.", start_ms=900, end_ms=1500),
        ],
        source_title="Casino Royale (2006)",
    )
    assert edl.output.ratio == "1:1"
    assert edl.output.border_style == "thin_rounded"
    assert edl.output.cinema_grade == "crisp_hd"
    assert edl.tracks.subtitles.style.preset == "cinema_neon_glow"
    assert edl.tracks.audio.bgm is not None
    assert edl.tracks.audio.bgm.asset_id == "dark_cinema_pulse"
    assert any(o.kind == "pov_top_bar" for o in edl.tracks.overlays)
    assert any(o.kind == "cinema_credit" for o in edl.tracks.overlays)

