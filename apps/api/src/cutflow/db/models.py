"""SQLAlchemy 2.0 declarative schema for CutFlow (SQLite + PostgreSQL compatible)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def new_id(prefix: str = "") -> str:
    token = uuid.uuid4().hex[:14]
    return f"{prefix}_{token}" if prefix else token


def utcnow_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class Base(DeclarativeBase):
    pass


class CreatorProfileRow(Base):
    __tablename__ = "creator_profiles"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    creator_name: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    config_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), default=utcnow_iso, nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), default=utcnow_iso, nullable=False)


class SourceRow(Base):
    __tablename__ = "sources"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    source_type: Mapped[str] = mapped_column(String(24), nullable=False)  # url | upload | inbox
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    channel: Mapped[str | None] = mapped_column(String(160), nullable=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fps: Mapped[float | None] = mapped_column(Float, nullable=True)
    archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    heatmap_json: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[str] = mapped_column(String(32), default=utcnow_iso, nullable=False)


class JobRow(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    source_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("sources.id", ondelete="CASCADE"), nullable=False, index=True
    )
    profile_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(24), default="queued", nullable=False, index=True)
    stage: Mapped[str] = mapped_column(String(32), default="queued", nullable=False)
    progress: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    settings_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), default=utcnow_iso, nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), default=utcnow_iso, nullable=False)


class ClipProjectRow(Base):
    __tablename__ = "clip_projects"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    job_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("sources.id", ondelete="CASCADE"), nullable=False
    )
    rank: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    score: Mapped[int] = mapped_column(Integer, default=80, nullable=False)
    title: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    reason: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="draft", nullable=False)
    proxy_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    peaks_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    edl_json: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), default=utcnow_iso, nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), default=utcnow_iso, nullable=False)


class ExportRow(Base):
    __tablename__ = "exports"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("clip_projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    path: Mapped[str] = mapped_column(Text, nullable=False)
    ratio: Mapped[str] = mapped_column(String(12), default="9:16", nullable=False)
    quality: Mapped[str] = mapped_column(String(12), default="1080p", nullable=False)
    speed_preset: Mapped[str] = mapped_column(String(16), default="final", nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), default=utcnow_iso, nullable=False)


class FeedItemRow(Base):
    __tablename__ = "feed_items"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    profile_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    external_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    channel: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    duration_s: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    thumbnail_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="new", nullable=False)
    discovered_at: Mapped[str] = mapped_column(String(32), default=utcnow_iso, nullable=False)
