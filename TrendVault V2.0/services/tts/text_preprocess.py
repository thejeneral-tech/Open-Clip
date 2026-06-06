"""Port of scripts/tts/textPreprocessor.ts — pause shaping for natural cadence."""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

DEFAULT_PAUSES: Dict[str, int] = {
    "commaPauseMs": 180, "periodPauseMs": 380, "ellipsisPauseMs": 650,
    "lineBreakPauseMs": 500, "hookPauseMs": 700, "endingPauseMs": 800,
}

CINEMATIC_PAUSES: Dict[str, int] = {
    "commaPauseMs": 250, "periodPauseMs": 550, "ellipsisPauseMs": 900,
    "lineBreakPauseMs": 750, "hookPauseMs": 1000, "endingPauseMs": 1100,
}


def pause_config_from_royal_pace(slider: float) -> Dict[str, int]:
    v = max(0, min(100, slider or 0))
    return {
        "commaPauseMs": round(120 + v * 2),
        "periodPauseMs": round(280 + v * 4),
        "ellipsisPauseMs": round(450 + v * 5),
        "lineBreakPauseMs": round(350 + v * 4),
        "hookPauseMs": round(500 + v * 4),
        "endingPauseMs": round(650 + v * 4),
    }


def normalize_for_tts(s: str) -> str:
    s = re.sub(r"[*_~`#]+", "", s)
    s = re.sub(r"\.{2,}", "...", s)
    s = re.sub(r"\s*[—–]\s*", ", ", s)
    s = s.replace("“", '"').replace("”", '"')
    s = s.replace("‘", "'").replace("’", "'")
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"([,;:.!?])(?=[^\s\d])", r"\1 ", s)
    s = s.strip()
    if s and not re.search(r"[.!?…]$", s):
        s += "."
    return s


def normalize_for_caption(s: str) -> str:
    s = re.sub(r"[*_~`#]+", "", s)
    s = re.sub(r"\s*[—–]\s*", " — ", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    return s.strip()


def prepare_script(lines: List[str], cfg: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    cfg = cfg or DEFAULT_PAUSES
    clean = [l.strip() for l in lines if l and l.strip()]
    tts_chunks: List[Dict[str, Any]] = []
    for i, raw in enumerate(clean):
        is_hook = i == 0
        is_ending = i == len(clean) - 1
        is_short = len(re.split(r"\s+", raw)) <= 5
        tts_line = normalize_for_tts(raw)
        pause = cfg["lineBreakPauseMs"]
        if is_hook:
            pause = cfg["hookPauseMs"]
        elif is_ending:
            pause = cfg["endingPauseMs"]
        elif is_short:
            pause = cfg["lineBreakPauseMs"] + 150
        tts_chunks.append({"text": tts_line, "pauseAfterMs": pause})

    caption_text = "\n".join(normalize_for_caption(l) for l in clean)
    return {"ttsChunks": tts_chunks, "captionText": caption_text}


def prepare_string(text: str, cfg: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    if "\n" in text:
        lines = text.split("\n")
    else:
        lines = re.split(r"(?<=[.!?])\s+", text)
    return prepare_script(lines, cfg)
