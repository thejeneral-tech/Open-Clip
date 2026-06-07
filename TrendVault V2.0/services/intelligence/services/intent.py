"""Understand a plain-English task and map it to a concrete output mode +
parameters. LLM classification with a deterministic keyword fallback."""
from __future__ import annotations

import re

from .. import llm

# Canonical output modes (spec section 8).
MODES: dict[str, dict] = {
    "summary":             {"label": "Summary", "needs_frames": False, "needs_comments": False},
    "clips":               {"label": "Clip list", "needs_frames": True,  "needs_comments": True},
    "shorts_script":       {"label": "Shorts/TikTok script", "needs_frames": False, "needs_comments": True},
    "subtitles":           {"label": "Subtitle file (SRT)", "needs_frames": False, "needs_comments": False},
    "blog":                {"label": "Blog article", "needs_frames": False, "needs_comments": False},
    "tweet_thread":        {"label": "Tweet thread", "needs_frames": False, "needs_comments": False},
    "research_notes":      {"label": "Research notes", "needs_frames": False, "needs_comments": False},
    "content_ideas":       {"label": "Content ideas", "needs_frames": False, "needs_comments": True},
    "editing_instructions": {"label": "Editing instructions", "needs_frames": True, "needs_comments": False},
    "timeline":            {"label": "Timeline markers", "needs_frames": True, "needs_comments": True},
    "hooks":               {"label": "Hooks", "needs_frames": False, "needs_comments": True},
    "comment_timestamps":  {"label": "Comment-driven timestamps", "needs_frames": False, "needs_comments": True},
}
DEFAULT_MODE = "summary"
FILTERS = ("funny", "controversial", "useful", "emotional", "inspiring", "educational", "shocking")
PLATFORMS = ("tiktok", "shorts", "reels")


def _keyword_intent(prompt: str) -> dict:
    p = (prompt or "").lower()
    intent: dict = {
        "mode": None, "platform": None, "max_duration": None, "min_duration": None,
        "filter": None, "count": None, "focus": prompt.strip(),
    }

    # platform
    for plat in PLATFORMS:
        if plat in p or (plat == "shorts" and "short" in p):
            intent["platform"] = plat
            break
    if "reel" in p:
        intent["platform"] = "reels"

    # duration constraints
    m = re.search(r"(?:under|less than|below|<|max(?:imum)?)\s*(\d+)\s*(?:sec|s\b|seconds|second)", p)
    if m:
        intent["max_duration"] = int(m.group(1))
    m = re.search(r"(\d+)\s*(?:sec|seconds|second)s?\b", p)
    if m and intent["max_duration"] is None and ("under" in p or "below" in p or "less" in p):
        intent["max_duration"] = int(m.group(1))

    # count
    m = re.search(r"\b(\d{1,2})\s*(?:clips|shorts|moments|ideas|hooks|tweets)\b", p)
    if m:
        intent["count"] = int(m.group(1))

    # filter
    if "funny" in p or "funniest" in p or "hilarious" in p or "laugh" in p:
        intent["filter"] = "funny"
    elif "controvers" in p or "drama" in p or "heated" in p:
        intent["filter"] = "controversial"
    elif "emotional" in p or "touching" in p or "inspiring" in p:
        intent["filter"] = "emotional"
    elif "useful" in p or "valuable" in p or "actionable" in p:
        intent["filter"] = "useful"
    elif "shocking" in p or "surprising" in p or "wild" in p:
        intent["filter"] = "shocking"

    # mode
    def has(*words):
        return any(w in p for w in words)

    if has("subtitle", "srt", ".srt", "caption file"):
        intent["mode"] = "subtitles"
    elif has("blog", "article"):
        intent["mode"] = "blog"
    elif has("tweet", "thread", "twitter", " x thread"):
        intent["mode"] = "tweet_thread"
    elif has("script") or (intent["platform"] and has("script", "viral")):
        intent["mode"] = "shorts_script"
    elif has("hook"):
        intent["mode"] = "hooks"
    elif has("reaction", "outline", "idea", "repurpose"):
        intent["mode"] = "content_ideas"
    elif has("research", "notes", "takeaway", "key point", "extract", "useful information", "study"):
        intent["mode"] = "research_notes"
    elif has("edit", "editing", "cut list", "b-roll", "broll"):
        intent["mode"] = "editing_instructions"
    elif has("timeline", "markers", "chapter"):
        intent["mode"] = "timeline"
    elif has("timestamps", "commenting", "comments are about", "people talk about") and has("comment", "people"):
        intent["mode"] = "comment_timestamps"
    elif has("clip", "shorts", "short", "reel", "tiktok", "best moments", "best part", "highlight"):
        intent["mode"] = "clips"
    elif has("summary", "summarize", "summarise", "tldr", "tl;dr", "recap", "what is this about", "overview"):
        intent["mode"] = "summary"

    return intent


def parse_intent(prompt: str, metadata: dict | None = None, use_llm: bool = True) -> dict:
    base = _keyword_intent(prompt)

    llm_intent: dict = {}
    if use_llm and prompt and prompt.strip():
        mode_lines = "\n".join(f'  - "{k}": {v["label"]}' for k, v in MODES.items())
        sys = "You convert a user's request about a YouTube video into a structured task spec."
        ask = f"""User request: "{prompt}"
Video title: "{(metadata or {}).get('title','')}"

Choose the single best output mode from:
{mode_lines}

Return ONLY this JSON:
{{
  "mode": "<one mode key from the list>",
  "platform": "tiktok|shorts|reels|null",
  "max_duration": <seconds as int or null>,
  "min_duration": <seconds as int or null>,
  "filter": "funny|controversial|useful|emotional|inspiring|educational|shocking|null",
  "count": <int or null>,
  "focus": "<short phrase describing exactly what the user wants>"
}}"""
        try:
            data = llm.generate_json(ask, system=sys, temperature=0.1, default={})
            if isinstance(data, dict):
                llm_intent = data
        except Exception:
            llm_intent = {}

    # merge: LLM mode preferred if valid, else keyword, else default.
    mode = llm_intent.get("mode")
    if mode not in MODES:
        mode = base.get("mode") if base.get("mode") in MODES else None
    if mode not in MODES:
        mode = DEFAULT_MODE

    def pick(key, valid=None):
        v = llm_intent.get(key)
        if v in (None, "", "null"):
            v = base.get(key)
        if valid and v not in valid and v is not None:
            v = None
        return v

    platform = pick("platform", PLATFORMS + (None,))
    if mode == "clips" and not platform and base.get("filter") is None:
        platform = None  # let clip finder choose per-clip

    result = {
        "mode": mode,
        "platform": platform,
        "max_duration": _as_int(pick("max_duration")),
        "min_duration": _as_int(pick("min_duration")),
        "filter": pick("filter", FILTERS + (None,)),
        "count": _as_int(pick("count")),
        "focus": (llm_intent.get("focus") or base.get("focus") or prompt or "").strip(),
        "raw_prompt": prompt or "",
        "label": MODES[mode]["label"],
        "needs_frames": MODES[mode]["needs_frames"],
        "needs_comments": MODES[mode]["needs_comments"],
    }
    # sensible default duration cap for short-form platforms
    if mode in ("clips", "shorts_script") and result["max_duration"] is None and result["platform"]:
        result["max_duration"] = 60
    return result


def _as_int(v):
    try:
        if v in (None, "", "null"):
            return None
        return int(float(v))
    except (TypeError, ValueError):
        return None
