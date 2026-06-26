"""Reddit story discovery, authenticated when possible and public as a fallback.

Two read paths, chosen automatically per request:

* **App-only OAuth** (preferred) — when ``REDDIT_CLIENT_ID``/``REDDIT_CLIENT_SECRET``
  are configured, we mint an application-only bearer token and read the JSON
  listings on ``oauth.reddit.com`` (~100 reads/min). This is fast for
  multi-subreddit grabs and returns real score/comment counts, so ``min_upvotes``
  filtering works.
* **Public RSS** (fallback) — with no credentials (or if the token can't be
  obtained) we read the open ``.rss`` Atom feeds. Reddit hard-blocks the
  *unauthenticated* ``.json`` endpoints (HTTP 403) and throttles RSS to ~one pull
  per 30s per IP, so this path is paced behind a process-wide gate and a short
  response cache, and ``upvotes``/``num_comments`` come back as 0.
"""
from __future__ import annotations

import asyncio
import html
import re
import xml.etree.ElementTree as ET
from typing import Any

import httpx

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# Reddit throttles rapid unauthenticated reads with HTTP 429 — empirically only
# ~one feed pull per ~30s per IP, with no Retry-After header, and every extra
# request *while throttled* keeps the cooldown alive. So instead of retrying
# (which only pokes the limiter and makes it worse) we run every fetch through a
# single process-wide gate that paces reads ~30s apart, and back the gate with a
# short response cache so a repeat grab of the same feed never touches Reddit.
_MIN_INTERVAL = 30.0          # min spacing between live feed pulls (per process)
_COOLDOWN_AFTER_429 = 35.0    # back off this long once Reddit returns a 429
_MAX_GATE_WAIT = 40.0         # never block a single request longer than this
_CACHE_TTL = 120.0            # serve an identical feed pull from cache this long

# Process-wide RSS throttle state. The lock serializes every public read so the
# pacing holds even when several grabs overlap; ``_next_allowed`` is on the event
# loop's monotonic clock. The cache holds a still-fresh response keyed by the
# feed's identity ("<mode>:<subreddit>|<sort>|<window>|<limit>") — RSS stores the
# raw Atom text, OAuth the parsed post list — independent of the body filters.
_reddit_lock = asyncio.Lock()
_next_allowed = 0.0
_feed_cache: dict[str, tuple[float, Any]] = {}

# App-only OAuth token state (used only when credentials are configured). The
# token is cached until shortly before it expires; the lock keeps overlapping
# grabs from minting several at once.
_TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
_OAUTH_BASE = "https://oauth.reddit.com"
_token_lock = asyncio.Lock()
_token: str | None = None
_token_expiry = 0.0


class _RedditAuthError(Exception):
    """The OAuth token couldn't be obtained/used — caller falls back to RSS."""

