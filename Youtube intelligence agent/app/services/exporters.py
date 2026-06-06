"""Build downloadable exports in multiple formats from a stored record."""
from __future__ import annotations

import csv
import io
import json

from .. import util
from . import outputs

FORMATS = ["json", "csv", "txt", "md", "srt", "timeline"]
_MEDIA = {
    "json": "application/json",
    "csv": "text/csv",
    "txt": "text/plain",
    "md": "text/markdown",
    "srt": "application/x-subrip",
    "timeline": "text/plain",
}


def export(record: dict, fmt: str) -> dict:
    fmt = (fmt or "json").lower()
    meta = record.get("metadata") or {}
    base = util.safe_filename(meta.get("title") or meta.get("video_id") or "video")
    builder = {
        "json": _json, "csv": _csv, "txt": _txt,
        "md": _markdown, "srt": _srt, "timeline": _timeline_notes,
    }.get(fmt, _json)
    content = builder(record)
    ext = "srt" if fmt == "srt" else ("md" if fmt in ("md", "timeline") else fmt)
    suffix = "_timeline" if fmt == "timeline" else ""
    return {
        "filename": f"{base}{suffix}.{ext}",
        "media_type": _MEDIA.get(fmt, "text/plain"),
        "content": content,
    }


def _json(record: dict) -> str:
    return json.dumps(record, ensure_ascii=False, indent=2, default=str)


def _csv(record: dict) -> str:
    buf = io.StringIO()
    clips = record.get("clips") or []
    if clips:
        cols = ["index", "start_str", "end_str", "duration", "viral_score", "platform",
                "title", "hook", "caption", "edit_style", "reason", "url"]
        w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for i, c in enumerate(clips, 1):
            w.writerow({"index": i, **c})
        return buf.getvalue()
    # fall back to comments
    comments = (record.get("comments") or {}).get("comments") or []
    w = csv.writer(buf)
    w.writerow(["author", "likes", "is_pinned", "is_uploader", "text"])
    for c in comments:
        w.writerow([c.get("author"), c.get("likes"), c.get("is_pinned"),
                    c.get("is_uploader"), c.get("text")])
    return buf.getvalue()


def _txt(record: dict) -> str:
    meta = record.get("metadata") or {}
    transcript = record.get("transcript") or {}
    head = f"{meta.get('title','')}\n{meta.get('url','')}\n\n"
    return head + (transcript.get("full_text") or "(no transcript)")


def _srt(record: dict) -> str:
    segs = (record.get("transcript") or {}).get("segments") or []
    return outputs.segments_to_srt(segs) if segs else "(no transcript)"


def _markdown(record: dict) -> str:
    meta = record.get("metadata") or {}
    comments = record.get("comments") or {}
    insights = comments.get("insights") or {}
    out = [f"# {meta.get('title','Video report')}", ""]
    out.append(f"- **URL:** {meta.get('url','')}")
    out.append(f"- **Channel:** {meta.get('channel','')}")
    out.append(f"- **Uploaded:** {meta.get('upload_date','')}")
    out.append(f"- **Duration:** {util.fmt_timestamp(meta.get('duration'))} "
               f"({'Short' if meta.get('is_short') else 'Long-form'})")
    out.append(f"- **Views:** {meta.get('view_count')} · **Likes:** {meta.get('like_count')}")
    if meta.get("hashtags"):
        out.append(f"- **Hashtags:** {' '.join(meta['hashtags'])}")
    out.append("")

    for o in record.get("outputs") or []:
        out.append(f"## {o.get('mode','output').title()} — _{o.get('prompt','')}_\n")
        out.append(o.get("content", ""))
        out.append("")

    clips = record.get("clips") or []
    if clips:
        out.append("## Clips\n")
        out.append(outputs.format_clips_markdown(clips))
        out.append("")

    if insights.get("summary"):
        out.append("## Comment insights\n")
        out.append(insights["summary"])
        for key, label in (("top_topics", "Top topics"), ("questions", "Questions"),
                           ("funny_moments", "Funny"), ("controversial", "Controversial"),
                           ("clip_requests", "Clip requests")):
            vals = insights.get(key) or []
            if vals:
                out.append(f"\n**{label}:**")
                for v in vals[:8]:
                    out.append(f"- {v.get('topic') if isinstance(v, dict) else v}")
        out.append("")

    markers = outputs.build_timeline(record)
    if markers:
        out.append("## Timeline\n")
        for m in markers:
            out.append(f"- **{m['time_str']}** ({m['type']}) {m['label']}")
    return "\n".join(out)


def _timeline_notes(record: dict) -> str:
    meta = record.get("metadata") or {}
    lines = [f"EDITING TIMELINE NOTES — {meta.get('title','')}",
             f"URL: {meta.get('url','')}",
             f"Duration: {util.fmt_timestamp(meta.get('duration'))}", "",
             "== MARKERS =="]
    for m in outputs.build_timeline(record):
        lines.append(f"{m['time_str']:>8}  [{m['type']}] {m['label']}")
    clips = record.get("clips") or []
    if clips:
        lines += ["", "== CLIP CANDIDATES =="]
        for i, c in enumerate(clips, 1):
            lines.append(f"{i}. {c['start_str']}-{c['end_str']} ({c.get('viral_score')}/100) "
                         f"{c.get('title','')}")
            if c.get("hook"):
                lines.append(f"     hook: {c['hook']}")
    return "\n".join(lines)
