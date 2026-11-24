"""SQLAlchemy + Alembic DB migrations, REST v1 API, legacy profile import, and telemetry tests."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from cutflow import telemetry
from cutflow.db import ClipProjectRow, JobRow, SourceRow, get_session
from cutflow.workspace.profiles import seed_and_import_profiles

FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "edl-schema"
    / "fixtures"
    / "sample_streamer_clip.edl.json"
)


def test_health_and_profile_crud_roundtrip(client: TestClient) -> None:
    health = client.get("/api/v1/health")
    assert health.status_code == 200
    assert health.json()["service"] == "cutflow"
    assert health.json()["database"] == "sqlite"

    profiles = client.get("/api/v1/profiles").json()
    assert len(profiles) >= 2
    assert all(p["cta_mode"] == "off" for p in profiles)

    created = client.post(
        "/api/v1/profiles",
        json={"name": "Bobby Vanriper — GTA VI", "creator_name": "Bobby Vanriper"},
    )
    assert created.status_code == 201
    pid = created.json()["id"]
    assert pid == "bobby-vanriper-gta-vi"

    updated = client.put(f"/api/v1/profiles/{pid}", json={"reveal_mode": "single_word"})
    assert updated.status_code == 200
    assert updated.json()["reveal_mode"] == "single_word"

    assert client.delete(f"/api/v1/profiles/{pid}").status_code == 204


def test_legacy_autoclip_profile_import(cutflow_home: Path) -> None:
    from cutflow import db

    db.init_db()
    legacy = cutflow_home / "legacy_profiles.json"
    legacy.write_text(
        json.dumps(
            [
                {
                    "id": "8000-expedia-x-ishowspeed-campaign",
                    "name": "$8,000 Expedia x IShowSpeed Campaign",
                    "creator_name": "IShowSpeed",
                    "brief": "Must mention Expedia.",
                    "layout_mode": "auto_split",
                    "cold_open_duration_s": 1.5,
                }
            ]
        ),
        encoding="utf-8",
    )

    loaded = seed_and_import_profiles(autoclip_profiles_file=legacy)
    imported = next((p for p in loaded if p.id == "8000-expedia-x-ishowspeed-campaign"), None)
    assert imported is not None
    assert imported.creator_name == "IShowSpeed"
    assert imported.title_card_style == "seam_card_white"
    assert imported.cold_open_duration_ms == 1500


def test_project_timeline_put_blade_cut_and_patch_endpoints(client: TestClient) -> None:
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
                title=raw_edl["title"],
                edl_json=raw_edl,
            )
        )

    fetched = client.get("/api/v1/projects/clip_demo_001/timeline")
    assert fetched.status_code == 200
    assert fetched.json()["totalDurationMs"] == 21500

    cut = client.post(
        "/api/v1/projects/clip_demo_001/blade-cut",
        json={"cutStartMs": 4500, "cutEndMs": 7500},
    )
    assert cut.status_code == 200
    assert cut.json()["totalDurationMs"] == 18500

    patched = client.post(
        "/api/v1/projects/clip_demo_001/patch",
        json={"ops": [{"op": "set_seam_title", "text": "UNBELIEVABLE REACTION"}]},
    )
    assert patched.status_code == 200
    assert patched.json()["edl"]["tracks"]["overlays"][0]["text"] == "UNBELIEVABLE REACTION"


def test_stage_telemetry_records_structured_jsonl(cutflow_home: Path) -> None:
    with telemetry.track_stage("job_bench_1", "align_phonemes", clip_count=4) as extra:
        extra["words"] = 310

    records = telemetry.read_metrics("job_bench_1")
    assert len(records) == 1
    assert records[0]["stage"] == "align_phonemes"
    assert records[0]["status"] == "ok"
    assert records[0]["meta"]["words"] == 310
    assert records[0]["duration_ms"] >= 0.0
