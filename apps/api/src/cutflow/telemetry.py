"""Structured JSON stage-timing telemetry for pipeline benchmarking."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import paths


@dataclass
class StageMetric:
    job_id: str
    stage: str
    duration_ms: float
    status: str = "ok"
    meta: dict[str, Any] = field(default_factory=dict)
    recorded_at: str = field(
        default_factory=lambda: datetime.now(UTC).isoformat(timespec="seconds")
    )

    def to_json_line(self) -> str:
        return json.dumps(
            {
                "job_id": self.job_id,
                "stage": self.stage,
                "duration_ms": round(self.duration_ms, 2),
                "status": self.status,
                "meta": self.meta,
                "recorded_at": self.recorded_at,
            }
        )


def telemetry_log_path(job_id: str) -> Path:
    paths.ensure_layout()
    return paths.telemetry_dir() / f"{job_id}.jsonl"


def record_metric(metric: StageMetric) -> Path:
    path = telemetry_log_path(metric.job_id)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(metric.to_json_line() + "\n")
    return path


def read_metrics(job_id: str) -> list[dict[str, Any]]:
    path = telemetry_log_path(job_id)
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


@contextmanager
def track_stage(job_id: str, stage: str, **meta: Any) -> Iterator[dict[str, Any]]:
    """Measure one pipeline stage and append a structured JSONL benchmark record."""
    started = time.perf_counter()
    extra: dict[str, Any] = dict(meta)
    status = "ok"
    try:
        yield extra
    except Exception as exc:
        status = f"error:{type(exc).__name__}"
        raise
    finally:
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        record_metric(
            StageMetric(
                job_id=job_id,
                stage=stage,
                duration_ms=elapsed_ms,
                status=status,
                meta=extra,
            )
        )
