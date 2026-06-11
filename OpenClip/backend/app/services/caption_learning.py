"""Caption self-tuning ("learns off old videos").

Every burned render is audited and the result folded into a small JSON profile
under ``DATA_DIR``. The profile remembers, per caption style, how often cues came
out *too fast to read* and nudges that style's words-per-cue down (or back up)
for the next generation — so captions get calmer and more readable the more
videos you make, without any change to the deterministic no-overlap guarantee.

The whole module is best-effort: every public function swallows its own errors
and degrades to "no opinion" (``suggest_max_words`` → ``None``, ``record_render``
→ no-op) so caption rendering can never be broken by the learning layer.
"""
from __future__ import annotations

import json
import os
import tempfile
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

PROFILE_VERSION = 1

# Tuning thresholds. ``fast_rate`` is the share of a render's cues that were both
# short-lived and densely packed (see captions.audit_timeline). The exponential
# moving average smooths across renders so one fast clip doesn't whipsaw a style.
_EMA_ALPHA = 0.3
_SLOW_DOWN_ABOVE = 0.35   # too many cramped cues over time -> show fewer words
_SPEED_UP_BELOW = 0.10    # consistently comfortable -> allow the preset's words again
_MIN_DELTA = -2           # never drop more than 2 words below the preset
_MAX_DELTA = 0            # never exceed the preset's own words-per-cue


def _profile_path() -> str:
    return os.path.join(settings.DATA_DIR, "caption_profile.json")


def _load() -> dict[str, Any]:
    try:
        with open(_profile_path(), encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and data.get("version") == PROFILE_VERSION:
            data.setdefault("styles", {})
            return data
    except FileNotFoundError:
        pass
    except Exception as exc:  # corrupt file -> start fresh, don't crash
        logger.warning("Caption profile unreadable, resetting: %s", exc)
    return {"version": PROFILE_VERSION, "total_renders": 0, "styles": {}}


def _save(data: dict[str, Any]) -> None:
    path = _profile_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, path)  # atomic swap
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _style_entry(data: dict[str, Any], style_name: str) -> dict[str, Any]:
    return data["styles"].setdefault(
        style_name,
        {"renders": 0, "groups": 0, "fast_groups": 0, "overlaps": 0,
         "fast_rate_ema": 0.0, "max_words_delta": 0},
    )


def suggest_max_words(style_name: str) -> int | None:
    """Learned words-per-cue for ``style_name``, or ``None`` to use the preset.

    Returns ``None`` until enough has been learned to have an opinion, so a fresh
    install behaves exactly like the hand-tuned preset.
    """
    try:
        from app.services.captions import get_style

        data = _load()
        entry = data["styles"].get(style_name)
        if not entry:
            return None
        delta = int(entry.get("max_words_delta", 0))
        if delta == 0:
            return None
        base = get_style(style_name).max_words
        return max(2, base + delta)
    except Exception as exc:
        logger.debug("suggest_max_words(%s) failed: %s", style_name, exc)
        return None


def record_render(style_name: str, audit: dict[str, Any]) -> None:
    """Fold one render's :func:`captions.audit_timeline` result into the profile."""
    try:
        groups = int(audit.get("groups", 0))
        if groups <= 0:
            return
        fast = int(audit.get("fast_groups", 0))
        rate = fast / groups

        data = _load()
        data["total_renders"] = int(data.get("total_renders", 0)) + 1
        e = _style_entry(data, style_name)
        e["renders"] += 1
        e["groups"] += groups
        e["fast_groups"] += fast
        e["overlaps"] += int(audit.get("overlaps", 0))
        # Seed the EMA from the first render so it converges quickly, then smooth.
        e["fast_rate_ema"] = (
            rate if e["renders"] == 1
            else (1 - _EMA_ALPHA) * float(e["fast_rate_ema"]) + _EMA_ALPHA * rate
        )

        delta = int(e["max_words_delta"])
        ema = float(e["fast_rate_ema"])
        if ema > _SLOW_DOWN_ABOVE and delta > _MIN_DELTA:
            delta -= 1
        elif ema < _SPEED_UP_BELOW and delta < _MAX_DELTA:
            delta += 1
        e["max_words_delta"] = max(_MIN_DELTA, min(_MAX_DELTA, delta))

        _save(data)
        if audit.get("overlaps"):
            logger.warning(
                "Caption render had %s overlapping cues (style=%s) — clamped, "
                "but check word timings.", audit["overlaps"], style_name,
            )
    except Exception as exc:
        logger.debug("record_render(%s) failed: %s", style_name, exc)
