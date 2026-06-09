"""Partial / segment downloads from YouTube via yt-dlp.

``download_section`` uses yt-dlp's ``download_ranges`` so only the DASH fragments
overlapping the requested time window are fetched (a 30s slice of a 2-hour video
pulls a few MB, not the whole file). ``download_audio`` grabs the audio track
only, used as the no-captions fallback. Both reuse the format selector + error
translation from :mod:`app.services.youtube`.
"""
from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)


def _progress_hook(on_progress: Callable[[float], None] | None):
    def hook(d: dict[str, Any]) -> None:
        if not on_progress:
            return
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes", 0)
            if total:
                on_progress(max(0.0, min(0.99, done / total)))
        elif d.get("status") == "finished":
            on_progress(1.0)

    return hook


def _translate_error(exc: Exception) -> RuntimeError:
    msg = str(exc)
    if "is not available" in msg or "Requested format" in msg:
        return RuntimeError(
            "YouTube returned no downloadable formats — yt-dlp is likely out of "
            "date. Update it with: pip install -U yt-dlp"
        )
    if "ffmpeg" in msg.lower():
        return RuntimeError(
            "ffmpeg is required to merge YouTube's separate video/audio streams. "
            "Install ffmpeg and make sure it's on your PATH."
        )
    return RuntimeError(f"YouTube download failed: {msg}")


def download_section(
    url: str,
    start: float,
    end: float,
    dest_path: str,
    *,
    height_cap: int | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> dict[str, Any]:
    """Download only ``[start, end]`` of ``url`` to ``dest_path`` (mp4).

    yt-dlp fetches just the fragments overlapping the range. ``force_keyframes_at_cuts``
    re-encodes the boundary GOPs so the cut is frame-accurate; the actual segment
    may begin a hair before ``start`` (nearest keyframe), which the caller's pad
    absorbs (it stores ``source_offset = start``).
    """
    import yt_dlp

    height_cap = height_cap or settings.YOUTUBE_HEIGHT_CAP
    ydl_opts: dict[str, Any] = {
        "format": f"bv*[height<={height_cap}]+ba/bv*+ba/b",
        "outtmpl": dest_path,
        "merge_output_format": "mp4",
        "download_ranges": yt_dlp.utils.download_range_func(None, [(start, end)]),
        "force_keyframes_at_cuts": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "progress_hooks": [_progress_hook(on_progress)],
        "concurrent_fragment_downloads": 4,
    }
    if settings.YOUTUBE_COOKIES_FILE:
        ydl_opts["cookiefile"] = settings.YOUTUBE_COOKIES_FILE

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as exc:
        raise _translate_error(exc) from exc

    logger.info(
        "Downloaded segment [%.2f-%.2f] of %s -> %s",
        start, end, info.get("id"), dest_path,
    )
    return {
        "start": start,
        "end": end,
        "duration": end - start,
        "width": info.get("width"),
        "height": info.get("height"),
        "title": info.get("title"),
    }


def download_audio(
    url: str,
    out_template: str,
    *,
    on_progress: Callable[[float], None] | None = None,
) -> str:
    """Download the best audio-only stream. ``out_template`` should contain a
    ``%(ext)s`` placeholder (the real container ext isn't known up front).
    Returns the actual downloaded file path."""
    import yt_dlp

    ydl_opts: dict[str, Any] = {
        "format": "bestaudio/best",
        "outtmpl": out_template,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "progress_hooks": [_progress_hook(on_progress)],
    }
    if settings.YOUTUBE_COOKIES_FILE:
        ydl_opts["cookiefile"] = settings.YOUTUBE_COOKIES_FILE

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as exc:
        raise _translate_error(exc) from exc

    downloads = info.get("requested_downloads") or []
    if downloads and downloads[0].get("filepath"):
        return downloads[0]["filepath"]
    # Fallback: resolve the template ourselves.
    path = out_template.replace("%(ext)s", info.get("ext", "m4a"))
    if os.path.exists(path):
        return path
    raise RuntimeError("Audio download produced no output file.")
