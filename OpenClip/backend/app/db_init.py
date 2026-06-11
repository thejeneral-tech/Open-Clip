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


def _sync_added_columns(Base, engine) -> None:
    """Add ORM columns missing from existing tables (additive drift only).

    ``create_all`` creates new *tables* but never alters existing ones, so a
    model gaining a column would otherwise break a previously-initialized
    SQLite database. Only scalar-defaulted or nullable columns can be added
    this way; anything else still needs a real migration.
    """
    from sqlalchemy import inspect, text

    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                ddl = f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col.type.compile(engine.dialect)}'
                default = getattr(col.default, "arg", None)
                if col.default is not None and getattr(col.default, "is_scalar", False):
                    literal = ("1" if default else "0") if isinstance(default, bool) else repr(default)
                    ddl += f" DEFAULT {literal}"
                    if not col.nullable:
                        ddl += " NOT NULL"
                elif not col.nullable:
                    continue  # can't backfill safely — needs a real migration
                conn.execute(text(ddl))


def init_db() -> None:
    """Create the data directories and the database schema (idempotent)."""
    _ensure_dirs()

    # Import models so every table registers on Base.metadata before create_all.
    import app.models  # noqa: F401
    from app.core.database import Base, sync_engine

    Base.metadata.create_all(sync_engine)
    _sync_added_columns(Base, sync_engine)


if __name__ == "__main__":  # `python -m app.db_init`
    init_db()
    print(f"Initialized database at {settings.SQLITE_PATH}")
