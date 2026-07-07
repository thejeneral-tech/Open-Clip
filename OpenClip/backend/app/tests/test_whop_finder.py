"""Tests for the Whop auto video finder (campaign_finder + endpoint)."""
import uuid

import pytest

from app.services import campaign_finder


# ------------------------------------------------------------- pure unit tests
def test_source_name_strips_clipping_vocabulary():
    assert campaign_finder._source_name("Rob the Bank Podcast Clips").lower() == "rob the bank podcast"
    assert "campaign" not in campaign_finder._source_name("Crypto Bros Clipping Campaign").lower()
    assert "clips" not in campaign_finder._source_name("Theo Von Clips").lower()


def test_understand_detects_thin_description():
    u = campaign_finder.understand_campaign(
        {"name": "Foo Show Clips", "description": "Foo · Whop Content Rewards", "category": "entertainment"}
    )
    assert u["description_reliable"] is False
    assert u["queries"]
    assert u["queries"][0].lower().startswith("foo show")  # anchored on the title


def test_understand_all_suffix_title_avoids_clipping_vocab_query():
    # A name that is ENTIRELY clipping vocabulary must not be searched literally.
    u = campaign_finder.understand_campaign(
        {"name": "UGC Clips Campaign", "description": "", "category": "gaming"}
    )
    assert u["description_reliable"] is False
    assert u["queries"], "should still produce a fallback query"
    for q in u["queries"]:
        low = q.lower()
        assert "clips" not in low and "campaign" not in low and "ugc" not in low


def test_understand_uses_real_description():
    u = campaign_finder.understand_campaign(
        {
            "name": "Money Show Clips",
            "description": "Clip the best moments about investing and wealth building strategies.",
            "category": "education",
        }
    )
    assert u["description_reliable"] is True
    joined = " ".join(u["queries"]).lower()
    assert any(w in joined for w in ("invest", "wealth", "money"))


def test_rank_orders_by_relevance_and_duration():
    u = {"topic": "Rob the Bank Podcast", "keywords": ["rob", "bank", "podcast"]}
    candidates = [
        {"id": "a", "title": "Rob the Bank Full Episode", "uploader": "Rob The Bank",
         "duration": 3600, "url": "u1", "_from_primary": True},
        {"id": "b", "title": "Random cooking tutorial", "uploader": "Chef Mike",
         "duration": 600, "url": "u2", "_from_primary": False},
        {"id": "c", "title": "bank short", "uploader": "x", "duration": 25, "url": "u3",
         "_from_primary": False},
    ]
    ranked = campaign_finder.rank_matches(u, candidates, primary_query="Rob the Bank Podcast", limit=10)
    assert ranked[0]["url"] == "u1"          # source + keywords + long duration wins
    assert ranked[-1]["url"] == "u3"         # 25s short, no overlap → last
    assert all("score" in r and "reason" in r for r in ranked)
    assert ranked[0]["score"] > ranked[-1]["score"]


def test_find_matches_dedupes_across_queries(monkeypatch):
    def fake_search(query, limit):
        return [
            {"id": "dup", "title": "Rob the Bank Podcast Ep 1", "uploader": "Rob The Bank",
             "duration": 3000, "url": "https://youtu.be/dup", "view_count": 1000, "thumbnail": "t"},
        ]

    monkeypatch.setattr(campaign_finder.youtube, "search", fake_search)
    monkeypatch.setattr(campaign_finder, "_llm_understand", lambda *a, **k: None)  # heuristic path
    res = campaign_finder.find_matches(
        {"name": "Rob the Bank Podcast Clips", "description": "", "category": "entertainment"}, limit=6
    )
    assert res["queries"]
    assert len(res["matches"]) == 1          # same id from multiple queries collapses to one
    assert res["matches"][0]["score"] > 0
    assert res["matches"][0]["url"] == "https://youtu.be/dup"


def test_channel_url_resolution():
    from app.services.youtube import _channel_url

    assert _channel_url("@robthebank") == "https://www.youtube.com/@robthebank/videos"
    assert _channel_url("https://www.youtube.com/@x").endswith("/videos")
    assert _channel_url("https://www.youtube.com/@x/videos").endswith("/videos")
    assert _channel_url("Rob The Bank") is None  # plain name → search fallback, no guess


