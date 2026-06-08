"""AI task handlers — one per task type, registered in ``HANDLERS``.

Each handler:
  • reads the page/feature context from the request,
  • builds task-specific instructions (system + user prompts),
  • calls the resolved local model,
  • parses the model's text into the structured shape the UI expects,
  • raises ``AITaskError`` with a *user-facing* message on any failure.

Handlers never fabricate a low-quality "fix" silently: on an unreachable model
or empty/garbage output they raise a clear error and the caller preserves the
user's original content. This is the single place AI task logic lives — pages do
not build prompts or call the model directly.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable, Dict, List

from core.config import config
from lib import local_llm
from lib.prompts_lib import TONES, build_prompts
from services.script.script_service import parse_ai_json


class AITaskError(RuntimeError):
    """Carries a user-facing message explaining why an AI task could not finish."""


# ── LLM call wrapper ────────────────────────────────────────────────────────
def _friendly_llm_error(msg: str) -> str:
    low = msg.lower()
    if "unreachable" in low or "connect" in low or "timed out" in low or "timeout" in low:
        return (f"Local AI model is unreachable at {config.local_llm_url}. "
                f"Start your AI backend (e.g. run `ollama serve`), make sure the "
                f"selected model is pulled, then try again.")
    if "not found" in low or "404" in low or "no such model" in low:
        return ("The selected AI model is not installed on your local backend. "
                "Pull it (e.g. `ollama pull <model>`) or pick an installed model in "
                "Settings → AI Model, then try again.")
    if "out of memory" in low or "cuda" in low or " oom" in low:
        return ("The local AI model ran out of memory. Pick a smaller model in "
                "Settings → AI Model and try again.")
    if "empty response" in low:
        return "The local AI model returned an empty response — try again."
    return f"Local AI error: {msg[:200]}"


def _llm(model: str, system: str, user: str, *,
         max_tokens: int = 900, temperature: float = 0.85, top_p: float = 0.95) -> str:
    try:
        return local_llm.chat(user=user, system=system, model=model,
                              max_tokens=max_tokens, temperature=temperature, top_p=top_p)
    except RuntimeError as e:
        raise AITaskError(_friendly_llm_error(str(e))) from e


def _repair_json(s: str) -> str:
    """Best-effort fixes for the JSON slips small local models commonly make."""
    s = re.sub(r",\s*([}\]])", r"\1", s)                       # trailing commas
    # Key missing its opening quote: `, durationSeconds":` -> `, "durationSeconds":`
    s = re.sub(r'([{,]\s*)([A-Za-z_][\w]*)"\s*:', r'\1"\2":', s)
    # Key with no quotes at all: `, type:` -> `, "type":` (avoid matching URLs like http:)
    s = re.sub(r'([{,]\s*)([A-Za-z_][\w]*)\s*:(?=\s*["\[{\d-])', r'\1"\2":', s)
    return s


def _parse_json_lenient(text: str) -> Any:
    """Parse model output as JSON, repairing common breakage. Raises AITaskError."""
    try:
        return parse_ai_json(text)
    except Exception:  # noqa: BLE001 — fall through to repair attempts
        pass
    t = text or ""
    fo, lo = t.find("{"), t.rfind("}")
    if fo != -1 and lo > fo:
        block = t[fo:lo + 1]
        for cand in (_repair_json(block), block):
            try:
                return json.loads(cand)
            except Exception:  # noqa: BLE001
                continue
    raise AITaskError("The AI returned malformed output — please try again.")


def _llm_json(model: str, system: str, user: str, *,
              max_tokens: int = 900, temperature: float = 0.85, top_p: float = 0.95) -> Any:
    """Call the model and parse JSON, with one stricter retry on malformed output."""
    text = _llm(model, system, user, max_tokens=max_tokens,
                temperature=temperature, top_p=top_p)
    try:
        return _parse_json_lenient(text)
    except AITaskError:
        strict = user + (
            "\n\nIMPORTANT: your previous reply was not valid JSON. Return ONLY strictly "
            "valid JSON — every key and string value wrapped in double quotes, no trailing "
            "commas, no comments, no text before or after the JSON.")
        text2 = _llm(model, system, strict, max_tokens=max_tokens,
                     temperature=min(temperature, 0.5), top_p=top_p)
        return _parse_json_lenient(text2)


# ── Output coercion helpers ─────────────────────────────────────────────────
def _coerce_titled(items: Any) -> List[Dict[str, str]]:
    """Normalise a model list into ``[{"emoji","title"}]`` (accepts strings too)."""
    out: List[Dict[str, str]] = []
    for it in (items or []):
        if isinstance(it, dict):
            title = str(it.get("title") or it.get("name") or it.get("text") or "").strip()
            emoji = str(it.get("emoji") or "").strip() or "✦"
        else:
            title, emoji = str(it).strip(), "✦"
        if title:
            out.append({"emoji": emoji, "title": title})
    return out


_VALID_LINE_TYPES = {
    "hook", "setup", "observation", "example", "escalation",
    "truth", "twist", "takeaway", "ending", "cta", "body", "line",
}


def _coerce_lines(items: Any) -> List[Dict[str, Any]]:
    """Normalise a model list into ``[{"text","type","durationSeconds"}]``."""
    out: List[Dict[str, Any]] = []
    for it in (items or []):
        if isinstance(it, dict):
            text = str(it.get("text") or "").strip()
            typ = str(it.get("type") or "observation").strip().lower()
            if typ not in _VALID_LINE_TYPES:
                typ = "observation"
            try:
                dur = float(it.get("durationSeconds") or it.get("duration") or 5)
            except (TypeError, ValueError):
                dur = 5.0
            dur = max(2.0, min(15.0, dur))
        else:
            text, typ, dur = str(it).strip(), "observation", 5.0
        if text:
            out.append({"text": text, "type": typ, "durationSeconds": dur})
    return out


def _first(req: Dict[str, Any], *keys: str, default: str = "") -> str:
    for k in keys:
        v = req.get(k)
        if v is not None and str(v).strip():
            return str(v).strip()
    return default


# ── Handlers ────────────────────────────────────────────────────────────────
def _h_improve_prompt(req: Dict[str, Any], model: str) -> Dict[str, Any]:
    current = _first(req, "currentContent", "currentPrompt", "prompt", "selectedText", "userInput")
    if not current:
        raise AITaskError("Type a prompt first — there's nothing to improve.")
    niche = _first(req, "niche", "currentSign", "subject", default="general")
    tone = _first(req, "tone", default="mysterious")
    style = _first(req, "scriptStyle", "style")
    emotional = bool(req.get("emotionalTone"))
    tone_line = TONES.get(tone.lower(), "")

    system = (
        "You are a senior short-form video prompt engineer for the TrendVault studio. "
        "You take a creator's rough story prompt and rewrite it into a sharper, more "
        "specific creative brief for a ~90-second narrated video. You NEVER change the "
        "subject — you enrich it with a concrete angle, specific detail, and emotional "
        "framing. Keep it tight (1–3 sentences). No preamble, no markdown, no quotes."
    )
    user = f"""Improve this video story prompt.

