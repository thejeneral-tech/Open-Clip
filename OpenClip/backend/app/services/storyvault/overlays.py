"""Burned-in intro overlays for Story Vault videos.

The reference look = gameplay + a white **Reddit topic card** (avatar, username,
verified badge, award row, post title, optional red "Plus N updates." line, and
heart/comment counts) that opens the video, followed by a big yellow **"Posted
by u/…" author intro**, after which the word-by-word captions take over.

This module rasterizes those two beats as transparent PNGs with Pillow and
exposes :func:`prepare_intro_overlays`, which turns a story + a template's render
config into the overlay specs the composer composites over the footage. The two
cards are shown across the windows during which their lines are *narrated*
(:func:`intro_beats` supplies that narration text), so each card is on screen for
exactly as long as the voice reads it and the body captions take over the moment
the body narration begins.

Everything is drawn in the reference 1080-wide canvas and then resized to the
actual render width, so the preview (540px) and final (1080px) renders stay
pixel-identical in layout and crisp at any scale.
"""
from __future__ import annotations

import re
from typing import Any

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from app.core.logging import get_logger
from app.services.storage import storage, sv_overlay_key

logger = get_logger(__name__)

# Reference canvas the geometry is authored in (matches templates_data canvas).
CANVAS_W = 1080
CANVAS_H = 1920

# Palette (RGB). Mirrors templates_data.COLORS so the burn matches the preview.
CARD_FILL = (255, 255, 255)
CARD_TITLE = (26, 26, 26)
CARD_META = (124, 124, 124)
CARD_RED = (224, 36, 27)
VERIFIED_BLUE = (29, 150, 232)
HEART_RED = (224, 36, 48)
COMMENT_GRAY = (124, 124, 124)
AUTHOR_YELLOW = (255, 240, 0)
AVATAR_BG = (58, 149, 179)
AWARD_COLORS = [(255, 180, 40), (255, 138, 76), (180, 120, 232), (90, 196, 120), (236, 92, 120)]

# Font candidates — bold matters for the look. Windows first (this box), then
# common Linux paths, then Pillow's bundled DejaVu, then the built-in bitmap.
_FONT_BOLD = [
    r"C:\Windows\Fonts\arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "DejaVuSans-Bold.ttf",
]
_FONT_REG = [
    r"C:\Windows\Fonts\arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/Library/Fonts/Arial.ttf",
    "DejaVuSans.ttf",
]


def _font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    for path in (_FONT_BOLD if bold else _FONT_REG):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


# --------------------------------------------------------------------- helpers
def _text_w(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont) -> float:
    return draw.textlength(text, font=font)


def _line_h(font: ImageFont.FreeTypeFont) -> int:
    asc, desc = font.getmetrics()
    return asc + desc


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_w: float) -> list[str]:
    """Greedy word-wrap to ``max_w`` px (hard-splitting any word longer than a line)."""
    lines: list[str] = []
    for paragraph in text.splitlines() or [""]:
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        cur = words[0]
        for w in words[1:]:
            if _text_w(draw, f"{cur} {w}", font) <= max_w:
                cur = f"{cur} {w}"
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
    return lines


def _draw_heart(draw: ImageDraw.ImageDraw, cx: float, cy: float, size: float, color: tuple) -> None:
    """A filled heart centered on (cx, cy) within a ``size``×``size`` box."""
    r = size * 0.27
    top = cy - size * 0.18
    draw.ellipse([cx - size * 0.5, top - r, cx - size * 0.5 + 2 * r, top + r], fill=color)
    draw.ellipse([cx + size * 0.5 - 2 * r, top - r, cx + size * 0.5, top + r], fill=color)
    draw.polygon(
        [(cx - size * 0.5, top), (cx + size * 0.5, top), (cx, cy + size * 0.5)],
        fill=color,
    )


