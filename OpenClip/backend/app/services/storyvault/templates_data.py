"""Built-in video templates (the "reference-based template system").

PURE DATA — ported from StoryVault's ``templates-data.js``. A template stores
the full set of knobs the render reads: canvas, safe zones, topic-card geometry/
duration, author-card font/colour, caption font/size/outline/placement/highlight,
transition timing, audio mix, branding, fps, export settings.

Each built-in carries a stable string ``key`` so per-user seeding stays
idempotent and a soft-deleted built-in is never resurrected.
"""
from __future__ import annotations

import copy
from typing import Any

# ASS colours are &HAABBGGRR.
COLORS = {
    "white": "&H00FFFFFF",
    "black": "&H00000000",
    "yellow": "&H0000F0FF",
    "cardFill": "&H00FFFFFF",
    "cardTitle": "&H00141414",
    "cardMeta": "&H00777777",
    "cardRed": "&H002430E0",
    "shadow": "&H78000000",
}

# The reference default — "Full-Screen Story Gameplay".
REFERENCE_TEMPLATE: dict[str, Any] = {
    "key": "full_screen_story",
    "name": "Full-Screen Story Gameplay",
    "builtin": True,
    "isDefault": True,
    "canvas": {"width": 1080, "height": 1920, "fps": 30},
    "safe": {"top": 230, "bottom": 320, "side": 60},
    "gameplay": {"mode": "fill_crop", "cropProfile": "center", "audioVolume": 0},
    "audio": {"narrationVolume": 1.0, "gameplayVolume": 0, "musicVolume": 0, "sfxVolume": 0},
    "branding": {"enabled": False, "position": "none", "text": ""},
    "topicCard": {
        "enabled": True, "minSeconds": 2.2, "maxSeconds": 5.0,
        "centerY": 760, "width": 820, "radius": 46, "titleSize": 50,
        "metaSize": 34, "avatar": True, "fade": 180,
    },
    "authorIntro": {
        "enabled": True, "minSeconds": 1.5, "maxSeconds": 3.0,
        "prefixReddit": "Posted by", "prefixQuora": "Written by",
        "maxSize": 138, "minSize": 60, "outline": 9, "fade": 160, "popScale": 108,
    },
    "captions": {
        "enabled": True, "style": "reference", "size": 80, "outline": 7, "marginV": 520,
        "centerY": 1150, "maxWords": 4, "maxChars": 18,
        "highlight": COLORS["yellow"], "primary": COLORS["white"],
    },
    "transition": {"type": "fade", "seconds": 0.35},
    "export": {"vcodec": "libx264", "acodec": "aac", "crf": 20, "audioBitrate": "160k"},
}


def _deep_merge(base: dict, patch: dict) -> dict:
    for k, v in (patch or {}).items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            base[k] = _deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def _variant(key: str, name: str, patch: dict) -> dict[str, Any]:
    t = copy.deepcopy(REFERENCE_TEMPLATE)
    t["key"] = key
    t["name"] = name
    t["isDefault"] = False
    t["builtin"] = True
    return _deep_merge(t, patch)


BUILTIN_TEMPLATES: list[dict[str, Any]] = [
    copy.deepcopy(REFERENCE_TEMPLATE),
    _variant("minimal_story", "Minimal Story", {
        "topicCard": {"width": 760, "titleSize": 46, "avatar": False, "maxSeconds": 4},
        "captions": {"size": 72, "maxWords": 3},
    }),
    _variant("large_captions", "Large Captions", {
        "captions": {"size": 104, "maxWords": 3, "outline": 8, "marginV": 560},
    }),
    _variant("reddit_card_focus", "Reddit Card Focus", {
        "topicCard": {"minSeconds": 3.0, "maxSeconds": 6.0, "width": 860},
        "authorIntro": {"minSeconds": 1.2, "maxSeconds": 2.4},
    }),
    _variant("quora_card_focus", "Quora Card Focus", {
        "topicCard": {"minSeconds": 3.0, "maxSeconds": 6.0, "width": 860, "avatar": True},
        "authorIntro": {"prefixReddit": "Written by", "minSeconds": 1.2, "maxSeconds": 2.4},
    }),
    _variant("clean_cinematic", "Clean Cinematic", {
        "topicCard": {"fade": 300}, "authorIntro": {"fade": 280, "popScale": 104},
        "captions": {"size": 78, "outline": 5, "marginV": 600},
    }),
    _variant("split_screen", "Split Screen", {
        "gameplay": {"mode": "split_bottom"},
        "captions": {"marginV": 480},
    }),
    _variant("center_pop", "Center Pop Captions", {
        "captions": {
            "style": "pop", "size": 116, "outline": 8, "maxWords": 2, "maxChars": 12,
            "centerY": 960, "font": "Arial Rounded MT Bold",
            "primary": COLORS["white"], "highlight": COLORS["white"],
        },
    }),
    _variant("full_screen_centered", "Full-Screen — Centered Captions", {
        "captions": {"centerY": 960},
    }),
    _variant("custom_template", "Custom Template", {}),
]
