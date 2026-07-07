"""Whop clip formulas

Adds ``whop_formulas`` — a reverse-engineered "clip formula" analysis for a
campaign source video (hook · script · retention editing · viral timestamps ·
recreation plan · submission checklist), produced by ``analyze_formula_task``.
SQLite installs get this table via ``app.db_init`` (create_all); this migration
is for PostgreSQL.

Revision ID: 0020_whop_formulas
Revises: 0019_whop_channel_links
Create Date: 2026-07-05 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0020_whop_formulas"
down_revision: Union[str, None] = "0019_whop_channel_links"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "whop_formulas",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "owner_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "campaign_id",
            sa.Integer(),
            sa.ForeignKey("whop_campaigns.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "video_id",
            sa.Integer(),
            sa.ForeignKey("videos.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column("title", sa.String(512), nullable=True),
        sa.Column("source_url", sa.String(1000), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="processing", index=True),
        sa.Column("stage", sa.String(64), nullable=True),
        sa.Column("progress", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("hook_score", sa.Integer(), nullable=True),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("celery_task_id", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("whop_formulas")
