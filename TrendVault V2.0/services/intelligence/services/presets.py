"""Preset CRUD + the canonical Auto-Create configuration shape.

A "preset" simply stores a full run configuration so it can be re-run later.
The same normalized config dict drives both presets and live Auto-Create runs,
so there is a single source of truth for defaults and valid values.
"""
from __future__ import annotations

from .. import config, database

SOURCE_TYPES = ("topic", "channel", "video", "preset")
CLIP_STYLES = ("auto", "funny", "heated", "story", "reaction", "highlight", "controversial")
CAPTION_STYLES = ("bold", "clean", "minimal", "big", "none")
FRAMING_MODES = ("smart", "center", "blur", "split")
ASPECT_RATIOS = ("9:16", "1:1", "16:9")
# Legacy sort values + the Smart Video Searcher's six scoring modes (+longest/shortest).
SORT_METHODS = (
    "relevance", "views", "recent", "rating",                 # legacy (back-compat)
    "best-match", "most-popular", "most-recent",
    "highest-engagement", "best-clip-potential", "most-commented",
    "longest", "shortest",
)
RECENCY = ("any", "year", "month", "week", "day")
SEARCH_SCOPES = ("youtube", "youtube_web", "channel", "video")
VIDEO_TYPES = ("any", "long-form", "shorts", "podcast", "interview", "compilation")
RESULT_LIMITS = (10, 20, 30, 50, 100)


def default_config() -> dict:
    """The canonical run/preset configuration with sane defaults."""
    return {
        "source_type": "topic",
        "topic": "",
        "channel_url": "",
        "video_url": "",
        "keywords": "",            # comma-separated
        "excluded_keywords": "",   # comma-separated
        "num_videos": config.DEFAULT_VIDEOS_TO_ANALYZE,
        "num_clips": config.DEFAULT_CLIPS_TO_CREATE,
        "min_len": config.DEFAULT_MIN_CLIP_LEN,
        "max_len": config.DEFAULT_MAX_CLIP_LEN,
        "clip_style": "auto",
        "caption_style": "bold",
        "framing": "smart",
        "aspect_ratio": "9:16",
        "sort_method": "relevance",
        "recency": "any",
        "min_views": 0,
        # --- Smart Video Searcher ---
        "search_scope": "youtube",     # youtube | youtube_web | channel | video
        "result_limit": 20,            # how many search results to surface (separate from clips)
        "language": "",                # ISO-639-1 hint or ""
        "max_duration_min": 0,         # max video length in minutes (0 = no cap)
        "video_type": "any",           # any | long-form | shorts | podcast | interview | compilation
        "auto_select": True,           # pre-tick the strongest results
    }


def _clamp_int(v, lo, hi, default) -> int:
    try:
        return max(lo, min(hi, int(float(v))))
    except (TypeError, ValueError):
        return default


def _pick(v, allowed, default):
    return v if v in allowed else default


def normalize_config(raw: dict | None) -> dict:
    """Coerce an arbitrary input dict into a valid, fully-populated config."""
    raw = raw or {}
    cfg = default_config()
    cfg.update({k: raw[k] for k in cfg if k in raw})

    cfg["source_type"] = _pick(cfg["source_type"], SOURCE_TYPES, "topic")
    cfg["clip_style"] = _pick(cfg["clip_style"], CLIP_STYLES, "auto")
    cfg["caption_style"] = _pick(cfg["caption_style"], CAPTION_STYLES, "bold")
    cfg["framing"] = _pick(cfg["framing"], FRAMING_MODES, "smart")
    cfg["aspect_ratio"] = _pick(cfg["aspect_ratio"], ASPECT_RATIOS, "9:16")
    cfg["sort_method"] = _pick(cfg["sort_method"], SORT_METHODS, "relevance")
    cfg["recency"] = _pick(cfg["recency"], RECENCY, "any")
    cfg["search_scope"] = _pick(cfg["search_scope"], SEARCH_SCOPES, "youtube")
    cfg["video_type"] = _pick(cfg["video_type"], VIDEO_TYPES, "any")
    cfg["result_limit"] = _pick(_clamp_int(cfg["result_limit"], 10, 100, 20), RESULT_LIMITS, 20)
    cfg["language"] = str(cfg.get("language") or "").strip().lower()[:5]
    cfg["auto_select"] = bool(cfg.get("auto_select", True))

    cfg["num_videos"] = _clamp_int(cfg["num_videos"], 1, config.MAX_VIDEOS_TO_ANALYZE,
                                   config.DEFAULT_VIDEOS_TO_ANALYZE)
    cfg["num_clips"] = _clamp_int(cfg["num_clips"], 1, config.MAX_CLIPS_TO_CREATE,
                                  config.DEFAULT_CLIPS_TO_CREATE)
    cfg["min_len"] = _clamp_int(cfg["min_len"], 3, 180, config.DEFAULT_MIN_CLIP_LEN)
    cfg["max_len"] = _clamp_int(cfg["max_len"], cfg["min_len"], 180, config.DEFAULT_MAX_CLIP_LEN)
    cfg["min_views"] = _clamp_int(cfg["min_views"], 0, 1_000_000_000, 0)
    cfg["max_duration_min"] = _clamp_int(cfg["max_duration_min"], 0, 1440, 0)

    for key in ("topic", "channel_url", "video_url", "keywords", "excluded_keywords"):
        cfg[key] = str(cfg.get(key) or "").strip()

    # Back-compat: if no explicit scope was given, derive it from the source type
    # so the existing Topic->Clips run flow keeps working unchanged.
    if "search_scope" not in raw:
        cfg["search_scope"] = {"channel": "channel", "video": "video"}.get(
            cfg["source_type"], "youtube")
    return cfg


def keyword_list(value: str) -> list[str]:
    """Split a comma/newline separated keyword string into clean tokens."""
    parts = []
    for chunk in str(value or "").replace("\n", ",").split(","):
        token = chunk.strip()
        if token:
            parts.append(token)
    return parts


# --- CRUD ----------------------------------------------------------------
def create(name: str, config_in: dict) -> dict:
    name = (name or "Untitled preset").strip() or "Untitled preset"
    pid = database.create_preset(name, normalize_config(config_in))
    return database.get_preset(pid)


def update(preset_id: int, name: str, config_in: dict) -> dict | None:
    existing = database.get_preset(preset_id)
    if not existing:
        return None
    name = (name or existing["name"]).strip() or existing["name"]
    database.update_preset(preset_id, name, normalize_config(config_in))
    return database.get_preset(preset_id)


def duplicate(preset_id: int) -> dict | None:
    src = database.get_preset(preset_id)
    if not src:
        return None
    new_name = f"{src['name']} (copy)"
    pid = database.create_preset(new_name, normalize_config(src["config"]))
    return database.get_preset(pid)


def get(preset_id: int) -> dict | None:
    return database.get_preset(preset_id)


def list_all() -> list[dict]:
    return database.list_presets()


def delete(preset_id: int) -> None:
    database.delete_preset(preset_id)
