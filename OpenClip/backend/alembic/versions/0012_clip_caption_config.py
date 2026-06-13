"""Per-clip caption override blob

Adds ``clips.caption_config`` — a JSON override blob (caption animation style
karaoke/pop, text + highlight colours, and any preset overrides) layered on top
of the clip's named ``caption_style`` at render time. NULL keeps the named
style's defaults. SQLite installs get this via ``app.db_init`` (create_all +
additive column sync); this migration is for PostgreSQL.

Revision ID: 0012_clip_caption_config
Revises: 0011_sv_video_intro_plan
Create Date: 2026-06-13 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0012_clip_caption_config"
down_revision: Union[str, None] = "0011_sv_video_intro_plan"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("clips", sa.Column("caption_config", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("clips", "caption_config")
