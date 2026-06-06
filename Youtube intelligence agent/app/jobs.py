"""In-memory job + progress tracking. The UI polls these to render the
progress bar and per-step status. Results themselves are persisted in SQLite.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import asdict, dataclass, field


@dataclass
class Step:
    name: str
    label: str
    status: str = "pending"   # pending | running | done | error | skipped
    detail: str = ""
    started_at: float | None = None
    ended_at: float | None = None


@dataclass
class Job:
    id: str
    kind: str                 # "full" or an individual step name
    url: str = ""
    prompt: str = ""
    video_id: str | None = None
    status: str = "queued"    # queued | running | done | error
    progress: int = 0
    error: str | None = None
    result: dict = field(default_factory=dict)
    steps: list[Step] = field(default_factory=list)
    logs: list[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(self, kind: str, url: str = "", prompt: str = "", steps: list[tuple[str, str]] | None = None) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], kind=kind, url=url, prompt=prompt)
        job.steps = [Step(name=n, label=l) for n, l in (steps or [])]
        with self._lock:
            self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self, limit: int = 25) -> list[dict]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)
        return [j.to_dict() for j in jobs[:limit]]

    # --- mutation helpers (all touch updated_at) -------------------------
    def _touch(self, job: Job) -> None:
        job.updated_at = time.time()
        self._recompute_progress(job)

    def _recompute_progress(self, job: Job) -> None:
        if not job.steps:
            return
        terminal = sum(1 for s in job.steps if s.status in ("done", "skipped", "error"))
        job.progress = int(terminal / len(job.steps) * 100)

    def start(self, job: Job) -> None:
        with self._lock:
            job.status = "running"
            self._touch(job)

    def log(self, job: Job, message: str) -> None:
        with self._lock:
            job.logs.append(f"{time.strftime('%H:%M:%S')}  {message}")
            job.updated_at = time.time()

    def step(self, job: Job, name: str, status: str, detail: str = "") -> None:
        with self._lock:
            for s in job.steps:
                if s.name == name:
                    if status == "running" and s.started_at is None:
                        s.started_at = time.time()
                    if status in ("done", "error", "skipped"):
                        s.ended_at = time.time()
                    s.status = status
                    if detail:
                        s.detail = detail
                    break
            self._touch(job)

    def set_video(self, job: Job, video_id: str) -> None:
        with self._lock:
            job.video_id = video_id
            job.updated_at = time.time()

    def finish(self, job: Job, result: dict | None = None) -> None:
        with self._lock:
            job.status = "done"
            job.progress = 100
            if result:
                job.result = result
            job.updated_at = time.time()

    def fail(self, job: Job, error: str) -> None:
        with self._lock:
            job.status = "error"
            job.error = error
            job.updated_at = time.time()


manager = JobManager()
