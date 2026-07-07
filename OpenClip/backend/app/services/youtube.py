"""YouTube (and other yt-dlp supported sites) import."""
from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from app.core.logging import get_logger

logger = get_logger(__name__)


def _channel_url(ref: str) -> str | None:
    """Turn a channel reference into its ``/videos`` listing URL, or None.

    Accepts a full channel URL or an ``@handle``. A PLAIN NAME returns None (we
    won't guess a handle — a wrong guess would surface the wrong channel's videos
    with a big relevance bonus); the caller falls back to search + uploader boost.
    """
    ref = (ref or "").strip()
    if not ref:
        return None
    if ref.lower().startswith(("http://", "https://")):
        base = ref.split("?")[0].rstrip("/")
        return base if base.endswith("/videos") else base + "/videos"
    if ref.startswith("@"):
        return f"https://www.youtube.com/{ref}/videos"
    return None


def channel_videos(ref: str, limit: int = 15) -> list[dict[str, Any]]:
    """Return a channel's recent uploads for a URL or ``@handle`` (else []).

    Blocking (yt-dlp); call off the event loop. Same lightweight shape as
    :func:`search`. A plain channel name returns [] — resolve it via search instead.
    """
    url = _channel_url(ref)
    if not url:
        return []
    import yt_dlp

    limit = max(1, min(int(limit), 40))
    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "skip_download": True,
        "playlistend": limit,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # bad/unknown channel — degrade gracefully
        logger.warning("Channel fetch failed for %r: %s", ref, exc)
        return []

    info = info or {}  # yt-dlp can return None (not raise) for some flat extractions
    channel_title = info.get("channel") or info.get("uploader") or info.get("title")
    out: list[dict[str, Any]] = []
    for entry in info.get("entries") or []:
        if not entry:
            continue
        vid = entry.get("id")
        if not vid:
            continue
        out.append(
            {
                "id": vid,
                "url": entry.get("webpage_url") or f"https://www.youtube.com/watch?v={vid}",
                "title": entry.get("title") or "Untitled",
                "duration": entry.get("duration"),
                "uploader": entry.get("uploader") or entry.get("channel") or channel_title,
                "view_count": entry.get("view_count"),
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
            }
        )
        if len(out) >= limit:
            break
    return out


def search(query: str, limit: int = 10) -> list[dict[str, Any]]:
    """Search YouTube for ``query`` and return lightweight candidate metadata.

    Uses yt-dlp's ``ytsearch`` with ``extract_flat`` so it only pulls listing
    metadata (no per-video page fetch, no download) — a handful of results comes
    back in ~2s. Blocking; call it off the event loop (e.g. ``asyncio.to_thread``).
    """
    import yt_dlp

    limit = max(1, min(int(limit), 40))
    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "skip_download": True,
    }
    out: list[dict[str, Any]] = []
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    except Exception as exc:  # network hiccup / yt-dlp change — degrade gracefully
        logger.warning("YouTube search failed for %r: %s", query, exc)
        return out

    for entry in (info or {}).get("entries") or []:
        if not entry:
            continue
        vid = entry.get("id")
        if not vid:
            continue
        out.append(
            {
                "id": vid,
                "url": entry.get("webpage_url") or f"https://www.youtube.com/watch?v={vid}",
                "title": entry.get("title") or "Untitled",
                "duration": entry.get("duration"),
                "uploader": entry.get("uploader") or entry.get("channel"),
                "view_count": entry.get("view_count"),
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                # Channel identity (present on most flat search entries) — lets us
                # resolve a plain creator name to their actual channel.
                "channel": entry.get("channel") or entry.get("uploader"),
                "channel_id": entry.get("channel_id"),
                "channel_url": entry.get("channel_url") or entry.get("uploader_url"),
            }
        )
    return out


_NAME_RE = re.compile(r"[a-z0-9]+")


