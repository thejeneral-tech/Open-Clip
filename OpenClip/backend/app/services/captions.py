"""Caption generation.

Turns clip words into styled, animated captions:

* word-level highlighting (the spoken word "pops"),
* AI-chosen emphasis + tasteful emoji insertion,
* five presets (Hormozi, Modern TikTok, Minimal, Gaming, Podcast),
* burned-in **ASS** output plus standalone **SRT** / **VTT** files.
"""
from __future__ import annotations

import re
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

# --- Smooth karaoke animation (all in milliseconds, relative to each cue's own
# start). Instead of the spoken word snapping to the highlight colour/size for a
# frame, it *glides*: the colour leads (fast, for tight lip-sync to the voice)
# and the scale trails (a smooth "pop"), then both ease back as the next word
# takes over — so exactly one word is lit at any instant and the highlight flows
# with the narration. These animate via ASS \t transforms inside one stable cue,
# so the line itself never re-draws between words (no flicker). ---
_COLOR_RISE_MS = 70    # active word reaches the highlight colour quickly (sync)
_COLOR_FALL_MS = 100   # ...and returns to the base colour as the next word lights
_SCALE_RISE_MS = 150   # active word grows smoothly into the "pop"
_SCALE_FALL_MS = 130   # ...and settles back down smoothly
# Emphasised words (numbers, long/important words) sit a touch larger even when
# not the active word; this is the fraction of the active grow they keep at rest.
_EMPHASIS_REST = 0.5
# Every cue lifts in from slightly transparent rather than hard-cutting onto the
# screen — a soft entrance that never dips to blank (so the centre stays filled).
# The final cue of the track additionally fades fully out for a clean ending.
_CUE_LIFT_MS = 110
_CUE_LIFT_ALPHA = "&H50&"   # ~69% opaque at the start of the lift -> fully opaque
_CUE_FADE_OUT_MS = 220

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


# ----------------------------------------------- preset (template) overrides
# A selected StoryVault preset carries a ``captions`` config blob that overrides
# the named style's colours, font, size, word-grouping and vertical placement so
# the burned-in captions match the preset's on-screen preview. Every key below is
# optional; absent keys fall back to the named style + global lower-third layout.


