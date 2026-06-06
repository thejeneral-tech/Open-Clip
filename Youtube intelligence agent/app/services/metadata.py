"""Fetch video metadata via yt-dlp (no download, no API key)."""
from __future__ import annotations

from typing import Any

from yt_dlp import YoutubeDL

from .. import util
from ..ffmpeg_utils import ffmpeg_location_for_ytdlp


class MetadataError(RuntimeError):
    pass


def _base_opts() -> dict:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "ignoreerrors": False,
    }
    loc = ffmpeg_location_for_ytdlp()
    if loc:
        opts["ffmpeg_location"] = loc
    return opts


def _fmt_date(yyyymmdd: str | None) -> str | None:
    if yyyymmdd and len(yyyymmdd) == 8 and yyyymmdd.isdigit():
        return f"{yyyymmdd[0:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:8]}"
    return yyyymmdd


def _detect_short(url: str, info: dict) -> bool:
    if util.is_short_url(url) or util.is_short_url(info.get("webpage_url", "")):
        return True
    duration = info.get("duration") or 0
    aspect = info.get("aspect_ratio")
    if duration and duration <= 60:
        # vertical aspect ratio is a strong Short signal
        if aspect and aspect < 1:
            return True
        w, h = info.get("width"), info.get("height")
        if w and h and h > w:
            return True
    return False


def fetch_metadata(url: str) -> dict:
    """Return a normalized metadata dict. Raises MetadataError on failure."""
    try:
        with YoutubeDL(_base_opts()) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:  # yt_dlp.utils.DownloadError and friends
        raise MetadataError(_clean_ytdlp_error(e)) from e

    if not info:
        raise MetadataError("yt-dlp returned no information for this URL.")
    if info.get("_type") == "playlist" or "entries" in info:
        entries = info.get("entries") or []
        if not entries:
            raise MetadataError("This URL is a playlist with no entries.")
        info = entries[0]

    video_id = info.get("id")
    title = info.get("title") or ""
    description = info.get("description") or ""

    chapters = []
    for ch in info.get("chapters") or []:
        chapters.append({
            "title": ch.get("title"),
            "start": ch.get("start_time"),
            "end": ch.get("end_time"),
        })

    heatmap = []
    for h in info.get("heatmap") or []:
        heatmap.append({
            "start": h.get("start_time"),
            "end": h.get("end_time"),
            "value": h.get("value"),
        })

    tags = info.get("tags") or []
    hashtags = util.extract_hashtags(title, description)

    meta = {
        "video_id": video_id,
        "url": info.get("webpage_url") or url,
        "title": title,
        "description": description,
        "channel": info.get("channel") or info.get("uploader"),
        "channel_id": info.get("channel_id"),
        "channel_url": info.get("channel_url") or info.get("uploader_url"),
        "channel_followers": info.get("channel_follower_count"),
        "upload_date": _fmt_date(info.get("upload_date")),
        "duration": info.get("duration"),
        "duration_string": info.get("duration_string") or util.fmt_timestamp(info.get("duration")),
        "view_count": info.get("view_count"),
        "like_count": info.get("like_count"),
        "comment_count": info.get("comment_count"),
        "categories": info.get("categories") or [],
        "tags": tags,
        "hashtags": hashtags,
        "thumbnail": info.get("thumbnail"),
        "chapters": chapters,
        "heatmap": heatmap,
        "is_short": _detect_short(url, info),
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
        "available_caption_langs": sorted(list((info.get("subtitles") or {}).keys())),
    }
    return meta


def _clean_ytdlp_error(e: Exception) -> str:
    msg = str(e)
    msg = msg.replace("", "").strip()
    # strip ANSI-ish prefixes yt-dlp sometimes adds
    for prefix in ("ERROR: ", "WARNING: "):
        if msg.startswith(prefix):
            msg = msg[len(prefix):]
    if "Private video" in msg:
        return "This video is private."
    if "Video unavailable" in msg:
        return "This video is unavailable."
    if "members-only" in msg.lower():
        return "This is a members-only video."
    if "confirm your age" in msg.lower() or "age" in msg.lower() and "sign in" in msg.lower():
        return "This video is age-restricted and requires sign-in."
    return msg or "Failed to fetch metadata."
