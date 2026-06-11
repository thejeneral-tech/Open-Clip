"""Caption generation.

Turns clip words into styled, animated captions:

* word-level highlighting (the spoken word "pops"),
* AI-chosen emphasis + tasteful emoji insertion,
* five presets (Hormozi, Modern TikTok, Minimal, Gaming, Podcast),
* burned-in **ASS** output plus standalone **SRT** / **VTT** files.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.core.logging import get_logger
from app.models.enums import CaptionStyle
from app.services import prompts
from app.services.ollama_client import OllamaClient, ollama

logger = get_logger(__name__)


def _ass_color(r: int, g: int, b: int) -> str:
    """ASS colour literal: &HAABBGGRR (alpha 00 = opaque)."""
    return f"&H00{b:02X}{g:02X}{r:02X}"


@dataclass
class StylePreset:
    fontname: str
    font_scale: float          # fraction of frame height
    bold: bool
    uppercase: bool
    primary: str               # base text colour
    highlight: str             # active/emphasis colour
    outline_color: str
    outline: float
    shadow: float
    alignment: int             # ASS numpad alignment (2=bottom-c, 5=middle-c)
    margin_v: int              # vertical margin (px, scaled by output)
    active_scale: float        # how much the active word grows
    max_words: int             # words shown together
    max_gap: float = 0.6       # split a group on silences longer than this


WHITE = _ass_color(255, 255, 255)
BLACK = _ass_color(0, 0, 0)

# Global caption layout (applied at render time, on top of every preset):
#   * size   — 65% of each preset's nominal font size,
#   * position — anchored bottom-center in the lower third of the frame.
# These are fractions of the output frame height, so they hold across aspect
# ratios / resolutions.
CAPTION_SIZE_SCALE = 0.65
CAPTION_ALIGNMENT = 2              # ASS numpad: 2 = bottom-center
CAPTION_MARGIN_V_FRAC = 0.15      # text baseline sits ~15% up from the bottom

STYLES: dict[str, StylePreset] = {
    CaptionStyle.HORMOZI.value: StylePreset(
        fontname="DejaVu Sans", font_scale=0.072, bold=True, uppercase=True,
        primary=WHITE, highlight=_ass_color(57, 229, 8), outline_color=BLACK,
        outline=4.0, shadow=1.5, alignment=5, margin_v=60, active_scale=1.14, max_words=4,
    ),
    CaptionStyle.MODERN_TIKTOK.value: StylePreset(
        fontname="DejaVu Sans", font_scale=0.055, bold=True, uppercase=False,
        primary=WHITE, highlight=_ass_color(254, 44, 85), outline_color=BLACK,
        outline=3.0, shadow=1.0, alignment=2, margin_v=180, active_scale=1.08, max_words=5,
    ),
    CaptionStyle.MINIMAL.value: StylePreset(
        fontname="DejaVu Sans", font_scale=0.045, bold=False, uppercase=False,
        primary=WHITE, highlight=WHITE, outline_color=BLACK,
        outline=2.0, shadow=0.0, alignment=2, margin_v=120, active_scale=1.0, max_words=6,
    ),
    CaptionStyle.GAMING.value: StylePreset(
        fontname="DejaVu Sans", font_scale=0.062, bold=True, uppercase=True,
        primary=WHITE, highlight=_ass_color(0, 255, 0), outline_color=_ass_color(20, 0, 40),
        outline=4.5, shadow=2.5, alignment=2, margin_v=160, active_scale=1.12, max_words=4,
    ),
    CaptionStyle.PODCAST.value: StylePreset(
        fontname="DejaVu Sans", font_scale=0.05, bold=True, uppercase=False,
        primary=WHITE, highlight=_ass_color(255, 209, 102), outline_color=BLACK,
        outline=2.5, shadow=1.0, alignment=2, margin_v=140, active_scale=1.05, max_words=6,
    ),
}


def get_style(name: str) -> StylePreset:
    return STYLES.get(name, STYLES[CaptionStyle.HORMOZI.value])


# --------------------------------------------------------------------- tokens
def build_tokens(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Initial caption tokens from clip-relative words."""
    tokens: list[dict[str, Any]] = []
    for w in words:
        # Captions read cleaner without commas ("however," -> "however",
        # "1,000" -> "1000"); strip them at the source so every render path
        # (ASS / SRT / VTT) is comma-free.
        word = str(w.get("word", "")).replace(",", "").strip()
        if not word:
            continue
        tokens.append(
            {
                "word": word,
                "start": float(w["start"]),
                "end": float(w["end"]),
                "emphasis": False,
                "emoji": None,
            }
        )
    return tokens