NICHE: {niche}
TONE: {tone}{(' — ' + tone_line) if tone_line else ''}
EMOTIONAL DELIVERY: {"ON — lean into feeling and stakes" if emotional else "OFF — keep it clean and direct"}
{("STYLE: " + style) if style else ""}

CURRENT PROMPT:
\"\"\"{current}\"\"\"

Rewrite it so a video-script model produces a more specific, scroll-stopping video:
add a clear angle and concrete detail, but stay locked to the SAME subject. Do not
drift into unrelated topics (love, zodiac, generic motivation) unless the prompt asks.

Return ONLY valid JSON, no markdown:
{{"improvedPrompt": "the rewritten prompt", "addedDetails": "<=10 word summary of what you sharpened", "explanation": "one short sentence on why it's better"}}"""

    data = _llm_json(model, system, user, max_tokens=600, temperature=0.85)
    improved = str(data.get("improvedPrompt") or "").strip()
    if not improved:
        raise AITaskError("AI returned an empty improved prompt — try again.")
    return {"result": {
        "improvedPrompt": improved,
        "addedDetails": str(data.get("addedDetails") or "prompt sharpened").strip(),
        "explanation": str(data.get("explanation") or "").strip(),
        "emotionalToneApplied": emotional,
    }}


def _h_generate_categories(req: Dict[str, Any], model: str) -> Dict[str, Any]:
    niche = _first(req, "niche", "topic")
    if not niche:
        raise AITaskError("Pick a niche first.")
    system = ("You generate short, punchy content CATEGORIES for a faceless short-form "
              "video channel. Output is parsed as JSON by a UI.")
    user = f"""Niche: "{niche}".
