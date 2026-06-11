"""Unit tests for the automation layer's pure logic (no DB, no network)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.services import presets, scoring
from app.services.bot_runner import compute_next_run, cosine, is_within_active_window
from app.services.discovery.base import DiscoveredItem
from app.services.discovery.rss import _parse_date
from app.services.ollama_service import OllamaService


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------- presets
def test_builtin_presets_resolve_fully():
    for spec in presets.list_builtin():
        cfg = spec["config"]
        # Every preset is merged onto the full default, so all sections exist.
        for section in ("discovery", "filters", "scoring", "clipping", "publishing"):
            assert section in cfg
        assert "weights" in cfg["scoring"]


def test_deep_merge_is_recursive_and_nondestructive():
    base = {"a": {"x": 1, "y": 2}, "b": 3}
    over = {"a": {"y": 9}, "c": 4}
    merged = presets.deep_merge(base, over)
    assert merged == {"a": {"x": 1, "y": 9}, "b": 3, "c": 4}
    assert base["a"]["y"] == 2  # original untouched


def test_config_to_bot_columns_roundtrip():
    cfg = presets.builtin("PODCAST_VIRAL")["config"]
    cols = presets.config_to_bot_columns(cfg)
    assert cols["clipping_config"]["caption_style"] == "podcast"
    assert "weights" in cols["scoring_config"]


# ------------------------------------------------------------------- scoring
def test_passes_filters_negative_keyword():
    item = DiscoveredItem(platform="youtube", external_id="1", url="u",
                          title="A great clickbait video", description="")
    ok, reason = scoring.passes_filters(item, {"negative_keywords": ["clickbait"]})
    assert not ok and "clickbait" in reason


def test_passes_filters_requires_keyword():
    item = DiscoveredItem(platform="youtube", external_id="1", url="u", title="cats", description="")
    ok, _ = scoring.passes_filters(item, {"keywords": ["ai"]})
    assert not ok
    item2 = DiscoveredItem(platform="youtube", external_id="2", url="u", title="ai news", description="")
    ok2, _ = scoring.passes_filters(item2, {"keywords": ["ai"]})
    assert ok2


def test_passes_filters_duration_bounds():
    item = DiscoveredItem(platform="youtube", external_id="1", url="u", duration_seconds=10)
    ok, reason = scoring.passes_filters(item, {"min_duration": 60})
    assert not ok and "short" in reason


def test_score_item_rewards_velocity_and_recency():
    cfg = presets.DEFAULT_CONFIG["scoring"]
    fresh_viral = DiscoveredItem(
        platform="youtube", external_id="1", url="u",
        published_at=_now() - timedelta(hours=2),
        metrics={"views": 500_000, "likes": 40_000, "comments": 5_000},
    )
    stale_flop = DiscoveredItem(
        platform="youtube", external_id="2", url="u",
        published_at=_now() - timedelta(hours=600),
        metrics={"views": 50, "likes": 1, "comments": 0},
    )
    s1, b1 = scoring.score_item(fresh_viral, scoring_config=cfg, relevance=80)
    s2, _ = scoring.score_item(stale_flop, scoring_config=cfg, relevance=20)
    assert 0 <= s2 < s1 <= 100
    assert b1["view_velocity"] > 0


def test_score_item_clamped_0_100():
    cfg = presets.DEFAULT_CONFIG["scoring"]
    item = DiscoveredItem(platform="youtube", external_id="1", url="u",
                          published_at=_now(), metrics={"views": 10**9})
    s, _ = scoring.score_item(item, scoring_config=cfg, relevance=100)
    assert 0 <= s <= 100


# ----------------------------------------------------------------- scheduling
def test_active_window_respects_days_hours_quiet():
    mon_noon = datetime(2026, 6, 8, 12, tzinfo=timezone.utc)  # a Monday
    assert is_within_active_window({}, mon_noon)
    assert not is_within_active_window({"days": [5, 6]}, mon_noon)        # weekends only
    assert not is_within_active_window({"hours": [9, 10]}, mon_noon)     # not noon
    assert not is_within_active_window({"quiet_hours": [12]}, mon_noon)  # quiet at noon


def test_compute_next_run_advances_into_window():
    now = datetime(2026, 6, 8, 12, tzinfo=timezone.utc)
    nxt = compute_next_run({"interval_minutes": 60, "hours": [15]}, now)
    assert nxt.hour == 15 and nxt > now


# ---------------------------------------------------------------- misc utils
def test_cosine_basic():
    assert cosine([1, 0], [1, 0]) == 1.0
    assert cosine([1, 0], [0, 1]) == 0.0
    assert cosine([], [1]) == 0.0


def test_parse_date_handles_rfc822_and_iso():
    assert _parse_date("Mon, 08 Jun 2026 12:00:00 GMT") is not None
    assert _parse_date("2026-06-08T12:00:00Z") is not None
    assert _parse_date("garbage") is None


def test_ollama_service_model_routing():
    svc = OllamaService(max_concurrency=1)
    # explicit assignment wins
    assert svc.resolve_model("titles", {"titles": "gemma3:12b"}) == "gemma3:12b"
    # fallback used when no assignment
    assert svc.resolve_model("titles", {}, fallback="llama4") == "llama4"
    # stage default resolves to a configured global model
    assert svc.resolve_model("scoring", {}) != ""
