"""Publishing API: connectors + the publish queue (approve / cancel / retry)."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from urllib.parse import quote, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.core.config import settings
from app.core.logging import get_logger
from app.models.bot import Bot
from app.models.clip import Clip
from app.models.enums import ConnectorStatus, PublishStatus
from app.models.publishing import PublishingConnector, PublishingJob
from app.models.user import User
from app.schemas.common import Message, TaskResponse
from app.schemas.publishing import (
    ConnectorAssignIn,
    ConnectorCreate,
    ConnectorOut,
    ConnectorUpdate,
    PublishingJobOut,
    PublishJobCreate,
    YouTubeAuthUrlIn,
    YouTubeAuthUrlOut,
    YouTubeStatusOut,
)
from app.services.publishing import youtube_oauth
from app.services.storage import storage, youtube_avatar_key

logger = get_logger(__name__)

router = APIRouter()

# Hosts we'll proxy an avatar from. The URL always comes from our own OAuth
# channel lookup, but validating the host keeps this from becoming an open proxy.
_AVATAR_HOSTS = ("ggpht.com", "googleusercontent.com")
# Display size we fetch/cache the avatar at (it renders in a ~44px circle). The
# Google CDN resizes on the "=sNN" token, so ask for a crisp-but-small render.
_AVATAR_SIZE = 176


def _sized_avatar_url(url: str) -> str:
    """Rewrite a Google avatar URL's size token so we cache a crisp render."""
    return re.sub(r"=s\d+", f"=s{_AVATAR_SIZE}", url, count=1)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _connector_out(c: PublishingConnector) -> ConnectorOut:
    out = ConnectorOut.model_validate(c)
    out.has_credentials = bool(c.credentials)
    return out


async def _owned_connector(db: AsyncSession, cid: int, user: User) -> PublishingConnector:
    c = await db.get(PublishingConnector, cid)
    if not c or c.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Connector not found")
    return c


async def _sync_bot_platforms(db: AsyncSession, bot_id: int | None) -> None:
    """Mirror a bot's connected channels into ``publishing_config.platforms`` so
    the runner's auto-publish step targets exactly the platforms it can post to.
    """
    if not bot_id:
        return
    bot = await db.get(Bot, bot_id)
    if not bot:
        return
    rows = (
        await db.execute(
            select(PublishingConnector.platform).where(PublishingConnector.bot_id == bot_id)
        )
    ).scalars().all()
    platforms = sorted(set(rows))
    cfg = dict(bot.publishing_config or {})
    cfg["platforms"] = platforms or ["manual"]
    bot.publishing_config = cfg


async def _owned_job(db: AsyncSession, jid: int, user: User) -> PublishingJob:
    job = await db.get(PublishingJob, jid)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.bot_id is not None:
        bot = await db.get(Bot, job.bot_id)
        if not bot or bot.owner_id != user.id:
            raise HTTPException(status_code=404, detail="Job not found")
    return job


