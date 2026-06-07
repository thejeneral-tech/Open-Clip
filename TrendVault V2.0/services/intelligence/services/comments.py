"""Fetch and analyze comments via yt-dlp (no API key). Also mines the
heatmap ('most replayed') and timestamp mentions from comment text."""
from __future__ import annotations

import re
from typing import Callable

from .. import config, llm, util

Logger = Callable[[str], None]
_TS_RE = re.compile(r"(?<!\d)(\d{1,2}:\d{2}(?::\d{2})?)(?!\d)")


def _noop(_: str) -> None:
    pass


# --- fetching ------------------------------------------------------------
def fetch_comments(video_id: str, url: str, max_comments: int | None = None,
                   log: Logger | None = None) -> dict:
    """Returns {comments, pinned, top, stats}. Never raises; returns empty on failure."""
    log = log or _noop
    max_comments = max_comments or config.MAX_COMMENTS
    from yt_dlp import YoutubeDL
    from ..ffmpeg_utils import ffmpeg_location_for_ytdlp

    opts = {
        "quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True,
        "getcomments": True,
        "extractor_args": {"youtube": {"comment_sort": ["top"], "max_comments": [str(max_comments)]}},
    }
    loc = ffmpeg_location_for_ytdlp()
    if loc:
        opts["ffmpeg_location"] = loc

    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:  # noqa: BLE001
        log(f"Comment fetch failed: {e}")
        return {"comments": [], "pinned": [], "top": [], "stats": {"available": False, "error": str(e)}}

    raw = (info or {}).get("comments") or []
    comments = [_normalize_comment(c) for c in raw]
    comments = [c for c in comments if c["text"]]

    pinned = [c for c in comments if c["is_pinned"]]
    top = sorted(comments, key=lambda c: c["likes"], reverse=True)[:15]
    log(f"Fetched {len(comments)} comments.")
    return {
        "comments": comments,
        "pinned": pinned,
        "top": top,
        "stats": {
            "available": True,
            "fetched": len(comments),
            "total_reported": (info or {}).get("comment_count"),
        },
    }


def _normalize_comment(c: dict) -> dict:
    return {
        "id": c.get("id"),
        "text": util_clean(c.get("text", "")),
        "author": c.get("author"),
        "likes": c.get("like_count") or 0,
        "is_pinned": bool(c.get("is_pinned")),
        "is_uploader": bool(c.get("author_is_uploader")),
        "is_reply": bool(c.get("parent") and c.get("parent") != "root"),
        "time_text": c.get("_time_text") or c.get("time_text"),
    }


def util_clean(text: str) -> str:
    return " ".join((text or "").split())


# --- deterministic mining -----------------------------------------------
def mentioned_timestamps(comments: list[dict], max_items: int = 25) -> list[dict]:
    counter: dict[int, int] = {}
    examples: dict[int, str] = {}
    likes: dict[int, int] = {}
    for c in comments:
        for m in _TS_RE.findall(c.get("text", "")):
            secs = util.parse_timestamp(m)
            if secs is None:
                continue
            key = int(secs)
            counter[key] = counter.get(key, 0) + 1
            likes[key] = likes.get(key, 0) + (c.get("likes") or 0)
            examples.setdefault(key, c.get("text", "")[:160])
    items = [
        {
            "time": k,
            "time_str": util.fmt_timestamp(k),
            "mentions": v,
            "comment_likes": likes.get(k, 0),
            "example": examples.get(k, ""),
        }
        for k, v in counter.items()
    ]
    items.sort(key=lambda x: (x["mentions"], x["comment_likes"]), reverse=True)
    return items[:max_items]


def most_replayed(heatmap: list[dict], top_n: int = 8) -> list[dict]:
    """Top moments from the YouTube heatmap (value is 0..1 replay intensity)."""
    if not heatmap:
        return []
    ranked = sorted(heatmap, key=lambda h: h.get("value", 0) or 0, reverse=True)[:top_n]
    out = []
    for h in ranked:
        start = h.get("start") or 0
        out.append({
            "time": int(start),
            "time_str": util.fmt_timestamp(start),
            "end_str": util.fmt_timestamp(h.get("end") or start),
            "intensity": round((h.get("value") or 0), 3),
        })
    out.sort(key=lambda x: x["time"])
    return out


# --- LLM insight analysis ------------------------------------------------
def analyze_comments(comments: list[dict], heatmap: list[dict], metadata: dict,
                     log: Logger | None = None) -> dict:
    log = log or _noop
    ts_mentions = mentioned_timestamps(comments)
    replayed = most_replayed(heatmap)

    insights: dict = {
        "available": bool(comments),
        "mentioned_timestamps": ts_mentions,
        "most_replayed": replayed,
    }
    if not comments:
        insights["summary"] = "No comments were available for this video."
        return insights

    top = sorted(comments, key=lambda c: c["likes"], reverse=True)[:60]
    pinned = [c for c in comments if c["is_pinned"]]
    comment_block = "\n".join(
        f"- ({c['likes']} likes{', PINNED' if c['is_pinned'] else ''}"
        f"{', by creator' if c['is_uploader'] else ''}) {c['text'][:300]}"
        for c in (pinned + top)[:60]
    )
    ts_hint = ", ".join(f"{t['time_str']} (x{t['mentions']})" for t in ts_mentions[:12]) or "none detected"

    prompt = f"""You are analyzing the YouTube comment section for the video "{metadata.get('title','')}".

Detected timestamp mentions in comments: {ts_hint}

Top / pinned comments:
{comment_block}

Analyze the audience reaction. Return a JSON object with exactly these keys:
{{
  "summary": "2-3 sentence summary of the overall audience reaction",
  "overall_sentiment": "positive | mixed | negative",
  "top_topics": [{{"topic": "short label", "detail": "what people say about it"}}],
  "questions": ["questions viewers are asking"],
  "funny_moments": ["moments people found funny (quote/paraphrase)"],
  "controversial": ["disagreements or controversial points"],
  "praise": ["what people praised"],
  "criticism": ["what people criticized"],
  "clip_requests": ["parts people explicitly want clipped or replayed"],
  "notable_timestamps": [{{"time_str": "M:SS", "why": "why this moment matters to viewers"}}]
}}
Use [] for empty categories. Base everything on the comments above."""

    try:
        log("Analyzing comment sentiment and themes with the reasoning model...")
        data = llm.generate_json(prompt, temperature=0.3, default={})
    except Exception as e:  # noqa: BLE001
        log(f"Comment analysis LLM call failed: {e}")
        data = {}

    if isinstance(data, dict):
        insights.update({k: v for k, v in data.items() if v is not None})
    insights.setdefault("summary", "Comment analysis unavailable.")
    return insights
