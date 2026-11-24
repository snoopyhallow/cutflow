"""Cross-language EDL contract tests + TimelineMapper, blade-cut, rolling edits, and patches."""

from __future__ import annotations

import json
from pathlib import Path

import jsonschema
import pytest

from cutflow.edl import (
    TimelineMapper,
    TimelineProject,
    apply_blade_cut,
    apply_edl_patch,
    delete_word,
    insert_word,
    update_word_timing,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = REPO_ROOT / "packages" / "edl-schema" / "timeline.v1.schema.json"
FIXTURE_PATH = REPO_ROOT / "packages" / "edl-schema" / "fixtures" / "sample_streamer_clip.edl.json"


def _load_fixture() -> TimelineProject:
    raw = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    return TimelineProject.model_validate(raw)


def test_fixture_validates_against_canonical_json_schema_and_pydantic() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    raw = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    jsonschema.validate(instance=raw, schema=schema)
    model = TimelineProject.model_validate(raw)
    round_tripped = model.to_canonical_dict()
    jsonschema.validate(instance=round_tripped, schema=schema)
    assert model.tracks.subtitles.style.reveal_mode == "progressive"
    assert model.tracks.audio.bgm is None


def test_timeline_mapper_maps_cold_open_and_body_deterministically() -> None:
    edl = _load_fixture()
    mapper = TimelineMapper(edl)
    # 1500ms cold-open + 20000ms clip [10000..30000] = 21500ms
    assert mapper.cold_open_ms == 1500
    assert mapper.total_duration_ms == 21500

    assert mapper.timeline_to_source(500) == (True, 24500)
    assert mapper.timeline_to_source(1500) == (False, 10000)
    assert mapper.timeline_to_source(4000) == (False, 12500)
    assert mapper.source_to_timeline(12500) == 4000


def test_blade_cut_splits_video_and_ripples_words_framing_and_overlays() -> None:
    edl = _load_fixture()
    # Cut a 4-second pause [4500..8500] right in the middle of the main body.
    cut = apply_blade_cut(edl, 4500, 8500)
    mapper = TimelineMapper(cut)

    assert len(cut.tracks.video.clips) == 2
    assert cut.tracks.video.clips[0].source_start_ms == 10000
    assert cut.tracks.video.clips[0].source_end_ms == 13000
    assert cut.tracks.video.clips[1].source_start_ms == 17000
    assert cut.tracks.video.clips[1].source_end_ms == 30000
    assert mapper.total_duration_ms == 17500
    assert mapper.source_to_timeline(15000) is None

    # Words before cut unchanged; words after cut shifted left by 4000ms.
    w1 = next(w for w in cut.tracks.subtitles.words if w.id == "w1")
    w7 = next(w for w in cut.tracks.subtitles.words if w.id == "w7")
    assert (w1.start_ms, w1.end_ms) == (1700, 1980)
    assert (w7.start_ms, w7.end_ms) == (5500, 5820)

    # Full-clip seam card trimmed cleanly to new duration 17500ms.
    assert cut.tracks.overlays[0].end_ms == 17500
    assert cut.tracks.video.framing[-1].timeline_end_ms == 17500


def test_rolling_edit_word_timing_adjusts_adjacent_boundary_without_overlap() -> None:
    edl = _load_fixture()
    # Drag w2 start earlier from 1980 -> 1880; w1 end should roll back to 1880 cleanly.
    updated = update_word_timing(edl, "w2", 1880, 2400, rolling_adjacent=True)
    words = {w.id: w for w in updated.tracks.subtitles.words}

    assert words["w1"].end_ms == 1880
    assert words["w2"].start_ms == 1880
    assert words["w2"].end_ms == 2400
    assert words["w3"].start_ms == 2400


def test_insert_delete_word_and_edl_patch_with_revert_snapshot() -> None:
    edl = _load_fixture()
    with_siu = insert_word(edl, "SIU!", start_ms=6000, duration_ms=1200)
    siu = next(w for w in with_siu.tracks.subtitles.words if w.text == "SIU!")
    assert (siu.start_ms, siu.end_ms) == (6000, 7200)

    removed = delete_word(with_siu, siu.id)
    assert all(w.text != "SIU!" for w in removed.tracks.subtitles.words)

    patched, before, summary = apply_edl_patch(
        edl,
        [
            {"op": "set_subtitles", "revealMode": "single_word", "enabled": True},
            {"op": "set_seam_title", "text": "WAIT FOR HIS REACTION"},
            {"op": "insert_word", "text": "SIU!", "startMs": 6000, "durationMs": 1000},
        ],
    )
    assert patched.tracks.subtitles.style.reveal_mode == "single_word"
    assert patched.tracks.overlays[0].text == "WAIT FOR HIS REACTION"
    assert any(w.text == "SIU!" for w in patched.tracks.subtitles.words)
    assert len(summary) == 4
    # Before snapshot remains completely unmutated for 1-click revert.
    assert before.tracks.subtitles.style.reveal_mode == "progressive"
    assert before.tracks.overlays[0].text != "WAIT FOR HIS REACTION"

    with pytest.raises(ValueError):
        delete_word(edl, "does_not_exist")
