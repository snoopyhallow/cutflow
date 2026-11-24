"""Milestone 6 tests: /api/v1/system/doctor endpoint and cutflow benchmark runner."""

from __future__ import annotations

import shutil

import pytest
from fastapi.testclient import TestClient

from cutflow.workspace.benchmark import run_benchmark

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def test_system_doctor_endpoint_reports_environment(client: TestClient) -> None:
    resp = client.get("/api/v1/system/doctor")
    assert resp.status_code == 200
    data = resp.json()
    assert data["version"] == "0.1.0"
    assert "python" in data
    assert "nvencOk" in data
    assert data["freeGb"] >= 0


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe required for benchmark test")
def test_benchmark_runner_produces_timed_markdown_table() -> None:
    res = run_benchmark(duration_s=6, include_final_1080p=False)
    assert len(res["rows"]) == 6
    assert "| Pipeline Stage | Measured Time | Notes |" in res["markdown"]
    assert "Zero-Copy Lossless Slice" in res["markdown"]
