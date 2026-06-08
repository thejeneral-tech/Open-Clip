"""YouTube (and other yt-dlp supported sites) import."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.core.logging import get_logger

logger = get_logger(__name__)


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
        "format": "bv*[height<=1440]+ba/bv*+ba/b",
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