# Present as a real browser; bare library User-Agents are more likely to be
# challenged by Reddit's edge.
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
_HEADERS = {
    "User-Agent": _UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
_VALID_SORTS = {"hot", "top", "new", "rising"}
_VALID_WINDOWS = {"hour", "day", "week", "month", "year", "all"}

_ATOM = "{http://www.w3.org/2005/Atom}"

# Markdown / formatting noise we strip before scoring and narration.
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_MD_MARKS = re.compile(r"[*_~^]{1,3}")
_WS = re.compile(r"[ \t]+")

# RSS entry bodies are rendered HTML; turn block-level tags into line breaks
# before stripping the rest so paragraphs survive.
_HTML_BR = re.compile(r"<br\s*/?>", re.I)
_HTML_BLOCK = re.compile(r"</(p|div|li|ul|ol|blockquote|h[1-6]|tr|table)>", re.I)
_HTML_TAG = re.compile(r"<[^>]+>")


def clean_text(raw: str) -> str:
    text = html.unescape(raw or "")
    text = _MD_LINK.sub(r"\1", text)
    text = text.replace("&#x200B;", " ").replace("​", " ")
    text = _MD_MARKS.sub("", text)
    lines = [_WS.sub(" ", ln).strip() for ln in text.splitlines()]
    out: list[str] = []
    blank = False
    for ln in lines:
        if not ln:
            if not blank:
                out.append("")
            blank = True
        else:
            out.append(ln)
            blank = False
    return "\n".join(out).strip()


def _html_to_text(raw: str) -> str:
    """Flatten a Reddit RSS HTML body to clean plain text."""
    text = _HTML_BR.sub("\n", raw or "")
    text = _HTML_BLOCK.sub("\n", text)
    text = _HTML_TAG.sub("", text)
    return clean_text(text)


def _cache_get(key: str, now: float) -> str | None:
    """Return a still-fresh cached feed body, or ``None`` (evicting if stale)."""
    item = _feed_cache.get(key)
    if item is None:
        return None
    expiry, feed = item
    if expiry <= now:
        _feed_cache.pop(key, None)
        return None
    return feed


async def _fetch_feed(
    url: str, params: dict[str, str], sub: str, loop: asyncio.AbstractEventLoop
) -> str:
    """Fetch one RSS feed through the shared throttle gate.

    Holds ``_reddit_lock`` across both the wait and the request so only one read
    is in flight and reads stay paced ~``_MIN_INTERVAL`` apart. On a 429 we set a
    longer cooldown and let the caller surface the "one subreddit at a time" note
    — we deliberately do NOT retry, since hitting Reddit again during a cooldown
    just keeps it alive.
    """
    global _next_allowed
    async with _reddit_lock:
        wait = min(_next_allowed - loop.time(), _MAX_GATE_WAIT)
        if wait > 0:
            logger.info("Reddit throttle: waiting %.0fs before r/%s", wait, sub)
            await asyncio.sleep(wait)
        async with httpx.AsyncClient(
            headers=_HEADERS, timeout=30, follow_redirects=True
        ) as client:
            resp = await client.get(url, params=params)
        if resp.status_code == 429:
            _next_allowed = loop.time() + _COOLDOWN_AFTER_429
            logger.info("Reddit r/%s rate-limited (429); cooling down %.0fs", sub, _COOLDOWN_AFTER_429)
        else:
            _next_allowed = loop.time() + _MIN_INTERVAL
    resp.raise_for_status()
    return resp.text


def _oauth_enabled() -> bool:
    """True when app-only OAuth credentials are configured."""
    return bool(settings.REDDIT_CLIENT_ID and settings.REDDIT_CLIENT_SECRET)


async def _get_token(loop: asyncio.AbstractEventLoop) -> str:
    """Return a cached app-only bearer token, minting a fresh one when needed."""
    global _token, _token_expiry
    async with _token_lock:
        if _token and loop.time() < _token_expiry:
            return _token
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    _TOKEN_URL,
                    data={"grant_type": "client_credentials"},
                    auth=(settings.REDDIT_CLIENT_ID or "", settings.REDDIT_CLIENT_SECRET or ""),
                    headers={"User-Agent": settings.DISCOVERY_USER_AGENT},
                )
        except httpx.HTTPError as exc:
            raise _RedditAuthError(f"token request failed: {exc}") from exc
        if resp.status_code != 200:
            raise _RedditAuthError(f"token request returned HTTP {resp.status_code}")
        payload = resp.json()
        token = payload.get("access_token")
        if not token:
            raise _RedditAuthError("token response carried no access_token")
        # Refresh a minute early so an in-flight request never races expiry.
        _token = token
        _token_expiry = loop.time() + float(payload.get("expires_in") or 3600) - 60
        logger.info("Reddit OAuth token acquired")
        return token


async def _fetch_oauth_children(
    sub: str, sort: str, time_window: str, limit: int, loop: asyncio.AbstractEventLoop
) -> list[dict[str, Any]]:
    """Read a subreddit listing via the authenticated API; return raw children.

    Results are cached briefly (keyed by feed identity) so a repeat grab of the
    same listing doesn't spend another API call. A rejected token (401) is
    cleared and reported as an auth error so the caller can fall back to RSS.
    """
    global _token, _token_expiry
    cache_key = f"oauth:{sub}|{sort}|{time_window}|{limit}"
    cached = _cache_get(cache_key, loop.time())
    if cached is not None:
        return cached

    token = await _get_token(loop)
    params: dict[str, str] = {"limit": str(limit), "raw_json": "1"}
    if sort == "top":
        params["t"] = time_window
    headers = {"User-Agent": settings.DISCOVERY_USER_AGENT, "Authorization": f"bearer {token}"}
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        resp = await client.get(f"{_OAUTH_BASE}/r/{sub}/{sort}", params=params, headers=headers)
    if resp.status_code == 401:
        _token, _token_expiry = None, 0.0  # force a re-auth next time
        raise _RedditAuthError("listing returned 401 (token rejected)")
    resp.raise_for_status()
    children = resp.json().get("data", {}).get("children", [])
    _feed_cache[cache_key] = (loop.time() + _CACHE_TTL, children)
    return children