def _draw_comment(draw: ImageDraw.ImageDraw, x: float, y: float, size: float, color: tuple) -> None:
    """A speech-bubble outline (rounded rect + small tail) at top-left (x, y)."""
    w, h = size, size * 0.82
    sw = max(2, int(size * 0.09))
    draw.rounded_rectangle([x, y, x + w, y + h], radius=size * 0.22, outline=color, width=sw)
    draw.polygon(
        [(x + w * 0.24, y + h), (x + w * 0.46, y + h), (x + w * 0.24, y + h + size * 0.22)],
        fill=color,
    )


def _draw_verified(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float) -> None:
    """Blue verified disc with a white checkmark, centered on (cx, cy)."""
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=VERIFIED_BLUE)
    draw.line(
        [(cx - r * 0.42, cy + r * 0.05), (cx - r * 0.08, cy + r * 0.4), (cx + r * 0.48, cy - r * 0.4)],
        fill=(255, 255, 255), width=max(2, int(r * 0.34)), joint="curve",
    )


def _count_updates(body: str) -> int:
    """How many "UPDATE" beats the story body has (drives the red card line).

    These repost-style AITA posts append updates over time; counting them lets
    the card show the authentic "Plus N updates." flag — and nothing when there
    are none.
    """
    if not body:
        return 0
    return len(re.findall(r"(?im)^\s*(?:edit|update)\s*(?:#?\s*\d+)?\s*[:\-]", body))


def _fmt_count(n: int) -> str:
    if n >= 1000:
        s = f"{n / 1000:.1f}".rstrip("0").rstrip(".")
        return f"{s}k"
    if n > 99:
        return "99+"
    return str(max(0, n))


def _handle_from(meta: dict[str, Any]) -> str:
    """A plausible ``u/Name`` handle: the story author, else derived from the
    community, else a stable generic."""
    author = (meta.get("author") or "").strip().lstrip("uU/").strip("/").strip()
    if author and author.lower() not in {"deleted", "removed", "automoderator"}:
        return author
    community = (meta.get("community") or "").strip().lstrip("rR/").strip("/").strip()
    if community:
        return f"{community.title().replace(' ', '')}Stories"
    return "RedditStories"


