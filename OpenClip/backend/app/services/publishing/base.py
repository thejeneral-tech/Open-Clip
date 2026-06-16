"""Publishing connector contract."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.models.publishing import PublishingConnector, PublishingJob


class ConnectorNotConfigured(RuntimeError):
    """Raised when a connector lacks the credentials/config to publish."""


@dataclass
class PublishResult:
    success: bool
    external_post_id: str | None = None
    external_url: str | None = None
    detail: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


class PublishConnector(ABC):
    #: platform key (matches SourcePlatform values, plus "manual").
    platform: str = ""
    #: True if real external credentials are required to publish.
    requires_credentials: bool = True

    def validate(self, connector: PublishingConnector) -> tuple[bool, str]:
        """Check the connector is ready to publish. Returns ``(ok, detail)``."""
        if self.requires_credentials and not connector.credentials:
            return False, f"{self.platform} connector has no credentials configured"
        return True, "ready"

    @abstractmethod
    def publish(
        self, job: PublishingJob, asset_path: str, connector: PublishingConnector
    ) -> PublishResult:
        """Deliver ``asset_path`` to the platform for ``job``."""
        raise NotImplementedError

    def fetch_analytics(
        self, job: PublishingJob, connector: PublishingConnector
    ) -> dict[str, Any]:
        """Pull post-publish performance. Default: nothing available."""
        return {}
