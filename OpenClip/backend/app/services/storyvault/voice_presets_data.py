"""Built-in voice presets (the bundled TikTok clone voices).

PURE DATA. These are the three voices cloned in the old StoryVault app —
"Tiktok Adam Voice", "Tiktok Anton Voice", "Tiktok Jessie Voice" — promoted to
built-ins so every user has them on a fresh start, exactly like the built-in
templates in :mod:`templates_data`.

Each preset carries a stable string ``key`` so per-user seeding stays idempotent
and a soft-deleted built-in is never resurrected. ``preview`` names a WAV under
:data:`ASSETS_DIR` — the saved audition clip the Voice Lab "Preview" button
plays (clone presets have no SAPI voice to re-synthesize from). That same clip
doubles as the **cloning reference**, and ``transcript`` is the exact words spoken
in it — the s2 engine needs both to clone the voice when narrating a video.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

ASSETS_DIR = Path(__file__).parent / "assets" / "voice_presets"

# ``voice`` is the literal "fish-clone" (these have no SAPI voice name); ``engine``
# marks them as cloned so the UI badges them "Cloned" and Preview plays the clip.
BUILTIN_VOICE_PRESETS: list[dict[str, Any]] = [
    {
        "key": "tiktok_adam",
        "name": "Tiktok Adam Voice",
        "engine": "fish-clone",
        "voice": "fish-clone",
        "speed": 1.0,
        "preview": "tiktok_adam.wav",
        "transcript": "This is the best idea we have had.",
        "isDefault": True,
    },
    {
        "key": "tiktok_anton",
        "name": "Tiktok Anton Voice",
        "engine": "fish-clone",
        "voice": "fish-clone",
        "speed": 1.0,
        "preview": "tiktok_anton.wav",
        "transcript": "This is the best thing we have ever done.",
        "isDefault": False,
    },
    {
        "key": "tiktok_jessie",
        "name": "Tiktok Jessie Voice",
        "engine": "fish-clone",
        "voice": "fish-clone",
        "speed": 1.0,
        "preview": "tiktok_jessie.wav",
        "transcript": "This is the best thing we have made.",
        "isDefault": False,
    },
]


def voice_preset_asset(filename: str) -> Path | None:
    """Resolve a built-in preview WAV bundled in the repo, or ``None`` if absent."""
    path = ASSETS_DIR / filename
    return path if path.exists() else None
