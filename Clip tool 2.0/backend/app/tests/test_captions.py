from app.services import captions as cap
from app.services.captions import build_tokens, get_style, render_ass, render_srt, render_vtt


def _tokens():
    return [
        {"word": "This", "start": 0.0, "end": 0.3, "emphasis": False, "emoji": None},
        {"word": "is", "start": 0.3, "end": 0.5, "emphasis": False, "emoji": None},
        {"word": "100", "start": 0.5, "end": 0.9, "emphasis": True, "emoji": "🔥"},
        {"word": "percent", "start": 0.9, "end": 1.4, "emphasis": False, "emoji": None},
    ]


def test_build_tokens_skips_blanks():
    words = [{"word": " hi ", "start": 0, "end": 1}, {"word": "  ", "start": 1, "end": 2}]
    tokens = build_tokens(words)
    assert len(tokens) == 1
    assert tokens[0]["word"] == "hi"


def test_build_tokens_strips_commas():
    words = [
        {"word": "However,", "start": 0, "end": 1},
        {"word": "1,000", "start": 1, "end": 2},
        {"word": ",", "start": 2, "end": 3},  # lone comma -> dropped
    ]
    tokens = build_tokens(words)
    assert [t["word"] for t in tokens] == ["However", "1000"]


def _style_fields(ass: str) -> list[str]:
    line = next(l for l in ass.splitlines() if l.startswith("Style: Default"))
    return line.split(",")


def test_render_ass_events_format_field_count_matches_dialogue():
    # The [Events] Format must declare the same number of fields that each
    # Dialogue line provides (incl. the empty Name) — otherwise libass shifts
    # the columns and the Text field absorbs a stray leading comma.
    ass = render_ass(_tokens(), "hormozi", 1080, 1920)
    fmt = next(l for l in ass.splitlines()
               if l.startswith("Format:") and "Text" in l and "Start" in l)
    assert "Name" in fmt
    n_fields = len(fmt.split(":", 1)[1].split(","))
    dialogue = next(l for l in ass.splitlines() if l.startswith("Dialogue"))
    # values before the Text field == n_fields - 1
    head = dialogue.split(":", 1)[1].split(",", n_fields - 1)
    assert len(head) == n_fields


def test_render_ass_caption_text_has_no_leading_comma():
    tokens = build_tokens([
        {"word": "Well,", "start": 0.0, "end": 0.4},
        {"word": "1,000", "start": 0.4, "end": 0.8},
    ])
    ass = render_ass(tokens, "hormozi", 1080, 1920)
    fmt = next(l for l in ass.splitlines()
               if l.startswith("Format:") and "Text" in l and "Start" in l)
    n_fields = len(fmt.split(":", 1)[1].split(","))
    for line in ass.splitlines():
        if line.startswith("Dialogue"):
            text = line.split(",", n_fields - 1)[n_fields - 1]
            assert "," not in text
            assert not text.lstrip().startswith(",")


def test_render_ass_size_is_65_percent():
    style = get_style("hormozi")
    ass = render_ass(_tokens(), "hormozi", 1080, 1920)
    fontsize = int(_style_fields(ass)[2])
    assert fontsize == max(12, round(style.font_scale * 1920 * cap.CAPTION_SIZE_SCALE))
    assert fontsize < round(style.font_scale * 1920)  # smaller than full size


def test_render_ass_anchors_to_lower_third():
    # All presets render bottom-centered (alignment 2) in the lower third,
    # regardless of the preset's own placement (hormozi is normally centered).
    for name in ["hormozi", "modern_tiktok", "minimal", "gaming", "podcast"]:
        fields = _style_fields(render_ass(_tokens(), name, 1080, 1920))
        alignment, margin_v = int(fields[-5]), int(fields[-2])
        assert alignment == 2
        assert margin_v == round(1920 * cap.CAPTION_MARGIN_V_FRAC)
        # bottom of the lower third of a 1920-tall frame starts at y=1280
        assert 1920 - margin_v >= 1280


def test_render_ass_has_header_and_events():
    ass = render_ass(_tokens(), "hormozi", 1080, 1920)
    assert "[V4+ Styles]" in ass
    assert "PlayResX: 1080" in ass
    assert "Dialogue:" in ass


def test_render_ass_uppercases_for_hormozi():
    ass = render_ass(_tokens(), "hormozi", 1080, 1920)
    assert "PERCENT" in ass  # uppercase style
    assert "🔥" in ass        # emoji preserved


def test_render_srt_and_vtt():
    srt = render_srt(_tokens())
    assert "-->" in srt
    assert "00:00:00,000" in srt
    vtt = render_vtt(_tokens())
    assert vtt.startswith("WEBVTT")
    assert "00:00:00.000" in vtt


def test_all_styles_exist():
    for name in ["hormozi", "modern_tiktok", "minimal", "gaming", "podcast"]:
        assert get_style(name).fontname


def test_group_tokens_respects_max_words():
    style = get_style("minimal")  # max_words 6
    tokens = build_tokens([{"word": f"w{i}", "start": i, "end": i + 0.4} for i in range(14)])
    groups = cap.group_tokens(tokens, style)
    assert all(len(g) <= style.max_words for g in groups)
    assert sum(len(g) for g in groups) == 14
