"""Tests for the Whop Studio clip-formula analyzer.

The deterministic + normalization logic is pure-unit (no DB, no LLM). The
endpoint flow uses the async client with the Celery enqueue stubbed out so no
real transcription/inference runs.
"""
import uuid

import pytest

from app.services import clip_formula

_CAMPAIGN = {
    "name": "Clip my podcast",
    "description": "Post 30-60s clips. Add #podcast and the link in bio.",
    "campaign_type": "clipping",
    "category": "entertainment",
    "platforms": ["tiktok", "youtube"],
    "requirements": ["30-60 second clips", "Include #podcast hashtag", "Add link in bio CTA"],
    "rate_per_1k": 1.5,
    "budget": 5000,
    "paid_out": 1200,
}


# ------------------------------------------------------------- pure unit tests
def test_build_requirements_pulls_from_campaign():
    req = clip_formula.build_requirements(_CAMPAIGN)
    assert req["video_length"].startswith("30")
    assert req["platforms"] == ["TikTok", "YouTube Shorts"]
    assert req["rpm"] == "$1.50 per 1,000 views"
    assert req["budget_remaining"] == "$3,800 left of $5,000"
    assert "#podcast" in " ".join(req["hashtags"]).lower()
    assert req["valid_submission"] == _CAMPAIGN["requirements"]
    assert req["rejection_reasons"]  # always populated


def test_build_requirements_unlimited_budget():
    req = clip_formula.build_requirements({**_CAMPAIGN, "budget": None})
    assert req["budget_remaining"] == "Unlimited budget"


def test_build_checklist_covers_requirements():
    req = clip_formula.build_requirements(_CAMPAIGN)
    checklist = clip_formula.build_checklist(_CAMPAIGN, req)
    labels = [c["label"] for c in checklist]
    assert any("vertical" in label.lower() for label in labels)
    assert "Include #podcast hashtag" in labels  # each requirement becomes an item
    assert all("label" in c and "required" in c for c in checklist)


def test_normalizers_tolerate_garbage():
    bp = clip_formula._norm_blueprint({"hook": "not a dict", "structure": ["nope"]})
    assert 1 <= bp["hook"]["rating"] <= 10
    assert bp["script"]["framework"]  # falls back to a default
    assert bp["structure"] == []  # non-dict rows dropped

    pb = clip_formula._norm_playbook({})
    assert pb["viral_moments"] == []
    assert pb["editing"]["caption_style"] == ""
    assert isinstance(pb["recreation_plan"], list)


def test_analyze_formula_assembles_all_sections(monkeypatch, sample_segments):
    blueprint = {
        "structure": [
            {"start": "0:00", "end": "0:03", "label": "Hook", "purpose": "grab attention",
             "visual": "facecam", "narration": "big claim", "why": "curiosity", "supports": "length"},
        ],
        "hook": {"rating": 9, "why_it_stops_scroll": "bold money claim",
                 "triggers": ["curiosity gap", "money claim"], "best_hook_lines": ["You won't believe this"]},
        "script": {"framework": "Hook-Problem-Solution-Proof-CTA",
                   "sentences": [{"text": "Today we reveal a secret", "purpose": "open loop",
                                  "serves": "curiosity", "action": "keep"}]},
        "retention": {"avg_seconds_between_changes": "2s", "techniques": ["fast cuts", "zooms"]},
        "campaign_integration": {"blend_type": "native with branding", "feels_natural": True, "notes": "woven in"},
        "background_footage": {"footage_type": "podcast", "must_match": True, "notes": "match the show"},
    }
    playbook = {
        "viral_moments": [
            {"rank": 1, "start": "0:04", "end": "0:09", "why_viral": "surprising reveal",
             "hook_line": "massive secret", "caption_title": "THE SECRET", "best_platform": "TikTok",
             "needs_context": False, "strength": 88},
        ],
        "visual_timeline": {"change_frequency": "every 2s", "changes": [{"time": "0:00", "visual": "caption pops"}]},
        "editing": {"caption_style": "bold word-by-word", "font": "Montserrat", "cuts": "hard cuts on beat"},
        "recreation_plan": ["import video", "cut the clip", "add captions"],
        "automation_workflow": ["read brief", "transcribe", "pick moment"],
        "template": "CAMPAIGN → CLIP → POST",
    }
    calls = {"n": 0}

    def fake_generate_json(stage, prompt, **kwargs):
        calls["n"] += 1
        return (blueprint if calls["n"] == 1 else playbook), {"model": "test"}

    monkeypatch.setattr(clip_formula.ollama_service, "generate_json", fake_generate_json)

    result, hook_score = clip_formula.analyze_formula(
        segments=sample_segments, full_text="Welcome everyone. Today we reveal a secret.",
        duration=9.0, campaign=_CAMPAIGN, model="test",
    )
    assert calls["n"] == 2  # blueprint + playbook
    assert hook_score == 9
    for key in (
        "requirements", "checklist", "structure", "hook", "script", "retention",
        "campaign_integration", "background_footage", "viral_moments", "visual_timeline",
        "editing", "recreation_plan", "automation_workflow", "template",
    ):
        assert key in result, f"missing section {key}"
    assert result["viral_moments"][0]["strength"] == 88
    assert result["requirements"]["rpm"] == "$1.50 per 1,000 views"
    assert result["template"] == "CAMPAIGN → CLIP → POST"


