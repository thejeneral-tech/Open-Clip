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

-- Topic-to-Clips workflow -------------------------------------------------
CREATE TABLE IF NOT EXISTS presets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT,
    config_json  TEXT,            -- full preset config (source type, topic, params...)
    created_at   TEXT,
    updated_at   TEXT
);

CREATE TABLE IF NOT EXISTS clip_runs (
    id               TEXT PRIMARY KEY,
    source_type      TEXT,
    query            TEXT,         -- topic / channel url / video url, for display
    params_json      TEXT,        -- the full run configuration
    status           TEXT,        -- queued | running | done | error
    progress         INTEGER,
    stats_json       TEXT,        -- live counters (videos, moments, clips, errors...)
    selected_json    TEXT,        -- the videos chosen for analysis
    job_id           TEXT,
    created_at       TEXT,
    updated_at       TEXT
);

CREATE TABLE IF NOT EXISTS run_clips (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT REFERENCES clip_runs(id) ON DELETE CASCADE,
    video_id      TEXT,
    source_url    TEXT,
    rank          INTEGER,
    clip_json     TEXT,           -- timings, scores, title, description, caption, reason
    framing_mode  TEXT,
    caption_style TEXT,
    file_path     TEXT,
    poster_path   TEXT,
    srt_path      TEXT,
    status        TEXT,           -- pending | rendering | rendered | approved | rejected | failed
    error         TEXT,
    created_at    TEXT,
    updated_at    TEXT
);

-- Smart Video Searcher: a job-based search, persisted so it survives refresh /
-- backend restart (resume & recovery).
CREATE TABLE IF NOT EXISTS search_jobs (
    id            TEXT PRIMARY KEY,
    job_id        TEXT,           -- in-memory JobManager id (steps/logs)
    request_json  TEXT,           -- the original search request (for retry/resume)
    status        TEXT,           -- queued|searching|done|error|cancelled
    progress      INTEGER,
    step          TEXT,
    stats_json    TEXT,           -- live counters (found/analyzed/duplicates/errors/elapsed...)
    results_json  TEXT,           -- final ranked results
    run_id        TEXT,           -- clip run spawned from this search, if any
    created_at    TEXT,
    updated_at    TEXT
);

-- Cache raw ytsearch query results so retry / find-more don't re-hit YouTube.
CREATE TABLE IF NOT EXISTS search_cache (
    key          TEXT PRIMARY KEY,
    payload_json TEXT,
    fetched_at   TEXT
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


# --- presets -------------------------------------------------------------
def create_preset(name: str, config: dict) -> int:
    with _lock, _conn() as conn:
        cur = conn.execute(
            "INSERT INTO presets (name, config_json, created_at, updated_at) VALUES (?,?,?,?)",
            (name, _dumps(config or {}), _now(), _now()),
        )
        return cur.lastrowid


def update_preset(preset_id: int, name: str, config: dict) -> bool:
    with _lock, _conn() as conn:
        cur = conn.execute(
            "UPDATE presets SET name=?, config_json=?, updated_at=? WHERE id=?",
            (name, _dumps(config or {}), _now(), preset_id),
        )
        return cur.rowcount > 0


def get_preset(preset_id: int) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM presets WHERE id=?", (preset_id,)).fetchone()
    if not r:
        return None
    return {"id": r["id"], "name": r["name"], "config": _loads(r["config_json"]) or {},
            "created_at": r["created_at"], "updated_at": r["updated_at"]}


def list_presets() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute("SELECT * FROM presets ORDER BY updated_at DESC").fetchall()
    return [{"id": r["id"], "name": r["name"], "config": _loads(r["config_json"]) or {},
             "created_at": r["created_at"], "updated_at": r["updated_at"]} for r in rows]


def delete_preset(preset_id: int) -> None:
    with _lock, _conn() as conn:
        conn.execute("DELETE FROM presets WHERE id=?", (preset_id,))


# --- clip runs -----------------------------------------------------------
def create_run(run_id: str, source_type: str, query: str, params: dict, job_id: str | None) -> None:
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT INTO clip_runs (id,source_type,query,params_json,status,progress,"
            "stats_json,selected_json,job_id,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, source_type, query, _dumps(params or {}), "queued", 0,
             _dumps({}), _dumps([]), job_id, _now(), _now()),
        )


