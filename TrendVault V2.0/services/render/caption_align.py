"""AssemblyAI forced alignment — Python port of the server's alignment block.

Uploads the voice file, polls the transcript, then runs the same word-matching
cursor loop to attach per-word ms timings to each script line. Falls back (the
caller catches exceptions) to pure word-proportional timing.
"""
from __future__ import annotations

import re
import time
from typing import Any, Dict, List, Optional

import httpx

from core.config import config

_BASE = "https://api.assemblyai.com/v2"


def _norm(w: str) -> str:
    return re.sub(r"[^0-9A-Za-z']", "", (w or "").lower())


def transcribe(audio_path: str) -> Optional[List[Dict[str, Any]]]:
    """Upload + transcribe → list of {text, start, end} word dicts (ms). None if no key."""
    key = config.assemblyai_api_key
    if not key:
        return None
    headers = {"authorization": key}
    with open(audio_path, "rb") as f:
        up = httpx.post(f"{_BASE}/upload", headers=headers, content=f.read(), timeout=120.0)
    up.raise_for_status()
    audio_url = up.json()["upload_url"]

    tr = httpx.post(f"{_BASE}/transcript", headers=headers,
                    json={"audio_url": audio_url}, timeout=30.0)
    tr.raise_for_status()
    tid = tr.json()["id"]

    for _ in range(150):  # ~5 min ceiling
        st = httpx.get(f"{_BASE}/transcript/{tid}", headers=headers, timeout=30.0).json()
        status = st.get("status")
        if status == "completed":
            return st.get("words") or []
        if status == "error":
            raise RuntimeError(st.get("error") or "AssemblyAI error")
        time.sleep(2)
    raise RuntimeError("AssemblyAI transcription timed out")


def match_words_to_lines(script_lines: List[Dict[str, Any]],
                         words: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """Port of the cursor-matching loop (server.ts:4006-4028)."""
    all_words = [{"raw": w.get("text"), "norm": _norm(w.get("text", "")),
                  "start": w.get("start", 0), "end": w.get("end", 0)} for w in words]
    cursor = 0
    per_line: List[List[Dict[str, Any]]] = []
    for line in script_lines:
        tokens = [t for t in re.split(r"\s+", line.get("text", "")) if t]
        matched: List[Dict[str, Any]] = []
        for tok in tokens:
            target = _norm(tok)
            if not target:
                matched.append({"word": tok, "startMs": 0, "endMs": 0})
                continue
            found = -1
            for i in range(cursor, min(cursor + 6, len(all_words))):
                if all_words[i]["norm"] == target:
                    found = i
                    break
            if found >= 0:
                matched.append({"word": tok, "startMs": all_words[found]["start"],
                                "endMs": all_words[found]["end"]})
                cursor = found + 1
            elif cursor < len(all_words):
                matched.append({"word": tok, "startMs": all_words[cursor]["start"],
                                "endMs": all_words[cursor]["end"]})
                cursor += 1
            else:
                matched.append({"word": tok, "startMs": 0, "endMs": 0})
        per_line.append(matched)
    return per_line
