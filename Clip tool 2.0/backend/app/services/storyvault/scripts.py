"""Story → narration-script generation.

Two engines, mirroring StoryVault's graceful degradation:

* **ai** — rewrite via the local Ollama model (first-person, hook-led,
  duration-budgeted),
* **heuristic** — no-LLM fallback: pick a hook sentence, trim the story to the
  word budget at sentence boundaries, close with a question.

``engine="auto"`` tries the model and silently falls back.
"""
from __future__ import annotations

import re

from app.core.logging import get_logger
from app.services.ollama_client import OllamaError, ollama, strip_reasoning

logger = get_logger(__name__)

WORDS_PER_SECOND = 2.45  # natural TTS narration pace at 1.0 speed

_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")
_DRAMA = re.compile(
    r"\b(furious|screamed|shocked|caught|cheated|betray\w*|revenge|secret|"
    r"lied?|divorce|fired|terrified|insane|crazy|never|worst|refuse[ds]?)\b",
    re.IGNORECASE,
)

_HOOK_HINTS = {
    "conflict": "Open with the central conflict stated bluntly.",
    "craziest": "Open with the single craziest sentence from the story.",
    "question": "Open with a provocative question the story answers.",
    "quote": "Open with a short dramatic line of dialogue from the story.",
    "reveal": "Open by hinting at the ending without spoiling it.",
    "calm": "Open calmly and let the tension build naturally.",
    "suspense": "Open with an ominous detail that hints something is wrong.",
    "funny": "Open with the funniest, most absurd detail.",
}

_STYLE_HINTS = {
    "calm": "calm, measured storyteller",
    "dramatic": "dramatic, emotionally charged narrator",
    "suspenseful": "slow-burning, suspenseful narrator",
    "funny": "playful narrator with comedic timing",
    "serious": "serious, matter-of-fact narrator",
    "confessional": "intimate, confessional first-person voice",
    "documentary": "neutral documentary narrator",
}


def word_budget(duration_target: int, speed: float = 1.0) -> int:
    return max(40, int(duration_target * WORDS_PER_SECOND * max(0.7, min(1.4, speed))))


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENT_SPLIT.split(text) if s.strip()]


# ----------------------------------------------------------------- heuristic
def heuristic_script(
    title: str,
    body: str,
    *,
    duration_target: int = 60,
    hook_style: str = "conflict",
    speed: float = 1.0,
) -> dict[str, str]:
    budget = word_budget(duration_target, speed)
    sents = _sentences(body)
    if not sents:
        sents = [title]

    # Hook: a question/dramatic sentence from the opening, else the title.
    hook = ""
    for s in sents[:6]:
        if hook_style == "question" and s.endswith("?"):
            hook = s
            break
        if _DRAMA.search(s) and len(s.split()) <= 30:
            hook = s
            break
    if not hook:
        hook = title if title.endswith("?") else f"{title.rstrip('.')}."

    used = len(hook.split())
    lines: list[str] = [hook]
    for s in sents:
        if s == hook:
            continue
        w = len(s.split())
        if used + w > budget - 12:  # leave room for the closer
            break
        lines.append(s)
        used += w

    closer = "What would you have done? Let me know in the comments."
    if used + len(closer.split()) <= budget + 10:
        lines.append(closer)

    text = " ".join(lines)
    return {"full_text": text, "hook": hook}


# ------------------------------------------------------------------------ AI
def ai_script(
    title: str,
    body: str,
    *,
    duration_target: int = 60,
    hook_style: str = "conflict",
    narration_style: str = "dramatic",
    drama_level: int = 3,
    speed: float = 1.0,
    model: str | None = None,
) -> dict[str, str]:
    budget = word_budget(duration_target, speed)
    voice = _STYLE_HINTS.get(narration_style, _STYLE_HINTS["dramatic"])
    hook_hint = _HOOK_HINTS.get(hook_style, _HOOK_HINTS["conflict"])

    system = (
        "You rewrite internet stories into first-person scripts for narrated "
        "vertical short-form videos (TikTok/Shorts). Output ONLY the narration "
        "text — no headings, no scene directions, no markdown, no emojis."
    )
    prompt = (
        f"Rewrite this story as a {voice}. {hook_hint} "
        f"Dramatize at intensity {max(1, min(5, drama_level))} of 5. "
        f"Target roughly {budget} words (about {duration_target} seconds spoken). "
        "Keep it first-person, present the events in order, and end with a short "
        "question that invites comments.\n\n"
        f"TITLE: {title}\n\nSTORY:\n{body[:6000]}"
    )

    resp = ollama.generate(prompt, model=model, system=system, options={"temperature": 0.8})
    text = strip_reasoning(resp.get("response", "")).strip()
    text = re.sub(r"^(script|narration)\s*:\s*", "", text, flags=re.IGNORECASE).strip()
    if len(text.split()) < 30:
        raise OllamaError("Model returned an implausibly short script")

    # Trim runaway output at a sentence boundary near the budget.
    words = text.split()
    if len(words) > budget * 1.4:
        clipped = " ".join(words[: int(budget * 1.25)])
        cut = max(clipped.rfind(". "), clipped.rfind("! "), clipped.rfind("? "))
        text = clipped[: cut + 1] if cut > 0 else clipped

    hook = _sentences(text)[0] if _sentences(text) else title
    return {"full_text": text, "hook": hook}


# ---------------------------------------------------------------- dispatcher
def generate_script(
    title: str,
    body: str,
    *,
    engine: str = "auto",
    duration_target: int = 60,
    hook_style: str = "conflict",
    narration_style: str = "dramatic",
    drama_level: int = 3,
    speed: float = 1.0,
    model: str | None = None,
) -> dict[str, str]:
    """Returns ``{"full_text", "hook", "generator"}``."""
    if engine in ("auto", "ai"):
        try:
            out = ai_script(
                title, body,
                duration_target=duration_target, hook_style=hook_style,
                narration_style=narration_style, drama_level=drama_level,
                speed=speed, model=model,
            )
            out["generator"] = model or "ollama-default"
            return out
        except Exception as exc:
            if engine == "ai":
                raise
            logger.warning("AI script generation failed (%s); using heuristic", exc)

    out = heuristic_script(
        title, body, duration_target=duration_target, hook_style=hook_style, speed=speed
    )
    out["generator"] = "heuristic"
    return out