# ------------------------------------------------------------- topic card PNG
def _render_topic_card(meta: dict[str, Any], tc: dict[str, Any]) -> Image.Image:
    """Rasterize the Reddit topic card at the 1080 reference canvas scale."""
    card_w = int(tc.get("width", 820))
    radius = int(tc.get("radius", 46))
    title_size = int(tc.get("titleSize", 50))
    meta_size = int(tc.get("metaSize", 34))
    show_avatar = tc.get("avatar", True) is not False
    pad = 42
    content_x0 = pad
    content_w = card_w - 2 * pad

    handle = _handle_from(meta)
    display = handle if len(handle) <= 22 else handle[:21] + "…"
    title = (meta.get("title") or "").strip() or "Untitled story"
    updates = _count_updates(meta.get("body") or "")

    f_name = _font(40, bold=True)
    f_meta = _font(meta_size, bold=False)
    f_title = _font(title_size, bold=True)
    f_red = _font(int(title_size * 0.82), bold=True)
    f_count = _font(34, bold=True)

    scratch = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    title_lines = _wrap(scratch, title, f_title, content_w)
    title_lh = int(title_size * 1.2)

    avatar_d = 92 if show_avatar else 0
    text_x = content_x0 + (avatar_d + 22 if show_avatar else 0)
    name_h, meta_h = _line_h(f_name), _line_h(f_meta)
    header_h = max(avatar_d, name_h + 6 + meta_h)

    # --- measure total height ---
    y = pad
    y += header_h + 26
    title_block_h = title_lh * len(title_lines)
    y += title_block_h
    if updates > 0:
        y += 10 + _line_h(f_red)
    y += 28
    footer_h = _line_h(f_count)
    y += footer_h
    y += pad
    card_h = y

    # --- draw, with a soft drop shadow inside a transparent margin ---
    margin = 40
    img = Image.new("RGBA", (card_w + 2 * margin, card_h + 2 * margin), (0, 0, 0, 0))
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [margin, margin + 8, margin + card_w, margin + card_h + 8], radius=radius, fill=(0, 0, 0, 150)
    )
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))

    draw = ImageDraw.Draw(img)
    ox, oy = margin, margin  # card origin inside the padded image
    draw.rounded_rectangle([ox, oy, ox + card_w, oy + card_h], radius=radius, fill=CARD_FILL)

    # Header: avatar + name row + handle.
    y = oy + pad
    if show_avatar:
        ax0, ay0 = ox + content_x0, y + (header_h - avatar_d) // 2
        draw.ellipse([ax0, ay0, ax0 + avatar_d, ay0 + avatar_d], fill=AVATAR_BG)
        letter = (display[:1] or "R").upper()
        fa = _font(int(avatar_d * 0.56), bold=True)
        lb = draw.textbbox((0, 0), letter, font=fa)
        draw.text(
            (ax0 + (avatar_d - (lb[2] - lb[0])) / 2 - lb[0], ay0 + (avatar_d - (lb[3] - lb[1])) / 2 - lb[1]),
            letter, font=fa, fill=(255, 255, 255),
        )

    tx = ox + text_x
    ty = y + (header_h - (name_h + 6 + meta_h)) // 2
    draw.text((tx, ty), display, font=f_name, fill=CARD_TITLE)
    name_w = _text_w(draw, display, f_name)
    badge_cy = ty + name_h * 0.46
    badge_r = name_h * 0.34
    bx = tx + name_w + 14 + badge_r
    _draw_verified(draw, bx, badge_cy, badge_r)
    # Award row after the verified badge.
    aw_r = name_h * 0.26
    awx = bx + badge_r + 16 + aw_r
    for color in AWARD_COLORS:
        if awx + aw_r > ox + card_w - pad:
            break
        draw.ellipse([awx - aw_r, badge_cy - aw_r, awx + aw_r, badge_cy + aw_r], fill=color)
        awx += aw_r * 2 + 8
    draw.text((tx, ty + name_h + 6), f"u/{handle}", font=f_meta, fill=CARD_META)

    # Title.
    y = oy + pad + header_h + 26
    for line in title_lines:
        draw.text((ox + content_x0, y), line, font=f_title, fill=CARD_TITLE)
        y += title_lh
    if updates > 0:
        y += 10
        plural = "update" if updates == 1 else "updates"
        draw.text((ox + content_x0, y), f"Plus {updates} {plural}.", font=f_red, fill=CARD_RED)
        y += _line_h(f_red)

    # Footer: heart + count, comment bubble + count.
    y += 28
    icon = footer_h * 0.95
    fx = ox + content_x0
    cy = y + footer_h / 2
    _draw_heart(draw, fx + icon / 2, cy, icon, HEART_RED)
    fx += icon + 12
    likes = _fmt_count(int(meta.get("upvotes") or 0) or 990)
    draw.text((fx, y), likes, font=f_count, fill=CARD_META)
    fx += _text_w(draw, likes, f_count) + 38
    _draw_comment(draw, fx, y, icon, COMMENT_GRAY)
    fx += icon + 14
    comments = _fmt_count(int(meta.get("num_comments") or 0) or 99)
    draw.text((fx, y), comments, font=f_count, fill=CARD_META)

    return img


