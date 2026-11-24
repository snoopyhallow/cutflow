"""Initial CutFlow schema.

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-11-25
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "creator_profiles",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("creator_name", sa.String(120), nullable=False, server_default=""),
        sa.Column("config_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
    )

    op.create_table(
        "sources",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("source_type", sa.String(24), nullable=False),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("title", sa.String(255), nullable=False, server_default=""),
        sa.Column("channel", sa.String(160), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("fps", sa.Float(), nullable=True),
        sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("heatmap_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.String(32), nullable=False),
    )

    op.create_table(
        "jobs",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column(
            "source_id",
            sa.String(32),
            sa.ForeignKey("sources.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("profile_id", sa.String(64), nullable=True),
        sa.Column("status", sa.String(24), nullable=False, server_default="queued"),
        sa.Column("stage", sa.String(32), nullable=False, server_default="queued"),
        sa.Column("progress", sa.Float(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("settings_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
    )
    op.create_index("ix_jobs_source_id", "jobs", ["source_id"])
    op.create_index("ix_jobs_profile_id", "jobs", ["profile_id"])
    op.create_index("ix_jobs_status", "jobs", ["status"])

    op.create_table(
        "clip_projects",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column(
            "job_id",
            sa.String(32),
            sa.ForeignKey("jobs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "source_id",
            sa.String(32),
            sa.ForeignKey("sources.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("rank", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("score", sa.Integer(), nullable=False, server_default="80"),
        sa.Column("title", sa.String(200), nullable=False, server_default=""),
        sa.Column("reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("status", sa.String(24), nullable=False, server_default="draft"),
        sa.Column("proxy_path", sa.Text(), nullable=True),
        sa.Column("peaks_path", sa.Text(), nullable=True),
        sa.Column("edl_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
    )
    op.create_index("ix_clip_projects_job_id", "clip_projects", ["job_id"])

    op.create_table(
        "exports",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(32),
            sa.ForeignKey("clip_projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("ratio", sa.String(12), nullable=False, server_default="9:16"),
        sa.Column("quality", sa.String(12), nullable=False, server_default="1080p"),
        sa.Column("speed_preset", sa.String(16), nullable=False, server_default="final"),
        sa.Column("size_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("duration_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.String(32), nullable=False),
    )
    op.create_index("ix_exports_project_id", "exports", ["project_id"])

    op.create_table(
        "feed_items",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("profile_id", sa.String(64), nullable=False),
        sa.Column("external_id", sa.String(128), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("channel", sa.String(160), nullable=False, server_default=""),
        sa.Column("duration_s", sa.Float(), nullable=False, server_default="0"),
        sa.Column("thumbnail_url", sa.Text(), nullable=True),
        sa.Column("status", sa.String(24), nullable=False, server_default="new"),
        sa.Column("discovered_at", sa.String(32), nullable=False),
    )
    op.create_index("ix_feed_items_profile_id", "feed_items", ["profile_id"])
    op.create_index("ix_feed_items_external_id", "feed_items", ["external_id"])


def downgrade() -> None:
    op.drop_table("feed_items")
    op.drop_table("exports")
    op.drop_table("clip_projects")
    op.drop_table("jobs")
    op.drop_table("sources")
    op.drop_table("creator_profiles")
