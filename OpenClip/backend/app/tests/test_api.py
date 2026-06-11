"""End-to-end API tests (skipped automatically when no test DB is available)."""
import uuid

import pytest

pytestmark = pytest.mark.asyncio


async def _register(client) -> str:
    email = f"user_{uuid.uuid4().hex[:8]}@example.com"
    res = await client.post("/api/v1/auth/register", json={"email": email, "password": "password123"})
    assert res.status_code == 201, res.text
    return res.json()["access_token"]


async def test_health(client):
    res = await client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


async def test_register_login_me(client):
    token = await _register(client)
    res = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    assert "@example.com" in res.json()["email"]


async def test_requires_auth(client):
    res = await client.get("/api/v1/projects")
    assert res.status_code == 401


async def test_project_crud(client):
    token = await _register(client)
    headers = {"Authorization": f"Bearer {token}"}

    created = await client.post("/api/v1/projects", json={"name": "Test"}, headers=headers)
    assert created.status_code == 201
    pid = created.json()["id"]

    listed = await client.get("/api/v1/projects", headers=headers)
    assert any(p["id"] == pid for p in listed.json())

    updated = await client.patch(f"/api/v1/projects/{pid}", json={"name": "Renamed"}, headers=headers)
    assert updated.json()["name"] == "Renamed"

    deleted = await client.delete(f"/api/v1/projects/{pid}", headers=headers)
    assert deleted.status_code == 200


async def test_settings_roundtrip(client):
    token = await _register(client)
    headers = {"Authorization": f"Bearer {token}"}
    res = await client.patch("/api/v1/settings", json={"target_clip_count": 25}, headers=headers)
    assert res.status_code == 200
    assert res.json()["target_clip_count"] == 25


async def test_settings_reframe_detection_toggles(client):
    token = await _register(client)
    headers = {"Authorization": f"Bearer {token}"}
    res = await client.get("/api/v1/settings", headers=headers)
    assert res.json()["reframe_hq_detection"] is False  # off by default
    assert res.json()["reframe_face_zoom"] is False
    res = await client.patch(
        "/api/v1/settings",
        json={"reframe_hq_detection": True, "reframe_face_zoom": True},
        headers=headers,
    )
    assert res.status_code == 200
    assert res.json()["reframe_hq_detection"] is True
    assert res.json()["reframe_face_zoom"] is True
