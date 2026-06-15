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


# ---------------------------------------------- acronym spelling
def test_speechify_spells_acronyms_as_bare_letters():
    # Bare spaced letters — a fluent, distinct spelling on both SAPI and the s2
    # cloned voice (verified by transcribing the audio).
    assert tts.speechify_acronyms("AITA") == "A I T A"
    assert tts.speechify_acronyms("TIFU") == "T I F U"
    assert tts.speechify_acronyms("OP") == "O P"


def test_speechify_keeps_sentence_and_punctuation():
    # Only the acronym is rewritten; the rest of the line (and trailing ?) stays.
    out = tts.speechify_acronyms("AITA for refusing to sign off on 4 hours?")
    assert out == "A I T A for refusing to sign off on 4 hours?"


def test_speechify_leaves_normal_words_numbers_and_single_letters():
    # Sentence-case words, digits, and lone capitals (A / I) are untouched.
    for s in ["Hello world", "I had a dog", "the year 2010", "grade A work"]:
        assert tts.speechify_acronyms(s) == s


def test_speechify_ignores_overlong_caps_runs():
    # 7+ all-caps is more likely a shouted word than an acronym — left alone.
    assert tts.speechify_acronyms("AAAAAAA") == "AAAAAAA"


# ----------------------------------------- real-audio timeline calibration
def test_build_words_compresses_overshooting_sapi_clock():
    # SAPI's AudioPosition runs ahead of the rendered WAV: here the last word is
    # reported at 12.0s for a clip whose real audio is only 10.0s long. Without
    # calibration that word lands past the trimmed video end and its caption is
    # cut off; after it, the last word starts _LAST_WORD_TAIL before the true end
    # and every word is pulled back proportionally (first word anchored).
    raw = [
        {"word": "one", "audioMs": 0, "charPos": 0, "charCount": 3},
        {"word": "two", "audioMs": 6000, "charPos": 4, "charCount": 3},
        {"word": "three", "audioMs": 12000, "charPos": 8, "charCount": 5},
    ]
    words = tts._build_words(raw, 10.0)
    assert [w["word"] for w in words] == ["one", "two", "three"]
    assert words[0]["start"] == 0.0                       # first word anchored
    assert words[-1]["start"] == round(10.0 - tts._LAST_WORD_TAIL, 3)  # 9.555
    # Linear: the midpoint word sits halfway along the compressed span.
    assert abs(words[1]["start"] - words[-1]["start"] / 2) < 0.01
    # Every word now lands inside the real audio.
    assert all(w["start"] < 10.0 for w in words)


def test_build_words_leaves_fitting_clock_untouched():
    # When SAPI's clock already fits the audio (no overshoot), nothing moves.
    raw = [
        {"word": "a", "audioMs": 0, "charPos": 0, "charCount": 1},
        {"word": "b", "audioMs": 1000, "charPos": 2, "charCount": 1},
        {"word": "c", "audioMs": 2000, "charPos": 4, "charCount": 1},
    ]
    words = tts._build_words(raw, 5.0)
    assert [w["start"] for w in words] == [0.0, 1.0, 2.0]


# ------------------------------------------- speech-envelope / run-pinning
def test_speech_bounds_classifies_silences():
    # Lead-in → speech onset; trailing pad → speech offset; the rest are pauses.
    sil = [(0.0, 0.2), (2.0, 3.0), (5.5, 6.0)]
    start, end, pauses = tts._speech_bounds(sil, 6.0)
    assert (start, end) == (0.2, 5.5)
    assert pauses == [(2.0, 3.0)]


def test_speech_bounds_rejects_implausible_envelope():
    # If detection flags most of the clip as silent, distrust it and fall back.
    start, end, pauses = tts._speech_bounds([(0.0, 5.0)], 6.0)
    assert (start, end, pauses) == (0.0, 6.0, [])


def test_build_words_pins_runs_to_real_speech():
    # Two 3-word clauses, an over-running SAPI clock, and a real pause at 2.0-3.0s
    # with the audio padded out to 6.0s. Each clause must be pinned to its real
    # silence-bounded run, so the second clause's first word lands EXACTLY where
    # the voice resumes after the pause (3.0s) — not late, not in the silence.
    raw = [
        {"word": "the", "audioMs": 0, "charPos": 0, "charCount": 3},
        {"word": "first", "audioMs": 500, "charPos": 4, "charCount": 5},
        {"word": "clause", "audioMs": 1000, "charPos": 10, "charCount": 6},
        {"word": "second", "audioMs": 4000, "charPos": 17, "charCount": 6},
        {"word": "clause", "audioMs": 4500, "charPos": 24, "charCount": 6},
        {"word": "here", "audioMs": 5000, "charPos": 31, "charCount": 4},
    ]
    silences = [(2.0, 3.0), (5.5, 6.0)]  # one internal pause + trailing pad
    words = tts._build_words(raw, 6.0, silences)
    assert [w["word"] for w in words] == ["the", "first", "clause", "second", "clause", "here"]
    assert words[0]["start"] == 0.0       # clause 1 opens at the speech onset
    assert words[3]["start"] == 3.0       # clause 2 opens exactly as the voice resumes
    starts = [w["start"] for w in words]
    assert starts == sorted(starts)       # monotonic
    assert all(w["start"] < 5.5 for w in words)   # all inside the real speech span
    assert words[-1]["end"] <= 5.5 + 1e-6         # held to speech end, not into the pad


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
