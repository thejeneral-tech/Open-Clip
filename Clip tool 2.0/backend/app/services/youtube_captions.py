"""Fetch YouTube captions without downloading the video.

Uses yt-dlp's ``writeautomaticsub`` / ``writesubtitles`` with ``json3`` output
(``skip_download=True``) and parses the events into the pipeline's transcript
segment shape. These are phrase-level (no per-word timing) — they drive the
detection LLM and the transcript view; accurate word timing for burned captions
comes from a short per-segment Whisper pass after the clip is downloaded.
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)


def _clean(text: str) -> str:
    return " ".join((text or "").split())


def _parse_json3(path: Path) -> list[dict[str, Any]]:
    """Parse a yt-dlp json3 caption file into [{id, start, end, text, words}]."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    segments: list[dict[str, Any]] = []
    for event in data.get("events", []):
        segs = event.get("segs")
        if not segs:
            continue
        text = _clean("".join(s.get("utf8", "") for s in segs))
        if not text or text in ("[Music]", "[Applause]"):
            continue
        start = round((event.get("tStartMs", 0) or 0) / 1000.0, 2)
        dur = round((event.get("dDurationMs", 0) or 0) / 1000.0, 2)
        segments.append(
            {
                "id": len(segments),
                "start": start,
                "end": round(start + dur, 2),
                "text": text,
                "speaker": None,
                "words": [],
            }
        )
    return segments


def fetch_captions(
    url: str, video_id: str | None, langs: list[str] | None = None
) -> dict[str, Any] | None:
    """Return ``{language, engine, segments, full_text}`` or None if unavailable."""
    import yt_dlp

    langs = langs or settings.YOUTUBE_CAPTION_LANGS
    # yt-dlp accepts language *patterns*; broaden "en" -> "en.*" so regional
    # variants (en-US, en-GB, auto en-orig) are picked up.
    lang_patterns = ["-live_chat"]
    for lang in langs:
        base = lang.split("-")[0]
        for pat in (lang, f"{base}.*", base):
            if pat not in lang_patterns:
                lang_patterns.append(pat)

    with tempfile.TemporaryDirectory(prefix="yt_caps_") as tmp:
        tmpdir = Path(tmp)
        opts: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitleslangs": lang_patterns,
            "subtitlesformat": "json3",
            "outtmpl": str(tmpdir / "%(id)s.%(ext)s"),
        }
        if settings.YOUTUBE_COOKIES_FILE:
            opts["cookiefile"] = settings.YOUTUBE_COOKIES_FILE
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])
        except Exception as exc:  # noqa: BLE001 — captions are best-effort
            logger.warning("Caption fetch failed: %s", exc)
            return None

        files = sorted(tmpdir.glob("*.json3"))
        if not files:
            return None
        # Prefer a manual track (no ".en-orig"/auto marker) when both exist.
        manual = [f for f in files if "orig" not in f.name]
        chosen = manual[0] if manual else files[0]
        is_auto = "orig" in chosen.name or len(manual) == 0
        segments = _parse_json3(chosen)

    if not segments:
        return None
    full_text = _clean(" ".join(s["text"] for s in segments))
    return {
        "language": "en",
        "engine": "youtube_captions_auto" if is_auto else "youtube_captions",
        "segments": segments,
        "full_text": full_text,
    }
