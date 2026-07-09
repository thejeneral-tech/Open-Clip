"""A dedicated, logged-in Whop browser session for the app.

Whop gates campaign briefs behind login, and the app can't borrow the user's everyday
Chrome (it locks its own cookie store while running). So the app keeps its OWN Chrome
profile under ``DATA_DIR/whop_profile``: the user signs into Whop once in a visible
window (``connect`` → log in → ``confirm``), the session persists in that profile, and
afterwards the app can render gated campaign pages headlessly with it (``fetch``) to read
requirements + links.

"Connected" is tracked by a ``.connected`` marker written only when the user confirms a
finished login — NOT inferred from cookies (Whop sets anonymous cookies just from loading
the page, which would falsely read as logged-in). Everything is single-flighted: only one
Chrome context may touch the profile at a time (a login window OR a fetch), guarded by
``_PROFILE_LOCK``. Playwright's sync API runs from worker threads (never the event loop),
using the user's installed Chrome via ``channel="chrome"`` — no Chromium download.
"""
from __future__ import annotations

import contextlib
import re
import shutil
import threading
import time
from pathlib import Path

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

PROFILE_DIR = Path(settings.DATA_DIR) / "whop_profile"
_MARKER = PROFILE_DIR / ".connected"     # written only after a confirmed login

# Make the automated window look like an ordinary Chrome so Google/Whop don't refuse
# sign-in with "this browser may not be secure" (they block automation-flagged browsers).
_STEALTH_ARGS = ["--disable-blink-features=AutomationControlled", "--no-first-run"]
_IGNORE_DEFAULT = ["--enable-automation"]


def _launch(p, *, headless: bool):
    """Launch the app's persistent Chrome profile with the automation fingerprint stripped."""
    return p.chromium.launch_persistent_context(
        str(PROFILE_DIR),
        channel="chrome",
        headless=headless,
        args=_STEALTH_ARGS,
        ignore_default_args=_IGNORE_DEFAULT,
    )


# Only one Chrome context may open the profile at once (login window or a headless fetch).
_PROFILE_LOCK = threading.Lock()

# Login flow state (a headed window the user drives) — guarded by _STATE_LOCK.
_STATE_LOCK = threading.Lock()
_state: dict[str, object] = {"connecting": False, "error": None, "started_at": 0.0}
_confirm_event = threading.Event()       # set when the user says "I've logged in"
_login_thread: threading.Thread | None = None


# ----------------------------------------------------------------- status
def has_session() -> bool:
    """True once a login has been completed and confirmed (the marker exists)."""
    return _MARKER.exists()


def status() -> dict[str, object]:
    with _STATE_LOCK:
        connecting = bool(_state["connecting"])
        error = _state["error"]
    return {"connected": has_session(), "connecting": connecting, "error": error}


def disconnect() -> dict[str, object]:
    """Forget the saved session (clears the profile) so the user can re-connect fresh."""
    with _PROFILE_LOCK:
        shutil.rmtree(PROFILE_DIR, ignore_errors=True)
    with _STATE_LOCK:
        _state["error"] = None
    return status()


# ----------------------------------------------------------------- login flow
def _login_worker(timeout_s: int) -> None:
    from playwright.sync_api import sync_playwright

    ok = False
    err: str | None = None
    try:
        with _PROFILE_LOCK, sync_playwright() as p:
            ctx = _launch(p, headless=False)
            try:
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                with contextlib.suppress(Exception):
                    page.goto("https://whop.com/login", wait_until="domcontentloaded", timeout=30000)
                # Keep the window open until the user confirms (or gives up / closes it).
                deadline = time.monotonic() + timeout_s
                while time.monotonic() < deadline:
                    if _confirm_event.wait(timeout=2):
                        ok = True         # trust the user's confirm; sync-preview verifies
                        break
                    if not ctx.pages:     # user closed the window without confirming
                        break
            finally:
                ctx.close()               # persists cookies to the profile
        if ok:
            _MARKER.write_text("1", encoding="utf-8")
        else:
            err = "Login not completed"
    except Exception as exc:              # pragma: no cover - browser/OS dependent
        err = str(exc)
        logger.info("Whop connect failed: %s", exc)
    finally:
        _confirm_event.clear()
        with _STATE_LOCK:
            _state["connecting"] = False
            _state["error"] = None if ok else err


