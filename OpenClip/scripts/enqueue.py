"""Enqueue helper (avoids PowerShell inline-quote pain).

    python scripts/enqueue.py renders   # re-render all video-1 clips (fast path)
    python scripts/enqueue.py video2    # full reprocess of video 2
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

# Resolve the DB + Celery result backend from the app's own settings, so this
# dev helper always targets the same local stack as ``launch.py`` on any OS
# (no hardcoded, machine-specific paths). ``SQLITE_PATH`` is already resolved to
# an absolute path and ``celery_result_backend`` yields the correct db+sqlite
# URI under DATA_DIR.
from app.core.config import settings  # noqa: E402

DB = settings.SQLITE_PATH
os.environ.setdefault("CELERY_RESULT_BACKEND", settings.celery_result_backend)

import sqlite3  # noqa: E402

from app.schemas.video import ProcessOptions  # noqa: E402
from app.workers.tasks import process_video_task, render_preview_task  # noqa: E402

cmd = sys.argv[1] if len(sys.argv) > 1 else "renders"
con = sqlite3.connect(DB)

if cmd == "renders":
    con.execute("UPDATE videos SET status='ready', stage='ready', progress=0.0, error=NULL WHERE id=2")
    con.commit()
    ids = [r[0] for r in con.execute("SELECT id FROM clips WHERE video_id=1 ORDER BY id")]
    for cid in ids:
        render_preview_task.delay(cid)
    print("enqueued render_preview_task for clips:", ids)
elif cmd == "video2":
    con.execute("UPDATE videos SET status='queued', stage='queued', progress=0.0, error=NULL WHERE id=2")
    con.commit()
    r = process_video_task.delay(2, ProcessOptions().model_dump(mode="json"))
    print("enqueued process_video_task for video 2:", r.id)
else:
    print("unknown command:", cmd)

con.close()