def update_run(run_id: str, **fields) -> None:
    if not fields:
        return
    mapping = {
        "status": "status", "progress": "progress", "job_id": "job_id",
        "stats": "stats_json", "selected": "selected_json", "query": "query",
        "params": "params_json",
    }
    sets, vals = [], []
    for key, val in fields.items():
        col = mapping.get(key)
        if not col:
            continue
        sets.append(f"{col}=?")
        vals.append(_dumps(val) if col.endswith("_json") else val)
    if not sets:
        return
    sets.append("updated_at=?")
    vals.append(_now())
    vals.append(run_id)
    with _lock, _conn() as conn:
        conn.execute(f"UPDATE clip_runs SET {','.join(sets)} WHERE id=?", vals)


def get_run(run_id: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM clip_runs WHERE id=?", (run_id,)).fetchone()
    if not r:
        return None
    return {
        "id": r["id"], "source_type": r["source_type"], "query": r["query"],
        "params": _loads(r["params_json"]) or {}, "status": r["status"],
        "progress": r["progress"], "stats": _loads(r["stats_json"]) or {},
        "selected": _loads(r["selected_json"]) or [], "job_id": r["job_id"],
        "created_at": r["created_at"], "updated_at": r["updated_at"],
    }


def list_runs(limit: int = 50) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id,source_type,query,status,progress,stats_json,created_at,updated_at "
            "FROM clip_runs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["stats"] = _loads(d.pop("stats_json")) or {}
        out.append(d)
    return out


def delete_run(run_id: str) -> None:
    with _lock, _conn() as conn:
        conn.execute("DELETE FROM clip_runs WHERE id=?", (run_id,))


# --- rendered clips ------------------------------------------------------
def add_run_clip(run_id: str, video_id: str, source_url: str, rank: int, clip: dict,
                 framing_mode: str, caption_style: str, status: str = "pending") -> int:
    with _lock, _conn() as conn:
        cur = conn.execute(
            "INSERT INTO run_clips (run_id,video_id,source_url,rank,clip_json,framing_mode,"
            "caption_style,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (run_id, video_id, source_url, rank, _dumps(clip or {}), framing_mode,
             caption_style, status, _now(), _now()),
        )
        return cur.lastrowid


def update_run_clip(clip_id: int, **fields) -> None:
    if not fields:
        return
    mapping = {
        "clip": "clip_json", "framing_mode": "framing_mode", "caption_style": "caption_style",
        "file_path": "file_path", "poster_path": "poster_path", "srt_path": "srt_path",
        "status": "status", "error": "error", "rank": "rank",
    }
    sets, vals = [], []
    for key, val in fields.items():
        col = mapping.get(key)
        if not col:
            continue
        sets.append(f"{col}=?")
        vals.append(_dumps(val) if col.endswith("_json") else val)
    if not sets:
        return
    sets.append("updated_at=?")
    vals.append(_now())
    vals.append(clip_id)
    with _lock, _conn() as conn:
        conn.execute(f"UPDATE run_clips SET {','.join(sets)} WHERE id=?", vals)


def _row_to_clip(r: sqlite3.Row) -> dict:
    clip = _loads(r["clip_json"]) or {}
    clip.update({
        "id": r["id"], "run_id": r["run_id"], "video_id": r["video_id"],
        "source_url": r["source_url"], "rank": r["rank"],
        "framing_mode": r["framing_mode"], "caption_style": r["caption_style"],
        "file_path": r["file_path"], "poster_path": r["poster_path"],
        "srt_path": r["srt_path"], "status": r["status"], "error": r["error"],
    })
    return clip


def get_run_clip(clip_id: int) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM run_clips WHERE id=?", (clip_id,)).fetchone()
    return _row_to_clip(r) if r else None


