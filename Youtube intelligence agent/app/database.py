"""SQLite persistence layer. One file DB, JSON blobs for variable-shape data."""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

from .config import DB_PATH

_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


def _loads(text: str | None) -> Any:
    if not text:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


@contextmanager
def _conn() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        yield conn
        conn.commit()
    finally:
        conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS videos (
    video_id    TEXT PRIMARY KEY,
    url         TEXT,
    title       TEXT,
    channel     TEXT,
    upload_date TEXT,
    duration    INTEGER,
    view_count  INTEGER,
    like_count  INTEGER,
    is_short    INTEGER,
    thumbnail   TEXT,
    metadata_json TEXT,
    created_at  TEXT,
    updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS transcripts (
    video_id      TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
    source        TEXT,
    language      TEXT,
    full_text     TEXT,
    segments_json TEXT,
    created_at    TEXT
);

CREATE TABLE IF NOT EXISTS comments (
    video_id      TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
    comments_json TEXT,
    heatmap_json  TEXT,
    insights_json TEXT,
    created_at    TEXT
);

CREATE TABLE IF NOT EXISTS frames (
    video_id    TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
    frames_json TEXT,
    created_at  TEXT
);

CREATE TABLE IF NOT EXISTS clips (
    video_id    TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
    clips_json  TEXT,
    created_at  TEXT
);

CREATE TABLE IF NOT EXISTS outputs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id    TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
    prompt      TEXT,
    mode        TEXT,
    content     TEXT,
    meta_json   TEXT,
    created_at  TEXT
);
"""


def init_db() -> None:
    with _lock, _conn() as conn:
        conn.executescript(SCHEMA)


# --- videos --------------------------------------------------------------
def upsert_video(meta: dict) -> None:
    row = (
        meta.get("video_id"),
        meta.get("url"),
        meta.get("title"),
        meta.get("channel"),
        meta.get("upload_date"),
        meta.get("duration"),
        meta.get("view_count"),
        meta.get("like_count"),
        1 if meta.get("is_short") else 0,
        meta.get("thumbnail"),
        _dumps(meta),
        _now(),
    )
    with _lock, _conn() as conn:
        conn.execute(
            """
            INSERT INTO videos (video_id,url,title,channel,upload_date,duration,
                view_count,like_count,is_short,thumbnail,metadata_json,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(video_id) DO UPDATE SET
                url=excluded.url, title=excluded.title, channel=excluded.channel,
                upload_date=excluded.upload_date, duration=excluded.duration,
                view_count=excluded.view_count, like_count=excluded.like_count,
                is_short=excluded.is_short, thumbnail=excluded.thumbnail,
                metadata_json=excluded.metadata_json, updated_at=excluded.updated_at
            """,
            row + (_now(),),
        )


def get_video(video_id: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM videos WHERE video_id=?", (video_id,)).fetchone()
    if not r:
        return None
    meta = _loads(r["metadata_json"]) or {}
    meta.setdefault("video_id", r["video_id"])
    return meta


def list_videos(limit: int = 100) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT video_id,url,title,channel,duration,is_short,thumbnail,updated_at "
            "FROM videos ORDER BY updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def delete_video(video_id: str) -> None:
    with _lock, _conn() as conn:
        conn.execute("DELETE FROM videos WHERE video_id=?", (video_id,))


# --- generic per-video blob tables --------------------------------------
def _save_blob(table: str, columns: dict, video_id: str) -> None:
    cols = ["video_id"] + list(columns.keys()) + ["created_at"]
    vals = [video_id] + list(columns.values()) + [_now()]
    placeholders = ",".join("?" * len(cols))
    updates = ",".join(f"{c}=excluded.{c}" for c in cols if c != "video_id")
    sql = (
        f"INSERT INTO {table} ({','.join(cols)}) VALUES ({placeholders}) "
        f"ON CONFLICT(video_id) DO UPDATE SET {updates}"
    )
    with _lock, _conn() as conn:
        conn.execute(sql, vals)


def save_transcript(video_id: str, transcript: dict) -> None:
    _save_blob("transcripts", {
        "source": transcript.get("source"),
        "language": transcript.get("language"),
        "full_text": transcript.get("full_text"),
        "segments_json": _dumps(transcript.get("segments", [])),
    }, video_id)


def get_transcript(video_id: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM transcripts WHERE video_id=?", (video_id,)).fetchone()
    if not r:
        return None
    return {
        "source": r["source"],
        "language": r["language"],
        "full_text": r["full_text"],
        "segments": _loads(r["segments_json"]) or [],
    }


def save_comments(video_id: str, comments: list, heatmap: list | None, insights: dict | None) -> None:
    _save_blob("comments", {
        "comments_json": _dumps(comments or []),
        "heatmap_json": _dumps(heatmap or []),
        "insights_json": _dumps(insights or {}),
    }, video_id)


def get_comments(video_id: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM comments WHERE video_id=?", (video_id,)).fetchone()
    if not r:
        return None
    return {
        "comments": _loads(r["comments_json"]) or [],
        "heatmap": _loads(r["heatmap_json"]) or [],
        "insights": _loads(r["insights_json"]) or {},
    }


def save_frames(video_id: str, frames: list) -> None:
    _save_blob("frames", {"frames_json": _dumps(frames or [])}, video_id)


def get_frames(video_id: str) -> list:
    with _conn() as conn:
        r = conn.execute("SELECT frames_json FROM frames WHERE video_id=?", (video_id,)).fetchone()
    return (_loads(r["frames_json"]) if r else None) or []


def save_clips(video_id: str, clips: list) -> None:
    _save_blob("clips", {"clips_json": _dumps(clips or [])}, video_id)


def get_clips(video_id: str) -> list:
    with _conn() as conn:
        r = conn.execute("SELECT clips_json FROM clips WHERE video_id=?", (video_id,)).fetchone()
    return (_loads(r["clips_json"]) if r else None) or []


def save_output(video_id: str, prompt: str, mode: str, content: str, meta: dict | None = None) -> int:
    with _lock, _conn() as conn:
        cur = conn.execute(
            "INSERT INTO outputs (video_id,prompt,mode,content,meta_json,created_at) "
            "VALUES (?,?,?,?,?,?)",
            (video_id, prompt, mode, content, _dumps(meta or {}), _now()),
        )
        return cur.lastrowid


def list_outputs(video_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id,prompt,mode,content,meta_json,created_at FROM outputs "
            "WHERE video_id=? ORDER BY id DESC",
            (video_id,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["meta"] = _loads(d.pop("meta_json"))
        out.append(d)
    return out


def get_output(output_id: int) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM outputs WHERE id=?", (output_id,)).fetchone()
    if not r:
        return None
    d = dict(r)
    d["meta"] = _loads(d.pop("meta_json"))
    return d


def get_full_record(video_id: str) -> dict:
    """Everything we know about a video, for the UI and JSON export."""
    return {
        "metadata": get_video(video_id),
        "transcript": get_transcript(video_id),
        "comments": get_comments(video_id),
        "frames": get_frames(video_id),
        "clips": get_clips(video_id),
        "outputs": list_outputs(video_id),
    }
