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


# Columns added after the initial create_all schema. ``Base.metadata.create_all``
# only creates *missing tables* — it never ALTERs an existing one — so additive
# columns on an already-created SQLite DB must be backfilled by hand. Each entry
# is (column_name, column_ddl); ``_ensure_columns`` adds any that are missing.
_ADDED_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "clips": [
        ("source_segment_path", "VARCHAR(1024)"),
        ("source_offset", "FLOAT NOT NULL DEFAULT 0"),
    ],
    "videos": [
        ("youtube_meta", "JSON NOT NULL DEFAULT '{}'"),
    ],
}


def _ensure_columns(engine) -> None:
    """Add any missing additive columns to existing SQLite tables (idempotent)."""
    with engine.begin() as conn:
        for table, columns in _ADDED_COLUMNS.items():
            existing = {
                row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")
            }
            if not existing:
                continue  # table not created yet — create_all handles it
            for name, ddl in columns:
                if name not in existing:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


def init_db() -> None:
    """Create the data directories and the database schema (idempotent)."""
    _ensure_dirs()

    # Import models so every table registers on Base.metadata before create_all.
    import app.models  # noqa: F401
    from app.core.database import Base, sync_engine

    Base.metadata.create_all(sync_engine)
    if settings.is_sqlite:
        _ensure_columns(sync_engine)


if __name__ == "__main__":  # `python -m app.db_init`
    init_db()
    print(f"Initialized database at {settings.SQLITE_PATH}")