def start_connect(timeout_s: int = 300) -> dict[str, object]:
    """Open a visible Chrome window at Whop login for a one-time sign-in. Non-blocking.

    The window stays open until the user calls :func:`confirm_connect` (or it times out).
    """
    global _login_thread
    with _STATE_LOCK:
        if _state["connecting"]:
            return status()
        _state["connecting"] = True
        _state["error"] = None
        _state["started_at"] = time.time()
    _confirm_event.clear()
    _login_thread = threading.Thread(target=_login_worker, args=(timeout_s,), daemon=True)
    _login_thread.start()
    return status()


def confirm_connect() -> dict[str, object]:
    """Signal that the user finished logging in (verifies, closes the window, persists)."""
    _confirm_event.set()
    # Give the worker a moment to verify + write the marker so status reflects it.
    for _ in range(20):
        with _STATE_LOCK:
            if not _state["connecting"]:
                break
        time.sleep(0.5)
    return status()


# ----------------------------------------------------------------- authed fetch
def fetch(url: str, *, settle_ms: int = 2500, timeout_ms: int = 25000) -> dict | None:
    """Render ``url`` headlessly with the logged-in profile → ``{"text","hrefs"}`` or None.

    Returns None if not connected, the profile is busy (a login window is open), or the
    render fails — callers degrade to the anonymous/paste path.
    """
    if not has_session():
        return None
    if not _PROFILE_LOCK.acquire(timeout=1):
        logger.info("Whop profile busy; skipping authenticated fetch of %s", url)
        return None
    try:
        from playwright.sync_api import TimeoutError as PWTimeout, sync_playwright

        with sync_playwright() as p:
            ctx = _launch(p, headless=True)
            try:
                page = ctx.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                with contextlib.suppress(PWTimeout):
                    page.wait_for_load_state("networkidle", timeout=6000)
                page.wait_for_timeout(settle_ms)
                text = page.inner_text("body")
                hrefs = page.eval_on_selector_all("a[href]", "els => els.map(e => e.href)")
            finally:
                ctx.close()
    except Exception as exc:
        logger.info("Authenticated fetch failed for %s: %s", url, exc)
        return None
    finally:
        _PROFILE_LOCK.release()

    hrefs = [h for h in (hrefs or []) if isinstance(h, str) and h.startswith("http")]
    logger.info("Authenticated fetch %s: %d chars, %d links", url, len(text or ""), len(hrefs))
    return {"text": text or "", "hrefs": hrefs}


# ----------------------------------------------------------------- campaign crawl
# A Whop content-rewards "experience" (e.g. .../joined/<whop>/<exp>/app/) embeds the
# campaigns app in an apps.whop.com iframe. Each campaign card, when opened, shows a
# brief that links to a Google Doc — the real requirements. This crawls the list and
# opens each campaign to harvest those links.
def _app_frame(page):
    """The embedded apps.whop.com experience iframe (the campaigns app), or None."""
    return next(
        (f for f in page.frames if "apps.whop.com" in f.url and "experiences" in f.url),
        None,
    )


# Extract campaign titles from the browse-campaigns list. Cards read
# "[Clipping|UGC] <time ago> <TITLE> <community> Paid Out $…" — the community name is the
# non-boilerplate line common to most cards, so we drop it and keep the title.
_CAMPAIGN_TITLES_JS = r"""() => {
  // Nav/header/empty-state chrome that must not be mistaken for a campaign card.
  const NAV = /discover active campaigns|no campaigns found|home\s+submissions|analytics\s+users/i;
  const cards = Array.from(document.querySelectorAll('div,li,a')).filter(n => {
    const t = n.innerText || '';
    return t.length < 220 && /(paid out|cpm|\/\s*1k)/i.test(t) && !NAV.test(t);
  });
  const lines = t => t.split('\n').map(s=>s.trim()).filter(Boolean);
  const boiler = l => /^(clipping|ugc)$/i.test(l) || /ago$/i.test(l) || /^paid out/i.test(l)
    || /^\$/.test(l) || /^cpm/i.test(l) || /^\d/.test(l)
    || /^(yesterday|today|just now|now)$/i.test(l)
    || /^(home|submissions|analytics|discover|accounts|campaigns|browse|users|payouts)$/i.test(l);
  const freq = {};
  for (const c of cards) for (const l of lines(c.innerText)) if (!boiler(l)) freq[l]=(freq[l]||0)+1;
  const community = Object.entries(freq).sort((a,b)=>b[1]-a[1]).map(e=>e[0])[0] || '';
  const titles = [], seen = new Set();
  for (const c of cards) {
    const title = lines(c.innerText).filter(l => !boiler(l) && l !== community)[0];
    if (title && title.length >= 3 && !seen.has(title)) { seen.add(title); titles.push(title); }
  }
  return {community, titles};
}"""


