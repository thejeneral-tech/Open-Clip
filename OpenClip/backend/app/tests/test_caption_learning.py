"""The caption self-tuning profile: fast content slows a preset, calm relaxes it."""
import json

import pytest

from app.services import caption_learning as cl
from app.services import captions as cap


@pytest.fixture
def tmp_profile(tmp_path, monkeypatch):
    """Point the profile at a throwaway dir so the real one is never touched."""
    monkeypatch.setattr(cl.settings, "DATA_DIR", str(tmp_path))
    return tmp_path / "caption_profile.json"


def test_no_opinion_before_learning(tmp_profile):
    assert cl.suggest_max_words("hormozi") is None  # fresh install = use the preset


def test_sustained_fast_content_reduces_words_then_relaxes(tmp_profile):
    base = cap.get_style("modern_tiktok").max_words  # 5
    for _ in range(8):
        cl.record_render("modern_tiktok", {"groups": 10, "fast_groups": 9, "overlaps": 0})
    learned = cl.suggest_max_words("modern_tiktok")
    assert learned is not None and learned < base  # slowed down

    for _ in range(25):
        cl.record_render("modern_tiktok", {"groups": 10, "fast_groups": 0, "overlaps": 0})
    assert cl.suggest_max_words("modern_tiktok") is None  # back to the preset


def test_delta_is_bounded(tmp_profile):
    for _ in range(50):
        cl.record_render("hormozi", {"groups": 10, "fast_groups": 10, "overlaps": 0})
    data = json.loads(tmp_profile.read_text(encoding="utf-8"))
    assert data["styles"]["hormozi"]["max_words_delta"] >= -2  # never collapses below floor
    assert cl.suggest_max_words("hormozi") >= 2


def test_record_render_ignores_empty(tmp_profile):
    cl.record_render("hormozi", {"groups": 0, "fast_groups": 0, "overlaps": 0})
    assert not tmp_profile.exists()  # nothing learned from a no-op render
