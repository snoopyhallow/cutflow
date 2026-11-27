"""Milestone 2 tests: FFprobe, 20ms RMS onset alignment, Hype Curve, Inbox, Archive, and API."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from cutflow import paths
from cutflow.ai import (
    HypePoint,
    TranscriptResult,
    TranscriptSegment,
    build_hype_curve,
    complete_json,
    select_hot_windows,
)
from cutflow.ai import llm as llm_module
from cutflow.audio import (
    WordTiming,
    align_words_to_audio,
    compute_peaks_100hz,
    extract_lossless_clip_slice,
    extract_wav_16k,
    normalize_word_timings,
    probe_media,
)
from cutflow.db import JobRow, SourceRow, get_session
from cutflow.db.models import new_id
from cutflow.edl import TimelineProject
from cutflow.ingest import InboxWatcher
from cutflow.workspace import profiles as profile_store
from cutflow.workspace.jobs import run_job_pipeline_sync

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def _make_sample_mp4(dest: Path, duration_s: int = 10) -> Path:
    """Create a real MP4 with 1.5s silence -> 3.0s 440Hz tone -> quiet tail."""
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None
    # Silence [0..1.5s], loud 440Hz burst [1.5..4.5s], soft tail [4.5..10s]
    audio_expr = (
        "aevalsrc="
        "if(lt(t\\,1.5)\\,0\\,if(lt(t\\,4.5)\\,0.75*sin(2*PI*440*t)\\,0.03*sin(2*PI*220*t)))"
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
        f"testsrc2=size=640x360:rate=30:duration={duration_s}",
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
        "96k",
        str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    assert proc.returncode == 0, f"ffmpeg sample gen failed: {proc.stderr}"
    return dest


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe required for media tests")
def test_real_media_probe_peaks_20ms_onset_alignment_and_lossless_slice(tmp_path: Path) -> None:
    sample = _make_sample_mp4(tmp_path / "sample.mp4", duration_s=10)
    info = probe_media(sample)
    assert info.width == 640
    assert info.height == 360
    assert info.has_audio is True
    assert 9500 <= info.duration_ms <= 10500

    wav = extract_wav_16k(sample, tmp_path / "sample.wav")
    peaks = compute_peaks_100hz(wav, rate_hz=100)
    assert peaks["rateHz"] == 100
    assert 900 <= len(peaks["peaks"]) <= 1100

    # Simulate Whisper stretching the opening word backwards across 1.5s of pure silence!
    stretched = [
        WordTiming(text="WHOA!", start_ms=0, end_ms=2600),
        WordTiming(text="LOOK!", start_ms=2600, end_ms=4200),
    ]
    aligned = align_words_to_audio(stretched, wav, window_ms=20)
    assert 1420 <= aligned[0].start_ms <= 1560, f"Expected ~1500ms onset, got {aligned[0].start_ms}"
    assert aligned[1].start_ms >= aligned[0].end_ms

    # Zero-copy lossless clip slice (-c copy)
    slice_path, slice_origin = extract_lossless_clip_slice(
        sample,
        tmp_path / "clip_slice.mp4",
        clip_start_ms=1000,
        clip_end_ms=7000,
        handle_ms=1000,
        source_duration_ms=info.duration_ms,
    )
    assert slice_origin == 0
    slice_info = probe_media(slice_path)
    assert slice_info.width == 640
    assert slice_info.duration_ms >= 5500


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe required")
def test_hype_curve_heatmap_fusion_and_long_vod_window_selection(tmp_path: Path) -> None:
    sample = _make_sample_mp4(tmp_path / "hype.mp4", duration_s=10)
    wav = extract_wav_16k(sample, tmp_path / "hype.wav")

    heatmap = [
        {"start_time": 0.0, "end_time": 2.0, "value": 0.1},
        {"start_time": 2.0, "end_time": 4.0, "value": 0.95},
        {"start_time": 4.0, "end_time": 10.0, "value": 0.15},
    ]
    curve = build_hype_curve(wav, heatmap=heatmap, window_s=2.0)
    assert len(curve) >= 5
    peak = max(curve, key=lambda p: p.score)
    assert 1.5 <= peak.start_s <= 4.5

    # Long VOD (>25 min) selects top non-overlapping hot windows
    long_curve = [
        HypePoint(start_s=i * 60.0, end_s=(i + 1) * 60.0, score=0.95 if i in (10, 45, 90) else 0.1)
        for i in range(120)
    ]
    windows = select_hot_windows(long_curve, duration_ms=120 * 60 * 1000, max_windows=5)
    assert len(windows) == 5
    for idx in range(1, len(windows)):
        assert windows[idx].start_ms >= windows[idx - 1].end_ms


def test_llm_content_hash_cache_avoids_duplicate_api_calls(
    cutflow_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"count": 0}

    def fake_gemini(*_args: Any, **_kwargs: Any) -> str:
        calls["count"] += 1
        return '{"clips": [{"startSec": 1.0, "endSec": 9.0, "score": 91}]}'

    monkeypatch.setenv("CUTFLOW_GEMINI_KEY", "test-key-not-real")
    monkeypatch.setattr(llm_module, "_call_gemini", fake_gemini)

    kwargs = {"system_prompt": "sys", "provider": "gemini", "model": "gemini-test"}
    first = complete_json("find clips", **kwargs)
    second = complete_json("find clips", **kwargs)
    assert first == second
    assert calls["count"] == 1


def test_llm_auto_selects_configured_claude_key_and_compatible_model(
    cutflow_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Any] = {}

    def fake_anthropic(api_key: str, model: str, *_args: Any, **_kwargs: Any) -> str:
        captured["api_key"] = api_key
        captured["model"] = model
        return '{"ok": true}'

    monkeypatch.delenv("CUTFLOW_GEMINI_KEY", raising=False)
    monkeypatch.setenv("CUTFLOW_ANTHROPIC_KEY", "sk-ant-test-key")
    monkeypatch.setattr(llm_module.config.load().models, "active_provider", "gemini")
    monkeypatch.setattr(
        "cutflow.ai.llm.get_secret",
        lambda k: "sk-ant-test-key" if k == "anthropic" else None,
    )
    monkeypatch.setattr(llm_module, "_call_anthropic", fake_anthropic)

    res = complete_json("test auto provider", use_cache=False)
    assert res == {"ok": True}
    assert captured["api_key"] == "sk-ant-test-key"
    assert captured["model"].startswith("claude")


def test_normalize_word_timings_spreads_collapsed_runs_without_rightward_drift() -> None:
    collapsed = [
        WordTiming(text="Wait", start_ms=7020, end_ms=7020),
        WordTiming(text="what", start_ms=7020, end_ms=7020),
        WordTiming(text="happened", start_ms=7020, end_ms=7480),
        WordTiming(text="next?", start_ms=7520, end_ms=7900),
    ]
    norm = normalize_word_timings(collapsed)
    assert [w.text for w in norm] == ["Wait", "what", "happened", "next?"]
    for i in range(len(norm) - 1):
        assert norm[i].end_ms <= norm[i + 1].start_ms
    # Must never push "next?" past its real acoustic start at 7520ms!
    assert norm[3].start_ms == 7520


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe required")
def test_clip_slice_mid_gop_cut_is_frame_accurate_without_keyframe_snap_drift(
    tmp_path: Path,
) -> None:
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None
    # Sparse 10-second single-keyframe (-g 300) video: -c:v copy would snap 3.7s back to 0.0s!
    sparse_mp4 = tmp_path / "sparse_gop.mp4"
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
            "testsrc2=size=640x360:rate=30:duration=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=44100:duration=10",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "300",
            "-keyint_min",
            "300",
            "-sc_threshold",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(sparse_mp4),
        ],
        check=True,
    )
    slice_path, origin_ms = extract_lossless_clip_slice(
        sparse_mp4,
        tmp_path / "exact_slice.mp4",
        clip_start_ms=4700,
        clip_end_ms=7700,
        handle_ms=1000,
        source_duration_ms=10_000,
    )
    assert origin_ms == 3700
    probed = probe_media(slice_path)
    # Expected slice span = [3700ms .. 8700ms] = 5000ms (with -c copy it would bloat to ~8700ms!)
    assert 4850 <= probed.duration_ms <= 5150, f"Got {probed.duration_ms}ms (keyframe drift!)"


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe required")
def test_end_to_end_upload_pipeline_media_peaks_sse_and_raw_vod_archive(
    client: TestClient, tmp_path: Path
) -> None:
    sample = _make_sample_mp4(tmp_path / "vod.mp4", duration_s=10)

    # 1. Upload via multipart endpoint (auto_clip=false so we run pipeline synchronously with stub)
    with sample.open("rb") as fh:
        up = client.post(
            "/api/v1/sources/upload",
            files={"file": ("streamer_vod.mp4", fh, "video/mp4")},
            data={"auto_clip": "false"},
        )
    assert up.status_code == 201
    source_id = up.json()["source"]["id"]

    # 2. Create job row and execute real FFmpeg pipeline with injected fake ASR words
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
        words = [
            WordTiming(text="No", start_ms=0, end_ms=2100),
            WordTiming(text="way!", start_ms=2100, end_ms=3200),
            WordTiming(text="SIU!", start_ms=3200, end_ms=4300),
        ]
        return TranscriptResult(
            language="en",
            provider="stub",
            segments=[TranscriptSegment(start_ms=0, end_ms=4300, text="No way! SIU!", words=words)],
            words=words,
        )

    created_ids = run_job_pipeline_sync(job_id, transcriber=fake_asr)
    assert len(created_ids) >= 1
    project_id = created_ids[0]

    # 3. Verify project listing, canonical EDL v1 timeline, lossless media, peaks, thumb, and SSE
    proj_list = client.get("/api/v1/projects")
    assert proj_list.status_code == 200
    assert any(p["id"] == project_id and p["hasSlice"] and p["hasPeaks"] for p in proj_list.json())

    tl_resp = client.get(f"/api/v1/projects/{project_id}/timeline")
    assert tl_resp.status_code == 200
    edl = TimelineProject.model_validate(tl_resp.json()["edl"])
    assert len(edl.tracks.subtitles.words) == 3
    # First word was silence-stretched from 0ms -> onset aligner snapped it near ~1500ms (+coldOpen)
    cold_open_ms = edl.tracks.video.cold_open.duration_ms if edl.tracks.video.cold_open else 0
    assert edl.tracks.subtitles.words[0].start_ms >= cold_open_ms + 1300

    media_resp = client.get(f"/api/v1/projects/{project_id}/media")
    assert media_resp.status_code == 200
    assert media_resp.headers["content-type"] == "video/mp4"

    peaks_resp = client.get(f"/api/v1/projects/{project_id}/peaks")
    assert peaks_resp.status_code == 200
    assert peaks_resp.json()["rateHz"] == 100

    thumb_resp = client.get(f"/api/v1/projects/{project_id}/thumb")
    assert thumb_resp.status_code == 200
    assert thumb_resp.headers["content-type"] == "image/jpeg"

    sse_resp = client.get(f"/api/v1/jobs/{job_id}/events")
    assert sse_resp.status_code == 200
    assert '"status": "done"' in sse_resp.text

    # 4. 1-click Raw VOD Archive deletes raw source MP4 while lossless clip slice stays playable!
    arch_resp = client.post(f"/api/v1/sources/{source_id}/archive")
    assert arch_resp.status_code == 200
    assert arch_resp.json()["archived"] is True
    assert arch_resp.json()["reclaimedBytes"] > 0

    media_after = client.get(f"/api/v1/projects/{project_id}/media")
    assert media_after.status_code == 200


def test_url_ingest_endpoint_blocks_ssrf_and_inbox_watcher_two_pass_stability(
    client: TestClient,
) -> None:
    # SSRF protection on URL ingest
    for bad in ("http://127.0.0.1:8010/api/v1/settings", "file:///C:/Windows/win.ini"):
        resp = client.post("/api/v1/sources/url", json={"url": bad})
        assert resp.status_code == 400

    # Two-pass inbox drop stability & hardlink ingest
    profile = profile_store.list_profiles()[0]
    profile_folder = paths.inbox_dir() / profile.id
    profile_folder.mkdir(parents=True, exist_ok=True)
    drop_file = profile_folder / "dropped_clip.mp4"
    drop_file.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"0" * 1024)

    watcher = InboxWatcher()
    # First scan observes file fingerprint; skips while stability is unconfirmed
    assert watcher.scan_once(require_stable=True) == []
    assert drop_file.exists()

    # Second scan sees identical size/mtime -> ingests & moves original to processed/
    ingested = watcher.scan_once(require_stable=True)
    assert len(ingested) == 1
    assert not drop_file.exists()
    assert (profile_folder / "processed" / "dropped_clip.mp4").is_file()

    with get_session() as session:
        src = session.get(SourceRow, ingested[0]["sourceId"])
        assert src is not None and src.source_type == "inbox"
        assert Path(src.path).is_file()
