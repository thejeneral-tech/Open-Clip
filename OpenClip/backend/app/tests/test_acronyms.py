"""Acronym spell-out for narration (``tts.speechify_acronyms``).

Pins the two behaviours the voice depends on: recognised acronyms are read
letter-by-letter, while a writer's CAPS *emphasis* (NO, NEVER, STOP, FINE) is
left alone so it isn't mangled into "en oh" / "ess tee oh pee". Pure string
helper — no SAPI, no audio.
"""
from app.services.storyvault.tts import speechify_acronyms


def test_known_acronyms_spelled_as_bare_letters():
    # Each recognised acronym becomes its bare, space-separated letters with a
    # trailing period, so the voice spells it as its own deliberate unit.
    assert speechify_acronyms("WIBTA for leaving?") == "W I B T A. for leaving?"
    assert speechify_acronyms("AITA? My MIL is mad.") == "A I T A.? My M I L. is mad."
    assert speechify_acronyms("OP said NTA.") == "O P. said N T A.."


def test_vowelless_initialisms_spelled_even_when_not_listed():
    # BF / DH / DW / TV aren't in the allowlist but are vowel-less initialisms.
    assert speechify_acronyms("My BF and DH watch TV") == "My B F. and D H. watch T V."


def test_emphasis_words_are_left_alone():
    # Every common emphasis word has a vowel and is not an acronym → untouched.
    for word in ("NO", "YES", "STOP", "NEVER", "FINE", "DONE", "REALLY", "OKAY"):
        assert speechify_acronyms(f"I said {word} to him") == f"I said {word} to him"


def test_non_acronym_abbreviations_left_alone():
    assert speechify_acronyms("MR and DR and ST") == "MR and DR and ST"


def test_possessive_acronym_keeps_suffix():
    assert speechify_acronyms("OP's car") == "O P.'s car"


def test_long_caps_runs_are_not_treated_as_acronyms():
    # 7+ letters is far more likely a shouted word than an initialism.
    assert speechify_acronyms("I was SERIOUSLY upset") == "I was SERIOUSLY upset"


def test_no_acronyms_is_a_passthrough():
    text = "Just a normal sentence with no acronyms at all."
    assert speechify_acronyms(text) == text
