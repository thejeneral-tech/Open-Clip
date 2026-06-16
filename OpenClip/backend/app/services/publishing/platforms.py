"""Social-platform publishing connectors.

YouTube is a full integration: a channel is connected via OAuth (see
``youtube_oauth`` and the ``/publishing/youtube/*`` endpoints), which stores a
refresh token on the connector row. At publish time we mint a fresh access
token from that refresh token and upload the rendered clip as a Short via the
YouTube Data API v3 resumable endpoint.

The other platforms (TikTok / Instagram / X / Facebook) are registered as
"coming soon" connectors: they validate to a clear, honest error instead of
pretending to post. The UI surfaces them as disabled so the queue never silently
drops a clip.
"""
from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING

import httpx

from app.core.logging import get_logger
from app.services.publishing.base import (
    ConnectorNotConfigured,
    PublishConnector,
    PublishResult,
)
from app.services.publishing.registry import register
from app.services.publishing.youtube_oauth import (
    OAuthError,
    is_configured,
    refresh_access_token,
)

if TYPE_CHECKING:
    from app.models.publishing import PublishingConnector, PublishingJob

logger = get_logger(__name__)


class YouTubeConnector(PublishConnector):
    """Upload a Short via the YouTube Data API v3 resumable endpoint.

    The connector row stores ``credentials = {"refresh_token": "...", ...}`` from
    the OAuth flow. We never persist long-lived access tokens — each publish
    refreshes one from the refresh token, so a revoked grant surfaces cleanly.
    """

    platform = "youtube"
    requires_credentials = True

    def validate(self, connector: PublishingConnector) -> tuple[bool, str]:
        if not is_configured():
            return False, (
                "YouTube isn't configured on the server (GOOGLE_CLIENT_ID / "
                "GOOGLE_CLIENT_SECRET). Ask the operator to set them in .env."
            )
        if not (connector.credentials or {}).get("refresh_token"):
            return False, (
                "This YouTube channel isn't connected. Open Publishing → Channels "
                "and click Connect."
            )
        return True, "ready"

    def publish(
        self, job: PublishingJob, asset_path: str, connector: PublishingConnector
    ) -> PublishResult:
        refresh_token = (connector.credentials or {}).get("refresh_token")
        if not refresh_token:
            raise ConnectorNotConfigured(
                "This YouTube channel isn't connected. Reconnect it under "
                "Publishing → Channels."
            )
        if not asset_path or not os.path.exists(asset_path):
            return PublishResult(success=False, detail="Rendered asset not found")

        try:
            token = refresh_access_token(refresh_token)
        except OAuthError as exc:
            # Most often invalid_grant: the refresh token was revoked/expired.
            raise ConnectorNotConfigured(
                f"YouTube sign-in expired — reconnect the channel. ({exc})"
            ) from exc

        cfg = connector.config or {}
        payload = job.payload or {}
        privacy = payload.get("privacy") or cfg.get("privacy", "private")
        tags = [t.lstrip("#") for t in (payload.get("hashtags") or [])][:30]
        if not tags:
            tags = cfg.get("default_tags") or ["shorts"]
        # #Shorts in the description (plus a vertical, <=180s clip) tells YouTube
        # to classify the upload as a Short.
        base_desc = job.description or ""
        description = base_desc if "#shorts" in base_desc.lower() else f"{base_desc}\n\n#Shorts"
        body = {
            "snippet": {
                "title": (job.title or "Short")[:100],
                "description": description[:5000],
                "tags": tags,
                "categoryId": str(cfg.get("category_id", "22")),
            },
            "status": {
                "privacyStatus": privacy,
                "selfDeclaredMadeForKids": bool(cfg.get("made_for_kids", False)),
            },
        }

        size = os.path.getsize(asset_path)
        init_url = (
            "https://www.googleapis.com/upload/youtube/v3/videos"
            "?uploadType=resumable&part=snippet,status"
        )
        init_headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": str(size),
            "X-Upload-Content-Type": "video/*",
        }
        try:
            with httpx.Client(timeout=600) as client:
                init = client.post(init_url, headers=init_headers, content=json.dumps(body))
                init.raise_for_status()
                upload_url = init.headers.get("Location")
                if not upload_url:
                    return PublishResult(success=False, detail="No resumable URL returned")
                with open(asset_path, "rb") as fh:
                    up = client.put(
                        upload_url,
                        headers={"Content-Type": "video/*", "Content-Length": str(size)},
                        content=fh.read(),
                    )
                up.raise_for_status()
                data = up.json()
        except httpx.HTTPError as exc:
            return PublishResult(success=False, detail=f"YouTube upload failed: {exc}")

        vid = data.get("id")
        return PublishResult(
            success=bool(vid),
            external_post_id=vid,
            external_url=f"https://youtube.com/shorts/{vid}" if vid else None,
            detail="Published to YouTube" if vid else "Upload returned no id",
            raw=data,
        )


class ComingSoonConnector(PublishConnector):
    """Placeholder for platforms we haven't integrated yet.

    Validates to an honest "coming soon" message so a queued clip lands in
    ``awaiting_approval`` with a clear reason instead of silently failing.
    """

    requires_credentials = False
    label = "This platform"

    def validate(self, connector: PublishingConnector) -> tuple[bool, str]:
        return False, f"{self.label} publishing is coming soon."

    def publish(
        self, job: PublishingJob, asset_path: str, connector: PublishingConnector
    ) -> PublishResult:
        raise ConnectorNotConfigured(f"{self.label} publishing is coming soon.")


class TikTokConnector(ComingSoonConnector):
    platform = "tiktok"
    label = "TikTok"


class InstagramConnector(ComingSoonConnector):
    platform = "instagram"
    label = "Instagram"


class XConnector(ComingSoonConnector):
    platform = "x"
    label = "X (Twitter)"


class FacebookConnector(ComingSoonConnector):
    platform = "facebook"
    label = "Facebook"


for _c in (
    YouTubeConnector(),
    TikTokConnector(),
    InstagramConnector(),
    XConnector(),
    FacebookConnector(),
):
    register(_c)