def _norm_ass_color(val: Any) -> str | None:
    """Normalise a preset colour into an ASS literal (``&HAABBGGRR``), or None.

    Accepts ASS literals (``&H`` + 6 or 8 hex digits) and CSS ``#RRGGBB``.
    """
    if not isinstance(val, str):
        return None
    s = val.strip()
    m = re.fullmatch(r"&[Hh]([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})", s)
    if m:
        hexd = m.group(1)
        if len(hexd) == 6:
            hexd = "00" + hexd
        return "&H" + hexd.upper()
    m = re.fullmatch(r"#?([0-9A-Fa-f]{6})", s)
    if m:
        h = m.group(1)
        return _ass_color(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    return None


def _caption_center_y(overrides: dict[str, Any], height: int) -> int | None:
    """Caption vertical centre in PlayRes px from the top, or None to keep the
    global lower-third placement. ``centerY`` (from the top) wins; otherwise
    ``marginV`` (from the bottom) is converted to a centre."""
    cy = overrides.get("centerY")
    if isinstance(cy, (int, float)) and cy > 0:
        return max(0, min(int(round(cy)), height))
    mv = overrides.get("marginV")
    if isinstance(mv, (int, float)) and mv >= 0:
        return max(0, min(int(round(height - mv)), height))
    return None


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


def _karaoke_enabled(style: StylePreset) -> bool:
    """True when the spoken word should visibly light up / grow.

    A style with no distinct highlight colour *and* no grow (Minimal, or any
    preset rendered in "pop" mode) has nothing to animate per word, so the cue
    is drawn as plain words — never emitting the highlight colour.
    """
    return style.highlight != style.primary or style.active_scale != 1.0


def _render_cue(
    tokens: list[dict[str, Any]],
    group: list[int],
    group_start: float,
    group_end: float,
    style: StylePreset,
    *,
    time_base: float,
    karaoke: bool,
    is_last: bool,
) -> str:
    """The full ASS text for one cue (group of words).

    Every word in the group is on screen for the whole cue; the spoken word
    smoothly lights up and grows exactly when the voice reaches it, then eases
    back as the next word takes over — driven by ASS ``\\t`` transforms whose
    times are relative to ``time_base`` (the cue's on-screen start). Because it
    is one stable line, nothing re-draws between words: the highlight simply
    glides across, in lock-step with the narration.
    """
    active_pct = int(round(style.active_scale * 100))
    emph_pct = (
        int(round((1.0 + (style.active_scale - 1.0) * _EMPHASIS_REST) * 100))
        if style.active_scale > 1.0
        else 100
    )
    pieces: list[str] = []
    for pos, idx in enumerate(group):
        tok = tokens[idx]
        word = tok["word"].upper() if style.uppercase else tok["word"]
        word = word.replace("{", "(").replace("}", ")")  # ASS-safe
        emphasis = bool(tok.get("emphasis"))
        if karaoke:
            base_pct = emph_pct if emphasis else 100
            w_start = max(float(tok["start"]), group_start)
            # The word stays lit until the next word in the group is spoken (or,
            # for the last word, until it finishes) — so only ever one is active.
            if pos + 1 < len(group):
                w_off = max(float(tokens[group[pos + 1]]["start"]), w_start)
            else:
                w_off = max(float(tok["end"]), w_start)
            rise = max(0, int(round((w_start - time_base) * 1000)))
            fall = max(rise, int(round((w_off - time_base) * 1000)))
            piece = (
                f"{{\\c{style.primary}\\fscx{base_pct}\\fscy{base_pct}"
                f"\\t({rise},{rise + _COLOR_RISE_MS},\\c{style.highlight})"
                f"\\t({rise},{rise + _SCALE_RISE_MS},\\fscx{active_pct}\\fscy{active_pct})"
                f"\\t({fall},{fall + _COLOR_FALL_MS},\\c{style.primary})"
                f"\\t({fall},{fall + _SCALE_FALL_MS},\\fscx{base_pct}\\fscy{base_pct})}}"
                f"{word}"
            )
        else:
            # No-highlight styles (Minimal / "pop" mode): plain words, in order.
            piece = word
        if tok.get("emoji"):
            piece = f"{piece} {tok['emoji']}"
        pieces.append(piece)

    # Cue entrance: a soft alpha lift (never a hard cut, never a blank dip) so a
    # new line glides in; the final cue of the track also fades fully out.
    dur_ms = max(1, int(round((group_end - time_base) * 1000)))
    lift = f"\\alpha{_CUE_LIFT_ALPHA}\\t(0,{min(_CUE_LIFT_MS, dur_ms)},\\alpha&H00&)"
    if is_last:
        out_start = max(min(_CUE_LIFT_MS, dur_ms), dur_ms - _CUE_FADE_OUT_MS)
        lift += f"\\t({out_start},{dur_ms},\\alpha&HFF&)"
    return f"{{{lift}}}{' '.join(pieces)}"


def build_segments(
    tokens: list[dict[str, Any]], style: StylePreset, start_offset: float = 0.0
) -> list[dict[str, Any]]:
    """Non-overlapping ``{start, end, text}`` caption cues for the clip.

    The single source of truth for *when* each caption is on screen and *how* its
    words animate:

    * timings are sanitized to a clean, monotonic timeline,
    * tokens are chunked into on-screen groups,
    * each group becomes **one stable cue** whose words light up/grow in sync with
      the voice (see :func:`_render_cue`); the cue is **held until the next group
      begins** so the centre is never momentarily blank,
    * ``start_offset`` (seconds) holds the whole track back: cues finishing before
      it are dropped and one straddling it starts at it, with the word animation
      re-based onto the clipped start so sync is preserved,
    * a final clamp guarantees ``end[i] <= start[i+1]`` for every pair — no two
      cues can ever be on screen at once, which is what used to stack them.
    """
    tokens = sanitize_timing(tokens)
    groups = group_tokens(tokens, style)
    karaoke = _karaoke_enabled(style)
    n = len(groups)
    segments: list[dict[str, Any]] = []
    for gi, group in enumerate(groups):
        group_start = tokens[group[0]]["start"]
        last_end = tokens[group[-1]]["end"]
        # Hold this group until the next group's first word (never past it), but
        # not more than MAX_HOLD past the last spoken word so it doesn't linger
        # through a long pause. The final group simply ends with its last word.
        if gi + 1 < n:
            group_end = min(tokens[groups[gi + 1][0]]["start"], last_end + MAX_HOLD)
        else:
            group_end = last_end
        if group_end <= group_start:
            group_end = group_start + MIN_SEG_DUR

        ev_start = group_start
        if start_offset > 0:
            if group_end <= start_offset:
                continue                       # cue is entirely before the offset
            ev_start = max(group_start, start_offset)
        if group_end <= ev_start:
            continue
        ev_start = round(ev_start, 3)
        text = _render_cue(
            tokens, group, group_start, round(group_end, 3), style,
            time_base=ev_start, karaoke=karaoke, is_last=(gi == n - 1),
        )
        segments.append({"start": ev_start, "end": round(group_end, 3), "text": text})
    return _clamp_no_overlap(segments)


def _clamp_no_overlap(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Force strictly sequential cues and drop any zero-length ones."""
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
    overrides: dict[str, Any] | None = None,
    start_offset: float = 0.0,
) -> str:
    """Render an ASS subtitle document with word-level highlighting.

    ``max_words`` overrides the preset's words-per-cue (set by the learning
    profile to slow down content that reads too fast); ``None`` uses the preset.

    ``overrides`` is a selected preset's ``captions`` config blob (colours, font,
    size, ``maxWords``, ``style`` karaoke/pop, and vertical placement). It is
    layered on top of the named style so the render matches the preset's preview.

    ``start_offset`` holds the caption track back by this many seconds: segments
    that finish before it are dropped and one straddling it is clipped to start
    at it. Used so captions don't collide with the intro Reddit card / author
    intro overlays, which own the opening seconds of the video.
    """
    style = get_style(style_name)
    if max_words:
        style = replace(style, max_words=max_words)

    overrides = overrides or {}
    # Colours / font from the preset, each falling back to the named style.
    primary = _norm_ass_color(overrides.get("primary")) or style.primary
    highlight = _norm_ass_color(overrides.get("highlight")) or style.highlight
    font_ov = overrides.get("font")
    fontname = font_ov.strip() if isinstance(font_ov, str) and font_ov.strip() else style.fontname
    # "Pop word" reads as plain words appearing in sequence — no karaoke colour or
    # grow on the spoken word; "karaoke" (the default) lights the active word.
    if str(overrides.get("style") or "").lower() == "pop":
        highlight = primary
        style = replace(style, active_scale=1.0)
    ov_max_words = overrides.get("maxWords")
    if isinstance(ov_max_words, int) and ov_max_words > 0:
        style = replace(style, max_words=ov_max_words)
    style = replace(style, primary=primary, highlight=highlight, fontname=fontname)

    # Font size: a preset ``size`` is absolute px in the 1080×1920 canvas (which
    # equals the render height), used verbatim; otherwise the style's height-
    # relative size at 65%.
    ov_size = overrides.get("size")
    if isinstance(ov_size, (int, float)) and ov_size > 0:
        fontsize = max(12, int(round(ov_size)))
    else:
        fontsize = max(12, int(round(style.font_scale * height * CAPTION_SIZE_SCALE)))
    ov_outline = overrides.get("outline")
    outline = (
        float(ov_outline) if isinstance(ov_outline, (int, float)) and ov_outline >= 0 else style.outline
    )
    bold = -1 if style.bold else 0

    # Placement. Default: bottom-centred in the lower third, regardless of style.
    # A preset may instead pin the vertical centre (centerY from the top, or
    # height − marginV), rendered with an \an5\pos() prefix on every cue.
    center_y = _caption_center_y(overrides, height)
    if center_y is not None:
        alignment = 5  # middle-centre; \pos fixes the exact anchor point
        margin_v = 0
        pos_tag = f"{{\\an5\\pos({width // 2},{center_y})}}"
    else:
        alignment = CAPTION_ALIGNMENT
        margin_v = max(0, int(round(height * CAPTION_MARGIN_V_FRAC)))
        pos_tag = ""

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 1
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{style.fontname},{fontsize},{style.primary},{style.highlight},{style.outline_color},{BLACK},{bold},0,0,0,100,100,0,0,1,{outline},{style.shadow},{alignment},40,40,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    # build_segments owns the clipping so each cue's word animation is re-based
    # onto its (possibly offset) on-screen start — the highlight stays in sync.
    segments = build_segments(tokens, style, start_offset=start_offset)
    events = [
        f"Dialogue: 0,{_fmt_time(seg['start'])},{_fmt_time(seg['end'])},Default,,0,0,0,,{pos_tag}{seg['text']}"
        for seg in segments
    ]
    return header + "\n".join(events) + "\n"


def write_ass(
    path: str,
    tokens: list[dict[str, Any]],
    style_name: str,
    width: int,
    height: int,
    overrides: dict[str, Any] | None = None,
    start_offset: float = 0.0,
) -> str:
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
        fh.write(render_ass(
            tokens, style_name, width, height,
            max_words=max_words, overrides=overrides, start_offset=start_offset,
        ))
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
