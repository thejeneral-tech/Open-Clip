"""Shared helpers to turn a stored video record into compact LLM context:
merged transcript blocks, windows for chunked processing, a multi-signal
summary block, and a map-reduce digest for long videos."""
from __future__ import annotations

from typing import Callable

from .. import llm, util

Logger = Callable[[str], None]


def _noop(_: str) -> None:
    pass


# --- transcript shaping --------------------------------------------------
def merge_segments(segments: list[dict], block_seconds: float = 12.0, max_chars: int = 260) -> list[dict]:
    """Merge fine-grained caption segments into readable timestamped blocks."""
    blocks: list[dict] = []
    cur_start = None
    cur_text: list[str] = []
    cur_chars = 0
    for s in segments or []:
        if cur_start is None:
            cur_start = s.get("start", 0.0)
        cur_text.append(s.get("text", ""))
        cur_chars += len(s.get("text", ""))
        elapsed = (s.get("start", 0.0) + s.get("duration", 0.0)) - cur_start
        if elapsed >= block_seconds or cur_chars >= max_chars:
            blocks.append({"start": cur_start, "text": " ".join(cur_text).strip()})
            cur_start, cur_text, cur_chars = None, [], 0
    if cur_text:
        blocks.append({"start": cur_start or 0.0, "text": " ".join(cur_text).strip()})
    return [b for b in blocks if b["text"]]


def blocks_text(blocks: list[dict], seconds: bool = False) -> str:
    if seconds:
        return "\n".join(f"[{int(b['start'])}] {b['text']}" for b in blocks)
    return "\n".join(f"[{util.fmt_timestamp(b['start'])}] {b['text']}" for b in blocks)


def compact_transcript(segments: list[dict], max_chars: int = 6000, seconds: bool = False) -> str:
    blocks = merge_segments(segments)
    text = blocks_text(blocks, seconds=seconds)
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rsplit("\n", 1)[0] + "\n[... transcript truncated ...]"


def transcript_windows(segments: list[dict], max_chars: int = 5000) -> list[dict]:
    """Split the merged transcript into windows for chunked LLM processing."""
    blocks = merge_segments(segments)
    windows: list[dict] = []
    cur: list[dict] = []
    cur_chars = 0
    for b in blocks:
        cur.append(b)
        cur_chars += len(b["text"]) + 12
        if cur_chars >= max_chars:
            windows.append(_window(cur))
            cur, cur_chars = [], 0
    if cur:
        windows.append(_window(cur))
    return windows


def _window(blocks: list[dict]) -> dict:
    return {
        "start": blocks[0]["start"],
        "end": blocks[-1]["start"],
        "blocks": blocks,
    }


# --- multi-signal summary block -----------------------------------------
def signals_block(record: dict, max_chars: int = 2400) -> str:
    meta = record.get("metadata") or {}
    comments = record.get("comments") or {}
    insights = comments.get("insights") or {}
    frames = record.get("frames") or []

    lines: list[str] = []
    dur = util.fmt_timestamp(meta.get("duration"))
    lines.append(f"TITLE: {meta.get('title','')}")
    lines.append(f"CHANNEL: {meta.get('channel','')} | DURATION: {dur} | "
                 f"{'SHORT' if meta.get('is_short') else 'LONG-FORM'} | "
                 f"VIEWS: {meta.get('view_count')} | LIKES: {meta.get('like_count')}")
    if meta.get("description"):
        lines.append("DESCRIPTION: " + meta["description"][:400].replace("\n", " "))
    if meta.get("chapters"):
        chs = ", ".join(f"{util.fmt_timestamp(c['start'])} {c.get('title','')}" for c in meta["chapters"][:12])
        lines.append("CHAPTERS: " + chs)
    if meta.get("hashtags") or meta.get("tags"):
        lines.append("TAGS: " + ", ".join((meta.get("hashtags") or [])[:8] + (meta.get("tags") or [])[:10]))

    replayed = insights.get("most_replayed") or []
    if replayed:
        lines.append("MOST REPLAYED: " + ", ".join(f"{r['time_str']}" for r in replayed[:8]))
    tsm = insights.get("mentioned_timestamps") or []
    if tsm:
        lines.append("COMMENT-MENTIONED TIMES: " + ", ".join(f"{t['time_str']}(x{t['mentions']})" for t in tsm[:10]))
    if insights.get("summary"):
        lines.append("AUDIENCE REACTION: " + str(insights["summary"])[:300])
    for key, label in (("funny_moments", "FUNNY"), ("controversial", "CONTROVERSIAL"),
                       ("clip_requests", "CLIP REQUESTS"), ("questions", "QUESTIONS")):
        vals = insights.get(key) or []
        if vals:
            lines.append(f"{label}: " + " | ".join(str(v) for v in vals[:4]))

    vframes = [f for f in frames if f.get("vision")]
    if vframes:
        vis = []
        for f in vframes[:8]:
            v = f["vision"]
            txt = v.get("on_screen_text") or ""
            vis.append(f"{f['time_str']}: {v.get('caption','')}" + (f" [text: {txt[:40]}]" if txt else ""))
        lines.append("VISUAL HIGHLIGHTS: " + " || ".join(vis))

    block = "\n".join(lines)
    return block[:max_chars]


def frame_highlights(frames: list[dict], limit: int = 20) -> str:
    out = []
    for f in frames:
        v = f.get("vision")
        if not v:
            continue
        out.append(f"[{f['time_str']}] {v.get('caption','')}"
                   + (f" | text: {v.get('on_screen_text')}" if v.get("on_screen_text") else "")
                   + (f" | {v.get('scene_type')}" if v.get("scene_type") else ""))
        if len(out) >= limit:
            break
    return "\n".join(out)


# --- map-reduce digest for long videos ----------------------------------
def build_digest(record: dict, log: Logger | None = None, max_direct_chars: int = 6500) -> str:
    """A thorough timestamped digest of the whole video, used as substrate for
    summary/blog/notes/etc. Returns the raw transcript if it's short enough."""
    log = log or _noop
    segments = (record.get("transcript") or {}).get("segments") or []
    if not segments:
        return ""
    direct = compact_transcript(segments, max_chars=max_direct_chars)
    if "[... transcript truncated ...]" not in direct:
        return direct

    log("Transcript is long; building a map-reduce digest...")
    windows = transcript_windows(segments, max_chars=5000)
    title = (record.get("metadata") or {}).get("title", "")
    parts: list[str] = []
    for i, w in enumerate(windows):
        text = blocks_text(w["blocks"])
        prompt = (
            f"Video: \"{title}\". Condense this transcript section "
            f"({util.fmt_timestamp(w['start'])}-{util.fmt_timestamp(w['end'])}) into 3-6 "
            f"timestamped bullet points capturing the key points, claims, and notable moments. "
            f"Keep timestamps like [m:ss]. Be specific.\n\n{text}"
        )
        try:
            part = llm.generate(prompt, temperature=0.2)
            parts.append(part.strip())
            log(f"Digested section {i + 1}/{len(windows)}.")
        except Exception as e:  # noqa: BLE001
            log(f"Digest section {i + 1} failed: {e}")
    return "\n".join(parts)