def resolve_channel(query: str) -> dict[str, Any] | None:
    """Resolve a creator reference to a concrete channel.

    Accepts a channel URL or ``@handle`` (returned as-is), or a **plain creator
    name** which is looked up on YouTube and matched to the channel that best
    fits the name across the top results. Returns ``{ref, name, channel_id}``
    where ``ref`` is a URL/@handle :func:`channel_videos` can pull uploads from,
    or ``None`` if nothing convincing was found. Blocking; call off the loop.
    """
    query = (query or "").strip()
    if not query:
        return None
    # Already a concrete reference — trust it.
    if query.lower().startswith(("http://", "https://")) or query.startswith("@"):
        return {"ref": query, "name": query.lstrip("@"), "channel_id": None}

    want = set(_NAME_RE.findall(query.lower()))
    if not want:
        return None

    # Look the name up and tally which channel the top results belong to.
    tally: dict[str, dict[str, Any]] = {}
    for r in search(query, 10):
        cid = r.get("channel_id")
        curl = r.get("channel_url")
        name = r.get("channel") or r.get("uploader")
        key = cid or curl or name
        if not key or not name:
            continue
        slot = tally.setdefault(key, {"name": name, "channel_id": cid, "url": curl, "count": 0})
        slot["count"] += 1

    if not tally:
        return None

    def _score(slot: dict[str, Any]) -> tuple[float, int]:
        got = set(_NAME_RE.findall((slot["name"] or "").lower()))
        # Fraction of the typed name found in the channel name, then how often
        # that channel showed up in the results.
        overlap = len(want & got) / len(want)
        return (overlap, slot["count"])

    best = max(tally.values(), key=_score)
    if _score(best)[0] < 0.5:               # no channel convincingly matches the name
        return None
    ref = best["url"] or (
        f"https://www.youtube.com/channel/{best['channel_id']}" if best["channel_id"] else None
    )
    if not ref:
        return None
    return {"ref": ref, "name": best["name"], "channel_id": best["channel_id"]}


