"""Story Vault music tracks

Adds the ``sv_music`` table — imported audio/video files converted to an MP3 bed
the render mixes under the narration — plus ``sv_videos.music_id`` /
``sv_videos.music_volume`` so a video can pin a track and its level. SQLite
installs get these via ``app.db_init`` (create_all + additive column sync); this
migration is for PostgreSQL.

Revision ID: 0015_sv_music
Revises: 0014_sv_video_cancel
Create Date: 2026-06-26 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0015_sv_music"
down_revision: Union[str, None] = "0014_sv_video_cancel"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sv_music",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "owner_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("original_filename", sa.String(512)),
        sa.Column("storage_path", sa.String(1024)),
        sa.Column("duration_seconds", sa.Float()),
        sa.Column("size_bytes", sa.BigInteger()),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("error", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.add_column(
        "sv_videos",
        sa.Column(
            "music_id",
            sa.Integer(),
            sa.ForeignKey("sv_music.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_sv_videos_music_id", "sv_videos", ["music_id"])
    op.add_column(
        "sv_videos",
        sa.Column("music_volume", sa.Float(), nullable=False, server_default="0.18"),
    )


def downgrade() -> None:
    op.drop_column("sv_videos", "music_volume")
    op.drop_index("ix_sv_videos_music_id", table_name="sv_videos")
    op.drop_column("sv_videos", "music_id")
    op.drop_table("sv_music")