def test_find_matches_pins_channel_and_boosts_filters(monkeypatch):
    def fake_channel_videos(ref, limit):
        return [
            {"id": "ch1", "title": "Rob The Bank Full Episode", "uploader": "Rob The Bank",
             "duration": 3600, "url": "https://youtu.be/ch1", "view_count": 1000, "thumbnail": "t"},
        ]

    def fake_search(query, limit):
        return [
            {"id": "s1", "title": "Unrelated cooking video", "uploader": "Chef",
             "duration": 600, "url": "https://youtu.be/s1", "view_count": 50, "thumbnail": "t"},
        ]

    monkeypatch.setattr(campaign_finder.youtube, "channel_videos", fake_channel_videos)
    monkeypatch.setattr(campaign_finder.youtube, "search", fake_search)
    monkeypatch.setattr(campaign_finder, "_llm_understand", lambda *a, **k: None)

    res = campaign_finder.find_matches(
        {"name": "Rob the Bank Podcast Clips", "description": "", "category": "entertainment"},
        limit=6,
        channel="https://www.youtube.com/@robthebankmotion",
        filters=["mindset", "money"],
    )
    urls = [m["url"] for m in res["matches"]]
    assert "https://youtu.be/ch1" in urls               # the pinned channel's upload is included
    assert res["matches"][0]["url"] == "https://youtu.be/ch1"  # and ranks first (from_channel bonus)
    assert "robthebankmotion" in res["understanding"]   # refinement surfaced to the user
    assert "channel" in res["matches"][0]["reason"].lower()


def test_find_matches_uses_llm_when_available(monkeypatch):
    captured: list[str] = []

    def fake_search(query, limit):
        captured.append(query)
        return [
            {"id": "v", "title": "Rob the Bank Full Episode", "uploader": "Rob The Bank",
             "duration": 3600, "url": "https://youtu.be/v", "view_count": 9000, "thumbnail": "t"},
        ]

    def fake_llm(campaign, **kwargs):
        return {
            "topic": "Rob the Bank Podcast",
            "keywords": ["rob", "bank", "podcast"],
            "queries": ["Rob the Bank podcast full episodes", "Rob the Bank interview"],
            "understanding": "Understood this campaign as Rob the Bank Podcast …",
        }

    monkeypatch.setattr(campaign_finder.youtube, "search", fake_search)
    monkeypatch.setattr(campaign_finder, "_llm_understand", fake_llm)
    res = campaign_finder.find_matches(
        {"name": "RTB Clipping Campaign", "description": "", "category": "entertainment"}, limit=6
    )
    # LLM's targeted queries drive the search, not the raw heuristic name.
    assert "Rob the Bank podcast full episodes" in captured
    assert res["understanding"].startswith("Understood this campaign as Rob the Bank")
    assert res["matches"][0]["url"] == "https://youtu.be/v"


# ------------------------------------------------------------- endpoint tests
async def _register(client) -> dict:
    email = f"finder_{uuid.uuid4().hex[:8]}@example.com"
    res = await client.post("/api/v1/auth/register", json={"email": email, "password": "password123"})
    assert res.status_code == 201, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


@pytest.mark.asyncio
async def test_find_videos_endpoint(client, monkeypatch):
    def fake_search(query, limit):
        return [
            {"id": "vid1", "title": "Rob the Bank Podcast Ep", "uploader": "Rob The Bank",
             "duration": 3200, "url": "https://youtu.be/vid1", "view_count": 5000,
             "thumbnail": "https://i.ytimg.com/vi/vid1/hqdefault.jpg"},
        ]

    monkeypatch.setattr(campaign_finder.youtube, "search", fake_search)
    monkeypatch.setattr(campaign_finder, "_llm_understand", lambda *a, **k: None)  # no ollama in tests
    headers = await _register(client)
    camp = await client.post(
        "/api/v1/whop/campaigns",
        json={"name": "Rob the Bank Podcast Clips", "rate_per_1k": 1.0, "platforms": ["tiktok"]},
        headers=headers,
    )
    cid = camp.json()["id"]

    res = await client.post(f"/api/v1/whop/campaigns/{cid}/find-videos?limit=6", headers=headers)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["understanding"]
    assert body["queries"]
    assert len(body["matches"]) >= 1
    assert body["matches"][0]["url"] == "https://youtu.be/vid1"
    assert 0 <= body["matches"][0]["score"] <= 100


@pytest.mark.asyncio
async def test_find_videos_requires_ownership(client):
    headers = await _register(client)
    res = await client.post("/api/v1/whop/campaigns/999999/find-videos", headers=headers)
    assert res.status_code == 404
