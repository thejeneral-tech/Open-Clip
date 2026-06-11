"""Progress helpers for Celery tasks.

Each tracker updates the owning DB row (status/stage/progress) and publishes a
real-time event. High-frequency callbacks (e.g. ffmpeg/Whisper) are throttled so
we don't hammer Postgres — only meaningful deltas are persisted.
"""
from __future__ import annotations

from typing import Any

from app.core.database import session_scope
from app.core.events import publish_progress
from app.models.clip import Clip
from app.models.export import Export
from app.models.storyvault import SvVideo
from app.models.video import Video

_MODELS = {"video": Video, "clip": Clip, "export": Export, "sv_video": SvVideo}


class ProgressTracker:
    def __init__(self, scope: str, scope_id: int) -> None:
        self.scope = scope
        self.scope_id = scope_id
        self._model = _MODELS[scope]
        self._last_persisted = -1.0

    def set(
        self,
        *,
        stage: str,
        progress: float,
        status: str = "processing",
        message: str | None = None,
        data: dict[str, Any] | None = None,
        persist: bool = True,
    ) -> None:
        progress = max(0.0, min(1.0, progress))
        if persist:
            with session_scope() as db:
                row = db.get(self._model, self.scope_id)
                if row is not None:
                    row.status = status
                    row.progress = progress
                    if hasattr(row, "stage"):
                        row.stage = stage
                    if status == "failed" and message:
                        row.error = message
            self._last_persisted = progress
        publish_progress(
            self.scope, self.scope_id,
            stage=stage, progress=progress, status=status, message=message, data=data,
        )

    def throttled(self, stage: str, progress: float, *, message: str | None = None,
                  step: float = 0.02) -> None:
        """Publish always, persist only when progress advanced by ``step``."""
        persist = abs(progress - self._last_persisted) >= step or progress >= 1.0
        self.set(stage=stage, progress=progress, message=message, persist=persist)

    def fail(self, stage: str, message: str) -> None:
        self.set(stage=stage, progress=self._last_persisted if self._last_persisted > 0 else 0.0,
                 status="failed", message=message)

    def complete(self, stage: str = "done", message: str | None = None,
                 data: dict[str, Any] | None = None) -> None:
        self.set(stage=stage, progress=1.0, status="completed", message=message, data=data)
