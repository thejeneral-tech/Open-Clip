"""Preview↔render hash sync — the ONE place both endpoints compute hashes.

The studio previews a voice, stores the returned `timing` (with scriptHash +
voiceHash), then sends it back when rendering. The render preflight recomputes
those hashes and rejects the render if they disagree (script or voice changed
since preview). Node computed them in two hand-synced sites; here both routes
import these helpers so they can never drift.

`stable_hash` is a faithful port of the Node `stableHash` (Java-style 32-bit
string hashCode). Both sides are now Python, so internal consistency — not
cross-language parity with the old Node value — is what matters.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


def stable_hash(s: str) -> str:
    """Port of: let h=0; for c in s: h=((h<<5)-h+c)|0; return String(h)."""
    h = 0
    for ch in s:
        h = (h << 5) - h + ord(ch)
        h &= 0xFFFFFFFF
        if h & 0x80000000:        # coerce to signed 32-bit each step (JS `| 0`)
            h -= 0x100000000
    return str(h)


def _js_str(x: Any) -> str:
    """Mimic JS `String(x)` for the `?? ''` array-join: None→'', 1.0→'1'."""
    if x is None:
        return ""
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, float) and x.is_integer():
        return str(int(x))
    return str(x)


def is_fish_engine(preset_id: Optional[str], engine: Optional[str]) -> bool:
    pid = (preset_id or "")
    eng = (engine or "")
    return (
        pid.startswith("fish_") or pid.startswith("fish-")
        or eng in ("fish-speech-s2-pro", "fish")
    )


def resolved_engine(voice: Dict[str, Any]) -> str:
    return "fish-speech-s2-pro" if is_fish_engine(voice.get("presetId"), voice.get("engine")) else "kokoro"


def script_hash(script_lines: List[Dict[str, Any]]) -> str:
    text = "||".join((l.get("text") or "").strip() for l in script_lines)
    return stable_hash(text)


def voice_key(voice: Dict[str, Any], engine: str) -> str:
    """KEEP IN SYNC with server.ts voice-preview & render preflight field order."""
    return "|".join([
        engine,
        voice.get("presetId") or "",
        _js_str(voice.get("speed")), _js_str(voice.get("pitch")), _js_str(voice.get("rate")),
        _js_str(voice.get("volume")), _js_str(voice.get("intensity")),
        _js_str(voice.get("throatDepth")), _js_str(voice.get("ancientRasp")),
        _js_str(voice.get("royalPace")), _js_str(voice.get("chamberSpace")),
        _js_str(voice.get("fishVoice")), _js_str(voice.get("fishSpeed")),
        _js_str(voice.get("fishTemp")), _js_str(voice.get("fishPitch")),
    ])


def voice_hash(voice: Dict[str, Any], engine: str) -> str:
    return stable_hash(voice_key(voice, engine))