# --------------------------------------------------------------- connectors
@router.get("/connectors", response_model=list[ConnectorOut])
async def list_connectors(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[ConnectorOut]:
    rows = (
        await db.execute(
            select(PublishingConnector).where(PublishingConnector.owner_id == current_user.id)
            .order_by(PublishingConnector.created_at.desc())
        )
    ).scalars().all()
    return [_connector_out(c) for c in rows]


@router.post("/connectors", response_model=ConnectorOut, status_code=201)
async def create_connector(
    payload: ConnectorCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> ConnectorOut:
    c = PublishingConnector(
        owner_id=current_user.id,
        bot_id=payload.bot_id,
        platform=payload.platform.value,
        name=payload.name,
        config=payload.config,
        credentials=payload.credentials,
        status=ConnectorStatus.CONNECTED.value if payload.credentials else ConnectorStatus.DISCONNECTED.value,
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return _connector_out(c)


@router.patch("/connectors/{connector_id}", response_model=ConnectorOut)
async def update_connector(
    connector_id: int,
    payload: ConnectorUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> ConnectorOut:
    c = await _owned_connector(db, connector_id, current_user)
    if payload.name is not None:
        c.name = payload.name
    if payload.config is not None:
        c.config = payload.config
    if payload.credentials is not None:
        c.credentials = payload.credentials
        c.status = ConnectorStatus.CONNECTED.value if payload.credentials else ConnectorStatus.DISCONNECTED.value
    if payload.bot_id is not None:
        c.bot_id = payload.bot_id
    await db.commit()
    await db.refresh(c)
    return _connector_out(c)


@router.delete("/connectors/{connector_id}", response_model=Message)
async def delete_connector(
    connector_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    c = await _owned_connector(db, connector_id, current_user)
    prev_bot = c.bot_id
    await db.delete(c)
    await db.flush()
    await _sync_bot_platforms(db, prev_bot)
    await db.commit()
    return Message(detail="Connector deleted")


@router.post("/connectors/{connector_id}/assign", response_model=ConnectorOut)
async def assign_connector(
    connector_id: int,
    payload: ConnectorAssignIn,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> ConnectorOut:
    """Assign a channel to a bot (or unassign with ``bot_id: null``). Keeps the
    bot's auto-publish platform list in sync."""
    c = await _owned_connector(db, connector_id, current_user)
    if payload.bot_id is not None:
        bot = await db.get(Bot, payload.bot_id)
        if not bot or bot.owner_id != current_user.id:
            raise HTTPException(status_code=404, detail="Bot not found")
    prev_bot = c.bot_id
    c.bot_id = payload.bot_id
    await db.flush()
    await _sync_bot_platforms(db, prev_bot)
    await _sync_bot_platforms(db, payload.bot_id)
    await db.commit()
    await db.refresh(c)
    return _connector_out(c)


# ------------------------------------------------------------------- queue
@router.get("/jobs", response_model=list[PublishingJobOut])
async def list_jobs(
    bot_id: int | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[PublishingJobOut]:
    # Scope to bots the user owns.
    owned_bot_ids = (
        await db.execute(select(Bot.id).where(Bot.owner_id == current_user.id))
    ).scalars().all()
    stmt = select(PublishingJob).where(PublishingJob.bot_id.in_(owned_bot_ids or [-1]))
    if bot_id is not None:
        stmt = stmt.where(PublishingJob.bot_id == bot_id)
    if status:
        stmt = stmt.where(PublishingJob.status == status)
    stmt = stmt.order_by(PublishingJob.created_at.desc()).limit(limit)
    rows = (await db.execute(stmt)).scalars().all()
    return [PublishingJobOut.model_validate(r) for r in rows]


@router.post("/jobs", response_model=PublishingJobOut, status_code=201)
async def create_job(
    payload: PublishJobCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> PublishingJobOut:
    clip = await db.get(Clip, payload.clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    platform = payload.platform.value if hasattr(payload.platform, "value") else payload.platform
    job = PublishingJob(
        clip_id=clip.id,
        connector_id=payload.connector_id,
        platform=platform,
        status=PublishStatus.PENDING.value,
        scheduled_at=payload.scheduled_at,
        title=payload.title or clip.title,
        description=payload.description or clip.description,
        payload={"asset_key": clip.preview_path, "hashtags": clip.hashtags or [], **payload.payload},
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return PublishingJobOut.model_validate(job)


@router.post("/jobs/{job_id}/approve", response_model=TaskResponse)
async def approve_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> TaskResponse:
    job = await _owned_job(db, job_id, current_user)
    job.status = PublishStatus.QUEUED.value
    await db.commit()

    from app.workers.bot_tasks import publish_clip_job

    task = publish_clip_job.apply_async((job.id,))
    return TaskResponse(task_id=task.id, detail="Publishing")


@router.post("/jobs/{job_id}/retry", response_model=TaskResponse)
async def retry_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> TaskResponse:
    job = await _owned_job(db, job_id, current_user)
    job.status = PublishStatus.QUEUED.value
    job.error = None
    await db.commit()

    from app.workers.bot_tasks import publish_clip_job

    task = publish_clip_job.apply_async((job.id,))
    return TaskResponse(task_id=task.id, detail="Retrying")


@router.post("/jobs/{job_id}/cancel", response_model=PublishingJobOut)
async def cancel_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> PublishingJobOut:
    job = await _owned_job(db, job_id, current_user)
    job.status = PublishStatus.CANCELLED.value
    await db.commit()
    await db.refresh(job)
    return PublishingJobOut.model_validate(job)


# --------------------------------------------------------------- youtube oauth
@router.get("/youtube/status", response_model=YouTubeStatusOut)
async def youtube_status(
    current_user: User = Depends(get_current_user),
) -> YouTubeStatusOut:
    """Whether a Google OAuth client is wired up (so channels can be connected)."""
    return YouTubeStatusOut(
        configured=youtube_oauth.is_configured(),
        redirect_uri=settings.GOOGLE_OAUTH_REDIRECT_URI,
    )


@router.post("/youtube/auth-url", response_model=YouTubeAuthUrlOut)
async def youtube_auth_url(
    payload: YouTubeAuthUrlIn,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> YouTubeAuthUrlOut:
    """Start the OAuth flow: return a Google consent URL carrying a signed state."""
    if not youtube_oauth.is_configured():
        raise HTTPException(
            status_code=503,
            detail="YouTube isn't configured on the server (GOOGLE_CLIENT_ID / SECRET).",
        )
    if payload.bot_id is not None:
        bot = await db.get(Bot, payload.bot_id)
        if not bot or bot.owner_id != current_user.id:
            raise HTTPException(status_code=404, detail="Bot not found")
    state = youtube_oauth.sign_state(
        user_id=current_user.id,
        bot_id=payload.bot_id,
        name=payload.name,
        return_to=payload.return_to,
    )
    return YouTubeAuthUrlOut(auth_url=youtube_oauth.build_auth_url(state))


def _safe_return_path(return_to: str | None) -> str:
    """Whitelist the post-connect landing page to a same-origin relative path.

    Only a path that starts with a single ``/`` (not ``//`` — that's a
    protocol-relative URL to another host) is honored; anything else falls back
    to the Publishing page.
    """
    if return_to and return_to.startswith("/") and not return_to.startswith("//"):
        return return_to
    return "/publishing"


def _frontend_redirect(path: str = "/publishing", **params: str) -> RedirectResponse:
    base = settings.FRONTEND_BASE_URL.rstrip("/")
    query = "&".join(f"{k}={quote(v)}" for k, v in params.items() if v)
    sep = "&" if "?" in path else "?"
    return RedirectResponse(url=f"{base}{path}{sep}{query}", status_code=302)


@router.get("/youtube/callback")
async def youtube_callback(
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    db: AsyncSession = Depends(get_session),
) -> RedirectResponse:
    """OAuth redirect target. Exchanges the code, stores the channel, and bounces
    the browser back to the Publishing page. Unauthenticated by design — trust is
    established by the signed ``state`` rather than a bearer token."""
    if error:
        return _frontend_redirect(error=f"YouTube authorization was cancelled ({error}).")
    if not code or not state:
        return _frontend_redirect(error="YouTube authorization is missing code/state.")
    return_path = "/publishing"
    try:
        st = youtube_oauth.verify_state(state)
        return_path = _safe_return_path(st.get("return_to"))
        tokens = await youtube_oauth.exchange_code(code)
        channel = await youtube_oauth.fetch_channel(tokens.get("access_token", ""))
    except youtube_oauth.OAuthError as exc:
        logger.warning("YouTube callback failed: %s", exc)
        return _frontend_redirect(return_path, error=str(exc))
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("YouTube callback crashed")
        return _frontend_redirect(return_path, error=f"YouTube connection failed: {exc}")

    owner_id = int(st["uid"])
    bot_id = st.get("bot_id")
    channel_id = channel.get("id")
    channel_title = channel.get("title") or "YouTube channel"
    name = st.get("name") or channel_title

    # Reuse an existing row for this channel (re-connect) instead of duplicating.
    existing = (
        await db.execute(
            select(PublishingConnector).where(
                PublishingConnector.owner_id == owner_id,
                PublishingConnector.platform == "youtube",
            )
        )
    ).scalars().all()
    connector = next((c for c in existing if (c.config or {}).get("channel_id") == channel_id), None)

    refresh_token = tokens.get("refresh_token")
    if connector is None:
        connector = PublishingConnector(
            owner_id=owner_id,
            platform="youtube",
            name=name,
            bot_id=bot_id,
        )
        db.add(connector)
    else:
        # Google omits refresh_token on silent re-consent — keep the stored one.
        if not refresh_token:
            refresh_token = (connector.credentials or {}).get("refresh_token")
        if bot_id is not None:
            connector.bot_id = bot_id

    connector.status = ConnectorStatus.CONNECTED.value
    connector.last_error = None
    connector.name = name
    connector.config = {
        "channel_id": channel_id,
        "channel_title": channel_title,
        "channel_thumbnail": channel.get("thumbnail"),
        "privacy": (connector.config or {}).get("privacy", settings.YOUTUBE_DEFAULT_PRIVACY),
        "made_for_kids": (connector.config or {}).get("made_for_kids", False),
    }
    connector.credentials = {
        "refresh_token": refresh_token,
        "scope": tokens.get("scope"),
        "token_type": tokens.get("token_type"),
    }

    await db.flush()
    await _sync_bot_platforms(db, connector.bot_id)
    await db.commit()
    return _frontend_redirect(return_path, connected="youtube", channel=channel_title)


@router.get("/channel-avatar/{connector_id}")
async def channel_avatar(
    connector_id: int,
    db: AsyncSession = Depends(get_session),
) -> Response:
    """Serve a connected channel's avatar from our OWN origin.

    Hotlinking Google's image CDN (``yt3.ggpht.com``) silently fails for users
    whose browser or antivirus blocks third-party image hosts (ad-blockers,
    McAfee/other web-protection) — the profile picture doesn't render and the
    page background shows through. Proxying the bytes same-origin (and caching
    them) makes the avatar load reliably. Unauthenticated because ``<img>`` can't
    carry a bearer token, and channel avatars are public images anyway.
    """
    key = youtube_avatar_key(connector_id)
    cache_headers = {"Cache-Control": "public, max-age=86400"}
    if storage.exists(key):
        with open(storage.abspath(key, ensure_parent=False), "rb") as fh:
            return Response(fh.read(), media_type="image/jpeg", headers=cache_headers)

    connector = await db.get(PublishingConnector, connector_id)
    remote = (connector.config or {}).get("channel_thumbnail") if connector else None
    if not connector or connector.platform != "youtube" or not remote:
        raise HTTPException(status_code=404, detail="No avatar for this channel")
    host = (urlparse(remote).hostname or "").lower()
    if not any(host == h or host.endswith("." + h) for h in _AVATAR_HOSTS):
        raise HTTPException(status_code=404, detail="Unsupported avatar host")

    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            resp = await client.get(_sized_avatar_url(remote))
        resp.raise_for_status()
        data = resp.content
    except Exception as exc:  # network hiccup / CDN error — don't 500 the page
        logger.warning("Avatar fetch failed for connector %s: %s", connector_id, exc)
        raise HTTPException(status_code=502, detail="Avatar fetch failed") from exc

    storage.save_bytes(key, data)
    return Response(data, media_type="image/jpeg", headers=cache_headers)