def _stories_from_oauth(
    children: list[dict[str, Any]], sub: str, sort: str, min_length: int, min_upvotes: int
) -> list[dict[str, Any]]:
    """Normalize authenticated listing children into story dicts (with counts)."""
    stories: list[dict[str, Any]] = []
    for child in children:
        post = child.get("data", {})
        if not post.get("is_self"):
            continue  # only self/text posts carry a story body
        body = clean_text(post.get("selftext") or "")
        if len(body) < min_length:
            continue
        upvotes = int(post.get("ups") or 0)
        if min_upvotes > 0 and upvotes < min_upvotes:
            continue
        permalink = post.get("permalink") or ""
        stories.append(
            {
                "source": "reddit",
                "external_id": f"reddit:{post.get('id')}",
                "source_url": (f"https://www.reddit.com{permalink}" if permalink else post.get("url") or ""),
                "community": f"r/{sub}",
                "author": (post.get("author") or None),
                "title": clean_text(post.get("title") or "")[:512],
                "body": body,
                "upvotes": upvotes,
                "num_comments": int(post.get("num_comments") or 0),
            }
        )
    logger.info("Reddit r/%s (%s, oauth): %d usable stories", sub, sort, len(stories))
    return stories


async def fetch_community(
    community: str,
    *,
    sort: str = "top",
    time_window: str = "week",
    limit: int = 25,
    min_upvotes: int = 0,
    min_length: int = 300,
) -> list[dict[str, Any]]:
    """Fetch text posts from a subreddit; returns normalized story dicts."""
    sub = community.strip().removeprefix("/").removeprefix("r/").strip("/")
    if not sub:
        return []
    sort = sort if sort in _VALID_SORTS else "top"
    time_window = time_window if time_window in _VALID_WINDOWS else "week"
    limit = max(1, min(100, limit))
    loop = asyncio.get_running_loop()

    # Preferred path: authenticated API (fast, real counts). On any auth/token
    # failure, fall through to the public RSS feed so discovery still works.
    if _oauth_enabled():
        try:
            children = await _fetch_oauth_children(sub, sort, time_window, limit, loop)
            return _stories_from_oauth(children, sub, sort, min_length, min_upvotes)
        except _RedditAuthError as exc:
            logger.warning("Reddit OAuth unavailable (%s) — falling back to public RSS", exc)

    params = {"limit": str(limit)}
    if sort == "top":
        params["t"] = time_window
    url = f"https://www.reddit.com/r/{sub}/{sort}.rss"
    cache_key = f"rss:{sub}|{sort}|{time_window}|{limit}"

    feed = _cache_get(cache_key, loop.time())
    if feed is None:
        feed = await _fetch_feed(url, params, sub, loop)
        _feed_cache[cache_key] = (loop.time() + _CACHE_TTL, feed)

    try:
        root = ET.fromstring(feed)
    except ET.ParseError:
        logger.warning("Reddit r/%s (%s): unparseable RSS feed", sub, sort)
        return []

    stories: list[dict[str, Any]] = []
    for entry in root.findall(f"{_ATOM}entry"):
        body = _html_to_text(entry.findtext(f"{_ATOM}content") or "")
        if len(body) < min_length:
            continue

        # Atom id looks like "t3_abc123"; the trailing token is the post id.
        post_id = (entry.findtext(f"{_ATOM}id") or "").split("_")[-1]
        author = (entry.findtext(f"{_ATOM}author/{_ATOM}name") or "").removeprefix("/u/")
        link = entry.find(f"{_ATOM}link")
        source_url = link.get("href") if link is not None else ""
        stories.append(
            {
                "source": "reddit",
                "external_id": f"reddit:{post_id}",
                "source_url": source_url,
                "community": f"r/{sub}",
                "author": author or None,
                "title": clean_text(entry.findtext(f"{_ATOM}title") or "")[:512],
                "body": body,
                # RSS feeds omit these counts; they default to 0 and engagement
                # scoring falls back to its baseline.
                "upvotes": 0,
                "num_comments": 0,
            }
        )
    if min_upvotes > 0:
        logger.debug("Reddit r/%s: min_upvotes ignored (RSS has no score)", sub)
    logger.info("Reddit r/%s (%s): %d usable stories", sub, sort, len(stories))
    return stories
