"""Cloned-voice (Fish Speech) caption text fix.

The s2 engine returns only a WAV, so word timings are recovered by aligning the
synthesized speech with faster-whisper. Whisper, though, transcribes what it
*hears* from the synthetic voice — which drifts from the script (mishearings,
merged words, numbers spelled out). These tests pin the fix: whisper supplies
only the *timing*; the caption **text** is always the known script, so a
mis-recognised word never reaches the burned-in captions. Pure helpers, no
server / no GPU needed.
"""
from app.services.storyvault import fish_clone


def _ww(*spec):
    """[(word, start, end)] -> recognised-word tokens."""
    return [{"word": w, "start": s, "end": e} for w, s, e in spec]


# ----------------------------------------------- script text wins over whisper
def test_align_keeps_script_text_over_whisper_mishearing():
    # Whisper misheard "refused"->"refuse" and "to"->"too"; the captions must
    # still read the script verbatim, not whisper's slurred guess.
    text = "I refused to sign the form"
    whisper = _ww(
        ("I", 0.0, 0.2),
        ("refuse", 0.2, 0.7),   # misheard "refused"
        ("too", 0.7, 0.9),      # misheard "to"
        ("sign", 0.9, 1.3),
        ("the", 1.3, 1.5),
        ("form", 1.5, 2.0),
    )
    words = fish_clone._align_to_text(text, whisper, 2.0)
    assert [w["word"] for w in words] == ["I", "refused", "to", "sign", "the", "form"]
    # Recognised words keep their measured timing...
    assert (words[0]["start"], words[0]["end"]) == (0.0, 0.2)
    assert words[3]["start"] == 0.9            # "sign" anchored
    assert words[5]["end"] == 2.0
    # ...and the two misheard words are interpolated between their anchors.
    assert 0.2 <= words[1]["start"] and words[2]["end"] <= 0.9
    starts = [w["start"] for w in words]
    assert starts == sorted(starts)            # monotonic timeline


def test_align_preserves_script_numbers_spelled_out_by_whisper():
    # "4" is voiced as "four"; the caption keeps the digit from the script.
    text = "for 4 hours"
    whisper = _ww(("for", 0.0, 0.3), ("four", 0.3, 0.7), ("hours", 0.7, 1.2))
    words = fish_clone._align_to_text(text, whisper, 1.2)
    assert [w["word"] for w in words] == ["for", "4", "hours"]
    assert 0.3 <= words[1]["start"] and words[1]["end"] <= 0.7


def test_align_always_returns_one_token_per_script_word():
    # Whisper dropped/garbled the middle words; every script word still gets a
    # caption token, in order, with a non-zero on-screen window.
    text = "alpha bravo charlie delta echo"
    whisper = _ww(("alpha", 0.0, 0.5), ("xx", 0.5, 0.7), ("echo", 0.9, 1.4))
    words = fish_clone._align_to_text(text, whisper, 1.4)
    assert [w["word"] for w in words] == ["alpha", "bravo", "charlie", "delta", "echo"]
    starts = [w["start"] for w in words]
    assert starts == sorted(starts)
    assert all(w["end"] > w["start"] for w in words)
    assert words[0]["start"] == 0.0 and words[-1]["end"] == 1.4


# --------------------------------------------------------- robust fallbacks
def test_align_falls_back_to_even_spacing_without_whisper():
    # No recognised words at all → space the script evenly (still correct text).
    words = fish_clone._align_to_text("one two three four", [], 4.0)
    assert [w["word"] for w in words] == ["one", "two", "three", "four"]
    assert words[0]["start"] == 0.0
    assert abs(words[-1]["end"] - 4.0) < 1e-6


def test_align_falls_back_when_nothing_aligns():
    # Whisper heard something entirely different (no overlap) → even spacing.
    text = "hello world"
    whisper = _ww(("zzz", 0.0, 0.5), ("qqq", 0.5, 1.0))
    words = fish_clone._align_to_text(text, whisper, 1.0)
    assert [w["word"] for w in words] == ["hello", "world"]
    assert words[0]["start"] == 0.0
    assert abs(words[-1]["end"] - 1.0) < 1e-6


def test_align_caps_pathological_stretch():
    # Whisper missed "middle" and the surrounding anchors are implausibly far
    # apart (a hallucination/duplication artifact). The unmatched word would span
    # ~19s; it's bounded so the highlight can never stall on screen.
    text = "start middle end"
    whisper = _ww(("start", 0.0, 0.3), ("end", 20.0, 20.5))
    words = fish_clone._align_to_text(text, whisper, 20.5)
    assert [w["word"] for w in words] == ["start", "middle", "end"]
    assert words[1]["end"] - words[1]["start"] <= fish_clone._MAX_WORD_DUR + 1e-6


def test_align_handles_punctuation_attached_by_whisper():
    # faster-whisper returns words with attached punctuation/leading spaces; the
    # match is on the normalised token, so they still anchor.
    text = "Wait. What happened next?"
    whisper = _ww((" Wait,", 0.0, 0.4), (" what", 0.4, 0.8),
                  (" happened", 0.8, 1.4), (" next.", 1.4, 1.9))
    words = fish_clone._align_to_text(text, whisper, 1.9)
    assert [w["word"] for w in words] == ["Wait.", "What", "happened", "next?"]
    assert (words[0]["start"], words[0]["end"]) == (0.0, 0.4)
    assert words[3]["end"] == 1.9
