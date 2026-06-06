"""In-memory render-job registry + SSE pub/sub.

Ports the Node server's render-progress fan-out (a Set of open responses) to a
pull-based model that fits Starlette SSE: the background render task pushes
events onto a per-subscriber asyncio.Queue; each connected `render-status`
generator drains its own queue. State (logs/pct/stage) is retained so a client
that connects late or reconnects gets a full history replay.

REQUIRES a single uvicorn worker — this registry is process-local, so the
render task and the SSE endpoint must share one process.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, List, Optional

from core.constants import SSE_LOG_CAP


class RenderJobState:
    def __init__(self, job_id: str, folder: str):
        self.job_id = job_id
        self.folder = folder
        self.status = "running"          # running | done | error
        self.logs: List[str] = []
        self.pct = 0
        self.stage = "Starting…"
        self.output_file: Optional[str] = None
        self.error: Optional[str] = None
        self.success = False
        self.created_at = time.time()
        self.subscribers: List[asyncio.Queue] = []


class JobRegistry:
    def __init__(self) -> None:
        self._jobs: Dict[str, RenderJobState] = {}

    # ── lifecycle ──
    def create(self, job_id: str, folder: str) -> RenderJobState:
        st = RenderJobState(job_id, folder)
        self._jobs[job_id] = st
        return st

    def get(self, job_id: str) -> Optional[RenderJobState]:
        return self._jobs.get(job_id)

    def cleanup(self, job_id: str) -> None:
        self._jobs.pop(job_id, None)

    # ── producer side (called from the render task) ──
    def _broadcast(self, st: RenderJobState, payload: Dict[str, Any]) -> None:
        for q in list(st.subscribers):
            try:
                q.put_nowait(payload)
            except Exception:
                pass

    def push_log(self, job_id: str, line: str,
                 pct: Optional[int] = None, stage: Optional[str] = None) -> None:
        st = self._jobs.get(job_id)
        if not st:
            return
        st.logs.append(line)
        if len(st.logs) > SSE_LOG_CAP:
            st.logs = st.logs[-SSE_LOG_CAP:]
        if pct is not None:
            st.pct = pct
        if stage is not None:
            st.stage = stage
        self._broadcast(st, {"log": line, "progress": st.pct, "stage": st.stage})

    def set_progress(self, job_id: str,
                     pct: Optional[int] = None, stage: Optional[str] = None) -> None:
        st = self._jobs.get(job_id)
        if not st:
            return
        if pct is not None:
            st.pct = pct
        if stage is not None:
            st.stage = stage
        self._broadcast(st, {"progress": st.pct, "stage": st.stage})

    def finish(self, job_id: str, success: bool,
               output_file: Optional[str] = None, error: Optional[str] = None) -> None:
        st = self._jobs.get(job_id)
        if not st:
            return
        st.status = "done" if success else "error"
        st.success = success
        st.output_file = output_file
        st.error = error
        if success:
            st.pct = 100
        self._broadcast(st, {
            "done": True, "success": success,
            "outputFile": output_file, "error": error,
            "progress": st.pct, "stage": st.stage,
        })

    # ── consumer side (called from the SSE endpoint) ──
    def subscribe(self, job_id: str) -> Optional[asyncio.Queue]:
        st = self._jobs.get(job_id)
        if not st:
            return None
        q: asyncio.Queue = asyncio.Queue()
        st.subscribers.append(q)
        return q

    def unsubscribe(self, job_id: str, q: asyncio.Queue) -> None:
        st = self._jobs.get(job_id)
        if st and q in st.subscribers:
            try:
                st.subscribers.remove(q)
            except ValueError:
                pass


_registry = JobRegistry()


def get_job_registry() -> JobRegistry:
    return _registry
