"""Script-generation prompt assembly — port of scripts/trend-vault-generate.ts.

Builds the Claude system+user prompts for a 90-second narration, plus the shared
helpers (seedable RNG, diversity dials, recent-hook anti-repetition, UPPERCASE
caption transform) used by both the AI path and the template fallback.
"""
from __future__ import annotations

import random
import time
from typing import Any, Callable, Dict, List, Tuple

from core.atomic_io import atomic_write_json, read_json
from core.constants import RECENT_HOOKS_FILE

TONES: Dict[str, str] = {
    "mysterious": "Create an atmosphere of mystery and psychological depth. Questions left unanswered. Truths revealed slowly.",
    "emotional": "Raw emotional honesty. Goes straight to the feeling. No metaphors — just reality.",
    "dark": "Dark psychology. The uncomfortable truths people know but never say out loud.",
    "reflective": "Meditative and introspective. Thoughtful pauses. Deep self-examination.",
    "dramatic": "High emotional stakes. Everything matters. Tension that builds.",
    "intimate": "Whispered truths. Close and personal. Feels like a private conversation.",
    "melancholic": "Beautiful sadness. Longing and loss. The ache of what was and what could have been.",
    "calm": "Steady and certain. Quiet authority. Truths delivered without performance.",
    "motivational": "Passionate, cinematic, and motivational. Slow narrator cadence. Hook → Observation → Energy Shift → Strength → Motivation → Deep Truth → Ending. Each sentence on its own line. Affirming, never fear-based. Honors patience, loyalty, discipline, resilience, timing, and growth.",
}

HOOK_STYLES: List[str] = [
    "a question that lands like an accusation",
    "a quiet statement that sounds like a memory",
    "a one-line scene (someone doing something specific)",
    "an indictment, no preamble",
    "a contradiction the viewer has felt but never named",
    "a direct address that doesn't feel preachy",
    "something a friend would whisper at 2am",
    "a single image — concrete, specific",
    "a stat or number that reframes everything",
    'a "what if" that sounds dangerous',
]

ENDING_STYLES: List[str] = [
    "a line they could screenshot and use as a reminder",
    "a hushed, almost-spoken affirmation",
    "a single sentence that flips the whole video",
    "an open-ended question you keep thinking about",
    "a quiet truth, delivered without performance",
    "a call to action disguised as an observation",
]

ANGLE_POOL: List[str] = [
    "hidden truth", "common mistake", "dark side", "beginner trap", "expert secret",
    "unexpected contradiction", "storytime warning", "myth vs reality",
    "psychology breakdown", "things nobody tells you", "before you try this",
    "why people fail at this", "the expensive lesson", "the uncomfortable truth",
    "what actually works", "what they don't show you", "the question nobody asks",
    "the real reason why",
]

RECENT_HOOKS_KEEP = 30


