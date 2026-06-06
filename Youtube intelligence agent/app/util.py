"""Small shared helpers: timestamp formatting, URL parsing, filenames."""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse

_YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def extract_video_id(url: str) -> str | None:
    """Pull the 11-char video id from any YouTube URL form (watch, youtu.be,
    shorts, embed) or accept a bare id."""
    if not url:
        return None
    url = url.strip()
    if _YT_ID_RE.match(url):
        return url
    try:
        u = urlparse(url)
    except Exception:
        return None
    host = (u.hostname or "").lower().lstrip("www.")
    if host in ("youtu.be",):
        cand = u.path.lstrip("/").split("/")[0]
        return cand if _YT_ID_RE.match(cand) else None
    if "youtube" in host:
        if u.path == "/watch":
            v = parse_qs(u.query).get("v", [None])[0]
            return v if v and _YT_ID_RE.match(v) else None
        parts = [p for p in u.path.split("/") if p]
        if parts and parts[0] in ("shorts", "embed", "v", "live") and len(parts) > 1:
            return parts[1] if _YT_ID_RE.match(parts[1]) else None
    # last resort: regex hunt
    m = re.search(r"(?:v=|/shorts/|/embed/|youtu\.be/)([A-Za-z0-9_-]{11})", url)
    return m.group(1) if m else None


def is_short_url(url: str) -> bool:
    return "/shorts/" in (url or "")


def watch_url(video_id: str, t: float | int | None = None) -> str:
    base = f"https://www.youtube.com/watch?v={video_id}"
    if t is not None:
        base += f"&t={int(t)}s"
    return base


def fmt_timestamp(seconds: float | int | None) -> str:
    """Human timestamp: 75 -> '1:15', 3725 -> '1:02:05'."""
    if seconds is None:
        return "0:00"
    seconds = int(round(float(seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def srt_timestamp(seconds: float | int | None) -> str:
    """SRT format: HH:MM:SS,mmm"""
    seconds = max(0.0, float(seconds or 0))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    ms = int(round((s - int(s)) * 1000))
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{ms:03d}"


def parse_timestamp(value) -> float | None:
    """Parse '1:23', '01:02:03', '83', '1m23s', 83.5 -> seconds."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return None
    if ":" in s:
        parts = s.split(":")
        try:
            parts = [float(p) for p in parts]
        except ValueError:
            return None
        total = 0.0
        for p in parts:
            total = total * 60 + p
        return total
    m = re.match(r"^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$", s, re.IGNORECASE)
    if m and any(m.groups()):
        h, mi, se = (float(g) if g else 0.0 for g in m.groups())
        return h * 3600 + mi * 60 + se
    try:
        return float(s)
    except ValueError:
        return None


def safe_filename(name: str, max_len: int = 80) -> str:
    name = re.sub(r"[^\w\- .]", "_", name or "untitled").strip()
    name = re.sub(r"\s+", "_", name)
    return (name[:max_len] or "untitled").rstrip("._")


def extract_hashtags(*texts: str) -> list[str]:
    tags: list[str] = []
    seen = set()
    for t in texts:
        for m in re.findall(r"(?<!\w)#(\w{2,40})", t or ""):
            low = m.lower()
            if low not in seen:
                seen.add(low)
                tags.append("#" + m)
    return tags
