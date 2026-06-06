"""Generate the final deliverable for a parsed intent. Each output mode has a
generator; most are LLM-driven over a digest+signals context, a few
(subtitles, timeline, comment timestamps) are computed deterministically."""
from __future__ import annotations

from typing import Callable

from .. import database, llm, util
from . import clips as clips_service
from . import context

Logger = Callable[[str], None]


def _noop(_: str) -> None:
    pass


def generate_output(record: dict, intent: dict, log: Logger | None = None) -> dict:
    log = log or _noop
    mode = intent.get("mode", "summary")
    meta = record.get("metadata") or {}
    log(f"Generating output: {intent.get('label', mode)}")

    handler = _HANDLERS.get(mode, _summary)
    try:
        content, data = handler(record, intent, log)
    except llm.LLMError as e:
        content, data = f"Could not generate output (LLM error): {e}", {}
    return {
        "mode": mode,
        "label": intent.get("label", mode),
        "title": meta.get("title", ""),
        "content": content,
        "data": data or {},
    }


# --- context helpers -----------------------------------------------------
def _digest(record: dict, log: Logger) -> str:
    d = context.build_digest(record, log)
    if not d:
        return "(No transcript available — relying on metadata and comments only.)"
    return d


def _header(meta: dict) -> str:
    return (f"Video: {meta.get('title','')}\nChannel: {meta.get('channel','')}\n"
            f"Duration: {util.fmt_timestamp(meta.get('duration'))} | "
            f"{'Short' if meta.get('is_short') else 'Long-form'}")


# --- generators ----------------------------------------------------------
def _summary(record, intent, log):
    meta = record.get("metadata") or {}
    digest = _digest(record, log)
    signals = context.signals_block(record, max_chars=1200)
    prompt = f"""{_header(meta)}

Signals:
{signals}

Transcript digest:
{digest}

Write a clear, useful summary of this video as Markdown:
- **TL;DR:** one sentence.
- **Key points:** 5-9 bullets, each ending with a [m:ss] timestamp.
- **Who it's for / takeaway:** 1-2 sentences.
Base everything strictly on the content above."""
    return llm.generate(prompt, temperature=0.3), {}


def _blog(record, intent, log):
    meta = record.get("metadata") or {}
    digest = _digest(record, log)
    prompt = f"""{_header(meta)}

Transcript digest:
{digest}

Write a polished, original blog article (800-1200 words) based on this video.
Use Markdown: an H1 title, a short hook intro, 3-5 H2 sections, and a conclusion.
Write in a clear, engaging voice. Do not invent facts beyond the content."""
    return llm.generate(prompt, temperature=0.6), {}


def _tweet_thread(record, intent, log):
    meta = record.get("metadata") or {}
    digest = _digest(record, log)
    n = intent.get("count") or 9
    prompt = f"""{_header(meta)}

Transcript digest:
{digest}

Write an engaging X/Twitter thread of {n} tweets summarizing the most valuable
ideas from this video. Rules: tweet 1 is a strong hook; number each tweet
"n/{n}"; keep each under 280 characters; last tweet gives the key takeaway.
Return as a Markdown numbered list, one tweet per item."""
    content = llm.generate(prompt, temperature=0.6)
    return content, {}


def _research_notes(record, intent, log):
    meta = record.get("metadata") or {}
    digest = _digest(record, log)
    prompt = f"""{_header(meta)}

Transcript digest:
{digest}

Extract thorough research notes as Markdown:
- **Key claims & facts** (bullets, each with a [m:ss] timestamp)
- **Data / numbers mentioned**
- **Definitions & frameworks**
- **Notable quotes**
- **Open questions / things to verify**
Be specific and faithful to the source."""
    return llm.generate(prompt, temperature=0.2), {}


def _content_ideas(record, intent, log):
    meta = record.get("metadata") or {}
    digest = _digest(record, log)
    signals = context.signals_block(record, max_chars=1000)
    reaction = "reaction" in (intent.get("focus", "").lower())
    extra = ("\n- A beat-by-beat **reaction video outline** (what to react to, with [timestamps])."
             if reaction else "")
    prompt = f"""{_header(meta)}

Signals:
{signals}

Transcript digest:
{digest}

Generate repurposing ideas as Markdown:
- 5 short-form video **hooks/angles** (with the [m:ss] they come from)
- 5 alternative **video title** ideas
- 3 **thumbnail** concepts
- 3 cross-platform **repurposing** angles (blog, newsletter, carousel){extra}
Make them specific to this video's content."""
    return llm.generate(prompt, temperature=0.7), {}