def make_rng(seed: int | None = None) -> Callable[[], float]:
    """Mulberry32 seedable PRNG (port). Returns a 0..1 float generator."""
    if seed is None:
        seed = (int(time.time() * 1000) ^ random.randint(0, 999999999))
    state = {"a": seed & 0xFFFFFFFF}

    def rnd() -> float:
        a = (state["a"] + 0x6D2B79F5) & 0xFFFFFFFF
        state["a"] = a
        t = a
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        inner = ((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF
        t = (((t + inner) & 0xFFFFFFFF) ^ t) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return rnd


def pick(items: List[Any], rnd: Callable[[], float]) -> Any:
    return items[int(rnd() * len(items))]


def read_recent_hooks() -> List[str]:
    return read_json(RECENT_HOOKS_FILE, []) or []


def append_recent_hook(hook: str) -> None:
    if not hook:
        return
    cur = read_recent_hooks()
    cur.insert(0, hook.strip())
    try:
        atomic_write_json(RECENT_HOOKS_FILE, cur[:RECENT_HOOKS_KEEP])
    except Exception:
        pass


def uppercase_script_lines(script: Dict[str, Any]) -> Dict[str, Any]:
    """UPPERCASE caption text (TikTok storycore). TTS still gets mixed-case text."""
    out = dict(script)
    out["hook"] = (script.get("hook") or "").upper()
    out["title"] = script.get("title")
    out["lines"] = [{**l, "text": (l.get("text") or "").upper()} for l in (script.get("lines") or [])]
    return out


def build_prompts(params: Dict[str, Any]) -> Dict[str, str]:
    """Return {system, user, finalSubject} for the Claude call."""
    niche = params.get("niche", "")
    subject = params.get("subject", "") or ""
    category = params.get("category", "") or ""
    trending = params.get("trendingTopic", "") or ""
    prompt = params.get("prompt", "") or ""
    angle = params.get("angle", "") or ""
    tone = params.get("emotionalTone", "mysterious") or "mysterious"

    tone_instruction = TONES.get(tone, TONES["mysterious"])
    line_range, word_min, word_max = "18–24", 200, 230

    rng = make_rng((int(time.time() * 1000) ^ random.randint(0, 999999999)) & 0xFFFFFFFF)
    hook_style = pick(HOOK_STYLES, rng)
    ending_style = pick(ENDING_STYLES, rng)
    recent_hooks = read_recent_hooks()

    final_subject = (
        prompt.strip() if prompt and prompt.strip()
        else trending.strip() if trending and trending.strip()
        else category.strip() if category and category.strip()
        else niche.strip()
    )
    creative_angle = params.get("randomAngle") or pick(ANGLE_POOL, rng)
    seed_tag = params.get("randomSeed") or f"{int(time.time() * 1000)}-{random.random():.10f}"

    if recent_hooks:
        recent_block = "\n".join('  • "' + h.replace('"', '\\"') + '"' for h in recent_hooks)
    else:
        recent_block = "  (none yet)"

    system_prompt = f"""You are generating a 1 minute 30 second short-form video narration script for Trend Vault.

Your scripts work for ANY niche: travel, crime, finance, fitness, psychology, food, history, relationships, tech, gaming, beauty, health, business — anything.
The subject is locked to the Story Prompt. You must write about that subject only.
You NEVER drift into relationships, love, heartbreak, zodiac signs, or generic emotional pain unless the Story Prompt explicitly asks for it.

TONE FOR THIS SCRIPT: {tone_instruction}
The tone controls MOOD and DELIVERY only — not the subject. A "Mysterious" tone on budget travel still produces a script about budget travel.

SCRIPT ARC (must follow this order):
1. HOOK (1 line, 2–3 sec) — One punchy sentence. Stops the scroll. Names the contradiction or truth.
2. SETUP (1–2 lines) — Establish the world. Specific context about this niche/topic.
3. OBSERVATION (3–4 lines) — Real, specific details. Not generic self-help.
4. EXAMPLE (2–3 lines) — Concrete example or scenario from within the niche.
5. ESCALATION (2–3 lines) — Second layer of truth. Raise the stakes.
6. TRUTH (3–4 lines) — The core reframe. Surprising but immediately recognized.
7. TWIST (2–3 lines) — Changes how the viewer sees everything just said.
8. TAKEAWAY (1–2 lines) — The practical or psychological takeaway.
9. ENDING (1–2 lines) — Unforgettable final line(s). The kind people screenshot.

HARD RULES:
- Write EXACTLY {line_range} lines total.
- Write between {word_min} and {word_max} words total.
- Each line is 1–2 short sentences (8–20 words per line).
- Total duration must be 85–95 seconds.
- Do NOT write a 30 second or 55 second script.
- Vary sentence rhythm — short lines hit hard, medium lines build tension.
- Be specific to the actual niche and topic. Avoid vague filler.
- Never explain the insight — state it.

ANTI-REPETITION:
- Do NOT open with any of these recently used hooks:
{recent_block}

DIVERSITY DIALS (honor these exactly):
- HOOK STYLE: {hook_style}
- CREATIVE ANGLE: {creative_angle}
- ENDING STYLE: {ending_style}"""

    user_prompt = f"""Generate a 1:30 short-form video script using this exact context:

NICHE: {niche}
CATEGORY: {category}{(chr(10) + 'TRENDING TOPIC: ' + trending) if trending else ''}{(chr(10) + 'SUBJECT: ' + subject) if subject else ''}
STORY PROMPT (PRIMARY — this is what the script must be about): {prompt}{(chr(10) + 'ADDITIONAL ANGLE: ' + angle) if angle else ''}
EMOTIONAL TONE: {tone}
CREATIVE ANGLE: {creative_angle}

FINAL SUBJECT LOCK: "{final_subject}"
You must stay locked to this subject for the entire script.
Do NOT write about love, relationships, heartbreak, zodiac, or generic motivation unless the Story Prompt explicitly asks for it.

LENGTH REQUIREMENT:
- 18 to 24 lines total
- 200 to 230 words total
- 85 to 95 seconds total duration
- Do NOT write a short 30s or 55s script

Random seed: {seed_tag} — use this to create a completely fresh angle, hook, structure, examples, and wording. Do not reuse any lines from previous scripts.

Return ONLY valid JSON, no markdown, no extra text:
{{
  "title": "Short memorable title about the actual topic",
  "hook": "The exact opening line",
  "estimatedWords": 215,
  "totalDuration": 90,
  "lines": [
    {{"text": "...", "type": "hook", "durationSeconds": 3}},
    {{"text": "...", "type": "setup", "durationSeconds": 4}},
    {{"text": "...", "type": "observation", "durationSeconds": 5}}
  ]
}}

Write all {line_range} lines. Hit {word_min}–{word_max} words. Make every line specific to "{final_subject}"."""

    return {"system": system_prompt, "user": user_prompt, "finalSubject": final_subject}
