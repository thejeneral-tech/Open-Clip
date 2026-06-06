"""Port of scripts/tts/scriptFormatter.ts."""
from __future__ import annotations

import math
import re

WORDS_PER_SECOND_BASE = 2.8


def format_script(text: str) -> str:
    s = text
    s = re.sub(r"\.\s+", "... ", s)
    s = re.sub(r"!\s+", "! ", s)
    s = re.sub(r"\?\s+", "? ", s)
    s = re.sub(r",\s+", ", ", s)
    s = re.sub(r"\s{2,}", " ", s)
    return s.strip()


def truncate_for_preview(text: str, max_seconds: float = 12, speed_multiplier: float = 1.0) -> str:
    wps = WORDS_PER_SECOND_BASE * speed_multiplier
    max_words = math.ceil(wps * max_seconds)
    words = re.split(r"\s+", text)
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words]) + "..."
