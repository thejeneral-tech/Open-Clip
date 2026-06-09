from app.services.transcript_utils import (
    clip_words_relative,
    format_for_llm,
    snap_to_boundaries,
    text_in_range,
    words_in_range,
)


def test_words_in_range(sample_segments):
    words = words_in_range(sample_segments, 4.0, 7.0)
    assert [w["word"] for w in words] == ["Today", "we", "reveal", "a", "massive", "secret"]


def test_text_in_range(sample_segments):
    assert "secret" in text_in_range(sample_segments, 4.0, 9.0)
    assert "Welcome" in text_in_range(sample_segments, 0.0, 4.0)


def test_clip_words_relative_rebases_to_zero(sample_segments):
    words = clip_words_relative(sample_segments, 4.0, 9.0)
    assert words[0]["word"] == "Today"
    assert words[0]["start"] == 0.0  # 4.0 - 4.0


def test_snap_to_boundaries(sample_segments):
    # 3.8 should snap to the 4.0 sentence boundary.
    start, end = snap_to_boundaries(3.8, 8.8, sample_segments)
    assert start == 4.0
    assert end == 9.0


def test_format_for_llm_includes_timestamps(sample_segments):
    out = format_for_llm(sample_segments)
    assert "[0.0-4.0]" in out
    assert "secret" in out
