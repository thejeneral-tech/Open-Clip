"""Clip finder. Scans the transcript in windows, asks the reasoning model for
standalone clip candidates with viral scoring, then validates/dedupes/ranks.
Falls back to engagement signals (heatmap + comment mentions) with no transcript."""
from __future__ import annotations

from typing import Callable

from .. import llm, util
from . import context

Logger = Callable[[str], None]
MAX_WINDOWS = 14
HARD_MAX_CLIP_SECONDS = 180


def _noop(_: str) -> None:
    pass


def find_clips(record: dict, intent: dict | None = None, log: Logger | None = None,
               max_windows: int | None = None, include_signals: bool = False) -> list[dict]:
    log = log or _noop
    intent = intent or {}
    meta = record.get("metadata") or {}
    duration = meta.get("duration") or 0
    segments = (record.get("transcript") or {}).get("segments") or []

    if not segments:
        log("No transcript available; building clips from engagement signals.")
        return _clips_from_signals(record, intent)

    cap = max_windows or MAX_WINDOWS
    windows = context.transcript_windows(segments, max_chars=4800)
    if len(windows) > cap:
        step = len(windows) / cap
        sampled = [windows[int(i * step)] for i in range(cap)]
        log(f"Long video: scanning {cap} of {len(windows)} transcript windows (evenly sampled).")
        windows = sampled

    signals = context.signals_block(record, max_chars=1400)
    constraints = _constraint_text(intent)
    title = meta.get("title", "")

    candidates: list[dict] = []
    for i, w in enumerate(windows):
        log(f"Scanning window {i + 1}/{len(windows)} for clips...")
        text = context.blocks_text(w["blocks"], seconds=True)
        prompt = f"""You are an expert short-form video editor finding viral clips from "{title}".

Context signals:
{signals}

{constraints}
Transcript section (each line is "[seconds] text"):
{text}

Find the 1-4 STRONGEST standalone clip moments in THIS section. Return ONLY JSON:
{{"clips":[{{
  "start": <int seconds, from the [seconds] markers>,
  "end": <int seconds>,
  "title": "punchy clip title",
  "reason": "why this is interesting/clippable",
  "viral_score": <integer 0-100>,
  "hook": "scroll-stopping opening line",
  "caption": "suggested on-screen caption / subtitle",
  "platform": "TikTok|Shorts|Reels",
  "edit_style": "suggested edit style (e.g. fast cuts + captions)"
}}]}}
If nothing is strong, return {{"clips":[]}}. Use exact timestamps from the markers."""
        try:
            data = llm.generate_json(prompt, temperature=0.4, default={"clips": []})
        except Exception as e:  # noqa: BLE001
            log(f"Window {i + 1} clip scan failed: {e}")
            continue
        for c in (data or {}).get("clips", []) if isinstance(data, dict) else []:
            try:
                clip = _normalize_clip(c, duration, intent, meta)
            except Exception:  # noqa: BLE001 - a malformed clip must not abort the scan
                clip = None
            if clip:
                candidates.append(clip)

    # Optionally supplement with engagement-signal clips (heatmap / comment
    # timestamps). Keeps multi-video runs productive even when LLM scanning is
    # sparse or flaky, and surfaces "most replayed" moments the model missed.
    if include_signals:
        candidates += _signal_candidates(record, intent)

    ranked = _rank_and_dedupe(candidates, intent)
    log(f"Found {len(ranked)} clip candidates.")
    return ranked


def _constraint_text(intent: dict) -> str:
    parts = []
    if intent.get("platform"):
        parts.append(f"Target platform: {intent['platform'].title()}.")
    if intent.get("filter"):
        parts.append(f"Focus on {intent['filter']} moments specifically.")
    if intent.get("max_duration"):
        parts.append(f"Each clip MUST be under {intent['max_duration']} seconds.")
    if intent.get("min_duration"):
        parts.append(f"Each clip should be at least {intent['min_duration']} seconds.")
    if intent.get("focus"):
        parts.append(f"User goal: {intent['focus']}.")
    return ("Constraints: " + " ".join(parts) + "\n") if parts else ""


def _clean_str(v, default: str = "") -> str:
    """Coerce an LLM field to a clean string. Small/flaky models sometimes return
    a list (or number) where a string is expected; never let that crash a whole
    video's clip scan."""
    if v is None:
        return default
    if isinstance(v, (list, tuple)):
        v = " ".join(str(x) for x in v)
    return str(v).strip()


