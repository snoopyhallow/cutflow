"""Milestone 5 tests: EDL-native AI Co-Editor, Edit Boundaries, Approval Status, and Post Copy."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from cutflow import config
from cutflow.ai import coeditor as coeditor_module
from cutflow.ai import generate_post_copy, run_coeditor
from cutflow.db import ClipProjectRow, JobRow, SourceRow, get_session
from cutflow.edl import TimelineMapper, TimelineProject

FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "edl-schema"
    / "fixtures"
    / "sample_streamer_clip.edl.json"
)


def _load_fixture() -> TimelineProject:
    return TimelineProject.model_validate(json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))


def _seed_project() -> str:
    raw_edl = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    with get_session() as session:
        session.add(
            SourceRow(id="src_demo_001", source_type="upload", path="demo.mp4", title="Demo")
        )
        session.flush()
        session.add(
            JobRow(id="job_demo_001", source_id="src_demo_001", status="done", settings_json={})
        )
        session.flush()
        session.add(
            ClipProjectRow(
                id="clip_demo_001",
                job_id="job_demo_001",
                source_id="src_demo_001",
                rank=1,
                score=92,
                title=raw_edl["title"],
                edl_json=raw_edl,
            )
        )
    return "clip_demo_001"


def test_coeditor_deterministic_rules_and_revert_snapshot() -> None:
    edl = _load_fixture()

    res = run_coeditor(
        edl,
        "Cut 4s to 9s, change title to 'WAIT FOR HIS REACTION', and use single word captions",
        use_llm=False,
    )
    assert res.provider == "rules"
    assert len(res.applied) >= 3
    assert TimelineMapper(res.edl).total_duration_ms == 16_500
    assert TimelineMapper(res.previous_edl).total_duration_ms == 21_500
    assert res.edl.tracks.subtitles.style.reveal_mode == "single_word"
    assert res.edl.tracks.overlays[0].text == "WAIT FOR HIS REACTION"

    # Insert missed word + disable cold open
    res2 = run_coeditor(
        res.edl,
        "Insert 'SIU!' at 5.5s and remove cold open",
        use_llm=False,
    )
    assert any(w.text == "SIU!" and w.start_ms == 5500 for w in res2.edl.tracks.subtitles.words)
    assert res2.edl.tracks.video.cold_open is None


def test_coeditor_llm_mode_obeys_boundaries_and_applies_ops(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    edl = _load_fixture()
    captured: dict[str, Any] = {}

    def fake_complete(user_prompt: str, **_kwargs: Any) -> dict[str, Any]:
        captured["prompt"] = user_prompt
        return {
            "reply": "Updated title card while keeping captions intact.",
            "ops": [{"op": "set_seam_title", "text": "GTA 6 GAS PRICES ARE INSANE"}],
        }

    monkeypatch.setattr(coeditor_module, "complete_json", fake_complete)
    res = run_coeditor(
        edl,
        "Make the title punchier",
        boundaries="Never remove captions or cold-open.",
        use_llm=True,
    )
    assert res.provider == "llm"
    assert "Never remove captions or cold-open." in captured["prompt"]
    assert res.edl.tracks.overlays[0].text == "GTA 6 GAS PRICES ARE INSANE"
    assert res.edl.tracks.subtitles.enabled is True


def test_coeditor_status_approval_and_post_copy_api_endpoints(client: TestClient) -> None:
    project_id = _seed_project()

    # 1. Co-Editor endpoint with saveBoundaries=True
    co_resp = client.post(
        f"/api/v1/projects/{project_id}/coeditor",
        json={
            "instruction": "Change title to 'NO WAY HE HIT THAT' and use single word captions",
            "boundaries": "Never disable profanity censoring.",
            "playheadMs": 3000,
            "saveBoundaries": True,
        },
    )
    assert co_resp.status_code == 200, co_resp.text
    co_data = co_resp.json()
    assert len(co_data["applied"]) >= 2
    assert co_data["edl"]["tracks"]["overlays"][0]["text"] == "NO WAY HE HIT THAT"
    assert co_data["previousEdl"]["tracks"]["overlays"][0]["text"] != "NO WAY HE HIT THAT"
    assert config.load().export.editor_boundaries == "Never disable profanity censoring."

    # 2. Approval status transitions (draft -> approved -> posted)
    for next_status in ("approved", "posted"):
        st = client.patch(
            f"/api/v1/projects/{project_id}/status",
            json={"status": next_status},
        )
        assert st.status_code == 200
        assert st.json()["status"] == next_status

    # Invalid status rejected
    bad_st = client.patch(
        f"/api/v1/projects/{project_id}/status",
        json={"status": "not_a_real_status"},
    )
    assert bad_st.status_code == 422

    # 3. Viral Post Copy generation
    copy_resp = client.post(
        f"/api/v1/projects/{project_id}/post-copy",
        json={"platform": "tiktok"},
    )
    assert copy_resp.status_code == 200
    copy_data = copy_resp.json()
    assert copy_data["title"] == "NO WAY HE HIT THAT"
    assert len(copy_data["hashtags"]) >= 4
    assert all(tag.startswith("#") for tag in copy_data["hashtags"])
    assert copy_data["title"] in copy_data["fullCopy"]

    # Direct offline post copy helper check
    offline = generate_post_copy(_load_fixture(), use_llm=False)
    assert offline["provider"] == "rules"
    assert "#shorts" in offline["hashtags"]
