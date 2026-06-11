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
    assert out[0].duration >= 5  # extended past the minimum (capped by the 9s clip)
    assert out[0].transcript_text  # populated from segments


_STEP = 5.0  # sentence length in the synthetic transcript below


def _long_segments(total: float = 200.0, step: float = _STEP):
    segs, t, i = [], 0.0, 0
    while t < total:
        segs.append({"id": i, "start": t, "end": t + step,
                     "text": f"sentence {i}.", "words": []})
        t += step
        i += 1
    return segs


def test_normalize_biases_toward_high_end():
    # A 3s hook from the model should be extended toward the high end of the
    # range (target ~= min + 0.7*(max-min)), not pinned to the minimum.
    segs = _long_segments()
    min_s, max_s = 8, 90
    raw = [{"start": 20.0, "end": 23.0, "title": "Hook", "viral_score": 90, "reasoning": "x"}]
    out = vd._normalize(raw, segs, min_s=min_s, max_s=max_s, duration=200.0)
    assert len(out) == 1
    clip = out[0]
    target = vd._target_len(min_s, max_s)
    assert clip.start == 20.0                       # hook preserved
    assert clip.duration >= target - _STEP          # reached the high-side target
    assert clip.duration <= max_s                   # within the hard cap
    assert clip.end % _STEP == 0                     # snapped to a sentence boundary


def test_normalize_clamps_overlong_clip_to_max():
    # A clip the model returns longer than max_s is trimmed back to max_s.
    segs = _long_segments()
    raw = [{"start": 0.0, "end": 100.0, "title": "Long", "viral_score": 90, "reasoning": "x"}]
    out = vd._normalize(raw, segs, min_s=8, max_s=30, duration=200.0)
    assert out[0].duration <= 30


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
