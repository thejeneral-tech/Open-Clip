"""Caption generation.

Turns clip words into styled, animated captions:

* word-level highlighting (the spoken word "pops"),
* AI-chosen emphasis + tasteful emoji insertion,
* five presets (Hormozi, Modern TikTok, Minimal, Gaming, Podcast),
* burned-in **ASS** output plus standalone **SRT** / **VTT** files.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
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

# Smallest time a single caption segment may occupy on screen. Word-level ASR
# timestamps are occasionally zero-length or slightly out of order (especially
# over music / crosstalk); without a floor a caption can flash for a single
# frame or, worse, overlap its neighbour — which libass then stacks vertically
# (the "double caption" artifact). See :func:`sanitize_timing`.
MIN_SEG_DUR = 0.10

# A cue is held on screen until the next cue begins (so the centre never flickers
# blank between words), but never longer than this past the last spoken word — so
# a caption doesn't linger through a long pause / music break.
MAX_HOLD = 1.2

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


def sanitize_timing(tokens: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return tokens on a strictly monotonic, non-overlapping timeline.

    Word-level ASR timestamps can run backwards or overlap (word *i* ends after
    word *i+1* starts). Burned straight into ASS, those overlapping events are
    both rendered and libass's collision avoidance stacks them — the classic
    doubled-caption artifact. Here we force a clean timeline: every word starts
    no earlier than the previous word ended, and lasts at least
    :data:`MIN_SEG_DUR`. For well-behaved input nothing moves (each word already
    starts after the last ended), so there is no drift; only genuinely
    out-of-order words get nudged forward by the minimum needed. Emphasis / emoji
    and every other field are preserved; the input list is left untouched.
    """
    clean: list[dict[str, Any]] = []
    prev_end = 0.0
    for tok in tokens:
        start = float(tok.get("start", prev_end))
        end = float(tok.get("end", start))
        start = max(start, prev_end)           # never travel backwards in time
        if end <= start:
            end = start + MIN_SEG_DUR          # give zero-length words a frame
        new = dict(tok)
        new["start"] = round(start, 3)
        new["end"] = round(end, 3)
        clean.append(new)
        prev_end = new["end"]
    return clean


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


def build_segments(
    tokens: list[dict[str, Any]], style: StylePreset
) -> list[dict[str, Any]]:
    """Non-overlapping ``{start, end, text}`` caption segments for the clip.

    The single source of truth for *when* each caption is on screen:

    * timings are sanitized to a clean, monotonic timeline,
    * tokens are chunked into on-screen groups,
    * each group is shown as a run of word-highlight segments that tile the
      group's window, and the group is **held until the next group begins** so
      the centre is never momentarily blank,
    * a final clamp guarantees ``end[i] <= start[i+1]`` for every pair — no two
      captions can ever be on screen at once, which is what used to stack them.
    """
    tokens = sanitize_timing(tokens)
    groups = group_tokens(tokens, style)
    segments: list[dict[str, Any]] = []
    for gi, group in enumerate(groups):
        group_start = tokens[group[0]]["start"]
        last_end = tokens[group[-1]]["end"]
        # Hold this group until the next group's first word (never past it), but
        # not more than MAX_HOLD past the last spoken word so it doesn't linger
        # through a long pause. The final group simply ends with its last word.
        if gi + 1 < len(groups):
            group_end = min(tokens[groups[gi + 1][0]]["start"], last_end + MAX_HOLD)
        else:
            group_end = last_end
        for pos, idx in enumerate(group):
            seg_start = tokens[idx]["start"]
            seg_end = (
                tokens[group[pos + 1]]["start"]
                if pos + 1 < len(group)
                else group_end
            )
            seg_start = min(max(seg_start, group_start), group_end)
            seg_end = min(max(seg_end, seg_start), group_end)
            pieces = [_word_text(tokens[j], style, active=(j == idx)) for j in group]
            segments.append(
                {"start": seg_start, "end": seg_end, "text": " ".join(pieces)}
            )
    return _clamp_no_overlap(segments)


