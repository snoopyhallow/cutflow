"""Phase 1 tests: Twitch Long-VOD downloader, unsupported-site guard, 5.1 .mkv + SRT + letterbox."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from cutflow.ai import (
    TranscriptResult,
    TranscriptSegment,
    chunk_compact_transcript,
    discover_highlights,
)
from cutflow.ai import highlights as highlights_module
from cutflow.audio import (
    WordTiming,
    detect_active_video_box,
    extract_embedded_subtitles,
    parse_subtitle_text,
    probe_media,
)
from cutflow.db import JobRow, SourceRow, get_session
from cutflow.db.models import new_id
from cutflow.ingest import (
    UnsupportedSiteError,
    build_ytdlp_download_argv,
    chapters_to_heatmap,
    detect_url_platform,
)
from cutflow.ingest.downloader import _parse_progress_line
from cutflow.ingest.feed import _fallback_item_url
from cutflow.workspace import profiles as profile_store
from cutflow.workspace.jobs import run_job_pipeline_sync

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def test_twitch_and_url_platform_detection_and_argv() -> None:
    assert detect_url_platform("https://www.twitch.tv/videos/2939401420") == "twitch"
    assert detect_url_platform("https://clips.twitch.tv/FunnyClip123") == "twitch"
    assert detect_url_platform("https://www.youtube.com/watch?v=dQw4w9WgXcQ") == "youtube"
    assert detect_url_platform("https://kick.com/xqc/videos/1234") == "kick"
    assert detect_url_platform("https://cdn.example.com/movie_scene.mp4") == "direct"

    with pytest.raises(UnsupportedSiteError, match="kisskh"):
        detect_url_platform(
            "https://kisskh.co/Drama/Spider-Man--Across-the-Spider-Verse/Episode-0?id=7554"
        )

    argv = build_ytdlp_download_argv(
        "yt-dlp",
        "https://www.twitch.tv/videos/2939401420",
        "C:/tmp/src_1.%(ext)s",
        start_sec=3600.0,
        end_sec=4500.0,
        concurrent_fragments=8,
        cookies_browser="chrome",
    )
    assert "--concurrent-fragments" in argv
    assert argv[argv.index("--concurrent-fragments") + 1] == "8"
    assert "--download-sections" in argv
    assert argv[argv.index("--download-sections") + 1] == "*3600.00-4500.00"
    assert "--cookies-from-browser" in argv
    assert argv[argv.index("--cookies-from-browser") + 1] == "chrome"

    with pytest.raises(ValueError, match="greater than start_sec"):
        build_ytdlp_download_argv(
            "yt-dlp",
            "https://www.twitch.tv/videos/2939401420",
            "out.%(ext)s",
            start_sec=500.0,
            end_sec=200.0,
        )

    prog = _parse_progress_line("CFPROG| 47.5%| 22.40MiB/s| 00:31")
    assert prog is not None
    assert prog[0] == pytest.approx(0.475)
    assert "22.40MiB/s" in prog[1]

    hm = chapters_to_heatmap(
        [{"title": "GTA VI", "start_time": 120.0, "end_time": 600.0}], duration_s=1200.0
    )
    assert hm is not None and hm[0]["start_time"] == 120.0

    assert (
        _fallback_item_url("https://www.twitch.tv/kaicenat/videos", "v2939401420")
        == "https://www.twitch.tv/videos/2939401420"
    )


def test_api_probe_and_url_range_validation_and_doctor_ytdlp(client: TestClient) -> None:
    doctor = client.get("/api/v1/system/doctor")
    assert doctor.status_code == 200
    assert doctor.json()["ytDlp"] is True

    # Unsupported obfuscated streaming site returns clear 422 on both probe and ingest
    bad_url = "https://kisskh.co/Drama/Spider-Man--Across-the-Spider-Verse/Episode-0?id=7554"
    probe_bad = client.post("/api/v1/sources/probe-url", json={"url": bad_url})
    assert probe_bad.status_code == 422
    assert "kisskh.co" in probe_bad.json()["detail"]

    ingest_bad = client.post("/api/v1/sources/url", json={"url": bad_url})
    assert ingest_bad.status_code == 422

    # Invalid VOD time window rejected cleanly
    inv_range = client.post(
        "/api/v1/sources/url",
        json={
            "url": "https://www.twitch.tv/videos/2939401420",
            "autoClip": False,
            "startSec": 900,
            "endSec": 300,
        },
    )
    assert inv_range.status_code == 400


def test_srt_cleaning_and_two_hour_movie_act_chunking(monkeypatch: pytest.MonkeyPatch) -> None:
    raw_srt = """1
