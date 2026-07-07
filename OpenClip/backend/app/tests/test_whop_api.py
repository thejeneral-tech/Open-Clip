"""Whop Campaigns API tests (skipped automatically when no test DB is available)."""
import uuid

import pytest

pytestmark = pytest.mark.asyncio

# Tiny PNG-looking payload — the endpoint validates the extension, not the pixels.
_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


async def _register(client) -> dict:
    email = f"whop_{uuid.uuid4().hex[:8]}@example.com"
    res = await client.post("/api/v1/auth/register", json={"email": email, "password": "password123"})
    assert res.status_code == 201, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


async def _create_campaign(client, headers, **overrides) -> dict:
    payload = {"name": "Clip my stream", "rate_per_1k": 2.0, "platforms": ["tiktok"], **overrides}
    res = await client.post("/api/v1/whop/campaigns", json=payload, headers=headers)
    assert res.status_code == 201, res.text
    return res.json()


async def _create_submission(client, headers, campaign_id: int, **overrides) -> dict:
    payload = {"post_url": "https://tiktok.com/@clipper/video/1", **overrides}
    res = await client.post(
        f"/api/v1/whop/campaigns/{campaign_id}/submissions", json=payload, headers=headers
    )
    assert res.status_code == 201, res.text
    return res.json()


