"""Enqueue helper (avoids PowerShell inline-quote pain).

    python scripts/enqueue.py renders   # re-render all video-1 clips (fast path)
    python scripts/enqueue.py video2    # full reprocess of video 2
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

# Set BEFORE importing the app so settings picks it up (the .env value is an
# empty-with-inline-comment that pydantic otherwise mis-parses for scripts).
DB = r"C:/Users/kevin/Documents/New Folder/Clip tool 2.0/data/openclip.db"
os.environ.setdefault(
    "CELERY_RESULT_BACKEND",
    "db+sqlite:///C:/Users/kevin/Documents/New Folder/Clip tool 2.0/data/celery_results.db",
)

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