# A whop's campaigns app is the experience whose slug is content-rewards / clipping-campaigns
# (e.g. .../content-rewards-<id>/app/ or .../general-clipping-campaigns-<id>/app/). Chat,
# course, "discover", and landing experiences don't match.
_CAMPAIGN_EXP_RE = re.compile(
    r"https://whop\.com/joined/[a-z0-9\-]+/(?:[a-z-]*?)(?:content-rewards|clipping-campaigns)-[A-Za-z0-9]+/app/",
    re.I,
)
_JOINED_WHOP_RE = re.compile(r"https://whop\.com/joined/([a-z0-9\-]+)", re.I)


def discover_experiences() -> list[str]:
    """Find the campaigns-app URL for every content-rewards whop the user has joined.

    Reads the authenticated ``/orders/`` list for joined whops, then finds each whop's
    content-rewards experience. Returns ``/joined/<whop>/<exp>/app/`` URLs (may be empty).
    """
    if not has_session():
        return []
    orders = fetch("https://whop.com/orders/", settle_ms=3500) or fetch("https://whop.com/hubs/")
    if not orders:
        return []
    whops: list[str] = []
    for h in orders["hrefs"]:
        m = _JOINED_WHOP_RE.match(h)
        if m and m.group(1) not in whops and m.group(1) not in ("hubs",):
            whops.append(m.group(1))

    exp_urls: list[str] = []
    for whop in whops:
        page = fetch(f"https://whop.com/joined/{whop}/", settle_ms=3500)
        if not page:
            continue
        match = next((_CAMPAIGN_EXP_RE.match(h) and h for h in page["hrefs"] if _CAMPAIGN_EXP_RE.match(h)), None)
        if match and match not in exp_urls:
            exp_urls.append(match)
    logger.info("Discovered %d content-rewards experiences across %d whops", len(exp_urls), len(whops))
    return exp_urls


def crawl_campaigns(app_url: str, *, limit: int = 40, settle_ms: int = 4500) -> list[dict] | None:
    """Crawl a content-rewards experience for each campaign's title + brief/doc links.

    Returns ``[{"title", "doc_links"}]`` (doc_links = Google Doc/Drive brief URLs), or
    None if not connected / the crawl fails. Best-effort per campaign.
    """
    from app.services import whop_requirements as wr

    if not has_session():
        return None
    if not _PROFILE_LOCK.acquire(timeout=1):
        logger.info("Whop profile busy; skipping crawl of %s", app_url)
        return None
    results: list[dict] = []
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            ctx = _launch(p, headless=True)
            try:
                page = ctx.new_page()
                page.goto(app_url, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(settle_ms + 1500)
                fr = _app_frame(page)
                if not fr:
                    return []
                for _ in range(5):                       # scroll to load the whole list
                    with contextlib.suppress(Exception):
                        fr.evaluate("window.scrollBy(0, 1500)")
                    page.wait_for_timeout(600)
                info = fr.evaluate(_CAMPAIGN_TITLES_JS) or {}
                titles = (info.get("titles") or [])[:limit]

                for title in titles:
                    try:
                        page.goto(app_url, wait_until="domcontentloaded", timeout=30000)
                        page.wait_for_timeout(settle_ms)
                        fr = _app_frame(page)
                        fr.get_by_text(title, exact=False).first.click(timeout=8000)
                        page.wait_for_timeout(settle_ms)
                        dfr = _app_frame(page)
                        hrefs = dfr.eval_on_selector_all("a[href]", "els => els.map(e => e.href)")
                        results.append({"title": title, "doc_links": wr._doc_urls(hrefs)})
                    except Exception as exc:
                        logger.info("Crawl campaign %r failed: %s", title, exc)
                        results.append({"title": title, "doc_links": []})
            finally:
                ctx.close()
    except Exception as exc:
        logger.info("Crawl failed for %s: %s", app_url, exc)
        return None
    finally:
        _PROFILE_LOCK.release()

    logger.info("Crawled %s: %d campaigns, %d with docs",
                app_url, len(results), sum(1 for r in results if r["doc_links"]))
    return results
