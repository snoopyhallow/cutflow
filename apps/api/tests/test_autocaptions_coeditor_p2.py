"""Phase 2 verification: GTX 1050 Ti int8 ASR selection, 1-click Auto-Captions, & AI Co-Editor."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from fastapi.testclient import TestClient

from cutflow.ai import (
    TranscriptResult,
    TranscriptSegment,
    run_coeditor,
    select_faster_whisper_targets,
)
from cutflow.app import create_app
from cutflow.audio.align import WordTiming
from cutflow.edl.schema import (
    AudioTrack,
    FramingSegment,
    OutputSpec,
    OverlayItem,
    SubtitleTrack,
    TimelineProject,
    TimelineTracks,
    VideoSlice,
    VideoTrack,
)


def _make_edl_with_hook() -> TimelineProject:
    return TimelineProject(
        schema_version=1,
        project_id="clip_p2",
        source_id="src_p2",
        title="Hook Removal Test",
        source_duration_ms=6000,
        output=OutputSpec(ratio="9:16", quality="720p", speed_preset="draft", fps=30),
        tracks=TimelineTracks(
            video=VideoTrack(
                cold_open=None,
                clips=[VideoSlice(id="s1", source_start_ms=0, source_end_ms=5000)],
                framing=[
                    FramingSegment(id="f1", timeline_start_ms=0, timeline_end_ms=5000, mode="split")
                ],
            ),
            audio=AudioTrack(gain_db=0.0, normalize_lufs=-14.0),
            subtitles=SubtitleTrack(enabled=True, words=[]),
            overlays=[
                OverlayItem(
                    id="ov_hook",
                    kind="seam_card_white",
                    text="Headline Hook",
                    start_ms=0,
                    end_ms=5000,
                )
            ],
        ),
    )


def test_faster_whisper_targets_always_include_safe_cpu_int8_fallback(monkeypatch) -> None:
    targets = select_faster_whisper_targets()
    assert targets[-1] == ("cpu", "int8")
    # Verify Pascal GPU without float16 picks int8 rather than crashing on float16
    for dev, ctype in targets:
        assert dev in ("cuda", "cpu")
        assert ctype in ("float16", "int8", "float32")


def test_coeditor_removes_headline_hook_overlay_and_handles_speed_and_mute() -> None:
    edl = _make_edl_with_hook()
    res = run_coeditor(
        edl,
        "Remove the hook I don't like it",
        playhead_ms=1200,
        use_llm=False,
    )
    assert len(res.applied) >= 1
    assert len(res.edl.tracks.overlays) == 0

    res2 = run_coeditor(
        res.edl,
        "set speed 1.5x and mute voice",
        playhead_ms=1000,
        use_llm=False,
    )
    assert res2.edl.tracks.video.clips[0].speed == 1.5
    assert res2.edl.tracks.audio.mute_original is True
    assert res2.edl.tracks.audio.gain_db == -60.0


def test_one_click_auto_captions_and_ai_models_endpoints(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CUTFLOW_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CUTFLOW_SKIP_LEGACY_IMPORT", "1")
    monkeypatch.setenv("CUTFLOW_DISABLE_WATCHER", "1")

    local_mp4 = tmp_path / "speech_clip.mp4"
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
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
                "color=c=black:s=320x240:r=24:d=2.5",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=320:sample_rate=16000:duration=2.5",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                str(local_mp4),
            ],
            check=True,
            capture_output=True,
        )

    def _fake_transcribe(wav_path: Path, **_kwargs) -> TranscriptResult:
        words = [
            WordTiming(text="COME", start_ms=150, end_ms=520),
            WordTiming(text="ON", start_ms=540, end_ms=850),
            WordTiming(text="GUYS!", start_ms=880, end_ms=1550),
        ]
        return TranscriptResult(
            language="en",
            provider="faster_whisper:cpu:int8:small",
            segments=[
                TranscriptSegment(start_ms=150, end_ms=1550, text="COME ON GUYS!", words=words)
            ],
            words=words,
        )

    monkeypatch.setattr("cutflow.ai.transcribe_wav", _fake_transcribe)

    app = create_app()
    with TestClient(app) as client:
        models_res = client.get("/api/v1/ai/models")
        assert models_res.status_code == 200
        assert "gemini-3.5-flash-lite" in models_res.json()["modelsByProvider"]["gemini"]

        if ffmpeg:
            src_res = client.post("/api/v1/sources/local-path", json={"path": str(local_mp4)})
            assert src_res.status_code == 201
            src_id = src_res.json()["source"]["id"]

            blank_res = client.post(
                "/api/v1/projects/blank",
                json={"title": "AutoCap Test", "sourceId": src_id},
            )
            proj_id = blank_res.json()["id"]

            cap_res = client.post(f"/api/v1/projects/{proj_id}/transcribe", json={})
            assert cap_res.status_code == 200
            body = cap_res.json()
            assert body["wordCount"] == 3
            assert body["provider"] == "faster_whisper:cpu:int8:small"
            assert len(body["edl"]["tracks"]["subtitles"]["words"]) == 3
