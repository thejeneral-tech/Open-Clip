"""External social-platform publishing connectors.

These require the operator's own credentials on the connector row — the platform
makes no calls until you connect an account. The YouTube connector implements a
genuine resumable upload against the Data API v3 (driven by an OAuth access
token); the others define the same contract and validate credentials, raising a
clear, actionable error until a full integration/token is supplied. This keeps
the system honest: it never pretends to post when it can't.
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

if TYPE_CHECKING:
    from app.models.publishing import PublishingConnector, PublishingJob

logger = get_logger(__name__)


class YouTubeConnector(PublishConnector):
    """Upload a Short via the YouTube Data API v3 resumable endpoint.

    Expects ``connector.credentials = {"access_token": "...", ...}`` (an OAuth2
    token with ``youtube.upload`` scope, refreshed by the operator). Token
    acquisition/refresh is intentionally left to the operator's OAuth setup.
    """

    platform = "youtube"

    def publish(
        self, job: "PublishingJob", asset_path: str, connector: "PublishingConnector"
    ) -> PublishResult:
        token = (connector.credentials or {}).get("access_token")
        if not token:
            raise ConnectorNotConfigured(
                "YouTube connector needs an OAuth2 access_token (youtube.upload scope) "
                "in its credentials. Connect a channel under Publishing → Connectors."
            )
        if not asset_path or not os.path.exists(asset_path):
            return PublishResult(success=False, detail="Rendered asset not found")

        privacy = job.payload.get("privacy") or connector.config.get("privacy", "private")
        tags = job.payload.get("hashtags", []) or []
        body = {
            "snippet": {
                "title": (job.title or "Short")[:100],
                "description": job.description or "",
                "tags": [t.lstrip("#") for t in tags][:15],
                "categoryId": str(connector.config.get("category_id", "22")),
            },
            "status": {"privacyStatus": privacy, "selfDeclaredMadeForKids": False},
        }
        size = os.path.getsize(asset_path)
        init_url = (
            "https://www.googleapis.com/upload/youtube/v3/videos"
            "?uploadType=resumable&part=snippet,status"
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": str(size),
            "X-Upload-Content-Type": "video/*",
        }
        try:
            with httpx.Client(timeout=120) as client:
                init = client.post(init_url, headers=headers, content=json.dumps(body))
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


class _CredentialedStub(PublishConnector):
    """Shared base for platforms whose official upload requires an approved app.

    Validates credentials and, if a generic ``upload_webhook`` is configured
    (e.g. a self-hosted relay or Make/n8n endpoint the operator runs), POSTs the
    asset there. Otherwise it raises a clear not-configured error rather than
    silently faking a post.
    """

    def publish(
        self, job: "PublishingJob", asset_path: str, connector: "PublishingConnector"
    ) -> PublishResult:
        webhook = (connector.config or {}).get("upload_webhook")
        if not webhook:
            raise ConnectorNotConfigured(
                f"{self.platform} publishing requires an approved API app. Configure an "
                f"'upload_webhook' on the connector (a relay you control) or use the "
                f"manual queue connector to download and post."
            )
        if not asset_path or not os.path.exists(asset_path):
            return PublishResult(success=False, detail="Rendered asset not found")
        try:
            with httpx.Client(timeout=300) as client, open(asset_path, "rb") as fh:
                resp = client.post(
                    webhook,
                    headers={"Authorization": f"Bearer {(connector.credentials or {}).get('token', '')}"},
                    data={
                        "title": job.title or "",
                        "description": job.description or "",
                        "platform": self.platform,
                    },
                    files={"file": (os.path.basename(asset_path), fh, "video/mp4")},
                )
                resp.raise_for_status()
                data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
        except httpx.HTTPError as exc:
            return PublishResult(success=False, detail=f"{self.platform} relay failed: {exc}")
        return PublishResult(
            success=True,
            external_post_id=data.get("id"),
            external_url=data.get("url"),
            detail=f"Relayed to {self.platform}",
            raw=data,
        )


class TikTokConnector(_CredentialedStub):
    platform = "tiktok"


class InstagramConnector(_CredentialedStub):
    platform = "instagram"


class XConnector(_CredentialedStub):
    platform = "x"


class FacebookConnector(_CredentialedStub):
    platform = "facebook"


for _c in (
    YouTubeConnector(),
    TikTokConnector(),
    InstagramConnector(),
    XConnector(),
    FacebookConnector(),
):
    register(_c)