Generate 10 distinct, scroll-worthy content categories a creator could make videos
about in this niche. Each category is 1–3 words plus one relevant emoji.

Return ONLY valid JSON, no markdown:
{{"categories": [{{"emoji": "🔥", "title": "Category Name"}}]}}"""
    cats = _coerce_titled(_llm_json(model, system, user, max_tokens=500,
                                    temperature=0.9).get("categories"))
    if not cats:
        raise AITaskError("AI returned no categories.")
    return {"result": {"categories": cats[:12]}}


def _h_generate_subjects(req: Dict[str, Any], model: str) -> Dict[str, Any]:
    niche = _first(req, "niche")
    if not niche:
        raise AITaskError("Pick a niche first.")
    category = _first(req, "category")
    scope = f'the niche "{niche}"' + (f' and category "{category}"' if category else "")
    system = "You brainstorm specific short-form video subjects. Output JSON only."
    user = f"""Generate 12 specific, clickable SUBJECT ideas for short-form videos in {scope}.
Each subject is a concrete topic phrase (3–8 words), not a full sentence.

Return ONLY valid JSON, no markdown:
{{"subjects": ["subject one", "subject two"]}}"""
    data = _llm_json(model, system, user, max_tokens=500, temperature=0.9)
    subs = [str(s).strip() for s in (data.get("subjects") or []) if str(s).strip()]
    if not subs:
        raise AITaskError("AI returned no subjects.")
    return {"result": {"subjects": subs[:15]}}


def _h_generate_trending_topics(req: Dict[str, Any], model: str) -> Dict[str, Any]:
    niche = _first(req, "niche")
    if not niche:
        raise AITaskError("Pick a niche first.")
    category = _first(req, "category")
    base = category or niche
    system = "You generate viral short-form video topic angles. Output JSON only."
    user = f"""Niche: "{niche}". Category: "{category or '(none)'}".
Generate 8 fresh, viral-feeling TOPIC angles a creator could film right now about {base}.
Each topic is a compelling title (4–9 words) with one emoji.

Return ONLY valid JSON, no markdown:
{{"topics": [{{"emoji": "🔥", "title": "Topic title"}}]}}"""
    topics = _coerce_titled(_llm_json(model, system, user, max_tokens=500,
                                      temperature=0.95).get("topics"))
    if not topics:
        raise AITaskError("AI returned no topics.")
    return {"result": {"topics": topics[:10]}}


def _h_generate_prompts(req: Dict[str, Any], model: str) -> Dict[str, Any]:
    niche = _first(req, "niche", "trendVaultSign", default="general")
    category = _first(req, "category")
    try:
        count = max(1, min(8, int(req.get("count") or 4)))
    except (TypeError, ValueError):
        count = 4
    raw_excl = (req.get("exclude") or req.get("excludedKeywords")
                or req.get("previousResults") or [])
    exclude = [str(x).strip() for x in raw_excl if str(x).strip()][:30]
    excl_block = "\n".join("- " + e for e in exclude) if exclude else "(none yet)"
    scope = f'the niche "{niche}"' + (f', category "{category}"' if category else "")
    system = ("You write short, scroll-stopping STORY PROMPTS for faceless short-form "
              "videos. Each prompt is a single vivid sentence a whole script could be "
              "built on. Output JSON only.")
    user = f"""Generate {count} fresh, distinct story prompts for {scope}.
