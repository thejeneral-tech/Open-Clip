"""Shared pytest fixtures.

Most tests are pure-unit and need nothing. The API tests run against a throwaway
**SQLite** database in a temp directory — no external services required — so the
full suite runs anywhere and never touches your real ``data/openclip.db``.
"""
from __future__ import annotations

import os
import tempfile

# Configure a safe, isolated environment BEFORE importing the app/settings.
_TMP = tempfile.mkdtemp(prefix="openclip-test-")
os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("DEBUG", "false")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ.setdefault("DB_BACKEND", "sqlite")
os.environ.setdefault("SQLITE_PATH", os.path.join(_TMP, "test.db"))
os.environ.setdefault("DATA_DIR", _TMP)
os.environ.setdefault("STORAGE_ROOT", os.path.join(_TMP, "storage"))

import pytest  # noqa: E402
from sqlalchemy import text  # noqa: E402

import app.models  # noqa: E402,F401  (register all tables)
from app.core.database import Base, sync_engine  # noqa: E402


def _db_reachable() -> bool:
    try:
        with sync_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


DB_OK = _db_reachable()


@pytest.fixture(scope="session", autouse=True)
def _schema():
    if not DB_OK:
        yield
        return
    Base.metadata.create_all(sync_engine)
    yield
    Base.metadata.drop_all(sync_engine)


@pytest.fixture
async def client():
    """Async HTTP client bound to the ASGI app (requires a test DB)."""
    if not DB_OK:
        pytest.skip("No test database reachable")
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
def sample_segments() -> list[dict]:
    return [
        {
            "id": 0, "start": 0.0, "end": 4.0, "text": "Welcome everyone to the show.", "speaker": "SPEAKER_00",
            "words": [
                {"word": "Welcome", "start": 0.0, "end": 0.6, "probability": 0.99},
                {"word": "everyone", "start": 0.6, "end": 1.2, "probability": 0.98},
                {"word": "to", "start": 1.2, "end": 1.4, "probability": 0.97},
                {"word": "the", "start": 1.4, "end": 1.6, "probability": 0.97},
                {"word": "show", "start": 1.6, "end": 2.0, "probability": 0.99},
            ],
        },
        {
            "id": 1, "start": 4.0, "end": 9.0, "text": "Today we reveal a massive secret.", "speaker": "SPEAKER_00",
            "words": [
                {"word": "Today", "start": 4.0, "end": 4.4, "probability": 0.99},
                {"word": "we", "start": 4.4, "end": 4.6, "probability": 0.98},
                {"word": "reveal", "start": 4.6, "end": 5.2, "probability": 0.96},
                {"word": "a", "start": 5.2, "end": 5.3, "probability": 0.95},
                {"word": "massive", "start": 5.3, "end": 5.9, "probability": 0.97},
                {"word": "secret", "start": 5.9, "end": 6.6, "probability": 0.99},
            ],
        },
    ]