def _hooks(record, intent, log):
    meta = record.get("metadata") or {}
    digest = _digest(record, log)
    n = intent.get("count") or 10
    prompt = f"""{_header(meta)}

Transcript digest:
{digest}

Write {n} scroll-stopping HOOK lines for short-form videos, each based on a real
moment in this video. Format each as a Markdown list item:
"**[m:ss]** — hook line". Make them punchy and curiosity-driven."""
    return llm.generate(prompt, temperature=0.8), {}


def _shorts_script(record, intent, log):
    meta = record.get("metadata") or {}
    platform = (intent.get("platform") or "shorts").title().replace("Tiktok", "TikTok")
    best = (record.get("clips") or [])
    if not best:
        best = clips_service.find_clips(record, {**intent, "count": 1}, log)
        if best:
            database.save_clips(meta.get("video_id"), (record.get("clips") or []) + best)
    section = best[0] if best else None

    if section:
        seg_text = _transcript_between(record, section["start"], section["end"])
        basis = (f"Base it on this moment ({section['start_str']}-{section['end_str']}):\n"
                 f"\"{seg_text}\"\nClip angle: {section.get('reason','')}")
    else:
        basis = "Transcript digest:\n" + _digest(record, log)

    prompt = f"""{_header(meta)}

{basis}

Write a complete {platform} short-form video script (target 30-60s). Use Markdown:
- **Hook (0-3s):** the exact opening line.
- **Script:** a table or beat list with columns Time | Voiceover | On-screen text.
- **Caption:** the post caption.
- **Hashtags:** 5-8 relevant hashtags.
- **CTA:** the closing call to action.
Make it punchy and platform-native."""
    content = llm.generate(prompt, temperature=0.75)
    return content, {"section": section}


def _editing_instructions(record, intent, log):
    meta = record.get("metadata") or {}
    digest = _digest(record, log)
    signals = context.signals_block(record, max_chars=1200)
    fh = context.frame_highlights(record.get("frames") or [], limit=15)
    prompt = f"""{_header(meta)}

Signals:
{signals}

Visual highlights (from frames):
{fh or '(no visual analysis available)'}

Transcript digest:
{digest}

Produce concrete editing instructions as Markdown:
- **Keep/cut list:** timestamp ranges to keep vs trim, with reasons.
- **Hook placement:** which moment to open on.
- **B-roll / cutaways:** suggestions at specific [timestamps].
- **On-screen text moments.**
- **Pacing & music** notes.
Be specific with timestamps."""
    return llm.generate(prompt, temperature=0.4), {}


def _clips_output(record, intent, log):
    meta = record.get("metadata") or {}
    clip_list = record.get("clips") or []
    if not clip_list:
        clip_list = clips_service.find_clips(record, intent, log)
        database.save_clips(meta.get("video_id"), clip_list)
    if not clip_list:
        return "No strong clip candidates were found for this video.", {"clips": []}
    return format_clips_markdown(clip_list), {"clips": clip_list}


def _timeline(record, intent, log):
    markers = build_timeline(record)
    if not markers:
        return "No timeline markers could be derived.", {"markers": []}
    lines = ["| Time | Type | Marker |", "| --- | --- | --- |"]
    for m in markers:
        lines.append(f"| {m['time_str']} | {m['type']} | {m['label']} |")
    return "\n".join(lines), {"markers": markers}


def _subtitles(record, intent, log):
    transcript = record.get("transcript") or {}
    segments = transcript.get("segments") or []
    if not segments:
        return "No transcript available to build subtitles.", {}
    start = end = None
    focus = (intent.get("focus") or "").lower()
    clip_list = record.get("clips") or []
    if clip_list and ("best" in focus or "section" in focus or intent.get("max_duration")):
        top = max(clip_list, key=lambda c: c.get("viral_score", 0))
        start, end = top["start"], top["end"]
        log(f"Building subtitles for best section {top['start_str']}-{top['end_str']}.")
    srt = segments_to_srt(segments, start, end)
    return srt, {"srt": srt, "range": [start, end]}


def _comment_timestamps(record, intent, log):
    insights = (record.get("comments") or {}).get("insights") or {}
    tsm = insights.get("mentioned_timestamps") or []
    replayed = insights.get("most_replayed") or []
    if not tsm and not replayed:
        return "No comment-mentioned timestamps or replay data were found.", {}
    rows = ["| Time | Mentions | What people say | Context |", "| --- | --- | --- | --- |"]
    data = []
    for t in tsm:
        ctx = _transcript_at(record, t["time"])
        rows.append(f"| [{t['time_str']}]({util.watch_url((record['metadata'] or {}).get('video_id'), t['time'])}) "
                    f"| {t['mentions']} | {t.get('example','')[:80]} | {ctx[:80]} |")
        data.append({**t, "context": ctx})
    md = "\n".join(rows)
    if replayed:
        md += "\n\n**Most replayed (YouTube heatmap):** " + ", ".join(r["time_str"] for r in replayed)
    return md, {"mentioned_timestamps": data, "most_replayed": replayed}


