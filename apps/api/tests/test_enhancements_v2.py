"""Enhanced tests: Hot-Window ASR, Silence Tightener, Multi-Segment Framing, Karaoke, Pin Cam."""

from __future__ import annotations

import json
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from cutflow.ai import HotWindow, TranscriptResult, TranscriptSegment, transcribe_hot_windows
from cutflow.audio import WordTiming, probe_media
from cutflow.db import ClipProjectRow, JobRow, SourceRow, get_session
from cutflow.edl import (
    TimelineMapper,
    TimelineProject,
    auto_tighten_silence,
    split_framing_segment,
)
from cutflow.render import generate_ass_subtitles, render_edl_to_mp4

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


def _write_test_wav(dest: Path, duration_s: int = 20, sr: int = 16000) -> Path:
    samples = np.zeros(duration_s * sr, dtype=np.int16)
    with wave.open(str(dest), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(samples.tobytes())
    return dest


def test_hot_window_scoped_asr_offsets_timestamps_into_vod_time(tmp_path: Path) -> None:
    wav = _write_test_wav(tmp_path / "long.wav", duration_s=30)
    windows = [
        HotWindow(start_ms=4_000, end_ms=9_000, peak_score=0.92),
        HotWindow(start_ms=18_000, end_ms=24_000, peak_score=0.88),
    ]

    def fake_transcriber(_chunk: Path, **_kw: object) -> TranscriptResult:
        wt = WordTiming(text="CLUTCH!", start_ms=500, end_ms=1200)
        return TranscriptResult(
            language="en",
            provider="stub",
            segments=[TranscriptSegment(start_ms=500, end_ms=1200, text="CLUTCH!", words=[wt])],
            words=[wt],
        )

    merged = transcribe_hot_windows(wav, windows, transcriber_fn=fake_transcriber)
    assert len(merged.words) == 2
    assert merged.words[0].start_ms == 4_500
    assert merged.words[1].start_ms == 18_500


def test_auto_tighten_silence_and_karaoke_kf_sweep() -> None:
    edl = _load_fixture()
    # Fixture has words [1700..3700] and [9500..10600] -> two large silent pauses to tighten!
    tightened, cuts, saved_ms = auto_tighten_silence(edl, min_gap_ms=1100)
    assert cuts >= 2
    assert saved_ms >= 14_000
    assert TimelineMapper(tightened).total_duration_ms < 7_500

    # Verify true libass \kf sweep generation when preset == "karaoke_fill"
    edl.tracks.subtitles.style.preset = "karaoke_fill"
    ass = generate_ass_subtitles(edl)
    assert r"{\kf" in ass


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe required")
def test_multi_segment_framing_keyframes_compile_and_render_cleanly(tmp_path: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None
    src = tmp_path / "multi_frame_src.mp4"
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
            "color=c=#182438:s=640x360:r=30:d=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=44100:duration=10",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(src),
        ],
        check=True,
    )

    edl = _load_fixture()
    edl.output.quality = "720p"
    edl.output.speed_preset = "draft"
    edl.output.fps = 30
    edl.tracks.video.cold_open = None
    edl.tracks.video.clips[0].source_start_ms = 0
    edl.tracks.video.clips[0].source_end_ms = 6000
    edl.tracks.video.framing[0].timeline_end_ms = 6000
    edl.tracks.overlays[0].end_ms = 6000
    edl.tracks.subtitles.words = []

    # Split layout at 3000ms: [0..3000ms: split] -> [3000..6000ms: fit]!
    keyframed = split_framing_segment(edl, 3000, right_mode="fit")
    assert len(keyframed.tracks.video.framing) == 2
    assert (
        keyframed.tracks.video.framing[0].mode,
        keyframed.tracks.video.framing[1].mode,
    ) == ("split", "fit")

    out_mp4 = tmp_path / "keyframed_out.mp4"
    render_edl_to_mp4(
        keyframed,
        media_path=src,
        output_path=out_mp4,
        scratch_dir=tmp_path / "scratch",
        prefer_nvenc=False,
    )
    info = probe_media(out_mp4)
    assert (info.width, info.height) == (720, 1280)
    assert 5400 <= info.duration_ms <= 6600


def test_profile_split_layout_creation_pin_webcam_and_tighten_api(client: TestClient) -> None:
    # Regression test: creating a profile with layout_mode='split' or 'centre' succeeds (HTTP 201)
    created = client.post(
        "/api/v1/profiles",
        json={"name": "Split Cam Streamer", "layout_mode": "split", "reveal_mode": "progressive"},
    )
    assert created.status_code == 201, created.text
    prof_id = created.json()["id"]

    raw_edl = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    raw_edl["profileId"] = prof_id
    with get_session() as session:
        session.add(
            SourceRow(id="src_pin_1", source_type="upload", path="demo.mp4", title="Pin Test")
        )
        session.flush()
        session.add(
            JobRow(id="job_pin_1", source_id="src_pin_1", status="done", settings_json={})
        )
        session.flush()
        session.add(
            ClipProjectRow(
                id="clip_pin_1",
                job_id="job_pin_1",
                source_id="src_pin_1",
                rank=1,
                score=90,
                title="Pin Test",
                edl_json=raw_edl,
            )
        )

    # Pin webcam box to Creator Profile
    pin_resp = client.post(
        "/api/v1/projects/clip_pin_1/pin-webcam",
        json={"camBox": {"x": 0.04, "y": 0.22, "w": 0.25, "h": 0.28}, "splitRatio": 0.38},
    )
    assert pin_resp.status_code == 200
    assert pin_resp.json()["cam_box"]["x"] == 0.04
    assert pin_resp.json()["split_ratio"] == 0.38

    # Tighten silence via REST API
    tight_resp = client.post(
        "/api/v1/projects/clip_pin_1/tighten-silence",
        json={"minGapMs": 1100},
    )
    assert tight_resp.status_code == 200
    assert tight_resp.json()["cutsApplied"] >= 2
    assert tight_resp.json()["totalDurationMs"] < 7500
