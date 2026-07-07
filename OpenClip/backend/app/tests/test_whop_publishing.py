"""Tests for the Whop Publishing endpoints (ready-clips + publish)."""
import uuid

import pytest

pytestmark = pytest.mark.asyncio


async def _register(client) -> tuple[dict, int]:
    email = f"pub_{uuid.uuid4().hex[:8]}@example.com"
    res = await client.post("/api/v1/auth/register", json={"email": email, "password": "password123"})
    assert res.status_code == 201, res.text
    # Decode the user id from the token subject.
    from app.core.security import decode_token

    uid = int(decode_token(res.json()["access_token"])["sub"])
    return {"Authorization": f"Bearer {res.json()['access_token']}"}, uid


async def _campaign_with_studio(client, headers) -> tuple[int, int]:
    camp = await client.post(
        "/api/v1/whop/campaigns",
        json={"name": "Publish me", "rate_per_1k": 1.0, "platforms": ["youtube"]},
        headers=headers,
    )
    cid = camp.json()["id"]
    studio = await client.post(f"/api/v1/whop/campaigns/{cid}/studio", headers=headers)
    return cid, studio.json()["project_id"]


def _seed_completed_clip(project_id: int) -> int:
    """Insert a ready-to-publish (completed, rendered) clip into the project."""
    from app.core.database import session_scope
    from app.models.clip import Clip
    from app.models.enums import JobStatus
    from app.models.video import Video

    with session_scope() as db:
        video = Video(project_id=project_id, source="youtube", status=JobStatus.COMPLETED.value)
        db.add(video)
        db.flush()
        clip = Clip(
            video_id=video.id, order_index=0, start_time=0.0, end_time=20.0, duration=20.0,
            title="A great clip", status=JobStatus.COMPLETED.value,
            preview_path="clips/preview.mp4", ranking_score=88.0,
        )
        db.add(clip)
        db.flush()
        return clip.id


def _seed_youtube_connector(owner_id: int) -> int:
    from app.core.database import session_scope
    from app.models.enums import ConnectorStatus
    from app.models.publishing import PublishingConnector

    with session_scope() as db:
        conn = PublishingConnector(
            owner_id=owner_id, platform="youtube", name="My Channel",
            status=ConnectorStatus.CONNECTED.value, config={"channel_title": "My Channel"},
            credentials={"refresh_token": "x"},
        )
        db.add(conn)
        db.flush()
        return conn.id


async def test_ready_clips_lists_completed(client):
    headers, _uid = await _register(client)
    cid, project_id = await _campaign_with_studio(client, headers)

    # No clips yet.
    empty = await client.get(f"/api/v1/whop/campaigns/{cid}/ready-clips", headers=headers)
    assert empty.status_code == 200
    assert empty.json() == []

    clip_id = _seed_completed_clip(project_id)
    res = await client.get(f"/api/v1/whop/campaigns/{cid}/ready-clips", headers=headers)
    assert res.status_code == 200
    body = res.json()
    assert len(body) == 1
    assert body[0]["id"] == clip_id
    assert body[0]["title"] == "A great clip"
    assert body[0]["publish_status"] is None


async def test_publish_creates_job(client, monkeypatch):
    from app.workers import bot_tasks

    calls: list = []
    monkeypatch.setattr(bot_tasks.publish_clip_job, "apply_async", lambda args=(), **k: calls.append(args) or type("T", (), {"id": "t"})())

    headers, uid = await _register(client)
    cid, project_id = await _campaign_with_studio(client, headers)
    clip_id = _seed_completed_clip(project_id)
    connector_id = _seed_youtube_connector(uid)

    res = await client.post(
        f"/api/v1/whop/campaigns/{cid}/publish",
        json={"clip_id": clip_id, "connector_id": connector_id},
        headers=headers,
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["clip_id"] == clip_id
    assert body["status"] == "queued"
    assert calls, "publish_clip_job should have been enqueued"

    # The clip now reports its publish status via ready-clips.
    ready = await client.get(f"/api/v1/whop/campaigns/{cid}/ready-clips", headers=headers)
    assert ready.json()[0]["publish_status"] == "queued"


async def test_publish_rejects_clip_from_other_campaign(client, monkeypatch):
    from app.workers import bot_tasks

    monkeypatch.setattr(bot_tasks.publish_clip_job, "apply_async", lambda *a, **k: type("T", (), {"id": "t"})())

    headers, uid = await _register(client)
    cid, _project_id = await _campaign_with_studio(client, headers)
    # A clip that belongs to a DIFFERENT project.
    other_headers, other_uid = await _register(client)
    _ocid, other_project = await _campaign_with_studio(client, other_headers)
    foreign_clip = _seed_completed_clip(other_project)
    connector_id = _seed_youtube_connector(uid)

    res = await client.post(
        f"/api/v1/whop/campaigns/{cid}/publish",
        json={"clip_id": foreign_clip, "connector_id": connector_id},
        headers=headers,
    )
    assert res.status_code == 404
