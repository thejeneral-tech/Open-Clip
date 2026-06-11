"""Manual / local publish-queue connector.

The zero-config default: it doesn't post anywhere external — it finalises the job
against the locally rendered asset and exposes a download URL, turning the
publishing queue into a working "review & post by hand" workflow. Always
available, needs no credentials, and never leaves the host.
"""
from __future__ import annotations

import os
from typing import TYPE_CHECKING

from app.services.publishing.base import PublishConnector, PublishResult
from app.services.publishing.registry import register

if TYPE_CHECKING:
    from app.models.publishing import PublishingConnector, PublishingJob


class ManualConnector(PublishConnector):
    platform = "manual"
    requires_credentials = False

    def publish(
        self, job: "PublishingJob", asset_path: str, connector: "PublishingConnector | None" = None
    ) -> PublishResult:
        if not asset_path or not os.path.exists(asset_path):
            return PublishResult(success=False, detail="Rendered asset not found for clip")
        # The asset key is already stored on the job payload; surface it as the
        # "external" location the operator downloads from.
        key = job.payload.get("asset_key", "")
        url = f"/media/{key}" if key else None
        return PublishResult(
            success=True,
            external_post_id=f"manual-{job.id}",
            external_url=url,
            detail="Ready for manual download & posting",
            raw={"asset_key": key},
        )


register(ManualConnector())