def _clamp_no_overlap(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Force strictly sequential segments and drop any zero-length ones."""
    out = [s for s in segments if s["end"] > s["start"]]
    for i in range(len(out) - 1):
        if out[i]["end"] > out[i + 1]["start"]:
            out[i]["end"] = out[i + 1]["start"]
    return [s for s in out if s["end"] > s["start"]]


# Reading-comfort thresholds for the learning audit. A cue counts as "too fast"
# only if it is both brief AND densely packed, so calm short cues aren't flagged.
FAST_CPS = 30.0                # characters per second a viewer can comfortably read
MIN_COMFORTABLE_GROUP = 0.7    # a cue shorter than this is a candidate for "fast"


def audit_timeline(
    tokens: list[dict[str, Any]], style_name: str, max_words: int | None = None
) -> dict[str, Any]:
    """Read-only quality metrics for a render (used by the learning profile).

    Reports the number of on-screen groups, how many were uncomfortably fast,
    and any residual overlaps (should always be 0 — the clamp guarantees it).
    """
    style = get_style(style_name)
    if max_words:
        style = replace(style, max_words=max_words)
    clean = sanitize_timing(tokens)
    groups = group_tokens(clean, style)
    segments = build_segments(tokens, style)
    overlaps = sum(
        1 for i in range(len(segments) - 1)
        if segments[i]["end"] > segments[i + 1]["start"] + 1e-6
    )
    fast = 0
    for gi, group in enumerate(groups):
        gstart = clean[group[0]]["start"]
        last_end = clean[group[-1]]["end"]
        gend = (
            min(clean[groups[gi + 1][0]]["start"], last_end + MAX_HOLD)
            if gi + 1 < len(groups)
            else last_end
        )
        window = max(1e-3, gend - gstart)
        chars = sum(len(clean[j]["word"]) for j in group) + max(0, len(group) - 1)
        if window < MIN_COMFORTABLE_GROUP and chars / window > FAST_CPS:
            fast += 1
    return {"groups": len(groups), "fast_groups": fast, "overlaps": overlaps}


def render_ass(
    tokens: list[dict[str, Any]],
    style_name: str,
    width: int,
    height: int,
    max_words: int | None = None,
) -> str:
    """Render an ASS subtitle document with word-level highlighting.

    ``max_words`` overrides the preset's words-per-cue (set by the learning
    profile to slow down content that reads too fast); ``None`` uses the preset.
    """
    style = get_style(style_name)
    if max_words:
        style = replace(style, max_words=max_words)
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

    events = [
        f"Dialogue: 0,{_fmt_time(seg['start'])},{_fmt_time(seg['end'])},Default,,0,0,0,,{seg['text']}"
        for seg in build_segments(tokens, style)
    ]
    return header + "\n".join(events) + "\n"


def write_ass(path: str, tokens: list[dict[str, Any]], style_name: str, width: int, height: int) -> str:
    # Consult the self-tuning profile for a learned words-per-cue, then feed this
    # render's quality back into it. Both steps are best-effort and never block a
    # render — the deterministic no-overlap guarantee does not depend on them.
    learning = None
    max_words: int | None = None
    try:
        from app.services import caption_learning as learning
        max_words = learning.suggest_max_words(style_name)
    except Exception:  # pragma: no cover - learning is optional
        learning = None
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(render_ass(tokens, style_name, width, height, max_words=max_words))
    if learning is not None:
        try:
            learning.record_render(style_name, audit_timeline(tokens, style_name, max_words))
        except Exception:  # pragma: no cover - learning is optional
            pass
    return path


# ----------------------------------------------------------------- SRT / VTT
def _grouped_lines(tokens: list[dict[str, Any]], max_words: int = 7) -> list[dict[str, Any]]:
    tokens = sanitize_timing(tokens)  # sidecar files share the clean timeline
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