def enrich(url: str) -> dict[str, Any] | None:
    """Full (non-flat) metadata extract for one video — no download.

    Returns the richer fields ``search``/``channel_videos`` can't (they use
    ``extract_flat``): ``upload_date`` (YYYYMMDD), ``like_count``,
    ``comment_count``, ``channel_follower_count``, ``description``, ``tags``,
    plus refreshed ``view_count``/``duration``/``title``/``uploader``. Blocking
    (fetches the watch page, ~5-10s); call off the event loop. ``None`` on failure.
    """
    import yt_dlp

    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        # We only need metadata — don't spend time probing every download format.
        "extract_flat": False,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # unavailable/private/geo-blocked — degrade gracefully
        logger.info("Video enrich failed for %r: %s", url, exc)
        return None

    info = info or {}
    vid = info.get("id")
    return {
        "id": vid,
        "url": info.get("webpage_url") or url,
        "title": info.get("title") or "Untitled",
        "duration": info.get("duration"),
        "uploader": info.get("uploader") or info.get("channel"),
        "view_count": info.get("view_count"),
        "like_count": info.get("like_count"),
        "comment_count": info.get("comment_count"),
        "channel_follower_count": info.get("channel_follower_count"),
        "upload_date": info.get("upload_date") or info.get("release_date"),
        "description": info.get("description"),
        "tags": info.get("tags") or [],
        "thumbnail": info.get("thumbnail")
        or (f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg" if vid else None),
        # A directly-fetchable English caption track (json3) if the video has one —
        # lets us read the transcript WITHOUT downloading the video (see
        # ``fetch_caption_text``). None when no English captions are published.
        "caption_url": _best_caption_url(info),
    }


def _best_caption_url(info: dict[str, Any]) -> str | None:
    """Pick a fetchable English caption track URL (prefers json3, manual > auto)."""
    subs = info.get("subtitles") or {}
    autos = info.get("automatic_captions") or {}

    def _pick(track: list[dict[str, Any]] | None) -> str | None:
        if not track:
            return None
        fmt = next((f for f in track if f.get("ext") == "json3"), None) or track[0]
        return fmt.get("url")

    for lang in ("en", "en-US", "en-GB", "en-orig"):
        for src in (subs, autos):
            picked = _pick(src.get(lang))
            if picked:
                return picked
    # Any English-ish variant (e.g. auto-translated "en").
    for src in (subs, autos):
        for key, track in src.items():
            if key.startswith("en"):
                picked = _pick(track)
                if picked:
                    return picked
    return None


def fetch_caption_text(caption_url: str, *, max_segments: int = 1200) -> dict[str, Any] | None:
    """Fetch + parse a YouTube json3 caption track into transcript text + segments.

    Returns ``{"text": str, "segments": [{"start": float, "text": str}]}`` or
    ``None``. Network-only (no video download); blocking — call off the loop.
    """
    import re

    import httpx

    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            resp = client.get(caption_url)
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:  # track expired / not json3 / network — degrade
        logger.info("Caption fetch failed: %s", exc)
        return None

    segments: list[dict[str, Any]] = []
    for event in data.get("events") or []:
        text = "".join(seg.get("utf8", "") for seg in (event.get("segs") or [])).strip()
        if not text:
            continue
        segments.append({"start": (event.get("tStartMs") or 0) / 1000.0, "text": text})
        if len(segments) >= max_segments:
            break
    if not segments:
        return None
    full = re.sub(r"\s+", " ", " ".join(s["text"] for s in segments)).strip()
    return {"text": full, "segments": segments}


def download(
    url: str,
    dest_path: str,
    *,
    on_progress: Callable[[float], None] | None = None,
) -> dict[str, Any]:
    """Download the best mp4 stream to ``dest_path``.

    Returns metadata: ``{title, duration, width, height, ext}``.
    """
    import yt_dlp

    def hook(d: dict[str, Any]) -> None:
        if on_progress and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes", 0)
            if total:
                on_progress(max(0.0, min(0.99, done / total)))
        elif on_progress and d.get("status") == "finished":
            on_progress(1.0)

    ydl_opts = {
        # Prefer a height-capped video+audio pair (any container — the result is
        # remuxed to mp4 via merge_output_format, which needs ffmpeg), falling back
        # to an uncapped pair, then any single best stream. We deliberately avoid
        # ext=mp4/m4a constraints: modern YouTube serves video/audio as separate
        # DASH streams, and the strict constraints make selection fail.
        #
        # Prefer H.264 (avc1): the smart-reframe subject tracker reads frames via
        # OpenCV (cv2.VideoCapture), whose ffmpeg build can't decode YouTube's AV1
        # streams ("Failed to get pixel format") — so an AV1 source yields zero
        # detections and every clip silently falls back to a static centre crop.
        # H.264 decodes everywhere; we keep AV1/VP9 only as a last-resort fallback.
        "format": (
            "bv*[vcodec^=avc1][height<=1440]+ba/"   # H.264 first (reframe-decodable)
            "bv*[height<=1440]+ba/bv*+ba/b"          # then any codec, so we never fail
        ),
        "format_sort": ["vcodec:h264"],              # rank H.264 ahead of AV1/VP9
        "outtmpl": dest_path,
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "progress_hooks": [hook],
        "concurrent_fragment_downloads": 4,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as exc:
        msg = str(exc)
        if "is not available" in msg or "Requested format" in msg:
            raise RuntimeError(
                "YouTube returned no downloadable video/audio formats — this almost "
                "always means yt-dlp is out of date (YouTube changes frequently break "
                "older versions). Update it with: pip install -U yt-dlp"
            ) from exc
        if "ffmpeg" in msg.lower():
            raise RuntimeError(
                "ffmpeg is required to merge YouTube's separate video/audio streams. "
                "Install ffmpeg and make sure it's on your PATH."
            ) from exc
        raise RuntimeError(f"YouTube download failed: {msg}") from exc

    return {
        "title": info.get("title"),
        "duration": info.get("duration"),
        "width": info.get("width"),
        "height": info.get("height"),
        "ext": info.get("ext", "mp4"),
        "uploader": info.get("uploader"),
    }