def list_run_clips(run_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM run_clips WHERE run_id=? ORDER BY rank ASC, id ASC", (run_id,)
        ).fetchall()
    return [_row_to_clip(r) for r in rows]


def get_run_record(run_id: str) -> dict:
    run = get_run(run_id)
    if not run:
        return {}
    run["clips"] = list_run_clips(run_id)
    return run


# --- search jobs (Smart Video Searcher) ----------------------------------
def create_search(search_id: str, job_id: str, request: dict) -> None:
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT INTO search_jobs (id,job_id,request_json,status,progress,step,"
            "stats_json,results_json,run_id,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (search_id, job_id, _dumps(request or {}), "queued", 0, "",
             _dumps({}), _dumps([]), None, _now(), _now()),
        )


def update_search(search_id: str, **fields) -> None:
    if not fields:
        return
    mapping = {
        "job_id": "job_id", "status": "status", "progress": "progress", "step": "step",
        "stats": "stats_json", "results": "results_json", "request": "request_json",
        "run_id": "run_id",
    }
    sets, vals = [], []
    for key, val in fields.items():
        col = mapping.get(key)
        if not col:
            continue
        sets.append(f"{col}=?")
        vals.append(_dumps(val) if col.endswith("_json") else val)
    if not sets:
        return
    sets.append("updated_at=?")
    vals.append(_now())
    vals.append(search_id)
    with _lock, _conn() as conn:
        conn.execute(f"UPDATE search_jobs SET {','.join(sets)} WHERE id=?", vals)


def _row_to_search(r: sqlite3.Row, with_results: bool = True) -> dict:
    d = {
        "id": r["id"], "job_id": r["job_id"], "request": _loads(r["request_json"]) or {},
        "status": r["status"], "progress": r["progress"], "step": r["step"],
        "stats": _loads(r["stats_json"]) or {}, "run_id": r["run_id"],
        "created_at": r["created_at"], "updated_at": r["updated_at"],
    }
    if with_results:
        d["results"] = _loads(r["results_json"]) or []
    return d


def get_search(search_id: str, with_results: bool = True) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM search_jobs WHERE id=?", (search_id,)).fetchone()
    return _row_to_search(r, with_results) if r else None


def list_searches(limit: int = 25) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM search_jobs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [_row_to_search(r, with_results=False) for r in rows]


def latest_unfinished_search() -> dict | None:
    """Most recent search still in an active state — for resume after refresh."""
    with _conn() as conn:
        r = conn.execute(
            "SELECT * FROM search_jobs WHERE status IN ('queued','searching') "
            "ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
    return _row_to_search(r) if r else None


def delete_search(search_id: str) -> None:
    with _lock, _conn() as conn:
        conn.execute("DELETE FROM search_jobs WHERE id=?", (search_id,))


def reap_orphan_search_jobs() -> int:
    """On startup, flip search jobs left 'running' by a dead process to 'error'
    so the UI can offer Retry. Returns how many were reaped."""
    with _lock, _conn() as conn:
        cur = conn.execute(
            "UPDATE search_jobs SET status='error', step='interrupted', updated_at=? "
            "WHERE status IN ('queued','searching')", (_now(),))
        return cur.rowcount


# --- search result cache -------------------------------------------------
def get_search_cache(key: str, ttl_seconds: int) -> Any:
    with _conn() as conn:
        r = conn.execute("SELECT payload_json, fetched_at FROM search_cache WHERE key=?",
                         (key,)).fetchone()
    if not r:
        return None
    try:
        age = (datetime.now(timezone.utc)
               - datetime.fromisoformat(r["fetched_at"])).total_seconds()
    except Exception:
        return None
    if age > ttl_seconds:
        return None
    return _loads(r["payload_json"])


def put_search_cache(key: str, payload: Any) -> None:
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT INTO search_cache (key,payload_json,fetched_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json, "
            "fetched_at=excluded.fetched_at",
            (key, _dumps(payload), _now()))