async def test_campaign_crud(client):
    headers = await _register(client)
    campaign = await _create_campaign(client, headers, description="Best clips win.", budget=500)
    cid = campaign["id"]
    assert campaign["status"] == "active"
    assert campaign["campaign_type"] == "clipping"
    assert campaign["rate_per_1k"] == 2.0
    assert campaign["budget_used_pct"] == 0.0

    listed = await client.get("/api/v1/whop/campaigns", headers=headers)
    assert any(c["id"] == cid for c in listed.json())

    updated = await client.patch(
        f"/api/v1/whop/campaigns/{cid}", json={"name": "Renamed", "status": "paused"}, headers=headers
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Renamed"
    assert updated.json()["status"] == "paused"

    filtered = await client.get("/api/v1/whop/campaigns?status=active", headers=headers)
    assert all(c["id"] != cid for c in filtered.json())

    deleted = await client.delete(f"/api/v1/whop/campaigns/{cid}", headers=headers)
    assert deleted.status_code == 200
    gone = await client.get(f"/api/v1/whop/campaigns/{cid}", headers=headers)
    assert gone.status_code == 404


async def test_campaign_rejects_unknown_platform(client):
    headers = await _register(client)
    res = await client.post(
        "/api/v1/whop/campaigns", json={"name": "Bad", "platforms": ["myspace"]}, headers=headers
    )
    assert res.status_code == 422


async def test_thumbnail_upload(client):
    headers = await _register(client)
    campaign = await _create_campaign(client, headers)
    cid = campaign["id"]

    res = await client.post(
        f"/api/v1/whop/campaigns/{cid}/thumbnail",
        files={"file": ("thumb.png", _PNG, "image/png")},
        headers=headers,
    )
    assert res.status_code == 200, res.text
    assert res.json()["thumbnail_url"] == f"/media/whop/campaigns/{cid}/thumbnail.png"

    bad = await client.post(
        f"/api/v1/whop/campaigns/{cid}/thumbnail",
        files={"file": ("clip.mp4", b"\x00\x01", "video/mp4")},
        headers=headers,
    )
    assert bad.status_code == 400


async def test_submission_approve_pay_math(client):
    headers = await _register(client)
    campaign = await _create_campaign(client, headers, rate_per_1k=2.0, max_payout=60)
    cid = campaign["id"]

    sub = await _create_submission(client, headers, cid, views=50_000)
    sid = sub["id"]
    assert sub["status"] == "pending"
    # 50k views at $2 / 1K = $100, capped at the campaign's $60 max payout.
    assert sub["earnings_estimate"] == 60.0
    assert sub["rate_per_1k"] == 2.0
    assert sub["campaign_name"] == campaign["name"]

    early = await client.post(f"/api/v1/whop/submissions/{sid}/pay", headers=headers)
    assert early.status_code == 409

    approved = await client.post(f"/api/v1/whop/submissions/{sid}/approve", headers=headers)
    assert approved.status_code == 200
    assert approved.json()["status"] == "approved"

    paid = await client.post(f"/api/v1/whop/submissions/{sid}/pay", headers=headers)
    assert paid.status_code == 200
    assert paid.json()["status"] == "paid"
    assert paid.json()["paid_amount"] == 60.0

    enriched = await client.get(f"/api/v1/whop/campaigns/{cid}", headers=headers)
    assert enriched.json()["submissions_paid"] == 1
    assert enriched.json()["paid_out"] == 60.0


async def test_reject_and_clawback(client):
    headers = await _register(client)
    campaign = await _create_campaign(client, headers)
    cid = campaign["id"]
    sub = await _create_submission(client, headers, cid, views=1_000)
    sid = sub["id"]

    # Clawback is only for approved/paid submissions.
    early = await client.post(
        f"/api/v1/whop/submissions/{sid}/clawback", json={"reason": "nope"}, headers=headers
    )
    assert early.status_code == 409

    rejected = await client.post(
        f"/api/v1/whop/submissions/{sid}/reject", json={"reason": "Wrong watermark"}, headers=headers
    )
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"
    assert rejected.json()["rejection_reason"] == "Wrong watermark"

    # Re-approving a rejected submission clears the rejection reason.
    approved = await client.post(f"/api/v1/whop/submissions/{sid}/approve", headers=headers)
    assert approved.json()["status"] == "approved"
    assert approved.json()["rejection_reason"] is None

    claw = await client.post(
        f"/api/v1/whop/submissions/{sid}/clawback", json={"reason": "Video deleted"}, headers=headers
    )
    assert claw.status_code == 200
    assert claw.json()["clawback_requested"] is True
    assert claw.json()["clawback_reason"] == "Video deleted"


async def test_dashboard_totals(client):
    headers = await _register(client)
    campaign = await _create_campaign(client, headers, rate_per_1k=1.0)
    cid = campaign["id"]

    first = await _create_submission(client, headers, cid, views=10_000)
    second = await _create_submission(client, headers, cid, views=5_000)
    await _create_submission(client, headers, cid, views=0)

    await client.post(f"/api/v1/whop/submissions/{first['id']}/approve", headers=headers)
    await client.post(f"/api/v1/whop/submissions/{first['id']}/pay", headers=headers)
    await client.post(f"/api/v1/whop/submissions/{second['id']}/approve", headers=headers)

    res = await client.get("/api/v1/whop/dashboard", headers=headers)
    assert res.status_code == 200
    data = res.json()
    assert data["campaigns_active"] == 1
    assert data["campaigns_total"] == 1
    assert data["submissions_total"] == 3
    assert data["submissions_pending"] == 1
    assert data["views_total"] == 15_000
    assert data["paid_out"] == 10.0        # 10k views * $1/1K, paid
    assert data["pending_payout"] == 5.0   # 5k views * $1/1K, approved
    assert data["approval_rate"] == 100.0  # 2 approvals, 0 rejections
    assert len(data["recent_submissions"]) == 3
    assert data["campaigns"][0]["id"] == cid
    assert data["campaigns"][0]["views_total"] == 15_000


async def test_analytics_shape(client):
    headers = await _register(client)
    campaign = await _create_campaign(client, headers, rate_per_1k=2.0)
    cid = campaign["id"]
    sub = await _create_submission(client, headers, cid, views=1_000)

    # Bumping the views writes a second snapshot; today keeps the last one.
    res = await client.patch(
        f"/api/v1/whop/submissions/{sub['id']}", json={"views": 4_000}, headers=headers
    )
    assert res.status_code == 200

    res = await client.get("/api/v1/whop/analytics?days=7", headers=headers)
    assert res.status_code == 200
    data = res.json()
    assert data["days"] == 7
    assert len(data["series"]) == 7
    assert data["views_total"] == 4_000
    assert data["series"][-1]["views"] == 4_000      # today's delta from a 0 baseline
    assert data["series"][-1]["earnings"] == 8.0     # 4k views * $2/1K
    assert sum(p["views"] for p in data["series"][:-1]) == 0
    assert data["submissions_total"] == 1
    assert data["campaigns"][0]["campaign_id"] == cid
    assert data["campaigns"][0]["views"] == 4_000


async def test_studio_project_is_idempotent(client):
    headers = await _register(client)
    campaign = await _create_campaign(client, headers)
    cid = campaign["id"]
    # A fresh campaign has no workspace yet.
    assert campaign["studio_project_id"] is None

    res = await client.post(f"/api/v1/whop/campaigns/{cid}/studio", headers=headers)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["campaign_id"] == cid
    project_id = body["project_id"]
    assert isinstance(project_id, int)

    # The campaign now echoes the same linked project.
    enriched = await client.get(f"/api/v1/whop/campaigns/{cid}", headers=headers)
    assert enriched.json()["studio_project_id"] == project_id

    # Calling studio again reuses the same project (idempotent).
    again = await client.post(f"/api/v1/whop/campaigns/{cid}/studio", headers=headers)
    assert again.status_code == 200
    assert again.json()["project_id"] == project_id


async def test_campaign_ownership_isolated(client):
    headers_a = await _register(client)
    headers_b = await _register(client)
    campaign = await _create_campaign(client, headers_a)
    cid = campaign["id"]
    sub = await _create_submission(client, headers_a, cid, views=100)

    res = await client.get(f"/api/v1/whop/campaigns/{cid}", headers=headers_b)
    assert res.status_code == 404
    res = await client.patch(f"/api/v1/whop/campaigns/{cid}", json={"name": "Mine"}, headers=headers_b)
    assert res.status_code == 404
    res = await client.post(f"/api/v1/whop/submissions/{sub['id']}/approve", headers=headers_b)
    assert res.status_code == 404
    listed = await client.get("/api/v1/whop/campaigns", headers=headers_b)
    assert all(c["id"] != cid for c in listed.json())

# url-preview endpoint tests live in test_whop_preview.py — that endpoint takes no
# DB session, so they call it directly and skip the async client fixture.


# ---------------------------------------------------------- bulk import / rescan
async def _import(client, headers, campaigns, reconcile=False, source="whop_marketplace"):
    res = await client.post(
        "/api/v1/whop/campaigns/import",
        json={"source": source, "reconcile": reconcile, "campaigns": campaigns},
        headers=headers,
    )
    assert res.status_code == 200, res.text
    return res.json()


async def test_import_upsert_and_reconcile(client):
    headers = await _register(client)
    first = await _import(
        client, headers,
        [{"name": f"MK {i}", "status": "active", "rate_per_1k": 1.0, "budget": 1000} for i in range(30)],
    )
    assert first["created"] == 30 and first["updated"] == 0

    # Rescan: 25 of the 30 still active (refreshed rate), 5 dropped off → reconcile ends them.
    res = await _import(
        client, headers,
        [{"name": f"MK {i}", "status": "active", "rate_per_1k": 2.0, "budget": 2000} for i in range(25)],
        reconcile=True,
    )
    assert res["updated"] == 25
    assert res["ended"] == 5
    assert res["reconciled"] is True

    listed = (await client.get("/api/v1/whop/campaigns", headers=headers)).json()
    statuses = [c["status"] for c in listed]
    assert statuses.count("active") == 25
    assert statuses.count("ended") == 5
    assert all(c["rate_per_1k"] == 2.0 for c in listed if c["status"] == "active")  # refreshed

    # Re-running the same rescan is idempotent (nothing created/ended again).
    again = await _import(
        client, headers,
        [{"name": f"MK {i}", "status": "active", "rate_per_1k": 2.0} for i in range(25)],
        reconcile=True,
    )
    assert again["created"] == 0 and again["ended"] == 0


async def test_import_reconcile_guard_blocks_partial_scrape(client):
    headers = await _register(client)
    await _import(client, headers, [{"name": f"MK {i}", "status": "active"} for i in range(50)])

    # A tiny scrape must NOT be trusted to mass-end 50 campaigns.
    res = await _import(
        client, headers,
        [{"name": "MK 0", "status": "active"}, {"name": "MK 1", "status": "active"}],
        reconcile=True,
    )
    assert res["reconciled"] is False
    assert res["ended"] == 0
    listed = (await client.get("/api/v1/whop/campaigns", headers=headers)).json()
    assert sum(1 for c in listed if c["status"] == "active") == 50


async def test_import_never_touches_own_campaign(client):
    headers = await _register(client)
    # A hand-made campaign (no marketplace source) that happens to share a name.
    await _create_campaign(client, headers, name="My Own Campaign", rate_per_1k=5.0)
    await _import(
        client, headers,
        [{"name": "My Own Campaign", "status": "active", "rate_per_1k": 1.0}]
        + [{"name": f"MK {i}", "status": "active"} for i in range(30)],
        reconcile=True,
    )
    listed = (await client.get("/api/v1/whop/campaigns", headers=headers)).json()
    own = [c for c in listed if c["name"] == "My Own Campaign" and c["rate_per_1k"] == 5.0]
    assert len(own) == 1                       # untouched, not overwritten
    assert own[0]["status"] == "active"        # never ended by reconcile


async def test_import_status_downgrade_gated_by_trust(client):
    headers = await _register(client)
    await _import(client, headers, [{"name": f"MK {i}", "status": "active"} for i in range(40)])
    # An untrusted (tiny) payload marking a campaign ended must NOT downgrade it.
    res = await _import(client, headers, [{"name": "MK 0", "status": "ended"}], reconcile=False)
    assert res["reconciled"] is False
    listed = (await client.get("/api/v1/whop/campaigns", headers=headers)).json()
    mk0 = next(c for c in listed if c["name"] == "MK 0")
    assert mk0["status"] == "active"           # downgrade suppressed on untrusted scrape


# --------------------------------------------------------------- channels
async def _create_channel(client, headers, **config) -> dict:
    """Create a connected YouTube channel (publishing connector)."""
    cfg = {"channel_id": "UC_theo", "channel_title": "theovonclipper", **config}
    res = await client.post(
        "/api/v1/publishing/connectors",
        json={
            "platform": "youtube",
            "name": cfg["channel_title"],
            "config": cfg,
            "credentials": {"refresh_token": "rt"},
        },
        headers=headers,
    )
    assert res.status_code == 201, res.text
    return res.json()


async def test_channel_manual_link_lifecycle(client):
    headers = await _register(client)
    channel = await _create_channel(client, headers)
    conn_id = channel["id"]
    campaign = await _create_campaign(client, headers, name="Theo clips")
    cid = campaign["id"]

    # Fresh channel: listed, but nothing connected yet.
    channels = (await client.get("/api/v1/whop/channels", headers=headers)).json()
    assert len(channels) == 1
    assert channels[0]["connector_id"] == conn_id
    assert channels[0]["campaigns_connected"] == 0
    assert channels[0]["channel_title"] == "theovonclipper"

    # Manual link (idempotent).
    linked = await client.post(
        f"/api/v1/whop/channels/{conn_id}/campaigns", json={"campaign_id": cid}, headers=headers
    )
    assert linked.status_code == 201, linked.text
    assert linked.json()["source"] == "manual"
    assert linked.json()["campaign"]["id"] == cid
    again = await client.post(
        f"/api/v1/whop/channels/{conn_id}/campaigns", json={"campaign_id": cid}, headers=headers
    )
    assert again.status_code == 201  # no duplicate row created

    conn_campaigns = (
        await client.get(f"/api/v1/whop/channels/{conn_id}/campaigns", headers=headers)
    ).json()
    assert len(conn_campaigns) == 1
    assert conn_campaigns[0]["source"] == "manual"

    channels = (await client.get("/api/v1/whop/channels", headers=headers)).json()
    assert channels[0]["campaigns_connected"] == 1

    # Unlink (idempotent — a second unlink is still 200).
    unlinked = await client.delete(
        f"/api/v1/whop/channels/{conn_id}/campaigns/{cid}", headers=headers
    )
    assert unlinked.status_code == 200
    empty = (await client.get(f"/api/v1/whop/channels/{conn_id}/campaigns", headers=headers)).json()
    assert empty == []


async def test_channel_auto_detect_from_submission(client):
    headers = await _register(client)
    channel = await _create_channel(client, headers)
    conn_id = channel["id"]
    campaign = await _create_campaign(client, headers, name="Auto campaign")
    cid = campaign["id"]

    # A YouTube submission whose handle matches the channel title auto-connects it.
    await _create_submission(
        client,
        headers,
        cid,
        platform="youtube",
        post_url="https://youtube.com/shorts/abc",
        creator_handle="@TheoVonClipper",
        views=1000,
    )
    conn_campaigns = (
        await client.get(f"/api/v1/whop/channels/{conn_id}/campaigns", headers=headers)
    ).json()
    assert len(conn_campaigns) == 1
    assert conn_campaigns[0]["campaign"]["id"] == cid
    assert conn_campaigns[0]["source"] == "auto"

    channels = (await client.get("/api/v1/whop/channels", headers=headers)).json()
    assert channels[0]["campaigns_connected"] == 1
    assert channels[0]["submissions_total"] == 1
    assert channels[0]["submissions_pending"] == 1

    # The review filter returns that channel's submissions.
    subs = (
        await client.get(f"/api/v1/whop/submissions?connector_id={conn_id}", headers=headers)
    ).json()
    assert len(subs) == 1


async def test_channel_auto_detect_ignores_non_matching(client):
    headers = await _register(client)
    channel = await _create_channel(client, headers)
    conn_id = channel["id"]
    campaign = await _create_campaign(client, headers, name="Other campaign")
    cid = campaign["id"]

    # Different handle + non-youtube platform → no auto link.
    await _create_submission(
        client, headers, cid, platform="tiktok", creator_handle="someone_else", views=500
    )
    conn_campaigns = (
        await client.get(f"/api/v1/whop/channels/{conn_id}/campaigns", headers=headers)
    ).json()
    assert conn_campaigns == []
    # No connected campaigns → the review filter is empty (not "all submissions").
    subs = (
        await client.get(f"/api/v1/whop/submissions?connector_id={conn_id}", headers=headers)
    ).json()
    assert subs == []


async def test_channel_endpoints_owner_scoped(client):
    a_headers = await _register(client)
    b_headers = await _register(client)
    channel = await _create_channel(client, a_headers)
    conn_id = channel["id"]
    campaign = await _create_campaign(client, a_headers, name="A's campaign")
    cid = campaign["id"]

    # B cannot see, link to, or read A's channel.
    assert (await client.get("/api/v1/whop/channels", headers=b_headers)).json() == []
    forbidden = await client.get(f"/api/v1/whop/channels/{conn_id}/campaigns", headers=b_headers)
    assert forbidden.status_code == 404
    link = await client.post(
        f"/api/v1/whop/channels/{conn_id}/campaigns", json={"campaign_id": cid}, headers=b_headers
    )
    assert link.status_code == 404


async def test_channel_rejects_non_youtube_connector(client):
    headers = await _register(client)
    res = await client.post(
        "/api/v1/publishing/connectors",
        json={"platform": "tiktok", "name": "tt", "credentials": {"x": "y"}},
        headers=headers,
    )
    assert res.status_code == 201, res.text
    conn_id = res.json()["id"]
    # Not a YouTube channel → treated as not found by the channel endpoints.
    assert (await client.get("/api/v1/whop/channels", headers=headers)).json() == []
    scoped = await client.get(f"/api/v1/whop/channels/{conn_id}/campaigns", headers=headers)
    assert scoped.status_code == 404