# ------------------------------------------------------------ author intro PNG
def _render_author_intro(meta: dict[str, Any], ai: dict[str, Any]) -> Image.Image:
    """Rasterize the big yellow "Posted by u/…" intro at the 1080 canvas scale."""
    prefix = (ai.get("prefixReddit") or "Posted by").strip()
    handle = _handle_from(meta)
    line1, line2 = prefix, f"u/{handle}"

    max_w = CANVAS_W - 2 * 70
    max_size = int(ai.get("maxSize", 138))
    min_size = int(ai.get("minSize", 60))
    outline = max(1, int(ai.get("outline", 9)))

    scratch = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    size = max_size
    while size > min_size:
        f = _font(size, bold=True)
        if max(_text_w(scratch, line1, f), _text_w(scratch, line2, f)) <= max_w:
            break
        size -= 4
    font = _font(size, bold=True)
    lh = int(size * 1.12)

    w1, w2 = _text_w(scratch, line1, font), _text_w(scratch, line2, font)
    text_w = int(max(w1, w2))
    pad = outline + 12
    img = Image.new("RGBA", (text_w + 2 * pad, 2 * lh + 2 * pad), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    for i, (line, lw) in enumerate(((line1, w1), (line2, w2))):
        x = (img.width - lw) / 2
        y = pad + i * lh
        draw.text((x, y), line, font=font, fill=AUTHOR_YELLOW,
                  stroke_width=outline, stroke_fill=(0, 0, 0))
    return img


# --------------------------------------------------------------------- public
def intro_beats(
    story_meta: dict[str, Any], template_config: dict[str, Any] | None
) -> list[dict[str, str]]:
    """Ordered narration beats that open the video, for whichever intro cards the
    template enables.

    The topic card narrates the post title; the author intro narrates the
    "Posted by <handle>" line (spoken without the ``u/`` so it doesn't come out
    as "u slash …"). The caller appends the story body after these.
    """
    cfg = template_config or {}
    tc = cfg.get("topicCard") or {}
    ai = cfg.get("authorIntro") or {}
    beats: list[dict[str, str]] = []
    if tc.get("enabled", False) is True:
        title = (story_meta.get("title") or "").strip()
        if title:
            beats.append({"kind": "card", "text": title.rstrip(".!?") + "."})
    if ai.get("enabled", False) is True:
        prefix = (ai.get("prefixReddit") or "Posted by").strip()
        beats.append({"kind": "author", "text": f"{prefix} {_handle_from(story_meta)}."})
    return beats


def prepare_intro_overlays(
    *,
    sv_video_id: int,
    story_meta: dict[str, Any],
    template_config: dict[str, Any] | None,
    width: int,
    height: int,
    card_window: tuple[float, float] | None = None,
    author_window: tuple[float, float] | None = None,
) -> dict[str, Any]:
    """Build the intro overlay PNGs for one render at the target resolution.

    The Reddit topic card is shown across ``card_window`` (while the title is
    narrated) and the "Posted by u/…" author intro across ``author_window``
    (while the author line is narrated), so each is on screen for exactly as long
    as its line is spoken. A beat with no window — its narration is disabled, or
    the window is too short to be worth a card — is skipped. Returns
    ``{"overlays": [...]}`` where each overlay is ``{path, x, y, start, end,
    fade}`` in the *target* render's pixel space.
    """
    cfg = template_config or {}
    tc = cfg.get("topicCard") or {}
    ai = cfg.get("authorIntro") or {}
    scale = width / CANVAS_W
    overlays: list[dict[str, Any]] = []

    def _add(img: Image.Image, kind: str, center_y: float,
             window: tuple[float, float], fade_ms: float) -> None:
        start, end = float(window[0]), float(window[1])
        if end - start < 0.3:  # too brief to register as a card
            return
        if scale != 1.0:
            img = img.resize(
                (max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS
            )
        key = sv_overlay_key(sv_video_id, kind, width)
        img.save(storage.abspath(key))
        storage.commit(key)
        overlays.append({
            "path": storage.abspath(key, ensure_parent=False),
            "x": round((width - img.width) / 2),
            "y": round(center_y - img.height / 2),
            "start": round(start, 3),
            "end": round(end, 3),
            "fade": max(0.05, float(fade_ms) / 1000.0),
        })

    if tc.get("enabled", False) is True and card_window:
        _add(_render_topic_card(story_meta, tc), "card",
             float(tc.get("centerY", 760)) * scale, card_window, tc.get("fade", 180))
    if ai.get("enabled", False) is True and author_window:
        _add(_render_author_intro(story_meta, ai), "author",
             height * 0.46, author_window, ai.get("fade", 160))

    return {"overlays": overlays}
