"""Reusable declarative mixins (timestamp columns)."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, func
from sqlalchemy.orm import Mapped, mapped_column


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# These use *client-side* ``default``/``onupdate`` (a Python callable) alongside
# ``server_default``. The Python defaults mean the ORM fills the values itself on
# INSERT/UPDATE, so SQLAlchemy never has to expire the column to re-fetch a
# server-generated value. That matters under the async engine: a server-side
# ``onupdate=func.now()`` expires ``updated_at`` after every commit, and the next
# attribute access (e.g. serializing the row) would emit a lazy SELECT in a sync
# greenlet and raise ``MissingGreenlet``. ``server_default`` is kept so rows
# inserted outside the ORM still get a sane value.


class CreatedAtMixin:
    """A single ``created_at`` set on insert."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, server_default=func.now(), nullable=False
    )


class TimestampMixin(CreatedAtMixin):
    """``created_at`` plus an ``updated_at`` that bumps on every UPDATE."""

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=_utcnow,
        onupdate=_utcnow,
        server_default=func.now(),
        nullable=False,
    )
