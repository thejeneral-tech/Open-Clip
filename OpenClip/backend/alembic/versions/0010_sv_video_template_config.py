"""Story Vault per-video template config snapshot

Adds ``sv_videos.template_config`` — a full JSON snapshot of the selected
template's render config (canvas, topicCard, authorIntro, captions, …) taken
when the video is queued, so the burned-in Reddit topic card and "Posted by
u/…" author intro match the template even if it is later edited or removed.
SQLite installs get this via ``app.db_init`` (create_all + additive column
sync); this migration is for PostgreSQL.

Revision ID: 0010_sv_video_template_config
Revises: 0009_sv_video_caption_config
Create Date: 2026-06-12 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0010_sv_video_template_config"
down_revision: Union[str, None] = "0009_sv_video_caption_config"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sv_videos", sa.Column("template_config", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("sv_videos", "template_config")
