"""Story Vault per-video intro narration plan

Adds ``sv_videos.intro_plan`` — the on-screen windows for the title (topic card)
and author intro, plus when the body narration starts. The narration now reads
the title and author before the story body on a single audio timeline; this
plan lets the final render rebuild the intro overlays with the exact timing the
captions were synced to. SQLite installs get this via ``app.db_init`` (create_all
+ additive column sync); this migration is for PostgreSQL.

Revision ID: 0011_sv_video_intro_plan
Revises: 0010_sv_video_template_config
Create Date: 2026-06-12 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011_sv_video_intro_plan"
down_revision: Union[str, None] = "0010_sv_video_template_config"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sv_videos", sa.Column("intro_plan", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("sv_videos", "intro_plan")
