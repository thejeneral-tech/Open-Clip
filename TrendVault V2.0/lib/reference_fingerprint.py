"""Reference-video "style fingerprint" — deterministic ffprobe/ffmpeg analysis.

Probes an uploaded reference clip for duration + cut frequency, estimates a pacing
bucket (fast/medium/slow), and maps that to suggested render settings the studio UI
consumes (grain, color grade, text animation, slow-zoom, fog, target length). No LLM.

The suggested values are exactly the ids the UI's setGrainType / setColorGrade /
textAnimSelect accept (see static/trend-vault.html), so `applyFingerprint` can apply
them directly. Blocking (subprocess) — call via asyncio.to_thread from the route.
"""
from __future__ import annotations

from typing import Any, Dict

from lib.ffmpeg_tools import probe_duration_sec, probe_scene_changes

# Only analyse the opening window so a long reference can't stall the request.
_ANALYZE_WINDOW_SEC = 60.0

# Pacing -> render settings. Every value below is a valid UI option id.
_SUGGESTIONS: Dict[str, Dict[str, Any]] = {
    "fast":   {"grainType": "digital", "colorGrade": "cyber",   "textAnimation": "word-drop", "slowZoom": False, "fogOverlay": False},
    "medium": {"grainType": "film",    "colorGrade": "analog",  "textAnimation": "rise",      "slowZoom": True,  "fogOverlay": False},
    "slow":   {"grainType": "film",    "colorGrade": "liminal", "textAnimation": "fade",      "slowZoom": True,  "fogOverlay": True},
}


def _pacing_from_cpm(cpm: float) -> str:
    if cpm >= 24:   # a cut roughly every <=2.5s — energetic edit
        return "fast"
    if cpm < 8:     # a cut every >=7.5s — cinematic / atmospheric
        return "slow"
    return "medium"


def _pacing_from_duration(duration: float) -> str:
    """Fallback pacing when cut detection is unavailable."""
    if duration <= 0:
        return "medium"
    if duration < 20:
        return "fast"
    if duration > 60:
        return "slow"
    return "medium"


def _target_duration(duration: float) -> int:
    if duration <= 0:
        return 90
    return max(15, min(180, round(duration)))


def analyze_reference(path: str) -> Dict[str, Any]:
    """Return the style fingerprint for the video at `path`.

    Degrades gracefully: if ffmpeg/ffprobe are missing or the file isn't decodable,
    duration is 0 and cut detection returns -1, yielding a sensible "medium" preset
    rather than an error.
    """
    duration = probe_duration_sec(path)
    scenes = probe_scene_changes(path, max_seconds=_ANALYZE_WINDOW_SEC)
    window = min(duration, _ANALYZE_WINDOW_SEC) if duration > 0 else _ANALYZE_WINDOW_SEC

    cpm = None
    if scenes >= 0 and window > 0:
        cpm = scenes / (window / 60.0)
        pacing = _pacing_from_cpm(cpm)
    else:
        pacing = _pacing_from_duration(duration)

    suggestions = dict(_SUGGESTIONS[pacing])
    suggestions["targetDuration"] = _target_duration(duration)

    return {
        "durationSeconds": round(duration, 2),
        "estimatedPacing": pacing,
        "cutsPerMinute": round(cpm, 1) if cpm is not None else None,
        "sceneChanges": scenes if scenes >= 0 else None,
        "suggestions": suggestions,
    }
