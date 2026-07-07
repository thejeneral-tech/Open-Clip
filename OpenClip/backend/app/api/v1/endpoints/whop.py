"""Whop Campaigns API — campaigns, submission review, payouts, analytics."""
from __future__ import annotations

import asyncio
import contextlib
import os
import re
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from math import ceil

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.core.logging import get_logger
from app.models import Project
from app.models.clip import Clip
from app.models.enums import JobStatus, PublishStatus, WhopCampaignStatus, WhopSubmissionStatus
from app.models.publishing import PublishingConnector, PublishingJob
from app.models.user import User
from app.models.video import Video
from app.models.whop import (
    WhopCampaign,
    WhopChannelCampaign,
    WhopFormula,
    WhopSubmission,
    WhopViewSnapshot,
)
from app.schemas.common import Message
from app.schemas.whop import (
    WhopAnalyticsOut,
    WhopAnalyticsPoint,
    WhopCampaignCreate,
    WhopCampaignOut,
    WhopCampaignStat,
    WhopCampaignUpdate,
    WhopChannelCampaignOut,
    WhopChannelLinkBody,
    WhopChannelOut,
    WhopDashboardOut,
    WhopFindBody,
    WhopFindOut,
    WhopFormulaCreate,
    WhopFormulaOut,
    WhopImportBody,
    WhopImportItem,
    WhopImportResult,
    WhopPublishBody,
    WhopPublishOut,
    WhopReadyClip,
    WhopReasonBody,
    WhopScoreBody,
    WhopScoreOut,
    WhopStrategyBody,
    WhopStrategyOut,
    WhopStudioOut,
    WhopSubmissionCreate,
    WhopSubmissionOut,
    WhopSubmissionUpdate,
    WhopUrlPreviewOut,
)
from app.services import campaign_finder, campaign_math, finder_scoring, youtube
from app.services.storage import storage, whop_thumbnail_key
from app.services.whop_marketplace import fetch_marketplace_campaigns
from app.services.whop_preview import fetch_url_preview

logger = get_logger(__name__)
router = APIRouter()

_ALLOWED_THUMBNAIL_EXT = {".png", ".jpg", ".jpeg", ".webp"}

# Campaign / submission fields where an explicit ``null`` in a PATCH clears the
# value; ``None`` for any other (non-nullable) field is ignored.
_CAMPAIGN_NULLABLE_FIELDS = {"description", "budget", "min_payout", "max_payout", "whop_url", "ends_at"}
_SUBMISSION_NULLABLE_FIELDS = {"title", "creator_handle", "notes"}


# ------------------------------------------------------------------ helpers
def _earnings_estimate(submission: WhopSubmission, campaign: WhopCampaign) -> float:
    """views / 1000 * rate, capped at the campaign's per-submission max payout."""
    amount = submission.views / 1000 * campaign.rate_per_1k
    if campaign.max_payout is not None:
        amount = min(amount, campaign.max_payout)
    return round(amount, 2)


def _as_utc(value: datetime) -> datetime:
    """SQLite hands back naive datetimes; treat them as UTC."""
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _days_left(ends_at: datetime) -> int:
    delta = _as_utc(ends_at) - datetime.now(timezone.utc)
    return max(0, ceil(delta.total_seconds() / 86400))


def _record_snapshot(db: AsyncSession, submission: WhopSubmission) -> None:
    db.add(WhopViewSnapshot(submission_id=submission.id, views=submission.views))


async def _owned_campaign(db: AsyncSession, campaign_id: int, user: User) -> WhopCampaign:
    campaign = await db.get(WhopCampaign, campaign_id)
    if not campaign or campaign.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Campaign not found")
    return campaign


async def _owned_submission(db: AsyncSession, submission_id: int, user: User) -> WhopSubmission:
    submission = await db.get(WhopSubmission, submission_id)
    if not submission or submission.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Submission not found")
    return submission


# ------------------------------------------------------------------ channels
# A "channel" is a connected YouTube publishing connector. Campaigns link to a
# channel two ways: MANUAL (a row in whop_channel_campaigns) and AUTO (derived,
# never stored — a campaign auto-connects when ≥1 of its YouTube submissions is
# attributed to the channel by handle/URL match).
async def _owned_connector(db: AsyncSession, connector_id: int, user: User) -> PublishingConnector:
    connector = await db.get(PublishingConnector, connector_id)
    if not connector or connector.owner_id != user.id or connector.platform != "youtube":
        raise HTTPException(status_code=404, detail="Channel not found")
    return connector


def _normalize_handle(value: str | None) -> str:
    """Lowercase and strip to alphanumerics so '@Theo Von_Clipper' == 'theovonclipper'."""
    return re.sub(r"[^a-z0-9]", "", value.lower()) if value else ""


_YT_HANDLE_RE = re.compile(r"@([A-Za-z0-9_.\-]+)")


def _channel_match_tokens(connector: PublishingConnector) -> set[str]:
    """Normalized identifiers a submission's handle can match this channel on."""
    cfg = connector.config or {}
    raw = [cfg.get("channel_title"), connector.name, *(cfg.get("whop_match_handles") or [])]
    return {t for t in (_normalize_handle(v) for v in raw) if len(t) >= 3}


def _submission_matches_channel(
    submission: WhopSubmission, tokens: set[str], channel_id: str | None
) -> bool:
    if submission.platform != "youtube":
        return False
    if _normalize_handle(submission.creator_handle) in tokens and tokens:
        return True
    url = submission.post_url or ""
    if channel_id and channel_id.lower() in url.lower():
        return True
    return any(_normalize_handle(h) in tokens for h in _YT_HANDLE_RE.findall(url) if tokens)


async def _manual_campaign_ids(db: AsyncSession, connector_id: int) -> set[int]:
    rows = (
        await db.execute(
            select(WhopChannelCampaign.campaign_id).where(
                WhopChannelCampaign.connector_id == connector_id
            )
        )
    ).scalars().all()
    return set(rows)


