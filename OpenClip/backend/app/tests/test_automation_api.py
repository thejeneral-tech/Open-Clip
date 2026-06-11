"""End-to-end API tests for the automation layer (skipped without a test DB)."""
from __future__ import annotations

import uuid

import pytest

pytestmark = pytest.mark.asyncio


async def _auth(client) -> dict:
    email = f"bots_{uuid.uuid4().hex[:8]}@example.com"
    res = await client.post("/api/v1/auth/register", json={"email": email, "password": "password123"})
    assert res.status_code == 201, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


async def test_presets_seeded_and_listed(client):
    headers = await _auth(client)
    # The lifespan seed runs on app startup; ensure it ran for this client.
    from app.services.preset_store import seed_system_presets

    seed_system_presets()
    res = await client.get("/api/v1/presets", headers=headers)
    assert res.status_code == 200
    keys = {p["key"] for p in res.json()}
    assert {"AI_NEWS", "PODCAST_VIRAL", "CUSTOM"} <= keys


async def test_bot_full_lifecycle(client):
    headers = await _auth(client)

    # create from a preset
    created = await client.post(
        "/api/v1/bots",
        json={"name": "My AI Bot", "preset_key": "AI_NEWS", "approval_mode": "semi_auto",
              "config_overrides": {"clipping": {"target_clip_count": 5}}},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    bot = created.json()
    bid = bot["id"]
    assert bot["clipping_config"]["target_clip_count"] == 5
    assert bot["status"] == "stopped"

    # add a source
    src = await client.post(
        f"/api/v1/bots/{bid}/sources",
        json={"platform": "rss", "name": "feed", "identifier": "https://example.com/rss"},
        headers=headers,
    )
    assert src.status_code == 201
    assert (await client.get(f"/api/v1/bots/{bid}/sources", headers=headers)).json()

    # lifecycle: start -> active + next_run set
    started = await client.post(f"/api/v1/bots/{bid}/start", headers=headers)
    assert started.json()["status"] == "active"
    assert started.json()["next_run_at"] is not None

    paused = await client.post(f"/api/v1/bots/{bid}/pause", headers=headers)
    assert paused.json()["status"] == "paused"

    stopped = await client.post(f"/api/v1/bots/{bid}/stop", headers=headers)
    assert stopped.json()["status"] == "stopped"

    # clone
    clone = await client.post(f"/api/v1/bots/{bid}/clone", headers=headers)
    assert clone.status_code == 201
    assert clone.json()["name"].endswith("(copy)")

    # export -> import round-trip
    exported = await client.get(f"/api/v1/bots/{bid}/export", headers=headers)
    assert exported.status_code == 200
    imported = await client.post("/api/v1/bots/import", json=exported.json(), headers=headers)
    assert imported.status_code == 201
    assert imported.json()["bot_type"] == "ai_news"


async def test_bot_isolation_between_users(client):
    a = await _auth(client)
    b = await _auth(client)
    created = await client.post("/api/v1/bots", json={"name": "Private", "preset_key": "CUSTOM"}, headers=a)
    bid = created.json()["id"]
    # user B cannot see or fetch user A's bot
    assert all(x["id"] != bid for x in (await client.get("/api/v1/bots", headers=b)).json())
    assert (await client.get(f"/api/v1/bots/{bid}", headers=b)).status_code == 404


async def test_discovery_platforms_and_publishing_connectors(client):
    headers = await _auth(client)
    plats = await client.get("/api/v1/discovery/platforms", headers=headers)
    assert "rss" in plats.json()["platforms"]

    conn = await client.post(
        "/api/v1/publishing/connectors",
        json={"platform": "youtube", "name": "My Channel", "credentials": {"access_token": "x"}},
        headers=headers,
    )
    assert conn.status_code == 201
    body = conn.json()
    assert body["has_credentials"] is True
    assert "credentials" not in body  # secrets never returned
    assert body["status"] == "connected"


async def test_ollama_status_endpoint(client):
    headers = await _auth(client)
    res = await client.get("/api/v1/automation/ollama/status", headers=headers)
    assert res.status_code == 200
    body = res.json()
    assert "ollama_up" in body and "gpus" in body and "max_concurrency" in body
