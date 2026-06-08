"""multi-bot content automation layer

Adds bots, presets, runs, trend sources/items, publishing connectors/jobs, and
bot metrics. SQLite installs get these via ``app.db_init`` (create_all); this
migration is for the PostgreSQL backend (``alembic upgrade head``).

Revision ID: 0002_automation
Revises: 0001_initial
Create Date: 2026-06-08 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002_automation"
down_revision: Union[str, None] = "0001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _ts() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    ]


def upgrade() -> None:
    # ------------------------------------------------------------- bot_presets
    op.create_table(
        "bot_presets",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("owner_id", sa.BigInteger(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("based_on", sa.String(64), nullable=True),
        sa.Column("config", postgresql.JSONB(), nullable=False, server_default="{}"),
        *_ts(),
    )
    op.create_index("ix_bot_presets_owner_id", "bot_presets", ["owner_id"])
    op.create_index("ix_bot_presets_key", "bot_presets", ["key"])

    # -------------------------------------------------------------------- bots
    op.create_table(
        "bots",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("owner_id", sa.BigInteger(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_id", sa.BigInteger(), sa.ForeignKey("projects.id", ondelete="SET NULL"), nullable=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("bot_type", sa.String(64), nullable=False, server_default="custom"),
        sa.Column("preset_key", sa.String(64), nullable=False, server_default="CUSTOM"),
        sa.Column("status", sa.String(32), nullable=False, server_default="stopped"),
        sa.Column("approval_mode", sa.String(32), nullable=False, server_default="manual"),
        sa.Column("model_assignments", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("discovery_config", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("filter_config", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("scoring_config", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("clipping_config", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("publishing_config", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("schedule_config", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("stats", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("insights", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        *_ts(),
    )
    op.create_index("ix_bots_owner_id", "bots", ["owner_id"])
    op.create_index("ix_bots_project_id", "bots", ["project_id"])
    op.create_index("ix_bots_status", "bots", ["status"])
    op.create_index("ix_bots_next_run_at", "bots", ["next_run_at"])

    # ---------------------------------------------------------------- bot_runs
    op.create_table(
        "bot_runs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("bot_id", sa.BigInteger(), sa.ForeignKey("bots.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("stage", sa.String(64), nullable=True),
        sa.Column("trigger", sa.String(32), nullable=False, server_default="schedule"),
        sa.Column("progress", sa.Float(), nullable=False, server_default="0"),
        sa.Column("stats", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("events", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        *_ts(),
    )
    op.create_index("ix_bot_runs_bot_id", "bot_runs", ["bot_id"])
    op.create_index("ix_bot_runs_status", "bot_runs", ["status"])

    # ----------------------------------------------------------- trend_sources
    op.create_table(
        "trend_sources",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("owner_id", sa.BigInteger(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("bot_id", sa.BigInteger(), sa.ForeignKey("bots.id", ondelete="CASCADE"), nullable=True),
        sa.Column("platform", sa.String(32), nullable=False, server_default="rss"),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("identifier", sa.Text(), nullable=False),
        sa.Column("list_mode", sa.String(16), nullable=False, server_default="allow"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("config", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("last_polled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        *_ts(),
    )
    op.create_index("ix_trend_sources_owner_id", "trend_sources", ["owner_id"])
    op.create_index("ix_trend_sources_bot_id", "trend_sources", ["bot_id"])

    # ------------------------------------------------------------- trend_items
    op.create_table(
        "trend_items",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("source_id", sa.BigInteger(), sa.ForeignKey("trend_sources.id", ondelete="SET NULL"), nullable=True),
        sa.Column("bot_id", sa.BigInteger(), sa.ForeignKey("bots.id", ondelete="CASCADE"), nullable=False),
        sa.Column("video_id", sa.BigInteger(), sa.ForeignKey("videos.id", ondelete="SET NULL"), nullable=True),
        sa.Column("platform", sa.String(32), nullable=False),
        sa.Column("external_id", sa.String(255), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("author", sa.String(255), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("thumbnail_url", sa.Text(), nullable=True),
        sa.Column("language", sa.String(16), nullable=True),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("metrics", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("score_breakdown", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("trend_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("embedding", postgresql.JSONB(), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="discovered"),
        sa.Column("reason", sa.Text(), nullable=True),
        *_ts(),
        sa.UniqueConstraint("bot_id", "platform", "external_id", name="uq_trend_bot_external"),
    )
    op.create_index("ix_trend_items_source_id", "trend_items", ["source_id"])
    op.create_index("ix_trend_items_bot_id", "trend_items", ["bot_id"])
    op.create_index("ix_trend_items_video_id", "trend_items", ["video_id"])
    op.create_index("ix_trend_items_trend_score", "trend_items", ["trend_score"])
    op.create_index("ix_trend_items_status", "trend_items", ["status"])

    # ----------------------------------------------------- publishing_connectors
    op.create_table(
        "publishing_connectors",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("owner_id", sa.BigInteger(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("bot_id", sa.BigInteger(), sa.ForeignKey("bots.id", ondelete="SET NULL"), nullable=True),
        sa.Column("platform", sa.String(32), nullable=False, server_default="youtube"),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="disconnected"),
        sa.Column("config", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("credentials", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("last_error", sa.Text(), nullable=True),
        *_ts(),
    )
    op.create_index("ix_publishing_connectors_owner_id", "publishing_connectors", ["owner_id"])
    op.create_index("ix_publishing_connectors_bot_id", "publishing_connectors", ["bot_id"])

    # ---------------------------------------------------------- publishing_jobs
    op.create_table(
        "publishing_jobs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("bot_id", sa.BigInteger(), sa.ForeignKey("bots.id", ondelete="SET NULL"), nullable=True),
        sa.Column("clip_id", sa.BigInteger(), sa.ForeignKey("clips.id", ondelete="CASCADE"), nullable=False),
        sa.Column("connector_id", sa.BigInteger(), sa.ForeignKey("publishing_connectors.id", ondelete="SET NULL"), nullable=True),
        sa.Column("platform", sa.String(32), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("payload", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("external_post_id", sa.String(255), nullable=True),
        sa.Column("external_url", sa.Text(), nullable=True),
        sa.Column("analytics", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("retries", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        *_ts(),
    )
    op.create_index("ix_publishing_jobs_bot_id", "publishing_jobs", ["bot_id"])
    op.create_index("ix_publishing_jobs_clip_id", "publishing_jobs", ["clip_id"])
    op.create_index("ix_publishing_jobs_connector_id", "publishing_jobs", ["connector_id"])
    op.create_index("ix_publishing_jobs_status", "publishing_jobs", ["status"])
    op.create_index("ix_publishing_jobs_scheduled_at", "publishing_jobs", ["scheduled_at"])

    # ------------------------------------------------------------- bot_metrics
    op.create_table(
        "bot_metrics",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("bot_id", sa.BigInteger(), sa.ForeignKey("bots.id", ondelete="CASCADE"), nullable=False),
        sa.Column("scope", sa.String(16), nullable=False, server_default="clip"),
        sa.Column("ref_id", sa.BigInteger(), nullable=True),
        sa.Column("platform", sa.String(32), nullable=True),
        sa.Column("metrics", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        *_ts(),
    )
    op.create_index("ix_bot_metrics_bot_id", "bot_metrics", ["bot_id"])
    op.create_index("ix_bot_metrics_scope", "bot_metrics", ["scope"])
    op.create_index("ix_bot_metrics_ref_id", "bot_metrics", ["ref_id"])
    op.create_index("ix_bot_metrics_recorded_at", "bot_metrics", ["recorded_at"])


def downgrade() -> None:
    op.drop_table("bot_metrics")
    op.drop_table("publishing_jobs")
    op.drop_table("publishing_connectors")
    op.drop_table("trend_items")
    op.drop_table("trend_sources")
    op.drop_table("bot_runs")
    op.drop_table("bots")
    op.drop_table("bot_presets")
