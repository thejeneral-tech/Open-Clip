"""Render a JS-heavy campaign page (Whop) in headless Chrome to read what a human sees.

Whop renders a campaign's requirements section and its linked brief (Google Doc, …)
client-side, so a plain ``httpx`` fetch only sees the OpenGraph summary. This drives the
user's own installed Chrome via Playwright (``channel="chrome"`` — no Chromium download)
to load the page, let its JavaScript render, and return the visible text plus every link
on the page. Callers feed that through the same requirement parser / link detector used
for a pasted brief.

Best-effort and bounded: returns ``None`` on any failure (Playwright not installed, no
Chrome, navigation error, timeout) so callers fall back to the plain fetch. Blocking —
Playwright's sync API must run OFF the event loop, which is fine since the extractor runs
under ``asyncio.to_thread``.
"""
from __future__ import annotations

import contextlib

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# A browser-ish UA is unnecessary (it IS a browser), but keep automation less obvious.
_VIEWPORT = {"width": 1280, "height": 2400}   # tall so lazy content below the fold renders


def render_page(url: str, *, settle_ms: int = 1500, timeout_ms: int = 20000) -> dict | None:
    """Load ``url`` in headless Chrome and return ``{"text", "hrefs"}``, or None.

    ``text`` is the rendered ``<body>`` innerText; ``hrefs`` is every anchor's resolved
    URL (so a linked Google Doc shows up even though it's injected by client JS).
    """
    if not settings.WHOP_HEADLESS_RENDER:
        return None
    try:
        from playwright.sync_api import TimeoutError as PWTimeout, sync_playwright
    except Exception as exc:                    # Playwright not installed
        logger.info("Headless render unavailable (playwright import failed: %s)", exc)
        return None

    try:
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(channel="chrome", headless=True)
            except Exception as exc:            # Chrome channel missing → let caller fall back
                logger.info("Could not launch system Chrome for render: %s", exc)
                return None
            try:
                page = browser.new_page(viewport=_VIEWPORT)
                page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                # Give client-side data a moment to load; networkidle when it settles fast.
                with contextlib.suppress(PWTimeout):
                    page.wait_for_load_state("networkidle", timeout=6000)
                page.wait_for_timeout(settle_ms)
                text = page.inner_text("body")
                hrefs = page.eval_on_selector_all(
                    "a[href]", "els => els.map(e => e.href)"
                )
            finally:
                browser.close()
    except Exception as exc:
        logger.info("Headless render failed for %s: %s", url, exc)
        return None

    hrefs = [h for h in (hrefs or []) if isinstance(h, str) and h.startswith("http")]
    logger.info("Rendered %s: %d chars, %d links", url, len(text or ""), len(hrefs))
    return {"text": text or "", "hrefs": hrefs}
