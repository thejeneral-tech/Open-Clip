"""Story Vault cloned-voice routing

Wires the Fish Speech (cloned) voices into video narration. Adds the cloning
reference to a preset — ``sv_voice_presets.ref_key`` (the reference clip's storage
key) and ``prompt_text`` (the words spoken in it, which the s2 engine needs to
clone) — and ``sv_videos.voice_config``, a queue-time snapshot of the resolved
engine + reference so the worker narrates with the chosen clone instead of SAPI.
SQLite installs get these via ``app.db_init`` (create_all + additive column sync);
this migration is for PostgreSQL.

Revision ID: 0013_sv_voice_clone_routing
Revises: 0012_clip_caption_config
Create Date: 2026-06-13 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0013_sv_voice_clone_routing"
down_revision: Union[str, None] = "0012_clip_caption_config"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("sv_voice_presets", sa.Column("ref_key", sa.String(1024), nullable=True))
    op.add_column("sv_voice_presets", sa.Column("prompt_text", sa.Text(), nullable=True))
    op.add_column("sv_videos", sa.Column("voice_config", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("sv_videos", "voice_config")
    op.drop_column("sv_voice_presets", "prompt_text")
    op.drop_column("sv_voice_presets", "ref_key")