def _normalize_clip(c: dict, duration: float, intent: dict, meta: dict) -> dict | None:
    if not isinstance(c, dict):
        return None
    start = util.parse_timestamp(c.get("start"))
    end = util.parse_timestamp(c.get("end"))
    if start is None:
        return None
    if end is None or end <= start:
        end = start + (intent.get("max_duration") or 30)
    # clamp to video bounds
    if duration:
        start = max(0.0, min(start, duration - 1))
        end = max(start + 1, min(end, duration))
    # enforce max duration
    cap = intent.get("max_duration") or HARD_MAX_CLIP_SECONDS
    if end - start > cap:
        end = start + cap
    if intent.get("min_duration") and (end - start) < intent["min_duration"]:
        end = start + intent["min_duration"]
    score = c.get("viral_score")
    try:
        score = int(float(score))
    except (TypeError, ValueError):
        score = 50
    score = max(0, min(100, score))
    platform = (c.get("platform") or intent.get("platform") or "Shorts")
    platform = str(platform).title().replace("Tiktok", "TikTok")
    vid = meta.get("video_id")
    return {
        "start": round(start, 1),
        "end": round(end, 1),
        "start_str": util.fmt_timestamp(start),
        "end_str": util.fmt_timestamp(end),
        "duration": round(end - start, 1),
        "title": (_clean_str(c.get("title")) or "Untitled clip")[:120],
        "reason": _clean_str(c.get("reason"))[:500],
        "viral_score": score,
        "hook": _clean_str(c.get("hook"))[:200],
        "caption": _clean_str(c.get("caption"))[:200],
        "platform": platform,
        "edit_style": _clean_str(c.get("edit_style"))[:200],
        "url": util.watch_url(vid, int(start)) if vid else None,
    }


def _overlap(a: dict, b: dict) -> float:
    inter = max(0.0, min(a["end"], b["end"]) - max(a["start"], b["start"]))
    shorter = max(1.0, min(a["duration"], b["duration"]))
    return inter / shorter


def _rank_and_dedupe(candidates: list[dict], intent: dict) -> list[dict]:
    candidates.sort(key=lambda c: c["viral_score"], reverse=True)
    kept: list[dict] = []
    for c in candidates:
        if any(_overlap(c, k) > 0.5 for k in kept):
            continue
        kept.append(c)
    count = intent.get("count") or 10
    return kept[:count]


# --- engagement-signal clips (used as fallback AND as a supplement) ------
def _signal_candidates(record: dict, intent: dict) -> list[dict]:
    """Raw clip candidates derived from the YouTube heatmap and comment-mentioned
    timestamps (no LLM). Returned unranked so callers can merge/dedupe."""
    meta = record.get("metadata") or {}
    insights = (record.get("comments") or {}).get("insights") or {}
    duration = meta.get("duration") or 0
    span = intent.get("max_duration") or 45
    vid = meta.get("video_id")
    out: list[dict] = []

    for r in (insights.get("most_replayed") or []):
        center = r["time"]
        out.append(_signal_clip(center, span, duration, vid,
                                title="Most replayed moment",
                                reason=f"YouTube heatmap shows high replay intensity ({r.get('intensity')}).",
                                score=int(60 + 35 * (r.get("intensity") or 0))))
    for t in (insights.get("mentioned_timestamps") or [])[:6]:
        out.append(_signal_clip(t["time"], span, duration, vid,
                                title="Audience-requested moment",
                                reason=f"Mentioned in {t['mentions']} comments: \"{t.get('example','')[:80]}\"",
                                score=min(95, 55 + t["mentions"] * 3)))
    return out


def _clips_from_signals(record: dict, intent: dict) -> list[dict]:
    return _rank_and_dedupe(_signal_candidates(record, intent), intent)


def _signal_clip(center: float, span: float, duration: float, vid, title, reason, score) -> dict:
    start = max(0.0, center - span / 2)
    end = start + span
    if duration:
        end = min(end, duration)
    return {
        "start": round(start, 1), "end": round(end, 1),
        "start_str": util.fmt_timestamp(start), "end_str": util.fmt_timestamp(end),
        "duration": round(end - start, 1),
        "title": title, "reason": reason, "viral_score": max(0, min(100, score)),
        "hook": "", "caption": "", "platform": "Shorts",
        "edit_style": "Trim to the key moment, add captions",
        "url": util.watch_url(vid, int(start)) if vid else None,
    }
