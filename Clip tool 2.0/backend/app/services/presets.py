"""Preset framework.

A *preset* is a complete, versioned bundle of rules that seeds a bot's behaviour:
discovery, filtering, scoring, clipping, metadata, and publishing. System presets
ship in code (:data:`BUILTIN_PRESETS`); users clone/edit/version them as DB rows
(:class:`~app.models.bot.BotPreset`).

When a bot is created from a preset the resolved config is *snapshotted* onto the
bot's own JSON columns, so later edits to the preset don't silently change a
running bot (the spec's "version presets" requirement).
"""
from __future__ import annotations

import copy
from typing import Any

# Baseline every preset is merged on top of, so partial presets are always
# complete. Mirrors the existing pipeline defaults (clip count, caption style…).
DEFAULT_CONFIG: dict[str, Any] = {
    "discovery": {
        "platforms": ["youtube", "rss"],
        "source_mode": "hybrid",          # whitelist | blacklist | hybrid
        "max_items_per_source": 25,
        "lookback_hours": 168,
        "search_queries": [],
    },
    "filters": {
        "keywords": [],
        "negative_keywords": [],
        "languages": ["en"],
        "countries": [],
        "categories": [],
        "min_views": 0,
        "max_age_hours": 720,
        "min_engagement": 0.0,
        "min_duration": 60,
        "max_duration": 10800,
    },
    "scoring": {
        "weights": {
            "view_velocity": 0.25,
            "like_velocity": 0.15,
            "comment_velocity": 0.1,
            "share_velocity": 0.1,
            "trend_velocity": 0.1,
            "recency": 0.1,
            "relevance": 0.15,
            "historical": 0.05,
        },
        "min_score": 55,                  # ingest threshold (0-100)
        "use_llm_relevance": True,
    },
    "clipping": {
        "target_clip_count": 8,
        "min_clip_seconds": 12,
        "max_clip_seconds": 60,
        "aspect_ratios": ["9:16"],
        "caption_style": "hormozi",
        "generate_titles": True,
        "generate_descriptions": True,
        "generate_broll": False,
        "enable_reframe": True,
        "enable_captions": True,
    },
    "metadata": {
        "hashtag_count": 12,
        "title_style": "viral",           # viral | curiosity | seo | platform
    },
    "publishing": {
        "platforms": [],
        "auto_publish_threshold": 80,     # semi_auto: publish clips scoring >= this
        "schedule_spacing_minutes": 120,
    },
    # Per-stage model overrides; empty => fall back to the bot/global defaults.
    "models": {},
}


