"""Scrape Whop's public Content Rewards marketplace for its campaign list.

The discover app (``contentrewards.com`` / ``*.apps.whop.com``) is server-side
rendered, so the full campaign list is embedded in the page HTML as React Server
Component data — fetchable directly server-side with a normal User-Agent (no
browser, no Cloudflare challenge). We pull the embedded campaign objects and map
them to the app's campaign shape so the rescan endpoint can upsert + reconcile.

Each embedded object looks like: ``{"avatar":..., "brand":..., "title":...,
"description":..., "pricePerView":"$$1.50", "totalBudget":"$$250,000",
"category":"Entertainment", "campaignType":"clipping",
"socialPlatforms":["tiktok","instagram"], "status":"active",
"whopProductRoute":"creator-casino-7b", ...}``.
"""
from __future__ import annotations

import json
import re

import httpx

from app.core.logging import get_logger

logger = get_logger(__name__)

_DISCOVER_URL = "https://contentrewards.com/discover"
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
_TIMEOUT = httpx.Timeout(30.0)

# Whop category label → this app's category vocabulary (unknowns fall back to "other").
_CATEGORY_MAP = {
    "personal brand": "personal_brand",
    "product": "products",
    "products": "products",
    "music": "music",
    "entertainment": "entertainment",
    "gaming": "gaming",
    "education": "education",
}
_VALID_PLATFORMS = {"tiktok", "instagram", "youtube", "x"}
_VALID_TYPES = {"clipping", "ugc", "faceless"}


def _money(value: object) -> float | None:
    if not value:
        return None
    m = re.search(r"[\d.]+", str(value).replace(",", ""))
    return float(m.group()) if m else None


def _map_campaign(obj: dict) -> dict | None:
    """Map a scraped marketplace object to a WhopImportItem-shaped dict."""
    name = (obj.get("title") or "").strip()
    if not name:
        return None
    rate = _money(obj.get("pricePerView")) or 1.0
    rate = min(max(rate, 0.01), 1000.0)  # schema requires 0 < rate <= 1000
    ctype = obj.get("campaignType")
    route = obj.get("whopProductRoute")
    desc = (obj.get("description") or "").strip() or (obj.get("brand") or "").strip()
    return {
        "name": name[:255],
        "description": (desc[:1990] + ("…" if len(desc) > 1990 else "")) or None,
        "campaign_type": ctype if ctype in _VALID_TYPES else "clipping",
        "category": _CATEGORY_MAP.get((obj.get("category") or "").strip().lower(), "other"),
        "status": "ended" if obj.get("status") == "completed" else "active",
        "rate_per_1k": round(rate, 4),
        "budget": _money(obj.get("totalBudget")),
        "platforms": [p for p in (obj.get("socialPlatforms") or []) if p in _VALID_PLATFORMS],
        "whop_url": f"https://whop.com/{route}" if route else None,
    }


def parse_marketplace_html(html: str) -> list[dict]:
    """Extract campaign objects from the discover page's embedded RSC payload."""
    # RSC serializes JSON inside JS string chunks with backslash-escaped quotes.
    text = html.replace('\\"', '"').replace("\\\\", "\\")
    decoder = json.JSONDecoder()
    out: list[dict] = []
    seen: set[str] = set()
    idx = 0
    while True:
        start = text.find('{"avatar":', idx)
        if start == -1:
            break
        try:
            obj, end = decoder.raw_decode(text, start)
            idx = end
        except json.JSONDecodeError:
            idx = start + 10
            continue
        if not (isinstance(obj, dict) and "title" in obj and "totalBudget" in obj):
            continue
        key = str(obj.get("id") or obj.get("title"))
        if key in seen:
            continue
        seen.add(key)
        mapped = _map_campaign(obj)
        if mapped:
            out.append(mapped)
    return out


async def fetch_marketplace_campaigns() -> list[dict]:
    """Fetch + parse the public Content Rewards marketplace live (the active list).

    The discover page is served ``no-store`` / dynamically rendered, and httpx
    doesn't cache, so every call is a fresh render of Whop's current published
    campaign list. The explicit no-cache request headers below defend against any
    intermediary proxy/CDN ever handing back a stale copy. (Whop batch-updates the
    live spend/view *metrics* on its own delay — but those aren't imported.)
    """
    headers = {
        "User-Agent": _UA,
        "Cache-Control": "no-cache, no-store, max-age=0",
        "Pragma": "no-cache",
    }
    async with httpx.AsyncClient(
        timeout=_TIMEOUT, follow_redirects=True, headers=headers
    ) as client:
        resp = await client.get(_DISCOVER_URL)
    resp.raise_for_status()
    campaigns = parse_marketplace_html(resp.text)
    logger.info("Whop marketplace scrape: parsed %d campaigns", len(campaigns))
    return campaigns