async def _auto_campaign_ids(
    db: AsyncSession, user: User, connector: PublishingConnector
) -> set[int]:
    tokens = _channel_match_tokens(connector)
    channel_id = (connector.config or {}).get("channel_id")
    if not tokens and not channel_id:
        return set()
    subs = (
        await db.execute(
            select(WhopSubmission).where(
                WhopSubmission.owner_id == user.id,
                WhopSubmission.platform == "youtube",
            )
        )
    ).scalars().all()
    return {s.campaign_id for s in subs if _submission_matches_channel(s, tokens, channel_id)}


async def _connected_campaign_ids(
    db: AsyncSession, user: User, connector: PublishingConnector
) -> set[int]:
    return (await _manual_campaign_ids(db, connector.id)) | (
        await _auto_campaign_ids(db, user, connector)
    )


async def _ensure_studio_project(db: AsyncSession, user: User, campaign: WhopCampaign) -> Project:
    """Return the campaign's Studio workspace Project, provisioning one on first use.

    Reuses the linked Project when it still exists and is owned by the caller;
    otherwise creates a fresh one and links it. Idempotent — repeat calls return
    the same Project.
    """
    if campaign.studio_project_id is not None:
        existing = await db.get(Project, campaign.studio_project_id)
        if existing is not None and existing.owner_id == user.id:
            return existing

    project = Project(
        owner_id=user.id,
        name=f"Whop · {campaign.name}"[:255],
        description="Clip workspace for the Whop campaign.",
    )
    db.add(project)
    await db.flush()
    campaign.studio_project_id = project.id
    await db.commit()
    return project


# ---------------------------------------------------------------- enrichers
def _submission_out(submission: WhopSubmission, campaign: WhopCampaign) -> WhopSubmissionOut:
    out = WhopSubmissionOut.model_validate(submission)
    out.earnings_estimate = _earnings_estimate(submission, campaign)
    out.campaign_name = campaign.name
    out.rate_per_1k = campaign.rate_per_1k
    return out


async def _campaign_out(db: AsyncSession, campaign: WhopCampaign) -> WhopCampaignOut:
    out = WhopCampaignOut.model_validate(campaign)
    out.thumbnail_url = storage.url(campaign.thumbnail_path)

    subs = (
        await db.execute(select(WhopSubmission).where(WhopSubmission.campaign_id == campaign.id))
    ).scalars().all()
    out.submissions_total = len(subs)
    for sub in subs:
        if sub.status == WhopSubmissionStatus.PENDING.value:
            out.submissions_pending += 1
        elif sub.status == WhopSubmissionStatus.APPROVED.value:
            out.submissions_approved += 1
            out.pending_payout += _earnings_estimate(sub, campaign)
        elif sub.status == WhopSubmissionStatus.REJECTED.value:
            out.submissions_rejected += 1
        elif sub.status == WhopSubmissionStatus.PAID.value:
            out.submissions_paid += 1
            out.paid_out += sub.paid_amount
        out.views_total += sub.views
    out.paid_out = round(out.paid_out, 2)
    out.pending_payout = round(out.pending_payout, 2)

    if campaign.budget is not None and campaign.budget > 0:
        out.budget_used_pct = round(out.paid_out / campaign.budget * 100, 2)
    if campaign.ends_at is not None:
        out.days_left = _days_left(campaign.ends_at)
    return out


