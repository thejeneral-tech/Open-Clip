"""Shared timing engine — Python port of scripts/timing.ts.

THE single source of truth for "what caption is on screen when". The generated
voice-audio duration is the master clock; captions snap to it. Ported 1:1 so the
preview (Python) and the Remotion render (the kept .ts engine) agree.

Math: count words per line → allocate audio time proportional to word count →
enforce a minimum readable display time → hard-normalize so the last caption
ends exactly at audioDurationSec.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Union

_WORD_RE = re.compile(r"\S+")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
DEFAULT_MIN_DISPLAY_SEC = 0.8


def count_words(text: str) -> int:
    if not text:
        return 0
    return len(_WORD_RE.findall(text))


def split_script_into_caption_lines(script: Union[List[Dict[str, Any]], str]) -> List[Dict[str, Any]]:
    """Accept an already-split list of line dicts OR a multi-sentence string."""
    if isinstance(script, list):
        out: List[Dict[str, Any]] = []
        for l in script:
            text = ((l or {}).get("text") or "").strip()
            if not text:
                continue
            out.append({
                "text": text,
                "type": (l or {}).get("type") or "observation",
                "durationSeconds": (l or {}).get("durationSeconds") or 0,
            })
        return out
    # Plain string — split on sentence boundaries
    parts = _SENTENCE_SPLIT.split(str(script or ""))
    return [
        {"text": s.strip(), "type": "observation", "durationSeconds": 0}
        for s in parts if s.strip()
    ]


def build_timed_captions(
    script: Union[List[Dict[str, Any]], str],
    audio_duration_sec: float,
    *,
    min_display_sec: Optional[float] = None,
    per_line_words: Optional[List[List[Dict[str, Any]]]] = None,
    source: str = "word-proportional",
) -> Dict[str, Any]:
    """Produce a fully-timed caption bundle. Guarantees the last caption ends
    exactly at the audio duration and that there are no gaps between captions."""
    lines = split_script_into_caption_lines(script)
    min_display = DEFAULT_MIN_DISPLAY_SEC if min_display_sec is None else min_display_sec
    audio = max(0.1, audio_duration_sec)
    n = len(lines)

    if n == 0:
        return {
            "audioDurationSec": audio,
            "totalWords": 0,
            "captions": [],
            "source": source,
            "finalCaptionEndDriftSec": 0,
        }

    word_counts = [max(1, count_words(l["text"])) for l in lines]
    total_words = sum(word_counts)

    # Step 1 — proportional allocation
    raw = [(w / total_words) * audio for w in word_counts]

    # Step 2 — enforce minimum readable display (only when audio is long enough)
    total_min_needed = min_display * n
    if total_min_needed < audio * 0.85:
        raw = [max(min_display, d) for d in raw]
        s = sum(raw)
        if s > 0 and abs(s - audio) > 1e-6:
            scale = audio / s
            raw = [d * scale for d in raw]
    else:
        s = sum(raw)
        if s > 0:
            scale = audio / s
            raw = [d * scale for d in raw]

    # Step 3 — accumulate
    captions: List[Dict[str, Any]] = []
    t = 0.0
    for i in range(n):
        start = t
        end = audio if i == n - 1 else min(audio, start + raw[i])
        t = end
        words = per_line_words[i] if (per_line_words and i < len(per_line_words)) else None
        captions.append({
            "index": i,
            "text": lines[i]["text"],
            "type": lines[i].get("type") or "observation",
            "start": start,
            "end": end,
            "duration": end - start,
            "wordCount": word_counts[i],
            "startMs": start * 1000,
            "endMs": end * 1000,
            "words": words if (words and len(words) > 0) else None,
        })

    # Step 4 — hard normalize last caption to exactly audio
    last = captions[-1]
    last["end"] = audio
    last["duration"] = last["end"] - last["start"]
    last["endMs"] = audio * 1000
    drift = last["end"] - audio  # 0 here, kept for parity

    return {
        "audioDurationSec": audio,
        "totalWords": total_words,
        "captions": captions,
        "source": source,
        "finalCaptionEndDriftSec": drift,
    }


def bundle_to_render_lines(bundle: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Convert a bundle into the scriptLines shape trend-vault-render.ts consumes."""
    out = []
    for c in bundle.get("captions", []):
        out.append({
            "text": c["text"],
            "type": c["type"],
            "startMs": c["startMs"],
            "endMs": c["endMs"],
            "durationSeconds": c["duration"],
            "words": c.get("words"),
        })
    return out
