"""initial schema

Revision ID: 0001_initial
Revises:
Create Date: 2026-01-01 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _ts() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    ]


def upgrade() -> None:
    # ---------------------------------------------------------------- users
    op.create_table(
        "users",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("full_name", sa.String(255), nullable=True),
        sa.Column("role", sa.String(32), nullable=False, server_default="editor"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("is_superuser", sa.Boolean(), nullable=False, server_default=sa.false()),
        *_ts(),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    # ---------------------------------------------------------------- projects
    op.create_table(
        "projects",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("owner_id", sa.BigInteger(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        *_ts(),
    )
    op.create_index("ix_projects_owner_id", "projects", ["owner_id"])

    # ---------------------------------------------------------------- videos
    op.create_table(
        "videos",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("project_id", sa.BigInteger(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source", sa.String(32), nullable=False, server_default="upload"),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("original_filename", sa.String(512), nullable=True),
        sa.Column("storage_path", sa.Text(), nullable=True),
        sa.Column("thumbnail_path", sa.Text(), nullable=True),
        sa.Column("title", sa.String(512), nullable=True),
        sa.Column("language", sa.String(16), nullable=True),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("fps", sa.Float(), nullable=True),
        sa.Column("codec", sa.String(64), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("stage", sa.String(64), nullable=True),
        sa.Column("progress", sa.Float(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("celery_task_id", sa.String(128), nullable=True),
        *_ts(),
    )
    op.create_index("ix_videos_project_id", "videos", ["project_id"])
    op.create_index("ix_videos_status", "videos", ["status"])

    # ---------------------------------------------------------------- transcripts
    op.create_table(
        "transcripts",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("video_id", sa.BigInteger(), sa.ForeignKey("videos.id", ondelete="CASCADE"), nullable=False),
        sa.Column("language", sa.String(16), nullable=True),
        sa.Column("engine", sa.String(64), nullable=True),
        sa.Column("model", sa.String(64), nullable=True),
        sa.Column("full_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("word_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("num_speakers", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("segments", postgresql.JSONB(), nullable=False, server_default="[]"),
        *_ts(),
    )
    op.create_index("ix_transcripts_video_id", "transcripts", ["video_id"], unique=True)

    # ---------------------------------------------------------------- clips
    op.create_table(
        "clips",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("video_id", sa.BigInteger(), sa.ForeignKey("videos.id", ondelete="CASCADE"), nullable=False),
        sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("start_time", sa.Float(), nullable=False),
        sa.Column("end_time", sa.Float(), nullable=False),
        sa.Column("duration", sa.Float(), nullable=False),
        sa.Column("title", sa.String(512), nullable=True),
        sa.Column("reasoning", sa.Text(), nullable=True),
        sa.Column("transcript_text", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("viral_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("ranking_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0"),
        sa.Column("score_breakdown", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("aspect_ratio", sa.String(8), nullable=False, server_default="9:16"),
        sa.Column("caption_style", sa.String(32), nullable=False, server_default="hormozi"),
        sa.Column("reframe_data", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("captions", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("title_variations", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("hashtags", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("keywords", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("broll_suggestions", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("preview_path", sa.Text(), nullable=True),
        sa.Column("thumbnail_path", sa.Text(), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("progress", sa.Float(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        *_ts(),
    )
    op.create_index("ix_clips_video_id", "clips", ["video_id"])
    op.create_index("ix_clips_viral_score", "clips", ["viral_score"])
    op.create_index("ix_clips_ranking_score", "clips", ["ranking_score"])
    op.create_index("ix_clips_status", "clips", ["status"])

    # ---------------------------------------------------------------- exports
    op.create_table(
        "exports",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("clip_id", sa.BigInteger(), sa.ForeignKey("clips.id", ondelete="CASCADE"), nullable=False),
        sa.Column("format", sa.String(8), nullable=False, server_default="mp4"),
        sa.Column("resolution", sa.String(8), nullable=False, server_default="1080p"),
        sa.Column("aspect_ratio", sa.String(8), nullable=False, server_default="9:16"),
        sa.Column("burn_captions", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("hwaccel", sa.String(16), nullable=True),
        sa.Column("storage_path", sa.Text(), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("progress", sa.Float(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("celery_task_id", sa.String(128), nullable=True),
        *_ts(),
    )
    op.create_index("ix_exports_clip_id", "exports", ["clip_id"])
    op.create_index("ix_exports_status", "exports", ["status"])

    # ---------------------------------------------------------------- ai_analyses
    op.create_table(
        "ai_analyses",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("video_id", sa.BigInteger(), sa.ForeignKey("videos.id", ondelete="CASCADE"), nullable=False),
        sa.Column("clip_id", sa.BigInteger(), sa.ForeignKey("clips.id", ondelete="CASCADE"), nullable=True),
        sa.Column("analysis_type", sa.String(48), nullable=False),
        sa.Column("model", sa.String(64), nullable=True),
        sa.Column("prompt", postgresql.JSONB(), nullable=True),
        sa.Column("result", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("tokens_eval", sa.BigInteger(), nullable=True),
        sa.Column("duration_ms", sa.Float(), nullable=True),
        *_ts(),
    )
    op.create_index("ix_ai_analyses_video_id", "ai_analyses", ["video_id"])
    op.create_index("ix_ai_analyses_clip_id", "ai_analyses", ["clip_id"])
    op.create_index("ix_ai_analyses_analysis_type", "ai_analyses", ["analysis_type"])

    # ---------------------------------------------------------------- user_settings
    op.create_table(
        "user_settings",
        sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
        sa.Column("user_id", sa.BigInteger(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("default_model", sa.String(64), nullable=False, server_default="qwen3:32b"),
        sa.Column("ranking_model", sa.String(64), nullable=False, server_default="qwen3:32b"),
        sa.Column("vision_model", sa.String(64), nullable=False, server_default="gemma3:27b"),
        sa.Column("whisper_model", sa.String(64), nullable=False, server_default="large-v3"),
        sa.Column("target_clip_count", sa.Integer(), nullable=False, server_default="12"),
        sa.Column("min_clip_seconds", sa.Integer(), nullable=False, server_default="8"),
        sa.Column("max_clip_seconds", sa.Integer(), nullable=False, server_default="90"),
        sa.Column("default_aspect_ratio", sa.String(8), nullable=False, server_default="9:16"),
        sa.Column("default_caption_style", sa.String(32), nullable=False, server_default="hormozi"),
        sa.Column("default_export_format", sa.String(8), nullable=False, server_default="mp4"),
        sa.Column("default_export_resolution", sa.String(8), nullable=False, server_default="1080p"),
        sa.Column("preferences", postgresql.JSONB(), nullable=False, server_default="{}"),
        *_ts(),
    )
    op.create_index("ix_user_settings_user_id", "user_settings", ["user_id"], unique=True)


def downgrade() -> None:
    op.drop_table("user_settings")
    op.drop_table("ai_analyses")
    op.drop_table("exports")
    op.drop_table("clips")
    op.drop_table("transcripts")
    op.drop_table("videos")
    op.drop_table("projects")
    op.drop_table("users")
