"""YouTube metadata + analytics extraction (no video download).

Everything here is pulled from yt-dlp's ``extract_info(download=False)`` — the
"most replayed" heatmap, chapters, and the comment section — plus deterministic
mining (comment-mentioned timestamps). These signals let the pipeline find
clip-worthy moments *before* downloading any video, so only the chosen segments
are ever fetched. Ported from the YouTube Intelligence Agent.
"""
from __future__ import annotations

import re
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# Matches "1:23" / "12:34" / "1:02:30" timestamps in comment text, but not a
# bare number glued to other digits (e.g. won't fire inside "v2:00pm123").
_TS_RE = re.compile(r"(?<!\d)(\d{1,2}:\d{2}(?::\d{2})?)(?!\d)")


class MetadataError(RuntimeError):
    pass


# --------------------------------------------------------------- small helpers
def parse_timestamp(value: Any) -> float | None:
    """Parse "M:SS" / "H:MM:SS" / a number into seconds. None if unparseable."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return None
    if ":" in s:
        try:
            parts = [int(p) for p in s.split(":")]
        except ValueError:
            return None
        secs = 0
        for p in parts:
            secs = secs * 60 + p
        return float(secs)
    try:
        return float(s)
    except ValueError:
        return None


def fmt_timestamp(seconds: Any) -> str:
    if seconds is None:
        return ""
    s = int(float(seconds))
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def _base_opts() -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "ignoreerrors": False,
    }
    if settings.YOUTUBE_COOKIES_FILE:
        opts["cookiefile"] = settings.YOUTUBE_COOKIES_FILE
    return opts


def clean_ytdlp_error(exc: Exception) -> str:
    """Human-friendly message for common yt-dlp failures."""
    msg = str(exc).strip()
    for prefix in ("ERROR: ", "WARNING: "):
        if msg.startswith(prefix):
            msg = msg[len(prefix):]
    low = msg.lower()
    if "private video" in low:
        return "This video is private."
    if "video unavailable" in low:
        return "This video is unavailable."
    if "members-only" in low:
        return "This is a members-only video."
    if "age" in low and "sign in" in low or "confirm your age" in low:
        return "This video is age-restricted and requires sign-in (set YOUTUBE_COOKIES_FILE)."
    return msg or "Failed to fetch video metadata."


# ---------------------------------------------------------------- extraction
def fetch_metadata(url: str) -> dict[str, Any]:
    """Return a normalized metadata dict for a YouTube URL. Raises on failure."""
    import yt_dlp

    try:
        with yt_dlp.YoutubeDL(_base_opts()) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # yt_dlp.utils.DownloadError and friends
        raise MetadataError(clean_ytdlp_error(exc)) from exc

    if not info:
        raise MetadataError("yt-dlp returned no information for this URL.")
    if info.get("_type") == "playlist" or "entries" in info:
        entries = info.get("entries") or []
        if not entries:
            raise MetadataError("This URL is a playlist with no entries.")
        info = entries[0]

    chapters = [
        {"title": ch.get("title"), "start": ch.get("start_time"), "end": ch.get("end_time")}
        for ch in (info.get("chapters") or [])
    ]
    heatmap = [
        {"start": h.get("start_time"), "end": h.get("end_time"), "value": h.get("value")}
        for h in (info.get("heatmap") or [])
    ]

    return {
        "video_id": info.get("id"),
        "url": info.get("webpage_url") or url,
        "title": info.get("title") or "",
        "description": info.get("description") or "",
        "channel": info.get("channel") or info.get("uploader"),
        "duration": info.get("duration"),
        "view_count": info.get("view_count"),
        "like_count": info.get("like_count"),
        "comment_count": info.get("comment_count"),
        "tags": info.get("tags") or [],
        "thumbnail": info.get("thumbnail"),
        "chapters": chapters,
        "heatmap": heatmap,
        "is_live": bool(info.get("is_live")),
        "was_live": bool(info.get("was_live")),
        "live_status": info.get("live_status"),
        "availability": info.get("availability"),
        "language": info.get("language"),
        "width": info.get("width"),
        "height": info.get("height"),
        "fps": info.get("fps"),
        "age_limit": info.get("age_limit"),
        "has_captions": bool(info.get("subtitles")),
        "has_auto_captions": bool(info.get("automatic_captions")),
        "available_caption_langs": sorted((info.get("subtitles") or {}).keys()),
    }


def fetch_comments(url: str, max_comments: int | None = None) -> list[dict[str, Any]]:
    """Fetch top comments via yt-dlp. Never raises — returns [] on any failure."""
    import yt_dlp

    max_comments = max_comments or settings.YOUTUBE_MAX_COMMENTS
    opts = _base_opts()
    opts["getcomments"] = True
    opts["extractor_args"] = {
        "youtube": {"comment_sort": ["top"], "max_comments": [str(max_comments)]}
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001 — comments are best-effort
        logger.warning("Comment fetch failed: %s", exc)
        return []

    out: list[dict[str, Any]] = []
    for c in (info or {}).get("comments") or []:
        text = " ".join((c.get("text") or "").split())
        if not text:
            continue
        out.append(
            {
                "text": text,
                "likes": c.get("like_count") or 0,
                "is_pinned": bool(c.get("is_pinned")),
                "is_uploader": bool(c.get("author_is_uploader")),
            }
        )
    return out


# ----------------------------------------------------------- signal mining
def mentioned_timestamps(comments: list[dict[str, Any]], max_items: int = 25) -> list[dict[str, Any]]:
    """Timestamps viewers mention in comments, ranked by mention count + likes."""
    counter: dict[int, int] = {}
    likes: dict[int, int] = {}
    examples: dict[int, str] = {}
    for c in comments:
        for m in _TS_RE.findall(c.get("text", "")):
            secs = parse_timestamp(m)
            if secs is None:
                continue
            key = int(secs)
            counter[key] = counter.get(key, 0) + 1
            likes[key] = likes.get(key, 0) + (c.get("likes") or 0)
            examples.setdefault(key, c.get("text", "")[:160])
    items = [
        {
            "time": k,
            "time_str": fmt_timestamp(k),
            "mentions": v,
            "comment_likes": likes.get(k, 0),
            "example": examples.get(k, ""),
        }
        for k, v in counter.items()
    ]
    items.sort(key=lambda x: (x["mentions"], x["comment_likes"]), reverse=True)
    return items[:max_items]


def most_replayed(heatmap: list[dict[str, Any]], top_n: int = 8) -> list[dict[str, Any]]:
    """Top moments from the YouTube heatmap (value is 0..1 replay intensity)."""
    if not heatmap:
        return []
    ranked = sorted(heatmap, key=lambda h: h.get("value", 0) or 0, reverse=True)[:top_n]
    out = [
        {
            "time": int(h.get("start") or 0),
            "time_str": fmt_timestamp(h.get("start") or 0),
            "end": float(h.get("end") or h.get("start") or 0),
            "intensity": round(h.get("value") or 0, 3),
        }
        for h in ranked
    ]
    out.sort(key=lambda x: x["time"])
    return out


def build_signal_bundle(url: str) -> dict[str, Any]:
    """Fetch metadata + engagement signals into one dict (persisted to Video.youtube_meta)."""
    meta = fetch_metadata(url)
    meta["most_replayed"] = (
        most_replayed(meta.get("heatmap") or []) if settings.YOUTUBE_FETCH_HEATMAP else []
    )
    if settings.YOUTUBE_FETCH_COMMENTS:
        comments = fetch_comments(url)
        meta["mentioned_timestamps"] = mentioned_timestamps(comments)
    else:
        meta["mentioned_timestamps"] = []
    logger.info(
        "Signals for %s: heatmap=%d most_replayed=%d mentioned_ts=%d chapters=%d",
        meta.get("video_id"),
        len(meta.get("heatmap") or []),
        len(meta["most_replayed"]),
        len(meta["mentioned_timestamps"]),
        len(meta.get("chapters") or []),
    )
    return meta
