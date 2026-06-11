"""YouTube / Google OAuth 2.0 helpers for the publishing flow.

Connecting a channel is a standard server-side OAuth code flow:

1. The (authenticated) UI asks for an auth URL. We sign a short-lived ``state``
   JWT carrying the requesting user (and an optional bot to assign the channel
   to) so the stateless callback can trust who started the flow.
2. The browser consents on Google and is redirected to ``GOOGLE_OAUTH_REDIRECT_URI``
   — a backend endpoint — with ``code`` + ``state``.
3. We exchange the code for tokens (keeping the ``refresh_token``), look up the
   channel, and persist a ``PublishingConnector`` row.

At publish time the connector exchanges its stored ``refresh_token`` for a fresh
access token (access tokens live ~1h) and uploads via the Data API. No Google
client libraries are needed — these are plain HTTPS calls, matching the rest of
the codebase's httpx usage.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt

from app.core.config import settings

# youtube.upload to insert videos; youtube.readonly to read channel name/avatar.
SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
]

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
CHANNELS_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels"

_STATE_PURPOSE = "yt_oauth"
_STATE_TTL = timedelta(minutes=15)


class OAuthError(RuntimeError):
    """A recoverable problem during the OAuth handshake."""


def is_configured() -> bool:
    return settings.youtube_oauth_configured


def _require_client() -> tuple[str, str]:
    if not settings.youtube_oauth_configured:
        raise OAuthError(
            "YouTube is not configured. Set GOOGLE_CLIENT_ID and "
            "GOOGLE_CLIENT_SECRET in .env (see .env.example)."
        )
    return settings.GOOGLE_CLIENT_ID, settings.GOOGLE_CLIENT_SECRET  # type: ignore[return-value]


# --------------------------------------------------------------------- state
def sign_state(*, user_id: int, bot_id: int | None, name: str | None) -> str:
    """Sign the CSRF/identity ``state`` returned to us by Google."""
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "purpose": _STATE_PURPOSE,
        "uid": int(user_id),
        "bot_id": int(bot_id) if bot_id else None,
        "name": name or None,
        "iat": now,
        "exp": now + _STATE_TTL,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def verify_state(token: str) -> dict[str, Any]:
    try:
        data = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except jwt.PyJWTError as exc:  # expired / tampered
        raise OAuthError(f"Invalid or expired OAuth state: {exc}") from exc
    if data.get("purpose") != _STATE_PURPOSE:
        raise OAuthError("OAuth state purpose mismatch")
    return data


# ----------------------------------------------------------------- auth URL
def build_auth_url(state: str) -> str:
    client_id, _ = _require_client()
    params = {
        "client_id": client_id,
        "redirect_uri": settings.GOOGLE_OAUTH_REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",      # ask for a refresh_token
        "prompt": "consent",           # force refresh_token even on re-consent
        "include_granted_scopes": "true",
        "state": state,
    }
    return f"{AUTH_ENDPOINT}?{urlencode(params)}"


# ----------------------------------------------------------------- exchange
async def exchange_code(code: str) -> dict[str, Any]:
    """Trade an authorization ``code`` for tokens (async; used by the callback)."""
    client_id, client_secret = _require_client()
    data = {
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": settings.GOOGLE_OAUTH_REDIRECT_URI,
        "grant_type": "authorization_code",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(TOKEN_ENDPOINT, data=data)
    if resp.status_code != 200:
        raise OAuthError(f"Token exchange failed: {resp.text}")
    return resp.json()


async def fetch_channel(access_token: str) -> dict[str, str | None]:
    """Look up the signed-in user's channel (title + avatar) for display."""
    params = {"part": "snippet", "mine": "true"}
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(CHANNELS_ENDPOINT, params=params, headers=headers)
    if resp.status_code != 200:
        raise OAuthError(f"Channel lookup failed: {resp.text}")
    items = resp.json().get("items") or []
    if not items:
        return {"id": None, "title": None, "thumbnail": None}
    snip = items[0].get("snippet", {})
    thumbs = snip.get("thumbnails", {})
    thumb = (thumbs.get("default") or thumbs.get("medium") or {}).get("url")
    return {"id": items[0].get("id"), "title": snip.get("title"), "thumbnail": thumb}


def refresh_access_token(refresh_token: str) -> str:
    """Exchange a stored ``refresh_token`` for a fresh access token (sync).

    Called from the Celery worker at publish time, so it uses a sync client.
    """
    client_id, client_secret = _require_client()
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }
    with httpx.Client(timeout=30) as client:
        resp = client.post(TOKEN_ENDPOINT, data=data)
    if resp.status_code != 200:
        raise OAuthError(f"Token refresh failed: {resp.text}")
    token = resp.json().get("access_token")
    if not token:
        raise OAuthError("Token refresh returned no access_token")
    return token