# Built-in system presets — only the deltas from DEFAULT_CONFIG.
BUILTIN_PRESETS: dict[str, dict[str, Any]] = {
    "PODCAST_VIRAL": {
        "name": "Podcast — Viral Moments",
        "bot_type": "podcast",
        "description": "Long-form interview/podcast clipping tuned for emotional peaks and hot takes.",
        "config": {
            "discovery": {"platforms": ["youtube", "rss"], "lookback_hours": 336},
            "filters": {"min_duration": 600, "max_duration": 14400},
            "clipping": {
                "target_clip_count": 10,
                "min_clip_seconds": 20,
                "max_clip_seconds": 75,
                "caption_style": "podcast",
                "generate_broll": True,
            },
            "scoring": {"min_score": 58},
        },
    },
    "NEWS_FAST": {
        "name": "News — Fast Turnaround",
        "bot_type": "ai_news",
        "description": "High-velocity news clipping; prioritises freshness over polish.",
        "config": {
            "discovery": {"platforms": ["rss", "youtube", "reddit"], "lookback_hours": 24},
            "filters": {"max_age_hours": 48, "min_duration": 30},
            "scoring": {
                "weights": {"recency": 0.3, "view_velocity": 0.3, "relevance": 0.2},
                "min_score": 50,
            },
            "clipping": {"target_clip_count": 6, "max_clip_seconds": 50, "caption_style": "modern_tiktok"},
        },
    },
    "SPORTS_HIGHLIGHTS": {
        "name": "Sports — Highlights",
        "bot_type": "sports",
        "description": "Action highlights with energetic captions.",
        "config": {
            "discovery": {"platforms": ["youtube"], "lookback_hours": 72},
            "clipping": {"target_clip_count": 12, "min_clip_seconds": 8, "max_clip_seconds": 40,
                         "caption_style": "gaming"},
            "scoring": {"weights": {"view_velocity": 0.35, "share_velocity": 0.2}},
        },
    },
    "AI_NEWS": {
        "name": "AI News",
        "bot_type": "ai_news",
        "description": "AI/tech news with curiosity-driven titles.",
        "config": {
            "discovery": {
                "platforms": ["rss", "youtube", "reddit"],
                "lookback_hours": 72,
                "search_queries": ["AI", "LLM", "machine learning"],
            },
            "filters": {"keywords": ["ai", "model", "gpt", "llm", "agent"], "languages": ["en"]},
            "metadata": {"title_style": "curiosity"},
            "clipping": {"target_clip_count": 6, "caption_style": "modern_tiktok"},
        },
    },
    "BUSINESS_GROWTH": {
        "name": "Business Growth",
        "bot_type": "business",
        "description": "Actionable business/finance insights, SEO-leaning metadata.",
        "config": {
            "metadata": {"title_style": "seo", "hashtag_count": 15},
            "clipping": {"target_clip_count": 8, "min_clip_seconds": 25, "caption_style": "minimal"},
        },
    },
    "GAMING_MOMENTS": {
        "name": "Gaming Moments",
        "bot_type": "gaming",
        "description": "Stream/gaming highlights with high-energy captions.",
        "config": {
            "discovery": {"platforms": ["youtube"], "lookback_hours": 96},
            "clipping": {"target_clip_count": 12, "min_clip_seconds": 10, "max_clip_seconds": 45,
                         "caption_style": "gaming"},
        },
    },
    "MOTIVATION": {
        "name": "Motivation",
        "bot_type": "motivation",
        "description": "Inspirational, emotionally resonant short clips.",
        "config": {
            "clipping": {"target_clip_count": 8, "caption_style": "hormozi", "enable_reframe": True},
            "scoring": {"weights": {"relevance": 0.25}, "min_score": 60},
        },
    },
    "CUSTOM": {
        "name": "Custom",
        "bot_type": "custom",
        "description": "A blank, fully-editable preset.",
        "config": {},
    },
}


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge ``override`` onto a deep copy of ``base``."""
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def resolve_config(preset_config: dict[str, Any] | None) -> dict[str, Any]:
    """Overlay a (possibly partial) preset config onto the full default."""
    return deep_merge(DEFAULT_CONFIG, preset_config or {})


def builtin(key: str) -> dict[str, Any] | None:
    """Return a fully-resolved built-in preset bundle, or ``None``."""
    spec = BUILTIN_PRESETS.get(key)
    if spec is None:
        return None
    return {
        "key": key,
        "name": spec["name"],
        "description": spec.get("description"),
        "bot_type": spec.get("bot_type", "custom"),
        "is_system": True,
        "version": 1,
        "config": resolve_config(spec.get("config")),
    }


def list_builtin() -> list[dict[str, Any]]:
    return [builtin(k) for k in BUILTIN_PRESETS]


def config_to_bot_columns(config: dict[str, Any]) -> dict[str, Any]:
    """Split a resolved preset config into the Bot model's JSON columns."""
    full = resolve_config(config)
    return {
        "discovery_config": full["discovery"],
        "filter_config": full["filters"],
        "scoring_config": full["scoring"],
        "clipping_config": full["clipping"],
        "publishing_config": full["publishing"],
        "model_assignments": full.get("models", {}),
    }


def bot_columns_to_config(bot: Any) -> dict[str, Any]:
    """Reassemble a preset-shaped config from a Bot's columns (for export)."""
    return {
        "discovery": bot.discovery_config or {},
        "filters": bot.filter_config or {},
        "scoring": bot.scoring_config or {},
        "clipping": bot.clipping_config or {},
        "publishing": bot.publishing_config or {},
        "metadata": (bot.clipping_config or {}).get("metadata", DEFAULT_CONFIG["metadata"]),
        "models": bot.model_assignments or {},
    }
