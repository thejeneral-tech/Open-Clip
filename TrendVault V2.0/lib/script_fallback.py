"""Template fallback script — port of generateFallbackScript (trend-vault-generate.ts).

Used only when no AI key is configured or every provider fails. Produces a
niche-aware ~90s / ~210-word, 18-line script. Never relationship/zodiac themed.
"""
from __future__ import annotations

import random
import re
import time
from typing import Any, Dict

from lib.prompts_lib import (
    append_recent_hook, make_rng, pick, read_recent_hooks, uppercase_script_lines,
)


def _words(text: str) -> int:
    return len([w for w in re.split(r"\s+", text) if w])


def generate_fallback_script(niche: str, prompt: str, angle: str = "",
                             emotional_tone: str = "mysterious") -> Dict[str, Any]:
    fb_rng = make_rng((int(time.time() * 1000) ^ random.randint(0, 999999999)) & 0xFFFFFFFF)
    recent = {h.lower().strip() for h in read_recent_hooks()}
    final_subject = prompt.strip() if (prompt and prompt.strip()) else niche

    generic_hooks = [
        f"Nobody tells you the real truth about {niche}.",
        f"Everyone gets {niche} wrong — and the proof is in what they don't say.",
        f"The thing about {niche} is that the obvious answer is never the right one.",
        f"Most people are doing {niche} the expensive way.",
        f"The difference between people who win at {niche} and people who don't isn't what you think.",
        f"{niche} rewards the people who understand one thing everyone else ignores.",
        f"You were never taught the real rules of {niche}.",
        f"Everything you know about {niche} was designed to keep you from the shortcut.",
        f"Here's what {niche} actually costs — and nobody warns you.",
        f"The moment you understand this about {niche}, everything changes.",
    ]
    eligible = [h for h in generic_hooks if h.lower().strip() not in recent]
    hook_text = pick(eligible if eligible else generic_hooks, fb_rng)
    subject_short = " ".join(final_subject.split(" ")[:6])

    lines = [
        {"text": hook_text, "type": "hook", "durationSeconds": 3},
        {"text": f"This is about {subject_short} — and it matters more than you think.", "type": "setup", "durationSeconds": 4},
        {"text": f"Most people approach {niche} the same way. And most people get the same mediocre result.", "type": "observation", "durationSeconds": 6},
        {"text": "They follow the same advice. Read the same guides. And wonder why nothing sticks.", "type": "observation", "durationSeconds": 5},
        {"text": "The problem isn't effort. The problem is the framework they're using.", "type": "observation", "durationSeconds": 5},
        {"text": f"Someone who figures out {niche} early isn't smarter. They just asked a different question.", "type": "example", "durationSeconds": 5},
        {"text": "Instead of asking how to do more — they asked what to stop doing.", "type": "example", "durationSeconds": 5},
        {"text": f"The real edge in {niche} isn't a secret resource. It's a shift in how you see the problem.", "type": "escalation", "durationSeconds": 6},
        {"text": f"{subject_short} sounds simple until you realize the conventional approach is the trap.", "type": "escalation", "durationSeconds": 5},
        {"text": f"The people who figured out {niche} stopped optimizing for the thing everyone else chases.", "type": "truth", "durationSeconds": 5},
        {"text": "They optimized for the thing underneath it.", "type": "truth", "durationSeconds": 3},
        {"text": f"In {niche}, the biggest wins come from choosing what not to spend — time, money, or attention.", "type": "truth", "durationSeconds": 6},
        {"text": "That single choice separates the people who break through from the ones who stay stuck.", "type": "truth", "durationSeconds": 5},
        {"text": "The shortcut isn't a trick.", "type": "twist", "durationSeconds": 2},
        {"text": "It's a different question entirely.", "type": "twist", "durationSeconds": 3},
        {"text": "Once you see it, you can't unsee it.", "type": "takeaway", "durationSeconds": 3},
        {"text": f"That's when {niche} finally starts working.", "type": "ending", "durationSeconds": 4},
        {"text": "And you'll wonder why it took you this long to ask.", "type": "ending", "durationSeconds": 4},
    ]

    try:
        append_recent_hook(hook_text)
    except Exception:
        pass

    total_duration = sum(l["durationSeconds"] for l in lines)
    estimated_words = sum(_words(l["text"]) for l in lines)

    return uppercase_script_lines({
        "lines": lines,
        "totalDuration": total_duration,
        "title": f"{niche} — The Real Truth",
        "hook": hook_text,
        "trendVaultSign": niche,
        "topic": final_subject,
        "emotionalTone": emotional_tone or "mysterious",
        "estimatedWords": estimated_words,
    })
