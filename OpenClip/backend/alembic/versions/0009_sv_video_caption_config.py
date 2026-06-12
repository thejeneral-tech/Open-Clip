"""Story Vault per-video caption config snapshot

Adds ``sv_videos.caption_config`` — a JSON snapshot of the selected preset's
caption settings (style/size/colours/position) taken when the video is queued,
so the burned-in captions match the preset's preview even if the template is
later edited or removed. SQLite installs get this via ``app.db_init``
(create_all + additive column sync); this migration is for PostgreSQL.

Revision ID: 0009_sv_video_caption_config
Revises: 0008_sv_voice_preset_builtin
Create Date: 2026-06-12 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009_sv_video_caption_config"
down_revision: Union[str, None] = "0008_sv_voice_preset_builtin"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sv_videos", sa.Column("caption_config", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("sv_videos", "caption_config")
