import pytest

from app.services import viral_detection as vd
from app.services.ollama_client import OllamaError
from app.services.viral_detection import CandidateClip, detect_viral_clips


def test_windows_short_video():
    assert vd._windows(120) == [(0.0, 120)]


def test_windows_long_video_overlap():
    windows = vd._windows(1500)
    assert windows[0][0] == 0.0
    assert len(windows) > 1
    # overlapping windows
    assert windows[1][0] < windows[0][1]


def test_normalize_enforces_duration(sample_segments):
    raw = [{"start": 0.0, "end": 3.0, "title": "Hook", "viral_score": 88, "reasoning": "strong"}]
    out = vd._normalize(raw, sample_segments, min_s=5, max_s=90, duration=9.0)
    assert len(out) == 1
    assert out[0].duration >= 5  # extended to the minimum
    assert out[0].transcript_text  # populated from segments


def test_dedupe_overlaps_keeps_highest_score():
    a = CandidateClip(start=0, end=10, title="a", viral_score=90, reasoning="")
    b = CandidateClip(start=1, end=9, title="b", viral_score=50, reasoning="")  # overlaps a
    c = CandidateClip(start=20, end=30, title="c", viral_score=70, reasoning="")
    kept = vd._dedupe_overlaps([a, b, c])
    titles = {clip.title for clip in kept}
    assert "a" in titles and "c" in titles
    assert "b" not in titles


class _FakeClient:
    def generate_json(self, prompt, *, model=None, system=None, schema=None, options=None, retries=2):
        return (
            {"clips": [
                {"start": 0.0, "end": 8.0, "title": "Big reveal", "viral_score": 92, "reasoning": "hook"},
            ]},
            {"model": "fake", "eval_count": 10, "duration_ms": 5.0},
        )


def test_detect_viral_clips_end_to_end(sample_segments):
    clips, analyses = detect_viral_clips(
        sample_segments, duration=9.0, target_count=5, min_seconds=5, max_seconds=90, client=_FakeClient()
    )
    assert len(clips) == 1
    assert clips[0].viral_score == 92
    assert analyses and analyses[0]["analysis_type"] == "viral_detection"


class _BrokenClient:
    """Every call fails — e.g. the configured model isn't installed (404)."""

    def generate_json(self, prompt, *, model=None, system=None, schema=None, options=None, retries=2):
        raise OllamaError("model 'qwen3:32b' not found")


def test_detect_surfaces_model_error_instead_of_empty(sample_segments):
    # When every window fails to reach the model, the caller must see the real
    # cause, not a misleading "No viral clips detected" from an empty result.
    with pytest.raises(OllamaError, match="qwen3:32b"):
        detect_viral_clips(
            sample_segments, duration=9.0, target_count=5,
            min_seconds=5, max_seconds=90, client=_BrokenClient(),
        )
