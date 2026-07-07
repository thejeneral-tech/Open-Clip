"""Whop channel↔campaign links

Adds ``whop_channel_campaigns`` — a join table linking a YouTube channel
(``publishing_connectors`` row) to a Whop campaign the user has manually pinned to
it. Only manual links are stored; "auto" links are derived from submissions at
read time. SQLite installs get this table via ``app.db_init`` (create_all); this
migration is for PostgreSQL.

Revision ID: 0019_whop_channel_links
Revises: 0018_whop_studio_project
Create Date: 2026-07-05 00:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0019_whop_channel_links"
down_revision: Union[str, None] = "0018_whop_studio_project"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "whop_channel_campaigns",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "owner_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "connector_id",
            sa.Integer(),
            sa.ForeignKey("publishing_connectors.id", ondelete="CASCADE"),
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
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("connector_id", "campaign_id", name="uq_whop_channel_campaign"),
    )


def downgrade() -> None:
    op.drop_table("whop_channel_campaigns")
