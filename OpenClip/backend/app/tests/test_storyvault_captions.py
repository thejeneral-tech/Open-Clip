"""End-to-end: a selected preset's caption config is snapshotted onto the video.

Skipped automatically when no test DB is available. The Celery dispatch is
monkeypatched so creating a video never touches the broker.
"""
import json
import uuid

import pytest

pytestmark = pytest.mark.asyncio


class _FakeTask:
    id = "test-task-id"


async def _register(client) -> dict[str, str]:
    email = f"sv_{uuid.uuid4().hex[:8]}@example.com"
    res = await client.post("/api/v1/auth/register", json={"email": email, "password": "password123"})
    assert res.status_code == 201, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


async def _import_story(client, headers) -> int:
    res = await client.post(
        "/api/v1/storyvault/stories/import",
        json={"title": "AITA for testing captions?", "body": "A reasonably long body for scoring."},
        headers=headers,
    )
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _stored_caption_config(video_id: int):
    """Read the raw caption_config column straight from the test SQLite file."""
    from sqlalchemy import text

    from app.core.database import sync_engine

    with sync_engine.connect() as conn:
        raw = conn.execute(
            text("SELECT caption_config FROM sv_videos WHERE id = :i"), {"i": video_id}
        ).scalar()
    if raw is None or isinstance(raw, dict):
        return raw
    return json.loads(raw)


async def test_create_video_snapshots_template_captions(client, monkeypatch):
    from app.api.v1.endpoints import storyvault as sv_ep

    monkeypatch.setattr(sv_ep.sv_generate_video_task, "delay", lambda *a, **k: _FakeTask())

    headers = await _register(client)
    story_id = await _import_story(client, headers)

    # Built-ins auto-seed on GET; pick the default preset.
    tpls = await client.get("/api/v1/storyvault/templates", headers=headers)
    assert tpls.status_code == 200, tpls.text
    templates = tpls.json()
    assert templates
    tpl_id = next((t["id"] for t in templates if t["is_default"]), templates[0]["id"])

    # Save a known caption config onto the preset (as the editor's Save does).
    caps = {
        "style": "pop", "size": 116, "centerY": 960, "outline": 8, "maxWords": 2,
        "primary": "&H00FFFFFF", "highlight": "&H0000F0FF",
    }
    up = await client.patch(
        f"/api/v1/storyvault/templates/{tpl_id}",
        json={"data": {"captions": caps}},
        headers=headers,
    )
    assert up.status_code == 200, up.text

    res = await client.post(
        "/api/v1/storyvault/videos",
        json={"story_id": story_id, "template_id": tpl_id, "caption_style": "modern_tiktok"},
        headers=headers,
    )
    assert res.status_code == 201, res.text

    stored = _stored_caption_config(res.json()["id"])
    assert stored is not None, "preset captions were not snapshotted"
    assert stored["style"] == "pop"
    assert stored["centerY"] == 960
    assert stored["primary"] == "&H00FFFFFF"
    assert stored["highlight"] == "&H0000F0FF"
    assert stored["maxWords"] == 2


async def test_create_video_without_template_leaves_caption_config_null(client, monkeypatch):
    from app.api.v1.endpoints import storyvault as sv_ep

    monkeypatch.setattr(sv_ep.sv_generate_video_task, "delay", lambda *a, **k: _FakeTask())

    headers = await _register(client)
    story_id = await _import_story(client, headers)

    res = await client.post(
        "/api/v1/storyvault/videos",
        json={"story_id": story_id, "caption_style": "hormozi"},
        headers=headers,
    )
    assert res.status_code == 201, res.text
    assert _stored_caption_config(res.json()["id"]) is None