00:00:01,000 --> 00:00:03,400
[dramatic synth music]
<i>BOND: You think I won't call that bluff?</i>

2
00:00:03,600 --> 00:00:05,800
♪ Ooh la la ♪

3
00:00:06,000 --> 00:00:08,500
(heavy breathing) That last hand... nearly killed me.
"""
    tx = parse_subtitle_text(raw_srt, language="en")
    assert len(tx.segments) == 2
    assert tx.segments[0].text == "You think I won't call that bluff?"
    assert tx.segments[1].text == "That last hand... nearly killed me."
    assert len(tx.words) >= 12

    # Build a synthetic 2-hour (7200s) movie script exceeding 60,000 chars
    long_segments: list[TranscriptSegment] = []
    for i in range(900):
        s_ms = i * 8000
        e_ms = s_ms + 6500
        line = (
            "CLIMAX SCENE: Monsieur Bond wins the final hand against Le Chiffre!"
            if i == 860
            else f"Exposition dialogue line number {i} inside the casino royale parlor room."
        )
        long_segments.append(
            TranscriptSegment(
                start_ms=s_ms,
                end_ms=e_ms,
                text=line,
                words=[WordTiming(text="word", start_ms=s_ms, end_ms=e_ms)],
            )
        )

    chunks = chunk_compact_transcript(long_segments, chunk_chars=26_000)
    assert len(chunks) >= 3
    assert any("Monsieur Bond wins the final hand" in ch for ch in chunks[-2:])

    seen_prompts: list[str] = []

    def _fake_llm(user_prompt: str, **_kwargs: Any) -> dict[str, Any]:
        seen_prompts.append(user_prompt)
        if "Monsieur Bond wins the final hand" in user_prompt:
            return {
                "clips": [
                    {
                        "startSec": 6875.0,
                        "endSec": 6920.0,
                        "slices": [
                            {"startSec": 6875.0, "endSec": 6895.0},
                            {"startSec": 6902.0, "endSec": 6920.0},
                        ],
                        "score": 98,
                        "title": "Monsieur Bond Wins",
                        "seamTitle": "Monsieur Bond Wins",
                        "povHook": "He almost died at the table.",
                        "mood": "dark_cinema",
                        "reason": "Climax payoff.",
                    }
                ]
            }
        return {
            "clips": [
                {
                    "startSec": 120.0,
                    "endSec": 155.0,
                    "score": 74,
                    "title": "Early Scene",
                    "seamTitle": "Early Scene",
                    "reason": "Opening setup.",
                }
            ]
        }

    monkeypatch.setattr(highlights_module, "complete_json", _fake_llm)
    prof = profile_store.CreatorProfile(
        id="cinema-test",
        name="Cinema Test",
        content_mode="cinema",
        min_duration_s=20.0,
        max_duration_s=175.0,
        max_clips=4,
    )
    full_tx = TranscriptResult(
        language="en", provider="embedded_subs", segments=long_segments, words=[]
    )
    found = discover_highlights(full_tx, [], 7_200_000, prof, source_title="Casino Royale")
    assert len(seen_prompts) == len(chunks)
    assert found[0].title == "Monsieur Bond Wins"
    assert found[0].pov_hook == "POV: HE ALMOST DIED AT THE TABLE."
    assert found[0].slices == [(6875000, 6895000), (6902000, 6920000)]


@pytest.mark.skipif(not HAS_FFMPEG, reason="FFmpeg required for real .mkv 5.1 + SRT test")
def test_cinema_mkv_51_ac3_embedded_srt_and_letterbox_pipeline(
    client: TestClient,
    tmp_path: Path,
) -> None:
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None

    srt_file = tmp_path / "dialogue.srt"
    srt_file.write_text(
        "1\n00:00:00,600 --> 00:00:02,800\n[tense music] <i>Who is it? It is 007.</i>\n\n"
        "2\n00:00:03,100 --> 00:00:05,800\nBond has been poisoned at the table!\n\n"
        "3\n00:00:06,200 --> 00:00:08,800\nStay with me James, do not pass out!\n",
        encoding="utf-8",
    )

    mkv_path = tmp_path / "casino_scene.mkv"
    # Build 1280x720 MKV with 2.39:1 active band (1280x536 padded into 1280x720 black letterbox),
    # Track 0 = jpn stereo AC-3, Track 1 = eng 5.1 AC-3, Track 2 = eng embedded SRT!
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=s=1280x536:r=24:d=9,pad=1280:720:0:92:black",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=220:sample_rate=48000:duration=9",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=9",
        "-i",
        str(srt_file),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-map",
        "2:a:0",
        "-map",
        "3:s:0",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a:0",
        "ac3",
        "-ac:a:0",
        "2",
        "-metadata:s:a:0",
        "language=jpn",
        "-c:a:1",
        "ac3",
        "-ac:a:1",
        "6",
        "-metadata:s:a:1",
        "language=eng",
        "-c:s:0",
        "srt",
        "-metadata:s:s:0",
        "language=eng",
        str(mkv_path),
    ]
    subprocess.run(cmd, check=True, timeout=60)

    info = probe_media(mkv_path, preferred_lang="en")
    assert info.preferred_audio_rel_index == 1
    assert info.audio_channels == 6
    assert info.audio_codec == "ac3"
    assert len(info.subtitle_streams) == 1
    assert info.subtitle_streams[0].language == "eng"

    box = detect_active_video_box(mkv_path, info)
    assert box is not None
    assert 0.70 <= box["h"] <= 0.80
    assert 0.10 <= box["y"] <= 0.16

    sub_tx = extract_embedded_subtitles(mkv_path, info, preferred_lang="en", min_cues=2)
    assert sub_tx is not None
    assert sub_tx.provider == "embedded_subs"
    assert "Who is it? It is 007." in sub_tx.segments[0].text

    # Run full job pipeline and verify Whisper ASR is completely bypassed ($0 ASR cost)
    cinema_prof = profile_store.upsert_profile(
        profile_store.CreatorProfile(
            id="cinema-mkv-prof",
            name="Cinema MKV Profile",
            content_mode="cinema",
            min_duration_s=4.0,
            max_duration_s=15.0,
            cold_open_enabled=False,
        )
    )
    src_id = new_id("src")
    job_id = new_id("job")
    with get_session() as session:
        session.add(
            SourceRow(
                id=src_id, source_type="inbox", path=str(mkv_path), title="Casino Royale"
            )
        )
        session.flush()
        session.add(
            JobRow(
                id=job_id,
                source_id=src_id,
                profile_id=cinema_prof.id,
                status="queued",
                stage="queued",
                progress=0.0,
                settings_json={},
            )
        )

    def _forbid_asr(*_args: Any, **_kwargs: Any) -> TranscriptResult:
        raise AssertionError("ASR should NOT run when embedded English subtitles exist!")

    created = run_job_pipeline_sync(job_id, transcriber=_forbid_asr)
    assert len(created) == 1
    pid = created[0]

    # Verify clip_slice.mp4 was transcoded from 5.1 AC-3 to stereo AAC + filmstrip exists
    proj_list = client.get(f"/api/v1/projects?job_id={job_id}").json()
    assert proj_list[0]["hasSlice"] is True
    assert proj_list[0]["hasFilmstrip"] is True
    assert proj_list[0]["wordCount"] >= 10

    filmstrip_resp = client.get(f"/api/v1/projects/{pid}/filmstrip")
    assert filmstrip_resp.status_code == 200
    assert filmstrip_resp.headers["content-type"] == "image/jpeg"

    media_resp = client.get(f"/api/v1/projects/{pid}/media")
    assert media_resp.status_code == 200
    slice_file = tmp_path / "verify_slice.mp4"
    slice_file.write_bytes(media_resp.content)
    slice_info = probe_media(slice_file)
    assert slice_info.audio_codec == "aac"
    assert slice_info.audio_channels == 2