# ---------------------------------------------------------------- dashboard
@router.get("/dashboard", response_model=WhopDashboardOut)
async def dashboard(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopDashboardOut:
    uid = current_user.id
    campaigns = (
        await db.execute(select(WhopCampaign).where(WhopCampaign.owner_id == uid))
    ).scalars().all()
    submissions = (
        await db.execute(
            select(WhopSubmission)
            .where(WhopSubmission.owner_id == uid)
            .order_by(WhopSubmission.updated_at.desc())
        )
    ).scalars().all()
    by_id = {c.id: c for c in campaigns}

    approved = sum(1 for s in submissions if s.status == WhopSubmissionStatus.APPROVED.value)
    rejected = sum(1 for s in submissions if s.status == WhopSubmissionStatus.REJECTED.value)
    paid = sum(1 for s in submissions if s.status == WhopSubmissionStatus.PAID.value)
    decisions = approved + paid + rejected

    active = [
        await _campaign_out(db, c) for c in campaigns if c.status == WhopCampaignStatus.ACTIVE.value
    ]
    active.sort(key=lambda c: c.views_total, reverse=True)

    return WhopDashboardOut(
        campaigns_active=len(active),
        campaigns_total=len(campaigns),
        submissions_pending=sum(
            1 for s in submissions if s.status == WhopSubmissionStatus.PENDING.value
        ),
        submissions_total=len(submissions),
        views_total=sum(s.views for s in submissions),
        paid_out=round(
            sum(s.paid_amount for s in submissions if s.status == WhopSubmissionStatus.PAID.value), 2
        ),
        pending_payout=round(
            sum(
                _earnings_estimate(s, by_id[s.campaign_id])
                for s in submissions
                if s.status == WhopSubmissionStatus.APPROVED.value
            ),
            2,
        ),
        approval_rate=round((approved + paid) / decisions * 100, 2) if decisions else 0.0,
        recent_submissions=[_submission_out(s, by_id[s.campaign_id]) for s in submissions[:8]],
        campaigns=active[:6],
    )


# ---------------------------------------------------------------- campaigns
@router.get("/campaigns", response_model=list[WhopCampaignOut])
async def list_campaigns(
    status: str | None = Query(default=None),
    q: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[WhopCampaignOut]:
    stmt = select(WhopCampaign).where(WhopCampaign.owner_id == current_user.id)
    if status:
        stmt = stmt.where(WhopCampaign.status == status)
    if q:
        stmt = stmt.where(WhopCampaign.name.ilike(f"%{q}%"))
    rows = (await db.execute(stmt.order_by(WhopCampaign.updated_at.desc()))).scalars().all()
    return [await _campaign_out(db, c) for c in rows]


# A reconcile / status-downgrade pass only runs when the scrape looks complete —
# a partial/failed scrape must never be able to mass-end campaigns. The scrape is
# "trusted" only if it carries at least this absolute floor AND this fraction of
# the campaigns we currently believe are active.
_RECONCILE_MIN_ACTIVE = 20
_RECONCILE_MIN_FRACTION = 0.7
# Legacy tag on descriptions of campaigns imported before the `source` column existed.
_MARKETPLACE_DESC_MARKER = "· Whop Content Rewards"


def _is_marketplace(c: WhopCampaign, source: str) -> bool:
    """Whether a campaign came from this import source (never the user's own)."""
    return c.source == source or (
        c.description is not None and c.description.rstrip().endswith(_MARKETPLACE_DESC_MARKER)
    )


async def _apply_import(
    db: AsyncSession,
    owner_id: int,
    payload_items: list[WhopImportItem],
    source: str,
    reconcile: bool,
) -> WhopImportResult:
    """Upsert `payload_items` for an owner and (optionally) reconcile statuses.

    Matches existing *same-source* campaigns by name (case-insensitive) and
    refreshes rate/budget/status/category/description, or creates new ones — the
    user's own hand-made campaigns (different/no source) are never matched,
    overwritten, or re-sourced. When ``reconcile`` is set, same-source campaigns
    absent from the payload are marked ended (they left the marketplace). Both the
    reconcile pass and any active→ended downgrade only run when the scrape is
    "trusted" (carries the min floor AND fraction of currently-active campaigns),
    so a partial/failed scrape can't wrongly end things.
    """
    rows = (
        await db.execute(select(WhopCampaign).where(WhopCampaign.owner_id == owner_id))
    ).scalars().all()
    mine = [c for c in rows if _is_marketplace(c, source)]
    by_name: dict[str, WhopCampaign] = {}
    for c in mine:
        by_name.setdefault(c.name.strip().lower(), c)
    current_active = sum(1 for c in mine if c.status == WhopCampaignStatus.ACTIVE.value)

    # Dedupe by name first so the trust check sees the real active count.
    items: list[WhopImportItem] = []
    seen: set[str] = set()
    for item in payload_items:
        key = item.name.strip().lower()
        if key in seen:
            continue
        seen.add(key)
        items.append(item)
    active_in_payload = sum(1 for it in items if it.status == WhopCampaignStatus.ACTIVE.value)
    trusted = active_in_payload >= max(
        _RECONCILE_MIN_ACTIVE, ceil(_RECONCILE_MIN_FRACTION * current_active)
    )

    created = 0
    updated = 0
    for item in items:
        name = item.name.strip()
        existing = by_name.get(name.lower())
        if existing is not None:
            existing.name = name[:255]
            if item.description:
                existing.description = item.description
            existing.category = item.category
            existing.campaign_type = item.campaign_type
            existing.rate_per_1k = item.rate_per_1k
            if item.budget is not None:      # don't wipe a real budget on a parse miss
                existing.budget = item.budget
            if item.platforms:
                existing.platforms = item.platforms
            if item.whop_url:
                existing.whop_url = item.whop_url
            existing.source = source
            # Never downgrade an active campaign to ended on an untrusted scrape.
            if item.status == WhopCampaignStatus.ACTIVE.value or trusted:
                existing.status = item.status
            updated += 1
        else:
            db.add(
                WhopCampaign(
                    owner_id=owner_id,
                    name=name[:255],
                    description=item.description or None,
                    campaign_type=item.campaign_type,
                    category=item.category,
                    status=item.status,
                    rate_per_1k=item.rate_per_1k,
                    budget=item.budget,
                    platforms=item.platforms,
                    whop_url=item.whop_url,
                    source=source,
                )
            )
            created += 1

    ended = 0
    reconciled = False
    if reconcile and trusted:
        reconciled = True
        for c in mine:  # same-source only; freshly-created rows aren't in `mine`
            if c.name.strip().lower() in seen:
                continue
            if c.status != WhopCampaignStatus.ENDED.value:
                c.status = WhopCampaignStatus.ENDED.value
                c.source = source
                ended += 1

    await db.commit()
    return WhopImportResult(
        total=len(payload_items),
        created=created,
        updated=updated,
        ended=ended,
        reconciled=reconciled,
    )


@router.post("/campaigns/import", response_model=WhopImportResult)
async def import_campaigns(
    payload: WhopImportBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopImportResult:
    """Bulk upsert campaigns from a client-supplied payload (e.g. a scan file)."""
    return await _apply_import(
        db, current_user.id, payload.campaigns, payload.source, payload.reconcile
    )


@router.post("/campaigns/rescan", response_model=WhopImportResult)
async def rescan_marketplace(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopImportResult:
    """One-click rescan: fetch Whop's public Content Rewards marketplace server-side
    and upsert + reconcile it (add new, refresh, mark departed campaigns ended).

    Needs no browser and no uploaded file — the discover app is server-side
    rendered, so its campaign list is fetched and parsed directly.
    """
    try:
        raw = await fetch_marketplace_campaigns()
    except httpx.HTTPError as exc:
        logger.info("Whop marketplace rescan fetch failed: %s", exc)
        raise HTTPException(status_code=502, detail="Couldn't reach the Whop marketplace") from exc
    if not raw:
        raise HTTPException(status_code=502, detail="No campaigns found on the Whop marketplace")
    items = [WhopImportItem(**r) for r in raw]
    return await _apply_import(db, current_user.id, items, "whop_marketplace", reconcile=True)


@router.post("/campaigns", response_model=WhopCampaignOut, status_code=201)
async def create_campaign(
    payload: WhopCampaignCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopCampaignOut:
    campaign = WhopCampaign(
        owner_id=current_user.id,
        name=payload.name.strip()[:255],
        description=payload.description or None,
        campaign_type=payload.campaign_type,
        category=payload.category,
        rate_per_1k=payload.rate_per_1k,
        budget=payload.budget,
        min_payout=payload.min_payout,
        max_payout=payload.max_payout,
        platforms=payload.platforms,
        requirements=payload.requirements,
        asset_links=[link.model_dump() for link in payload.asset_links],
        whop_url=payload.whop_url,
        ends_at=payload.ends_at,
    )
    db.add(campaign)
    await db.commit()
    await db.refresh(campaign)
    return await _campaign_out(db, campaign)


@router.get("/campaigns/{campaign_id}", response_model=WhopCampaignOut)
async def get_campaign(
    campaign_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopCampaignOut:
    campaign = await _owned_campaign(db, campaign_id, current_user)
    return await _campaign_out(db, campaign)


@router.patch("/campaigns/{campaign_id}", response_model=WhopCampaignOut)
async def update_campaign(
    campaign_id: int,
    payload: WhopCampaignUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopCampaignOut:
    campaign = await _owned_campaign(db, campaign_id, current_user)
    for field, value in payload.model_dump(exclude_unset=True).items():
        if value is None and field not in _CAMPAIGN_NULLABLE_FIELDS:
            continue
        if field == "name":
            value = value.strip()[:255]
        setattr(campaign, field, value)
    await db.commit()
    await db.refresh(campaign)
    return await _campaign_out(db, campaign)


@router.delete("/campaigns/{campaign_id}", response_model=Message)
async def delete_campaign(
    campaign_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    campaign = await _owned_campaign(db, campaign_id, current_user)
    thumbnail_path = campaign.thumbnail_path
    # Submissions and view snapshots go with it via the FK ON DELETE CASCADE.
    await db.delete(campaign)
    await db.commit()
    if thumbnail_path:
        with contextlib.suppress(Exception):
            storage.delete(thumbnail_path)
    return Message(detail="Campaign deleted")


@router.post("/campaigns/{campaign_id}/thumbnail", response_model=WhopCampaignOut)
async def upload_campaign_thumbnail(
    campaign_id: int,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopCampaignOut:
    campaign = await _owned_campaign(db, campaign_id, current_user)
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in _ALLOWED_THUMBNAIL_EXT:
        raise HTTPException(status_code=400, detail=f"Unsupported image type {ext!r}")

    key = whop_thumbnail_key(campaign.id, ext)
    dest = storage.abspath(key)
    try:
        with open(dest, "wb") as fh:
            while chunk := await file.read(8 * 1024 * 1024):
                fh.write(chunk)
        storage.commit(key)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to store the thumbnail") from exc

    if campaign.thumbnail_path and campaign.thumbnail_path != key:
        with contextlib.suppress(Exception):
            storage.delete(campaign.thumbnail_path)
    campaign.thumbnail_path = key
    await db.commit()
    await db.refresh(campaign)
    return await _campaign_out(db, campaign)


@router.post("/campaigns/{campaign_id}/studio", response_model=WhopStudioOut)
async def ensure_studio_project(
    campaign_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopStudioOut:
    campaign = await _owned_campaign(db, campaign_id, current_user)
    project = await _ensure_studio_project(db, current_user, campaign)
    return WhopStudioOut(project_id=project.id, campaign_id=campaign.id)


@router.post("/campaigns/{campaign_id}/find-videos", response_model=WhopFindOut)
async def find_videos(
    campaign_id: int,
    payload: WhopFindBody | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopFindOut:
    """Find YouTube source videos that correlate to the campaign.

    Reads the campaign's title + description, searches YouTube for the source
    material, and returns ranked matches the user can then clip. yt-dlp is
    blocking, so the work runs in a thread to keep the event loop responsive.
    """
    campaign = await _owned_campaign(db, campaign_id, current_user)
    body = payload or WhopFindBody()
    campaign_ctx = {
        "name": campaign.name,
        "description": campaign.description,
        "category": campaign.category,
        "campaign_type": campaign.campaign_type,
        "requirements": list(campaign.requirements or []),
        "platforms": list(campaign.platforms or []),
    }
    result = await asyncio.to_thread(
        campaign_finder.find_matches,
        campaign_ctx,
        limit=body.limit,
        use_llm=body.use_llm,
        channel=body.channel,
        strict_channel=body.strict_channel,
        filters=body.filters,
    )

    # Attach the fast (Stage-1) Auto Finder Score to every candidate: composite
    # 0-100 score, confidence, factor breakdown, reasons, and a projected payout
    # range. The heavier Stage-3 pass happens on demand via /score-videos.
    ctx = finder_scoring.build_campaign_ctx(campaign_ctx)
    pay = await _payout_ctx(db, campaign)
    for match in result.get("matches", []):
        match.update(finder_scoring.score_stage1(ctx, match, pay))

    return WhopFindOut(**result)


async def _payout_ctx(db: AsyncSession, campaign: WhopCampaign) -> finder_scoring.PayoutCtx:
    """Build the payout context (budget remaining + this campaign's own clip view
    median) used to project a video's earnings range."""
    subs = (
        await db.execute(select(WhopSubmission).where(WhopSubmission.campaign_id == campaign.id))
    ).scalars().all()
    paid_out = round(
        sum(s.paid_amount for s in subs if s.status == WhopSubmissionStatus.PAID.value), 2
    )
    return finder_scoring.PayoutCtx(
        rate_per_1k=campaign.rate_per_1k,
        min_payout=campaign.min_payout,
        max_payout=campaign.max_payout,
        remaining=campaign_math.budget_remaining(campaign.budget, paid_out),
        median_views=campaign_math.median_views([s.views for s in subs]),
    )


@router.post("/campaigns/{campaign_id}/score-videos", response_model=WhopScoreOut)
async def score_videos(
    campaign_id: int,
    payload: WhopScoreBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopScoreOut:
    """Deepen the Auto Finder Score for specific candidates (Stage 3).

    Pulls a full yt-dlp metadata extract per video (view velocity, recency,
    like/comment engagement, description/tags) and re-scores. Enrichment is
    blocking and per-video (~5-10s each), so it runs concurrently in threads.
    """
    campaign = await _owned_campaign(db, campaign_id, current_user)
    campaign_ctx = {
        "name": campaign.name,
        "description": campaign.description,
        "category": campaign.category,
        "campaign_type": campaign.campaign_type,
        "requirements": list(campaign.requirements or []),
        "platforms": list(campaign.platforms or []),
    }
    ctx = finder_scoring.build_campaign_ctx(campaign_ctx)
    pay = await _payout_ctx(db, campaign)

    # Stage 4 also reads the transcript from captions (no download); Stage 3 is
    # metadata-only. Each video's enrich (+ optional caption fetch) runs in one
    # thread so the whole batch fans out concurrently.
    want_captions = payload.stage >= 4
    urls = payload.urls
    results = await asyncio.gather(
        *(asyncio.to_thread(_enrich_and_caption, url, want_captions) for url in urls)
    )

    matches: list[dict] = []
    for url, (enriched, transcript) in zip(urls, results, strict=True):
        if not enriched:
            continue  # enrichment failed — the caller keeps its Stage-1 card
        prev = payload.prev_scores.get(url)
        if want_captions:
            scored = finder_scoring.score_stage4(ctx, enriched, pay, transcript=transcript, prev_score=prev)
        else:
            scored = finder_scoring.score_stage3(ctx, enriched, pay, prev_score=prev)
        top_ok = next((r["text"] for r in scored["reasons"] if r["kind"] == "ok"), None)
        matches.append(
            {
                "url": enriched.get("url") or url,
                "title": enriched.get("title") or "Untitled",
                "duration": enriched.get("duration"),
                "uploader": enriched.get("uploader"),
                "thumbnail": enriched.get("thumbnail"),
                "view_count": enriched.get("view_count"),
                "reason": top_ok or "Deep-scored against the campaign brief",
                **scored,
            }
        )
    return WhopScoreOut(matches=matches)


def _enrich_and_caption(url: str, want_captions: bool) -> tuple[dict | None, dict | None]:
    """Blocking: full metadata extract + (optionally) the caption transcript."""
    enriched = youtube.enrich(url)
    if not enriched:
        return None, None
    transcript = None
    if want_captions and enriched.get("caption_url"):
        transcript = youtube.fetch_caption_text(enriched["caption_url"])
    return enriched, transcript


@router.post("/campaigns/{campaign_id}/strategy", response_model=WhopStrategyOut)
async def campaign_strategy(
    campaign_id: int,
    payload: WhopStrategyBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopStrategyOut:
    """Campaign Copilot: one LLM synthesis over the ranked candidates → a plain
    recommendation (best source + why, a clip plan, worth-joining verdict).
    Heuristic fallback when no model is reachable, so it always answers fast."""
    campaign = await _owned_campaign(db, campaign_id, current_user)
    campaign_ctx = {
        "name": campaign.name,
        "description": campaign.description,
        "rate_per_1k": campaign.rate_per_1k,
        "budget": campaign.budget,
        "requirements": list(campaign.requirements or []),
    }
    videos = [v.model_dump() for v in payload.videos]
    result = await asyncio.to_thread(finder_scoring.strategize, campaign_ctx, videos)

    rec = result.get("recommended_index")
    rec_url = rec_title = None
    if isinstance(rec, int) and 0 <= rec < len(payload.videos):
        rec_url = payload.videos[rec].url
        rec_title = payload.videos[rec].title
    return WhopStrategyOut(
        opportunity_score=result.get("opportunity_score", 0),
        recommended_index=rec,
        recommended_url=rec_url,
        recommended_title=rec_title,
        headline=result.get("headline", ""),
        reasoning=result.get("reasoning", []),
        clip_plan=result.get("clip_plan", ""),
        worth_joining=result.get("worth_joining", False),
        source=result.get("source", "heuristic"),
    )


# --------------------------------------------------------------- publishing
# The Studio produces clips for a campaign; the Publishing section lists the
# completed ones ("ready to publish") and uploads them to a connected YouTube
# channel via the existing publishing pipeline (PublishingJob → publish_clip_job).
@router.get("/campaigns/{campaign_id}/ready-clips", response_model=list[WhopReadyClip])
async def list_ready_clips(
    campaign_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[WhopReadyClip]:
    campaign = await _owned_campaign(db, campaign_id, current_user)
    if campaign.studio_project_id is None:
        return []
    video_ids = (
        await db.execute(select(Video.id).where(Video.project_id == campaign.studio_project_id))
    ).scalars().all()
    if not video_ids:
        return []
    clips = (
        await db.execute(
            select(Clip)
            .where(Clip.video_id.in_(video_ids), Clip.status == JobStatus.COMPLETED.value)
            .order_by(Clip.ranking_score.desc())
        )
    ).scalars().all()
    if not clips:
        return []

    jobs = (
        await db.execute(
            select(PublishingJob)
            .where(PublishingJob.clip_id.in_([c.id for c in clips]))
            .order_by(PublishingJob.created_at.desc())
        )
    ).scalars().all()
    latest: dict[int, PublishingJob] = {}
    for j in jobs:
        latest.setdefault(j.clip_id, j)  # first seen per clip = most recent

    out: list[WhopReadyClip] = []
    for c in clips:
        job = latest.get(c.id)
        out.append(
            WhopReadyClip(
                id=c.id,
                title=c.title,
                duration=c.duration,
                thumbnail_url=storage.url(c.thumbnail_path),
                preview_url=storage.url(c.preview_path),
                publish_status=job.status if job else None,
                external_url=job.external_url if job else None,
            )
        )
    return out


@router.post("/campaigns/{campaign_id}/publish", response_model=WhopPublishOut, status_code=201)
async def publish_clip(
    campaign_id: int,
    payload: WhopPublishBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopPublishOut:
    campaign = await _owned_campaign(db, campaign_id, current_user)
    connector = await _owned_connector(db, payload.connector_id, current_user)  # youtube-only
    if not (connector.credentials or {}).get("refresh_token"):
        raise HTTPException(status_code=409, detail="This channel needs reconnecting — sign in again.")
    clip = await db.get(Clip, payload.clip_id)
    video = await db.get(Video, clip.video_id) if clip else None
    if not clip or not video or video.project_id != campaign.studio_project_id:
        raise HTTPException(status_code=404, detail="Clip not found in this campaign")
    if clip.status != JobStatus.COMPLETED.value or not clip.preview_path:
        raise HTTPException(status_code=409, detail="Clip isn't rendered yet")

    # Idempotency: don't create a second upload for a clip already in-flight or
    # published to this channel (guards double-clicks / two tabs / retried POSTs).
    _active = (
        PublishStatus.QUEUED.value,
        PublishStatus.SCHEDULED.value,
        PublishStatus.PUBLISHING.value,
        PublishStatus.PUBLISHED.value,
    )
    existing = (
        await db.execute(
            select(PublishingJob).where(
                PublishingJob.clip_id == clip.id,
                PublishingJob.connector_id == connector.id,
                PublishingJob.status.in_(_active),
            )
        )
    ).scalars().first()
    if existing is not None:
        return WhopPublishOut(clip_id=clip.id, job_id=existing.id, status=existing.status)

    job = PublishingJob(
        clip_id=clip.id,
        connector_id=connector.id,
        platform="youtube",
        status=PublishStatus.QUEUED.value,
        title=clip.title,
        description=clip.description,
        payload={"asset_key": clip.preview_path, "hashtags": clip.hashtags or []},
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    from app.workers.bot_tasks import publish_clip_job

    publish_clip_job.apply_async((job.id,))
    return WhopPublishOut(clip_id=clip.id, job_id=job.id, status=job.status)


# ---------------------------------------------------------------- formulas
# A "clip formula" reverse-engineers a campaign source video (transcript + the
# campaign's rules) into a reusable, section-by-section breakdown. The analysis
# runs in analyze_formula_task; the Studio polls the row for progress + result.
async def _owned_formula(db: AsyncSession, formula_id: int, user: User) -> WhopFormula:
    formula = await db.get(WhopFormula, formula_id)
    if not formula or formula.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Formula not found")
    return formula


@router.get("/campaigns/{campaign_id}/formulas", response_model=list[WhopFormulaOut])
async def list_formulas(
    campaign_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[WhopFormulaOut]:
    campaign = await _owned_campaign(db, campaign_id, current_user)
    rows = (
        await db.execute(
            select(WhopFormula)
            .where(WhopFormula.campaign_id == campaign.id)
            .order_by(WhopFormula.created_at.desc())
        )
    ).scalars().all()
    return [WhopFormulaOut.model_validate(r) for r in rows]


@router.post("/campaigns/{campaign_id}/formulas", response_model=WhopFormulaOut, status_code=201)
async def create_formula(
    campaign_id: int,
    payload: WhopFormulaCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopFormulaOut:
    campaign = await _owned_campaign(db, campaign_id, current_user)
    project = await _ensure_studio_project(db, current_user, campaign)
    video = await db.get(Video, payload.video_id)
    if not video or video.project_id != project.id:
        raise HTTPException(status_code=404, detail="Source video not found in this campaign")

    formula = WhopFormula(
        owner_id=current_user.id,
        campaign_id=campaign.id,
        video_id=video.id,
        title=video.title,
        source_url=video.source_url,
        status="processing",
        stage="queued",
        progress=0.0,
    )
    db.add(formula)
    await db.commit()
    await db.refresh(formula)

    from app.workers.tasks import analyze_formula_task

    task = analyze_formula_task.delay(formula.id)
    formula.celery_task_id = task.id
    await db.commit()
    await db.refresh(formula)
    return WhopFormulaOut.model_validate(formula)


@router.get("/formulas/{formula_id}", response_model=WhopFormulaOut)
async def get_formula(
    formula_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopFormulaOut:
    formula = await _owned_formula(db, formula_id, current_user)
    return WhopFormulaOut.model_validate(formula)


@router.delete("/formulas/{formula_id}", response_model=Message)
async def delete_formula(
    formula_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    formula = await _owned_formula(db, formula_id, current_user)
    await db.delete(formula)
    await db.commit()
    return Message(detail="Formula deleted")


# --------------------------------------------------------------- url preview
@router.get("/url-preview", response_model=WhopUrlPreviewOut)
async def url_preview(
    url: str = Query(..., min_length=1, max_length=500),
    current_user: User = Depends(get_current_user),
) -> WhopUrlPreviewOut:
    """Scrape a pasted whop.com link for its title/description/cover image.

    Whop can't be iframed, so the campaign form uses this to preview a campaign by
    URL and pull its details into a new campaign.
    """
    try:
        data = await fetch_url_preview(url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        logger.info("Whop URL preview failed for %r: %s", url, exc)
        raise HTTPException(status_code=502, detail="Couldn't load that Whop page") from exc
    return WhopUrlPreviewOut(**data)


# -------------------------------------------------------------- submissions
@router.post("/campaigns/{campaign_id}/submissions", response_model=WhopSubmissionOut, status_code=201)
async def create_submission(
    campaign_id: int,
    payload: WhopSubmissionCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopSubmissionOut:
    campaign = await _owned_campaign(db, campaign_id, current_user)
    submission = WhopSubmission(
        owner_id=current_user.id,
        campaign_id=campaign.id,
        creator_handle=payload.creator_handle,
        platform=payload.platform,
        post_url=payload.post_url.strip()[:500],
        title=payload.title,
        views=payload.views,
        likes=payload.likes,
        notes=payload.notes,
    )
    db.add(submission)
    await db.commit()
    await db.refresh(submission)
    if submission.views > 0:
        _record_snapshot(db, submission)
        await db.commit()
    return _submission_out(submission, campaign)


@router.get("/submissions", response_model=list[WhopSubmissionOut])
async def list_submissions(
    status: str | None = Query(default=None),
    campaign_id: int | None = Query(default=None),
    connector_id: int | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[WhopSubmissionOut]:
    stmt = (
        select(WhopSubmission, WhopCampaign)
        .join(WhopCampaign, WhopSubmission.campaign_id == WhopCampaign.id)
        .where(WhopSubmission.owner_id == current_user.id)
    )
    if status:
        stmt = stmt.where(WhopSubmission.status == status)
    if campaign_id is not None:
        stmt = stmt.where(WhopSubmission.campaign_id == campaign_id)
    if connector_id is not None:
        # Only submissions of the campaigns connected (manual ∪ auto) to this channel.
        connector = await _owned_connector(db, connector_id, current_user)
        connected = await _connected_campaign_ids(db, current_user, connector)
        if not connected:
            return []
        stmt = stmt.where(WhopSubmission.campaign_id.in_(connected))
    rows = (await db.execute(stmt.order_by(WhopSubmission.updated_at.desc()).limit(limit))).all()
    return [_submission_out(s, c) for s, c in rows]


@router.patch("/submissions/{submission_id}", response_model=WhopSubmissionOut)
async def update_submission(
    submission_id: int,
    payload: WhopSubmissionUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopSubmissionOut:
    submission = await _owned_submission(db, submission_id, current_user)
    old_views = submission.views
    for field, value in payload.model_dump(exclude_unset=True).items():
        if value is None and field not in _SUBMISSION_NULLABLE_FIELDS:
            continue
        setattr(submission, field, value)
    if submission.views != old_views:
        _record_snapshot(db, submission)
    await db.commit()
    await db.refresh(submission)
    campaign = await db.get(WhopCampaign, submission.campaign_id)
    return _submission_out(submission, campaign)


@router.post("/submissions/{submission_id}/approve", response_model=WhopSubmissionOut)
async def approve_submission(
    submission_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopSubmissionOut:
    submission = await _owned_submission(db, submission_id, current_user)
    if submission.status == WhopSubmissionStatus.PAID.value:
        raise HTTPException(status_code=409, detail="Submission is already paid")
    submission.status = WhopSubmissionStatus.APPROVED.value
    submission.rejection_reason = None
    await db.commit()
    await db.refresh(submission)
    campaign = await db.get(WhopCampaign, submission.campaign_id)
    return _submission_out(submission, campaign)


@router.post("/submissions/{submission_id}/reject", response_model=WhopSubmissionOut)
async def reject_submission(
    submission_id: int,
    payload: WhopReasonBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopSubmissionOut:
    submission = await _owned_submission(db, submission_id, current_user)
    if submission.status == WhopSubmissionStatus.PAID.value:
        raise HTTPException(status_code=409, detail="A paid submission can only be clawed back")
    submission.status = WhopSubmissionStatus.REJECTED.value
    submission.rejection_reason = payload.reason or None
    await db.commit()
    await db.refresh(submission)
    campaign = await db.get(WhopCampaign, submission.campaign_id)
    return _submission_out(submission, campaign)


@router.post("/submissions/{submission_id}/pay", response_model=WhopSubmissionOut)
async def pay_submission(
    submission_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopSubmissionOut:
    submission = await _owned_submission(db, submission_id, current_user)
    if submission.status != WhopSubmissionStatus.APPROVED.value:
        raise HTTPException(status_code=409, detail="Only approved submissions can be paid")
    campaign = await db.get(WhopCampaign, submission.campaign_id)
    submission.paid_amount = _earnings_estimate(submission, campaign)
    submission.status = WhopSubmissionStatus.PAID.value
    await db.commit()
    await db.refresh(submission)
    return _submission_out(submission, campaign)


@router.post("/submissions/{submission_id}/clawback", response_model=WhopSubmissionOut)
async def clawback_submission(
    submission_id: int,
    payload: WhopReasonBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopSubmissionOut:
    submission = await _owned_submission(db, submission_id, current_user)
    if submission.status not in (
        WhopSubmissionStatus.APPROVED.value,
        WhopSubmissionStatus.PAID.value,
    ):
        raise HTTPException(
            status_code=409, detail="Only approved or paid submissions can be clawed back"
        )
    submission.clawback_requested = True
    submission.clawback_reason = payload.reason or None
    await db.commit()
    await db.refresh(submission)
    campaign = await db.get(WhopCampaign, submission.campaign_id)
    return _submission_out(submission, campaign)


@router.delete("/submissions/{submission_id}", response_model=Message)
async def delete_submission(
    submission_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    submission = await _owned_submission(db, submission_id, current_user)
    await db.delete(submission)
    await db.commit()
    return Message(detail="Submission deleted")


# ------------------------------------------------------------------ channels
@router.get("/channels", response_model=list[WhopChannelOut])
async def list_channels(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[WhopChannelOut]:
    """Connected YouTube channels, each with its connected-campaign / review counts."""
    uid = current_user.id
    connectors = (
        await db.execute(
            select(PublishingConnector)
            .where(PublishingConnector.owner_id == uid, PublishingConnector.platform == "youtube")
            .order_by(PublishingConnector.created_at.desc())
        )
    ).scalars().all()
    if not connectors:
        return []

    # Preload once, then compute per-channel in memory (channels are few).
    manual_by_conn: dict[int, set[int]] = defaultdict(set)
    for connector_id, campaign_id in (
        await db.execute(
            select(WhopChannelCampaign.connector_id, WhopChannelCampaign.campaign_id).where(
                WhopChannelCampaign.owner_id == uid
            )
        )
    ).all():
        manual_by_conn[connector_id].add(campaign_id)

    all_subs = (
        await db.execute(select(WhopSubmission).where(WhopSubmission.owner_id == uid))
    ).scalars().all()
    yt_subs = [s for s in all_subs if s.platform == "youtube"]
    subs_by_campaign: dict[int, list[WhopSubmission]] = defaultdict(list)
    for s in all_subs:
        subs_by_campaign[s.campaign_id].append(s)

    out: list[WhopChannelOut] = []
    for c in connectors:
        cfg = c.config or {}
        tokens = _channel_match_tokens(c)
        channel_id = cfg.get("channel_id")
        auto = {s.campaign_id for s in yt_subs if _submission_matches_channel(s, tokens, channel_id)}
        connected = manual_by_conn[c.id] | auto
        conn_subs = [s for cid in connected for s in subs_by_campaign.get(cid, [])]
        out.append(
            WhopChannelOut(
                connector_id=c.id,
                name=c.name,
                channel_id=channel_id,
                channel_title=cfg.get("channel_title"),
                channel_thumbnail=cfg.get("channel_thumbnail"),
                status=c.status,
                has_credentials=bool((c.credentials or {}).get("refresh_token")),
                campaigns_connected=len(connected),
                submissions_pending=sum(
                    1 for s in conn_subs if s.status == WhopSubmissionStatus.PENDING.value
                ),
                submissions_total=len(conn_subs),
            )
        )
    return out


@router.get("/channels/{connector_id}/campaigns", response_model=list[WhopChannelCampaignOut])
async def list_channel_campaigns(
    connector_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[WhopChannelCampaignOut]:
    """Campaigns connected to a channel — manual pins plus auto-detected ones."""
    connector = await _owned_connector(db, connector_id, current_user)
    manual_ids = await _manual_campaign_ids(db, connector.id)
    auto_ids = await _auto_campaign_ids(db, current_user, connector)
    all_ids = manual_ids | auto_ids
    if not all_ids:
        return []
    campaigns = (
        await db.execute(
            select(WhopCampaign).where(
                WhopCampaign.owner_id == current_user.id, WhopCampaign.id.in_(all_ids)
            )
        )
    ).scalars().all()
    # Manual pins first, then by name — a stable, predictable order.
    campaigns.sort(key=lambda c: (c.id not in manual_ids, c.name.lower()))
    return [
        WhopChannelCampaignOut(
            campaign=await _campaign_out(db, c),
            source="manual" if c.id in manual_ids else "auto",
        )
        for c in campaigns
    ]


@router.post("/channels/{connector_id}/campaigns", response_model=WhopChannelCampaignOut, status_code=201)
async def link_channel_campaign(
    connector_id: int,
    payload: WhopChannelLinkBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopChannelCampaignOut:
    """Manually pin a campaign to a channel (idempotent)."""
    connector = await _owned_connector(db, connector_id, current_user)
    campaign = await _owned_campaign(db, payload.campaign_id, current_user)
    existing = (
        await db.execute(
            select(WhopChannelCampaign).where(
                WhopChannelCampaign.connector_id == connector.id,
                WhopChannelCampaign.campaign_id == campaign.id,
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        db.add(
            WhopChannelCampaign(
                owner_id=current_user.id, connector_id=connector.id, campaign_id=campaign.id
            )
        )
        await db.commit()
    return WhopChannelCampaignOut(campaign=await _campaign_out(db, campaign), source="manual")


@router.delete("/channels/{connector_id}/campaigns/{campaign_id}", response_model=Message)
async def unlink_channel_campaign(
    connector_id: int,
    campaign_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    """Remove a manual pin (idempotent — auto-detected links have no row to delete)."""
    connector = await _owned_connector(db, connector_id, current_user)
    link = (
        await db.execute(
            select(WhopChannelCampaign).where(
                WhopChannelCampaign.connector_id == connector.id,
                WhopChannelCampaign.campaign_id == campaign_id,
                WhopChannelCampaign.owner_id == current_user.id,
            )
        )
    ).scalar_one_or_none()
    if link is not None:
        await db.delete(link)
        await db.commit()
    return Message(detail="Campaign unlinked from channel")


# ---------------------------------------------------------------- analytics
@router.get("/analytics", response_model=WhopAnalyticsOut)
async def analytics(
    days: int = Query(default=30, ge=7, le=365),
    campaign_id: int | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> WhopAnalyticsOut:
    if campaign_id is not None:
        campaigns = [await _owned_campaign(db, campaign_id, current_user)]
    else:
        campaigns = (
            await db.execute(select(WhopCampaign).where(WhopCampaign.owner_id == current_user.id))
        ).scalars().all()
    by_id = {c.id: c for c in campaigns}

    stmt = select(WhopSubmission).where(WhopSubmission.owner_id == current_user.id)
    if campaign_id is not None:
        stmt = stmt.where(WhopSubmission.campaign_id == campaign_id)
    submissions = (await db.execute(stmt)).scalars().all()

    today = datetime.now(timezone.utc).date()
    start_date = today - timedelta(days=days - 1)
    start_dt = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)

    # Per submission: the last snapshot per day inside the range, plus the last
    # snapshot before the range as the baseline the first delta counts against.
    baseline: dict[int, int] = {}
    per_day: dict[int, dict[date, int]] = {}
    if submissions:
        snapshots = (
            await db.execute(
                select(WhopViewSnapshot)
                .where(WhopViewSnapshot.submission_id.in_([s.id for s in submissions]))
                .order_by(WhopViewSnapshot.created_at.asc())
            )
        ).scalars().all()
        for snap in snapshots:
            created = _as_utc(snap.created_at)
            if created < start_dt:
                baseline[snap.submission_id] = snap.views
            else:
                per_day.setdefault(snap.submission_id, {})[created.date()] = snap.views

    dates = [start_date + timedelta(days=i) for i in range(days)]
    views_by_day = dict.fromkeys(dates, 0)
    earnings_by_day = dict.fromkeys(dates, 0.0)
    for sub in submissions:
        day_map = per_day.get(sub.id)
        if not day_map:
            continue
        rate = by_id[sub.campaign_id].rate_per_1k
        prev = baseline.get(sub.id, 0)
        for day in dates:
            if day not in day_map:
                continue
            delta = max(0, day_map[day] - prev)
            views_by_day[day] += delta
            earnings_by_day[day] += delta / 1000 * rate
            prev = day_map[day]

    approved = sum(1 for s in submissions if s.status == WhopSubmissionStatus.APPROVED.value)
    rejected = sum(1 for s in submissions if s.status == WhopSubmissionStatus.REJECTED.value)
    paid = sum(1 for s in submissions if s.status == WhopSubmissionStatus.PAID.value)
    decisions = approved + paid + rejected

    views_total = sum(s.views for s in submissions)
    earnings_total = round(
        sum(s.paid_amount for s in submissions if s.status == WhopSubmissionStatus.PAID.value)
        + sum(
            _earnings_estimate(s, by_id[s.campaign_id])
            for s in submissions
            if s.status == WhopSubmissionStatus.APPROVED.value
        ),
        2,
    )

    stats: list[WhopCampaignStat] = []
    for campaign in campaigns:
        subs = [s for s in submissions if s.campaign_id == campaign.id]
        earnings = round(
            sum(s.paid_amount for s in subs if s.status == WhopSubmissionStatus.PAID.value)
            + sum(
                _earnings_estimate(s, campaign)
                for s in subs
                if s.status == WhopSubmissionStatus.APPROVED.value
            ),
            2,
        )
        stats.append(
            WhopCampaignStat(
                campaign_id=campaign.id,
                name=campaign.name,
                submissions=len(subs),
                views=sum(s.views for s in subs),
                earnings=earnings,
            )
        )
    stats.sort(key=lambda s: s.views, reverse=True)

    return WhopAnalyticsOut(
        days=days,
        views_total=views_total,
        earnings_total=earnings_total,
        effective_cpm=round(earnings_total / views_total * 1000, 2) if views_total else 0.0,
        submissions_total=len(submissions),
        approval_rate=round((approved + paid) / decisions * 100, 2) if decisions else 0.0,
        series=[
            WhopAnalyticsPoint(
                date=day.isoformat(), views=views_by_day[day], earnings=round(earnings_by_day[day], 2)
            )
            for day in dates
        ],
        campaigns=stats,
    )