Each prompt is ONE punchy sentence (8–16 words) teasing a specific, curiosity-driving idea.
Do NOT repeat or paraphrase any of these already-used prompts:
{excl_block}

Return ONLY valid JSON, no markdown:
{{"prompts": ["prompt one", "prompt two"]}}"""
    data = _llm_json(model, system, user, max_tokens=700, temperature=0.95)
    prompts = [str(p).strip() for p in (data.get("prompts") or []) if str(p).strip()]
    if not prompts:
        raise AITaskError("AI returned no prompts.")
    return {"result": {"prompts": prompts[:count]}}


def _h_extend_script(req: Dict[str, Any], model: str) -> Dict[str, Any]:
    existing = req.get("existingLines") or req.get("currentContent") or []
    if isinstance(existing, str):
        existing = [{"text": existing, "type": "line"}]
    try:
        add_count = max(1, min(8, int(req.get("addCount") or 4)))
    except (TypeError, ValueError):
        add_count = 4
    niche = _first(req, "niche", "trendVaultSign", default="general")
    prompt = _first(req, "prompt", "topic", "trendingTopic")
    tone = _first(req, "emotionalTone", "tone", default="mysterious")
    recent = existing[-12:] if isinstance(existing, list) else []
    existing_text = "\n".join(
        f'- ({(l.get("type") if isinstance(l, dict) else "line") or "line"}) '
        f'{(l.get("text") if isinstance(l, dict) else str(l)) or ""}'
        for l in recent
    )
    system = ("You continue an existing short-form video script. Match the voice, tone, "
              "and subject of the lines already written. Output JSON only.")
    user = f"""Subject / story prompt: "{prompt or niche}"
Niche: {niche}. Tone: {tone}.

Existing script lines (most recent last):
{existing_text or "(none yet)"}

Write {add_count} NEW lines that naturally continue this script toward a strong ending.
Each line is 1–2 short sentences (8–20 words). Stay locked to the SAME subject.
Valid types: hook, setup, observation, example, escalation, truth, twist, takeaway, ending.

Return ONLY valid JSON, no markdown:
{{"lines": [{{"text": "...", "type": "observation", "durationSeconds": 5}}]}}"""
    lines = _coerce_lines(_llm_json(model, system, user, max_tokens=900,
                                    temperature=0.9).get("lines"))
    if not lines:
        raise AITaskError("AI returned no new lines.")
    return {"result": {"lines": lines[:add_count]}}


def _h_regenerate_script(req: Dict[str, Any], model: str) -> Dict[str, Any]:
    niche = _first(req, "niche", "trendVaultSign", default="General")
    prompt = _first(req, "prompt")
    trending = _first(req, "trendingTopic")
    category = _first(req, "category")
    if not (prompt or trending or category):
        raise AITaskError("Nothing to reframe — set a prompt, topic, or category first.")
    try:
        target = int(req.get("targetDurationSec") or 90)
    except (TypeError, ValueError):
        target = 90
    params = {
        "niche": niche,
        "subject": _first(req, "subject"),
        "category": category or "general",
        "trendingTopic": trending,
        "prompt": prompt or trending or category or niche,
        "angle": _first(req, "angle"),
        "emotionalTone": _first(req, "emotionalTone", "tone", default="mysterious"),
        "targetDuration": target,
    }
    prompts = build_prompts(params)
    data = _llm_json(model, prompts["system"], prompts["user"], max_tokens=3500,
                     temperature=1.0, top_p=0.95)
    lines = _coerce_lines(data.get("lines"))
    if not lines:
        raise AITaskError("AI returned no script lines.")
    return {"result": {"lines": lines}}


HANDLERS: Dict[str, Callable[[Dict[str, Any], str], Dict[str, Any]]] = {
    "improve-prompt": _h_improve_prompt,
    "generate-categories": _h_generate_categories,
    "generate-subjects": _h_generate_subjects,
    "generate-trending-topics": _h_generate_trending_topics,
    "generate-prompts": _h_generate_prompts,
    "extend-script": _h_extend_script,
    "regenerate-script": _h_regenerate_script,
}
