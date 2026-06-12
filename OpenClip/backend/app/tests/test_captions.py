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


# --------------------------------------------------------------- overlap bug
def _dialogue_spans(ass: str) -> list[tuple[float, float]]:
    """(start, end) seconds for every Dialogue event, in file order."""
    def secs(t: str) -> float:
        h, m, rest = t.split(":")
        return int(h) * 3600 + int(m) * 60 + float(rest)

    spans = []
    for line in ass.splitlines():
        if line.startswith("Dialogue:"):
            parts = line.split(",", 3)
            spans.append((secs(parts[1]), secs(parts[2])))
    return spans


def test_sanitize_timing_is_monotonic_and_non_overlapping():
    # Out-of-order / overlapping ASR output (word 2 starts before word 1 ends,
    # word 3 runs backwards) is the real-world cause of the stacked captions.
    messy = [
        {"word": "a", "start": 0.0, "end": 0.5},
        {"word": "b", "start": 0.3, "end": 0.4},   # overlaps a, ends early
        {"word": "c", "start": 0.2, "end": 0.2},   # backwards + zero length
        {"word": "d", "start": 1.0, "end": 1.4},
    ]
    clean = cap.sanitize_timing(messy)
    for i in range(len(clean) - 1):
        assert clean[i]["end"] <= clean[i + 1]["start"] + 1e-9
        assert clean[i]["end"] > clean[i]["start"]  # every word has real duration
    # Well-behaved input must pass through untouched (no drift).
    good = _tokens()
    assert cap.sanitize_timing(good) == good


def test_render_ass_never_overlaps_even_with_bad_timings():
    messy = build_tokens([
        {"word": "brave", "start": 0.0, "end": 0.6},
        {"word": "bro", "start": 0.4, "end": 0.9},     # overlaps "brave"
        {"word": "the", "start": 0.3, "end": 0.5},     # runs backwards
        {"word": "thing", "start": 0.9, "end": 1.2},
        {"word": "I", "start": 1.1, "end": 1.15},      # overlaps "thing"
        {"word": "was", "start": 1.5, "end": 2.0},
    ])
    for name in ["hormozi", "modern_tiktok", "minimal", "gaming", "podcast"]:
        spans = _dialogue_spans(cap.render_ass(messy, name, 1080, 1920))
        assert spans, f"{name} produced no events"
        for i in range(len(spans) - 1):
            assert spans[i][1] <= spans[i + 1][0] + 1e-6, (
                f"{name}: event {i} ends at {spans[i][1]} after event "
                f"{i + 1} starts at {spans[i + 1][0]}"
            )
        assert all(end > start for start, end in spans)


def test_build_segments_holds_until_next_group_no_gaps():
    # Within a group the cue tiles continuously; the group is then held right up
    # to the next group's first word so the centre is never blank.
    style = get_style("hormozi")  # max_words 4
    tokens = build_tokens([{"word": f"w{i}", "start": i * 0.5, "end": i * 0.5 + 0.3}
                           for i in range(9)])
    segs = cap.build_segments(tokens, style)
    for i in range(len(segs) - 1):
        assert abs(segs[i]["end"] - segs[i + 1]["start"]) < 1e-6  # contiguous


def test_audit_timeline_reports_no_overlaps():
    messy = build_tokens([
        {"word": "x", "start": 0.0, "end": 0.9},
        {"word": "y", "start": 0.2, "end": 0.3},
        {"word": "z", "start": 0.1, "end": 0.1},
    ])
    audit = cap.audit_timeline(messy, "hormozi")
    assert audit["overlaps"] == 0
    assert audit["groups"] >= 1


# ----------------------------------------------------- preset (template) overrides
def test_norm_ass_color_accepts_ass_and_css():
    assert cap._norm_ass_color("&H0000F0FF") == "&H0000F0FF"
    assert cap._norm_ass_color("&hff00ff") == "&H00FF00FF"        # 6-digit → alpha 00, upper
    assert cap._norm_ass_color("&H8000F0FF") == "&H8000F0FF"      # 8-digit alpha preserved
    assert cap._norm_ass_color("#ffffff") == "&H00FFFFFF"          # white #RRGGBB → ASS BGR
    assert cap._norm_ass_color("#ff0000") == "&H000000FF"          # red → B0 G0 Rff
    assert cap._norm_ass_color("nonsense") is None
    assert cap._norm_ass_color(None) is None


def test_render_ass_overrides_apply_colours_size_outline():
    ass = render_ass(
        _tokens(), "modern_tiktok", 1080, 1920,
        overrides={"primary": "&H00FFFFFF", "highlight": "&H0000F0FF",
                   "size": 120, "outline": 9},
    )
    fields = _style_fields(ass)
    assert fields[2] == "120"            # font size used verbatim
    assert fields[3] == "&H00FFFFFF"     # primary colour
    assert fields[4] == "&H0000F0FF"     # highlight colour
    assert fields[16] == "9.0"           # outline width


def test_render_ass_overrides_pin_vertical_centre():
    ass = render_ass(_tokens(), "modern_tiktok", 1080, 1920, overrides={"centerY": 960})
    fields = _style_fields(ass)
    assert int(fields[-5]) == 5          # alignment middle-centre
    assert int(fields[-2]) == 0          # margin handed to \pos instead
    dialogue = [l for l in ass.splitlines() if l.startswith("Dialogue")]
    assert dialogue and all("\\an5\\pos(540,960)" in l for l in dialogue)


def test_render_ass_overrides_margin_v_converts_to_centre():
    # marginV (from the bottom) → centre at height − marginV when centerY absent.
    ass = render_ass(_tokens(), "modern_tiktok", 1080, 1920, overrides={"marginV": 520})
    dialogue = [l for l in ass.splitlines() if l.startswith("Dialogue")]
    assert dialogue and all("\\pos(540,1400)" in l for l in dialogue)  # 1920 - 520


def test_render_ass_pop_style_disables_karaoke_highlight():
    ass = render_ass(
        _tokens(), "modern_tiktok", 1080, 1920,
        overrides={"style": "pop", "primary": "&H00FFFFFF", "highlight": "&H0000F0FF"},
    )
    fields = _style_fields(ass)
    assert fields[4] == fields[3] == "&H00FFFFFF"  # highlight collapses to primary
    # No spoken word lights up in the highlight colour anywhere in the cues.
    assert "&H0000F0FF" not in ass


def test_render_ass_no_overrides_keeps_lower_third():
    # Backward compatible: absent overrides → unchanged bottom-centred placement.
    ass = render_ass(_tokens(), "modern_tiktok", 1080, 1920)
    fields = _style_fields(ass)
    assert int(fields[-5]) == 2
    assert int(fields[-2]) == round(1920 * cap.CAPTION_MARGIN_V_FRAC)
    assert "\\pos(" not in ass
