"""Fetch OpenGraph metadata for a Whop URL so campaigns can be imported by link.

Whop pages can't be embedded in an iframe (they send ``X-Frame-Options`` /
``frame-ancestors``), so the campaign form previews a pasted link by reading its
``og:*`` / ``twitter:*`` meta tags server-side instead. Fetches are restricted to
``whop.com`` hosts to keep this from becoming an open SSRF proxy. Parsing uses the
standard-library HTML parser — no third-party dependency, like the rest of the app.
"""
from __future__ import annotations

import html
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import httpx

from app.core.logging import get_logger

logger = get_logger(__name__)

_TIMEOUT = httpx.Timeout(10.0)
_MAX_BYTES = 2_000_000
# A browser-ish UA — some CDNs return a stripped page to unknown agents.
_USER_AGENT = (
    "Mozilla/5.0 (compatible; OpenClipBot/1.0; +https://openclip.local) "
    "AppleWebKit/537.36 (KHTML, like Gecko)"
)


def _is_whop_host(host: str) -> bool:
    host = host.lower()
    return host == "whop.com" or host.endswith(".whop.com")


def normalize_whop_url(raw: str) -> str:
    """Return a clean ``https`` whop.com URL, or raise ``ValueError``.

    Adds a scheme when the user pasted a bare ``whop.com/...`` string, forces
    https, and rejects any non-whop host so this can't be used to fetch arbitrary
    (including internal) URLs.
    """
    url = (raw or "").strip()
    if not url:
        raise ValueError("Enter a Whop URL")
    if "://" not in url:
        url = "https://" + url
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("URL must start with http(s)")
    if not _is_whop_host(parsed.hostname or ""):
        raise ValueError("Only whop.com links can be previewed")
    return parsed._replace(scheme="https").geturl()


class _MetaParser(HTMLParser):
    """Collect ``<meta>`` property/name → content pairs and the ``<title>``."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title: str | None = None
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "title":
            self._in_title = True
            return
        if tag != "meta":
            return
        a = {k.lower(): (v or "") for k, v in attrs}
        key = a.get("property") or a.get("name")
        content = a.get("content")
        # Keep the first value seen for a key — pages list the canonical og tag first.
        if key and content and key.lower() not in self.meta:
            self.meta[key.lower()] = content

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title and self.title is None:
            text = data.strip()
            if text:
                self.title = text


def _first(meta: dict[str, str], *keys: str) -> str | None:
    for key in keys:
        value = meta.get(key)
        if value:
            return html.unescape(value).strip() or None
    return None


def extract_preview(html_text: str, base_url: str) -> dict[str, str | None]:
    """Pull title / description / image / site name out of a page's meta tags."""
    parser = _MetaParser()
    parser.feed(html_text)
    meta = parser.meta

    image = _first(meta, "og:image", "og:image:url", "og:image:secure_url", "twitter:image")
    if image:
        image = urljoin(base_url, image)  # resolve relative og:image against the page
    return {
        "url": base_url,
        "title": _first(meta, "og:title", "twitter:title") or parser.title,
        "description": _first(meta, "og:description", "twitter:description", "description"),
        "image": image,
        "site_name": _first(meta, "og:site_name"),
    }


async def fetch_url_preview(raw_url: str) -> dict[str, str | None]:
    """Fetch a whop.com page and return its link-preview metadata."""
    url = normalize_whop_url(raw_url)
    async with httpx.AsyncClient(
        timeout=_TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": _USER_AGENT, "Accept": "text/html,application/xhtml+xml"},
    ) as client:
        resp = await client.get(url)
    resp.raise_for_status()

    ctype = resp.headers.get("content-type", "").lower()
    body = resp.text[:_MAX_BYTES] if "html" in ctype else ""
    return extract_preview(body, str(resp.url))
