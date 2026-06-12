"""SAPI narration: duplicate-boundary de-dup + multi-beat story split.

These exercise the pure timing helpers (no SAPI / no Windows needed) plus
``synthesize_story`` with the SAPI driver monkeypatched, so they run anywhere.
"""
from app.services.storyvault import tts


# --------------------------------------------------- doubled word/number fix
def test_build_words_collapses_same_source_span():
    # SAPI voices "34" as "thirty four" → two boundary events that BOTH report
    # the same source span ("34"). Without de-dup the caption reads "34 34".
    raw = [
        {"word": "I", "audioMs": 0, "charPos": 0, "charCount": 1},
        {"word": "am", "audioMs": 300, "charPos": 2, "charCount": 2},
        {"word": "34", "audioMs": 600, "charPos": 5, "charCount": 2},   # "thirty"
        {"word": "34", "audioMs": 1000, "charPos": 5, "charCount": 2},  # "four" (same span)
        {"word": "years", "audioMs": 1400, "charPos": 8, "charCount": 5},
    ]
    words = tts._build_words(raw, 2.0)
    assert [w["word"] for w in words] == ["I", "am", "34", "years"]
    # The single "34" spans both spoken syllables, up to the next word.
    num = next(w for w in words if w["word"] == "34")
    assert num["start"] == 0.6 and num["end"] == 1.4


def test_build_words_keeps_genuine_repeats():
    # A real repeated word has DISTINCT source positions, so it must survive.
    raw = [
        {"word": "very", "audioMs": 0, "charPos": 0, "charCount": 4},
        {"word": "very", "audioMs": 400, "charPos": 5, "charCount": 4},
        {"word": "good", "audioMs": 800, "charPos": 10, "charCount": 4},
    ]
    assert [w["word"] for w in tts._build_words(raw, 1.5)] == ["very", "very", "good"]


# ----------------------------------------------------- multi-beat narration
PARTS = [
    {"kind": "card", "text": "Title here."},        # chars [0, 11)
    {"kind": "author", "text": "Posted by Bob."},    # chars [13, 27)
    {"kind": "body", "text": "Body word one."},      # chars [29, 43)
]


def test_assemble_tracks_char_ranges():
    combined, ranges = tts._assemble(PARTS)
    assert combined == "Title here.\n\nPosted by Bob.\n\nBody word one."
    assert [r["kind"] for r in ranges] == ["card", "author", "body"]
    assert ranges[0]["start_char"] == 0 and ranges[2]["end_char"] == len(combined)


def _words_at(*specs):
    """[(word, charPos)] -> caption tokens with dummy timings + char map."""
    return [
        {"word": w, "start": i * 0.1, "end": i * 0.1 + 0.1, "charPos": cp, "charCount": len(w)}
        for i, (w, cp) in enumerate(specs)
    ]


def test_split_by_kind_uses_char_positions():
    _, ranges = tts._assemble(PARTS)
    words = _words_at(
        ("Title", 0), ("here", 6),
        ("Posted", 13), ("by", 20), ("Bob", 23),
        ("Body", 29), ("word", 34), ("one", 39),
    )
    grouped = tts._split_by_kind(words, ranges)
    assert [w["word"] for w in grouped["card"]] == ["Title", "here"]
    assert [w["word"] for w in grouped["author"]] == ["Posted", "by", "Bob"]
    assert [w["word"] for w in grouped["body"]] == ["Body", "word", "one"]


def test_split_by_kind_falls_back_to_word_counts():
    # No char map (even-spacing fallback) → split on each part's word count.
    _, ranges = tts._assemble(PARTS)  # counts: 2, 3, 3
    words = [{"word": f"w{i}", "start": i, "end": i + 0.5} for i in range(8)]
    grouped = tts._split_by_kind(words, ranges)
    assert [w["word"] for w in grouped["card"]] == ["w0", "w1"]
    assert [w["word"] for w in grouped["author"]] == ["w2", "w3", "w4"]
    assert [w["word"] for w in grouped["body"]] == ["w5", "w6", "w7"]


def test_synthesize_story_windows_track_narration(monkeypatch):
    # Card shows from t=0 until the author voice; author until the body voice;
    # body captions begin exactly when the body narration does.
    raw = [
        {"word": "Title", "audioMs": 0, "charPos": 0, "charCount": 5},
        {"word": "here", "audioMs": 400, "charPos": 6, "charCount": 4},
        {"word": "Posted", "audioMs": 1200, "charPos": 13, "charCount": 6},
        {"word": "by", "audioMs": 1600, "charPos": 20, "charCount": 2},
        {"word": "Bob", "audioMs": 1800, "charPos": 23, "charCount": 3},
        {"word": "Body", "audioMs": 2600, "charPos": 29, "charCount": 4},
        {"word": "word", "audioMs": 3000, "charPos": 34, "charCount": 4},
        {"word": "one", "audioMs": 3400, "charPos": 39, "charCount": 3},
    ]
    monkeypatch.setattr(tts, "_run_sapi", lambda *a, **k: (raw, 4.0))

    narr = tts.synthesize_story(PARTS, "ignored.wav", voice=None, speed=1.0)
    assert narr.card_window == (0.0, 1.2)
    assert narr.author_window == (1.2, 2.6)
    assert narr.body_start == 2.6
    assert [w["word"] for w in narr.body_words] == ["Body", "word", "one"]
    # Body tokens are cleaned of the internal char bookkeeping.
    assert all(set(w) == {"word", "start", "end"} for w in narr.body_words)
