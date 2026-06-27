"""Database engines & session factories.

We run two engines against the same database:

* an **async** engine used by the FastAPI request handlers, and
* a **sync** engine used by Celery workers and Alembic, where a blocking session
  model is far simpler than juggling an event loop.

Both share the same declarative :class:`Base`, so the ORM models are defined
exactly once and work in either context.

The default backend is **SQLite** (a single file under ``DATA_DIR``). WAL mode is
enabled so the API process (readers) and the Celery worker (writer) can hit the
file concurrently without tripping over each other.
"""
from __future__ import annotations

from collections.abc import AsyncGenerator, Generator
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import settings


class Base(DeclarativeBase):
    """Declarative base shared by every ORM model."""


_ECHO = settings.DB_ECHO and settings.ENVIRONMENT == "development"

# --------------------------------------------------------------------- async
if settings.is_sqlite:
    async_engine = create_async_engine(
        settings.sqlalchemy_database_uri,
        echo=_ECHO,
        pool_pre_ping=True,
        connect_args={"check_same_thread": False},
    )
else:
    async_engine = create_async_engine(
        settings.sqlalchemy_database_uri,
        echo=_ECHO,
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=20,
    )

AsyncSessionLocal = async_sessionmaker(
    bind=async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that yields an async session per request."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


# ---------------------------------------------------------------------- sync
if settings.is_sqlite:
    sync_engine = create_engine(
        settings.sync_database_uri,
        echo=False,
        pool_pre_ping=True,
        connect_args={"check_same_thread": False},
    )
else:
    sync_engine = create_engine(
        settings.sync_database_uri,
        echo=False,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
    )

SyncSessionLocal = sessionmaker(
    bind=sync_engine,
    class_=Session,
    expire_on_commit=False,
    autoflush=False,
)


# ----------------------------------------------------------------- sqlite tuning
if settings.is_sqlite:

    @event.listens_for(sync_engine, "connect")
    @event.listens_for(async_engine.sync_engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _record) -> None:  # noqa: ANN001
        """Enable WAL + foreign keys on every new SQLite connection.

        WAL lets the API and the worker read/write the same file concurrently;
        ``foreign_keys=ON`` makes the ``ON DELETE CASCADE`` constraints actually
        fire (SQLite ignores them otherwise); ``busy_timeout`` waits instead of
        failing fast when the single writer lock is briefly held.
        """
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=10000")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()


@contextmanager
def session_scope() -> Generator[Session, None, None]:
    """Transactional scope for Celery workers.

    Commits on success, rolls back on exception, always closes.
    """
    session = SyncSessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
