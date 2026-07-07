"""Unit tests for the Whop link-preview scraper (pure, no network or DB)."""
import pytest
from fastapi import HTTPException

from app.api.v1.endpoints import whop as whop_endpoints
from app.services.whop_preview import extract_preview, normalize_whop_url


def test_normalize_whop_url_rules():
    assert normalize_whop_url("whop.com/abc").startswith("https://whop.com/abc")
    assert normalize_whop_url("http://whop.com/x") == "https://whop.com/x"
    assert normalize_whop_url("https://foo.whop.com/y") == "https://foo.whop.com/y"
    with pytest.raises(ValueError):
        normalize_whop_url("https://example.com/whop.com")
    with pytest.raises(ValueError):
        normalize_whop_url("   ")


def test_extract_preview_reads_meta_tags():
    html_doc = """
    <html><head>
      <meta property="og:title" content="My Clip Campaign">
      <meta property="og:description" content="Earn $2 / 1K views">
      <meta property="og:image" content="/cover.png">
      <meta property="og:site_name" content="Whop">
      <title>ignored fallback</title>
    </head></html>
    """
    data = extract_preview(html_doc, "https://whop.com/foo/")
    assert data["title"] == "My Clip Campaign"
    assert data["description"] == "Earn $2 / 1K views"
    assert data["image"] == "https://whop.com/cover.png"  # relative resolved against page
    assert data["site_name"] == "Whop"


def test_extract_preview_twitter_and_entity_fallbacks():
    # No og:title/description → fall back to twitter:* and unescape entities.
    html_doc = (
        '<meta name="twitter:title" content="Ben &amp; Co">'
        '<meta name="twitter:description" content="clips">'
        '<meta name="twitter:image" content="https://img.whop.com/a.jpg">'
    )
    data = extract_preview(html_doc, "https://whop.com/x")
    assert data["title"] == "Ben & Co"
    assert data["description"] == "clips"
    assert data["image"] == "https://img.whop.com/a.jpg"


def test_extract_preview_title_fallback():
    data = extract_preview("<html><head><title>Just a title</title></head></html>", "https://whop.com/x")
    assert data["title"] == "Just a title"
    assert data["image"] is None


# The endpoint takes no DB session, so it's exercised directly (no client fixture,
# which keeps these off the flaky async-session teardown path).
async def test_url_preview_endpoint_rejects_non_whop():
    with pytest.raises(HTTPException) as exc:
        await whop_endpoints.url_preview(url="https://example.com/x", current_user=None)
    assert exc.value.status_code == 400


async def test_url_preview_endpoint_returns_metadata(monkeypatch):
    async def _fake_fetch(url: str) -> dict:
        assert "whop.com" in url
        return {
            "url": "https://whop.com/foo/",
            "title": "Foo Campaign",
            "description": "Clip it",
            "image": "https://img.whop.com/x.png",
            "site_name": "Whop",
        }

    monkeypatch.setattr(whop_endpoints, "fetch_url_preview", _fake_fetch)
    out = await whop_endpoints.url_preview(url="https://whop.com/foo", current_user=None)
    assert out.title == "Foo Campaign"
    assert out.image == "https://img.whop.com/x.png"


# --------------------------------------------------- marketplace scraper parse
def test_parse_marketplace_extracts_and_maps():
    from app.schemas.whop import WhopImportItem
    from app.services.whop_marketplace import parse_marketplace_html

    obj = (
        r'{\"avatar\":\"a\",\"brand\":\"BrandCo\",\"title\":\"Test Campaign\",'
        r'\"description\":\"A desc\",\"pricePerView\":\"$$2.50\",\"totalBudget\":\"$$10,000\",'
        r'\"category\":\"Music\",\"campaignType\":\"clipping\",'
        r'\"socialPlatforms\":[\"tiktok\",\"facebook\"],\"status\":\"active\",'
        r'\"whopProductRoute\":\"my-route\"}'
    )
    recs = parse_marketplace_html("garbage " + obj + " more")
    assert len(recs) == 1
    r = recs[0]
    assert r["name"] == "Test Campaign"
    assert r["rate_per_1k"] == 2.5
    assert r["budget"] == 10000.0
    assert r["category"] == "music"
    assert r["status"] == "active"
    assert r["platforms"] == ["tiktok"]  # facebook filtered (not an app platform)
    assert r["whop_url"] == "https://whop.com/my-route"
    WhopImportItem(**r)  # must validate against the import schema


def test_parse_marketplace_completed_and_unknowns():
    from app.schemas.whop import WhopImportItem
    from app.services.whop_marketplace import parse_marketplace_html

    obj = (
        r'{\"avatar\":null,\"brand\":\"B\",\"title\":\"Done Campaign\",'
        r'\"pricePerView\":\"$$1\",\"totalBudget\":\"$$500\",\"category\":\"Whatever\",'
        r'\"campaignType\":\"weird\",\"socialPlatforms\":[],\"status\":\"completed\",'
        r'\"whopProductRoute\":null}'
    )
    recs = parse_marketplace_html("x" + obj + "y")
    assert len(recs) == 1
    r = recs[0]
    assert r["status"] == "ended"            # completed → ended
    assert r["category"] == "other"          # unknown category → other
    assert r["campaign_type"] == "clipping"  # invalid type → clipping
    assert r["whop_url"] is None
    WhopImportItem(**r)