def apply_emphasis(
    tokens: list[dict[str, Any]],
    *,
    model: str | None = None,
    client: OllamaClient | None = None,
    add_emojis: bool = True,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Ask the LLM which words to emphasize and where to add emojis."""
    client = client or ollama
    if not tokens:
        return tokens, {}
    words_block = "\n".join(f"{i}: {t['word']}" for i, t in enumerate(tokens))
    try:
        parsed, meta = client.generate_json(
            prompts.EMPHASIS_USER_TEMPLATE.format(words=words_block),
            model=model,
            system=prompts.EMPHASIS_SYSTEM,
            schema=prompts.EMPHASIS_SCHEMA,
            options={"temperature": 0.4},
        )
    except Exception as exc:
        logger.warning("Emphasis generation failed, using heuristic: %s", exc)
        return heuristic_emphasis(tokens), {}

    emphasize = set(parsed.get("emphasize", []) if isinstance(parsed, dict) else [])
    emojis = parsed.get("emojis", {}) if isinstance(parsed, dict) else {}
    for i, tok in enumerate(tokens):
        tok["emphasis"] = i in emphasize
        if add_emojis:
            emoji = emojis.get(str(i)) or emojis.get(i)
            if emoji:
                tok["emoji"] = str(emoji)
    return tokens, meta


def heuristic_emphasis(tokens: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Emphasize numbers, long words, and ALL-CAPS words — no LLM call.

    Used as both the fallback for :func:`apply_emphasis` and the default,
    round-trip-free path during bulk processing.
    """
    for tok in tokens:
        w = tok["word"].strip(".,!?")
        tok["emphasis"] = bool(
            any(ch.isdigit() for ch in w) or len(w) >= 8 or (w.isupper() and len(w) > 2)
        )
    return tokens


def group_tokens(tokens: list[dict[str, Any]], style: StylePreset) -> list[list[int]]:
    """Chunk tokens into on-screen groups by word count and silence gaps."""
    groups: list[list[int]] = []
    current: list[int] = []
    for i, tok in enumerate(tokens):
        if current:
            prev = tokens[current[-1]]
            gap = tok["start"] - prev["end"]
            if len(current) >= style.max_words or gap > style.max_gap:
                groups.append(current)
                current = []
        current.append(i)
    if current:
        groups.append(current)
    return groups


# ----------------------------------------------------------------------- ASS
def _fmt_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    cs = int(round((seconds - int(seconds)) * 100))
    if cs == 100:
        s += 1
        cs = 0
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def _word_text(tok: dict[str, Any], style: StylePreset, active: bool) -> str:
    word = tok["word"].upper() if style.uppercase else tok["word"]
    word = word.replace("{", "(").replace("}", ")")  # ASS-safe
    emphasized = tok.get("emphasis") or active
    if emphasized:
        scale = int(style.active_scale * 100)
        override = f"{{\\c{style.highlight}\\fscx{scale}\\fscy{scale}}}"
        reset = "{\\r}"
        word = f"{override}{word}{reset}"
    if tok.get("emoji"):
        word = f"{word} {tok['emoji']}"
    return word


def render_ass(
    tokens: list[dict[str, Any]],
    style_name: str,
    width: int,
    height: int,
) -> str:
    """Render an ASS subtitle document with word-level highlighting."""
    style = get_style(style_name)
    fontsize = max(12, int(round(style.font_scale * height * CAPTION_SIZE_SCALE)))
    bold = -1 if style.bold else 0
    # Override each preset's own placement so captions always land in the lower
    # third, bottom-centered, regardless of the chosen style.
    alignment = CAPTION_ALIGNMENT
    margin_v = max(0, int(round(height * CAPTION_MARGIN_V_FRAC)))

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 1
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{style.fontname},{fontsize},{style.primary},{style.highlight},{style.outline_color},{BLACK},{bold},0,0,0,100,100,0,0,1,{style.outline},{style.shadow},{alignment},40,40,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    events: list[str] = []
    groups = group_tokens(tokens, style)
    for group in groups:
        for pos, idx in enumerate(group):
            tok = tokens[idx]
            seg_start = tok["start"]
            seg_end = tokens[group[pos + 1]]["start"] if pos + 1 < len(group) else tok["end"]
            if seg_end <= seg_start:
                seg_end = seg_start + 0.12
            pieces = [_word_text(tokens[j], style, active=(j == idx)) for j in group]
            text = " ".join(pieces)
            events.append(
                f"Dialogue: 0,{_fmt_time(seg_start)},{_fmt_time(seg_end)},Default,,0,0,0,,{text}"
            )
    return header + "\n".join(events) + "\n"


def write_ass(path: str, tokens: list[dict[str, Any]], style_name: str, width: int, height: int) -> str:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(render_ass(tokens, style_name, width, height))
    return path


# ----------------------------------------------------------------- SRT / VTT
def _grouped_lines(tokens: list[dict[str, Any]], max_words: int = 7) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    cur: list[dict[str, Any]] = []
    for tok in tokens:
        cur.append(tok)
        if len(cur) >= max_words:
            lines.append(
                {"start": cur[0]["start"], "end": cur[-1]["end"],
                 "text": " ".join(t["word"] for t in cur)}
            )
            cur = []
    if cur:
        lines.append(
            {"start": cur[0]["start"], "end": cur[-1]["end"],
             "text": " ".join(t["word"] for t in cur)}
        )
    return lines


def _srt_time(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _vtt_time(seconds: float) -> str:
    return _srt_time(seconds).replace(",", ".")


def render_srt(tokens: list[dict[str, Any]]) -> str:
    out: list[str] = []
    for i, line in enumerate(_grouped_lines(tokens), start=1):
        out.append(str(i))
        out.append(f"{_srt_time(line['start'])} --> {_srt_time(line['end'])}")
        out.append(line["text"])
        out.append("")
    return "\n".join(out)


def render_vtt(tokens: list[dict[str, Any]]) -> str:
    out: list[str] = ["WEBVTT", ""]
    for line in _grouped_lines(tokens):
        out.append(f"{_vtt_time(line['start'])} --> {_vtt_time(line['end'])}")
        out.append(line["text"])
        out.append("")
    return "\n".join(out)
