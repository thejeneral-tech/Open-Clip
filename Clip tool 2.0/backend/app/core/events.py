"""Real-time progress events (Redis-free).

Celery workers call :func:`publish_progress` as a job advances. Instead of a
Redis pub/sub channel, each event is written atomically to a small JSON file
under ``DATA_DIR/progress`` — one file per entity (e.g. ``video_42.json``):

* The WebSocket endpoint polls that file and relays changes to the browser, so a
  client that connects late immediately sees the latest snapshot.
* It also doubles as the "current state" cache read by the ``/status`` endpoint.

Files are tiny and overwritten in place, so this stays cheap even for the
high-frequency callbacks ffmpeg/Whisper emit — and unlike the database, it
captures sub-step progress that we intentionally don't persist.
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# How long (seconds) a snapshot is considered "live" after the last update.
_SNAPSHOT_TTL = 60 * 60 * 6


def _snapshot_path(scope: str, scope_id: str | int) -> str:
    return os.path.join(settings.progress_dir, f"{scope}_{scope_id}.json")


def publish_progress(
    scope: str,
    scope_id: str | int,
    *,
    stage: str,
    progress: float,
    status: str = "processing",
    message: str | None = None,
    data: dict[str, Any] | None = None,
) -> None:
    """Emit a progress event.

    Args:
        scope: entity type, e.g. ``"video"``, ``"clip"``, ``"export"``.
        scope_id: entity primary key.
        stage: machine name of the current pipeline stage.
        progress: 0.0–1.0 completion of this stage (or overall).
        status: ``queued`` | ``processing`` | ``completed`` | ``failed``.
        message: human-readable status line.
        data: arbitrary extra payload (counts, ids, etc.).
    """
    event = {
        "scope": scope,
        "scope_id": str(scope_id),
        "stage": stage,
        "progress": round(max(0.0, min(1.0, progress)), 4),
        "status": status,
        "message": message,
        "data": data or {},
        "ts": time.time(),
    }
    try:
        os.makedirs(settings.progress_dir, exist_ok=True)
        path = _snapshot_path(scope, scope_id)
        # Atomic write: a reader never sees a half-written file.
        fd, tmp = tempfile.mkstemp(dir=settings.progress_dir, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(event, fh)
            # On Windows os.replace fails with PermissionError (WinError 5) when a
            # reader (the WS/status endpoint) momentarily has the target open.
            # Retry briefly; it's a sub-millisecond collision in practice.
            for attempt in range(5):
                try:
                    os.replace(tmp, path)
                    break
                except PermissionError:
                    if attempt == 4:
                        raise
                    time.sleep(0.02)
        finally:
            # Never leave an orphaned temp behind (a failed replace would).
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
    except Exception as exc:  # pragma: no cover - never let telemetry kill a job
        logger.warning("Failed to publish progress for %s:%s: %s", scope, scope_id, exc)


def get_latest_snapshot(scope: str, scope_id: str | int) -> dict[str, Any] | None:
    """Return the most recent event for an entity, or ``None`` if stale/absent."""
    path = _snapshot_path(scope, scope_id)
    try:
        if not os.path.exists(path):
            return None
        if time.time() - os.path.getmtime(path) > _SNAPSHOT_TTL:
            return None
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None
