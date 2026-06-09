"""Schema bootstrap for the local (SQLite) stack.

Docker used to run ``alembic upgrade head`` on boot. Off Docker we default to
SQLite, where creating the schema straight from the ORM models is simpler and
needs no migration tooling. ``init_db`` is idempotent — safe to call on every
launch — and is invoked by the API at startup as well as by ``launch.py`` before
any service comes up (so the worker never races an empty database).

If you switch to PostgreSQL (``DB_BACKEND=postgres``), use Alembic instead:
``alembic upgrade head``.
"""
from __future__ import annotations

import os
from pathlib import Path

from app.core.config import settings


def _ensure_dirs() -> None:
    """Create every on-disk location the stack writes to."""
    for path in (
        settings.DATA_DIR,
        settings.STORAGE_ROOT,
        settings.progress_dir,
        settings.celery_broker_dir,
        Path(settings.SQLITE_PATH).parent,
    ):
        os.makedirs(path, exist_ok=True)


def init_db() -> None:
    """Create the data directories and the database schema (idempotent)."""
    _ensure_dirs()

    # Import models so every table registers on Base.metadata before create_all.
    import app.models  # noqa: F401
    from app.core.database import Base, sync_engine

    Base.metadata.create_all(sync_engine)


if __name__ == "__main__":  # `python -m app.db_init`
    init_db()
    print(f"Initialized database at {settings.SQLITE_PATH}")
