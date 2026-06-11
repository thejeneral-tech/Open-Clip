"""Story Vault tables

Stories discovered from Reddit/paste, generated scripts, background footage +
segments, the story-video pipeline, and final exports. SQLite installs get
these via ``app.db_init`` (create_all); this migration is for PostgreSQL.

Revision ID: 0004_storyvault
Revises: 0003_reframe_detection_settings
Create Date: 2026-06-11 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004_storyvault"
down_revision: Union[str, None] = "0003_reframe_detection_settings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "sv_stories",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("source", sa.String(32), nullable=False, server_default="paste"),
        sa.Column("source_url", sa.Text()),
        sa.Column("external_id", sa.String(128), index=True),
        sa.Column("community", sa.String(128)),
        sa.Column("author", sa.String(128)),
        sa.Column("title", sa.String(512), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("category", sa.String(64)),
        sa.Column("upvotes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("num_comments", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("score_breakdown", sa.JSON()),
        sa.Column("analysis", sa.JSON()),
        sa.Column("status", sa.String(32), nullable=False, server_default="new", index=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        *_timestamps(),
    )

    op.create_table(
        "sv_scripts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("story_id", sa.Integer(), sa.ForeignKey("sv_stories.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("full_text", sa.Text(), nullable=False),
        sa.Column("hook", sa.Text()),
        sa.Column("duration_target", sa.Integer(), nullable=False, server_default="60"),
        sa.Column("hook_style", sa.String(32), nullable=False, server_default="conflict"),
        sa.Column("narration_style", sa.String(32), nullable=False, server_default="dramatic"),
        sa.Column("drama_level", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("word_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("generator", sa.String(128)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "sv_backgrounds",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("original_filename", sa.String(512)),
        sa.Column("storage_path", sa.String(1024)),
        sa.Column("thumbnail_path", sa.String(1024)),
        sa.Column("category", sa.String(64)),
        sa.Column("duration_seconds", sa.Float()),
        sa.Column("width", sa.Integer()),
        sa.Column("height", sa.Integer()),
        sa.Column("fps", sa.Float()),
        sa.Column("size_bytes", sa.BigInteger()),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("error", sa.Text()),
        *_timestamps(),
    )

    op.create_table(
        "sv_segments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("background_id", sa.Integer(), sa.ForeignKey("sv_backgrounds.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("start_sec", sa.Float(), nullable=False),
        sa.Column("end_sec", sa.Float(), nullable=False),
        sa.Column("times_used", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "sv_videos",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("story_id", sa.Integer(), sa.ForeignKey("sv_stories.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("script_id", sa.Integer(), sa.ForeignKey("sv_scripts.id", ondelete="SET NULL")),
        sa.Column("title", sa.String(512)),
        sa.Column("duration_target", sa.Integer(), nullable=False, server_default="60"),
        sa.Column("hook_style", sa.String(32), nullable=False, server_default="conflict"),
        sa.Column("narration_style", sa.String(32), nullable=False, server_default="dramatic"),
        sa.Column("drama_level", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("voice", sa.String(128)),
        sa.Column("speed", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column("caption_style", sa.String(32), nullable=False, server_default="hormozi"),
        sa.Column("background_category", sa.String(64)),
        sa.Column("script_engine", sa.String(16), nullable=False, server_default="auto"),
        sa.Column("narration_path", sa.String(1024)),
        sa.Column("narration_duration", sa.Float()),
        sa.Column("word_timings", sa.JSON()),
        sa.Column("captions_ass_path", sa.String(1024)),
        sa.Column("captions_srt_path", sa.String(1024)),
        sa.Column("segment_plan", sa.JSON()),
        sa.Column("preview_path", sa.String(1024)),
        sa.Column("render_path", sa.String(1024)),
        sa.Column("status", sa.String(32), nullable=False, server_default="queued", index=True),
        sa.Column("stage", sa.String(64)),
        sa.Column("progress", sa.Float(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text()),
        sa.Column("reject_reason", sa.Text()),
        sa.Column("celery_task_id", sa.String(64)),
        *_timestamps(),
    )

    op.create_table(
        "sv_exports",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("sv_video_id", sa.Integer(), sa.ForeignKey("sv_videos.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("platform", sa.String(32), nullable=False, server_default="tiktok"),
        sa.Column("title", sa.String(512)),
        sa.Column("storage_path", sa.String(1024)),
        sa.Column("size_bytes", sa.BigInteger()),
        sa.Column("duration_seconds", sa.Float()),
        sa.Column("width", sa.Integer()),
        sa.Column("height", sa.Integer()),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    for table in ("sv_exports", "sv_videos", "sv_segments", "sv_backgrounds", "sv_scripts", "sv_stories"):
        op.drop_table(table)