def test_analyze_formula_survives_playbook_failure(monkeypatch, sample_segments):
    blueprint = {
        "hook": {"rating": 7, "why_it_stops_scroll": "ok"},
        "script": {"framework": "AIDA"},
        "structure": [], "retention": {"techniques": []},
        "campaign_integration": {"blend_type": "native", "notes": ""},
        "background_footage": {"footage_type": "podcast", "notes": ""},
    }
    calls = {"n": 0}

    def fake_generate_json(stage, prompt, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return blueprint, {}
        raise RuntimeError("model exploded")

    monkeypatch.setattr(clip_formula.ollama_service, "generate_json", fake_generate_json)
    result, hook_score = clip_formula.analyze_formula(
        segments=sample_segments, full_text="hi", duration=9.0, campaign=_CAMPAIGN,
    )
    assert hook_score == 7
    assert result["viral_moments"] == []
    assert result["template"]  # default template filled in


# ------------------------------------------------------------- endpoint tests
pytestmark_async = pytest.mark.asyncio


async def _register(client) -> dict:
    email = f"formula_{uuid.uuid4().hex[:8]}@example.com"
    res = await client.post("/api/v1/auth/register", json={"email": email, "password": "password123"})
    assert res.status_code == 201, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


@pytest.mark.asyncio
async def test_create_formula_rejects_unknown_video(client):
    headers = await _register(client)
    campaign = await client.post(
        "/api/v1/whop/campaigns",
        json={"name": "Clip", "rate_per_1k": 1.0, "platforms": ["tiktok"]},
        headers=headers,
    )
    cid = campaign.json()["id"]
    res = await client.post(
        f"/api/v1/whop/campaigns/{cid}/formulas", json={"video_id": 999999}, headers=headers
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_formula_flow(client, monkeypatch):
    from app.core.database import session_scope
    from app.models.video import Video
    from app.workers import tasks as worker_tasks

    # Don't actually enqueue/run the analysis in tests.
    class _FakeTask:
        id = "test-task-id"

    monkeypatch.setattr(worker_tasks.analyze_formula_task, "delay", lambda *a, **k: _FakeTask())

    headers = await _register(client)
    campaign = await client.post(
        "/api/v1/whop/campaigns",
        json={"name": "Clip", "rate_per_1k": 1.0, "platforms": ["tiktok"]},
        headers=headers,
    )
    cid = campaign.json()["id"]

    studio = await client.post(f"/api/v1/whop/campaigns/{cid}/studio", headers=headers)
    project_id = studio.json()["project_id"]

    # Drop a ready source video into the campaign's studio project.
    with session_scope() as db:
        video = Video(
            project_id=project_id, source="youtube", source_url="https://youtu.be/x",
            title="Test source", storage_path="videos/x.mp4", status="completed",
        )
        db.add(video)
        db.flush()
        video_id = video.id

    created = await client.post(
        f"/api/v1/whop/campaigns/{cid}/formulas", json={"video_id": video_id}, headers=headers
    )
    assert created.status_code == 201, created.text
    fid = created.json()["id"]
    assert created.json()["status"] == "processing"

    listed = await client.get(f"/api/v1/whop/campaigns/{cid}/formulas", headers=headers)
    assert any(f["id"] == fid for f in listed.json())

    one = await client.get(f"/api/v1/whop/formulas/{fid}", headers=headers)
    assert one.status_code == 200
    assert one.json()["video_id"] == video_id

    deleted = await client.delete(f"/api/v1/whop/formulas/{fid}", headers=headers)
    assert deleted.status_code == 200
    gone = await client.get(f"/api/v1/whop/formulas/{fid}", headers=headers)
    assert gone.status_code == 404