_HANDLERS = {
    "summary": _summary,
    "blog": _blog,
    "tweet_thread": _tweet_thread,
    "research_notes": _research_notes,
    "content_ideas": _content_ideas,
    "hooks": _hooks,
    "shorts_script": _shorts_script,
    "editing_instructions": _editing_instructions,
    "clips": _clips_output,
    "timeline": _timeline,
    "subtitles": _subtitles,
    "comment_timestamps": _comment_timestamps,
}


# --- shared formatting / deterministic builders -------------------------
def format_clips_markdown(clips: list[dict]) -> str:
    out = [f"## {len(clips)} clip candidate(s)\n"]
    for i, c in enumerate(clips, 1):
        out.append(
            f"### {i}. {c.get('title','Clip')}  \n"
            f"**{c['start_str']} – {c['end_str']}** ({c['duration']:.0f}s) · "
            f"Viral score **{c.get('viral_score',0)}/100** · {c.get('platform','')}\n\n"
            f"- **Why:** {c.get('reason','')}\n"
            f"- **Hook:** {c.get('hook','')}\n"
            f"- **Caption:** {c.get('caption','')}\n"
            f"- **Edit style:** {c.get('edit_style','')}\n"
            + (f"- **Watch:** {c['url']}\n" if c.get("url") else "")
        )
    return "\n".join(out)


def build_timeline(record: dict) -> list[dict]:
    meta = record.get("metadata") or {}
    insights = (record.get("comments") or {}).get("insights") or {}
    markers: list[dict] = []

    for c in meta.get("chapters") or []:
        markers.append(_marker(c.get("start"), "chapter", c.get("title", "Chapter")))
    for r in insights.get("most_replayed") or []:
        markers.append(_marker(r["time"], "replay", f"Most replayed (intensity {r.get('intensity')})"))
    for t in (insights.get("mentioned_timestamps") or [])[:12]:
        markers.append(_marker(t["time"], "comment", f"{t['mentions']} comments: {t.get('example','')[:60]}"))
    for cl in record.get("clips") or []:
        markers.append(_marker(cl["start"], "clip", f"Clip: {cl.get('title','')} ({cl.get('viral_score')}/100)"))
    scene_frames = [f for f in (record.get("frames") or []) if f.get("scene_change")]
    step = max(1, len(scene_frames) // 12) if scene_frames else 1
    for f in scene_frames[::step]:
        label = "Scene change"
        if f.get("vision"):
            label += f": {f['vision'].get('caption','')[:50]}"
        markers.append(_marker(f["timestamp"], "scene", label))

    markers = [m for m in markers if m["time"] is not None]
    markers.sort(key=lambda m: m["time"])
    return markers


def _marker(time, mtype, label) -> dict:
    return {"time": int(time) if time is not None else None,
            "time_str": util.fmt_timestamp(time), "type": mtype, "label": label}


def segments_to_srt(segments: list[dict], start: float | None = None, end: float | None = None) -> str:
    lines = []
    idx = 1
    for s in segments:
        s_start = s.get("start", 0.0)
        s_end = s_start + s.get("duration", 0.0)
        if start is not None and s_end < start:
            continue
        if end is not None and s_start > end:
            break
        a = max(s_start, start) if start is not None else s_start
        b = min(s_end, end) if end is not None else s_end
        if b <= a:
            b = a + 0.5
        lines.append(str(idx))
        lines.append(f"{util.srt_timestamp(a)} --> {util.srt_timestamp(b)}")
        lines.append(s.get("text", ""))
        lines.append("")
        idx += 1
    return "\n".join(lines)


def _transcript_between(record: dict, start: float, end: float) -> str:
    segs = (record.get("transcript") or {}).get("segments") or []
    text = " ".join(s["text"] for s in segs if start <= s.get("start", 0) <= end)
    return text[:1200]


def _transcript_at(record: dict, time: float, window: float = 8.0) -> str:
    segs = (record.get("transcript") or {}).get("segments") or []
    text = " ".join(s["text"] for s in segs if abs(s.get("start", 0) - time) <= window)
    return text[:160]
