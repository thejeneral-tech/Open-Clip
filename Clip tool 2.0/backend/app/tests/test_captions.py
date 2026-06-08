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
