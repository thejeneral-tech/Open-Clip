"""Whop Campaigns

Adds the ``whop_campaigns``, ``whop_submissions`` and ``whop_view_snapshots``
tables — clipping/UGC reward campaigns, their creator submissions, and the
view-count history the analytics series is derived from. SQLite installs get
these via ``app.db_init`` (create_all); this migration is for PostgreSQL.

Revision ID: 0017_whop
Revises: 0016_sv_music_presets
Create Date: 2026-07-03 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0017_whop"
down_revision: Union[str, None] = "0016_sv_music_presets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "whop_campaigns",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "owner_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("campaign_type", sa.String(32), nullable=False, server_default="clipping"),
        sa.Column("category", sa.String(64), nullable=False, server_default="personal_brand"),
        sa.Column("status", sa.String(32), nullable=False, server_default="active", index=True),
        sa.Column("rate_per_1k", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column("budget", sa.Float(), nullable=True),
        sa.Column("min_payout", sa.Float(), nullable=True),
        sa.Column("max_payout", sa.Float(), nullable=True),
        sa.Column("platforms", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("requirements", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("asset_links", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("whop_url", sa.String(500), nullable=True),
        sa.Column("thumbnail_path", sa.String(500), nullable=True),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "whop_submissions",
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
        sa.Column("creator_handle", sa.String(120), nullable=True),
        sa.Column("platform", sa.String(32), nullable=False, server_default="tiktok"),
        sa.Column("post_url", sa.String(500), nullable=False),
        sa.Column("title", sa.String(255), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending", index=True),
        sa.Column("views", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("likes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("paid_amount", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column("clawback_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("clawback_reason", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "whop_view_snapshots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "submission_id",
            sa.Integer(),
            sa.ForeignKey("whop_submissions.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("views", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("whop_view_snapshots")
    op.drop_table("whop_submissions")
    op.drop_table("whop_campaigns")
