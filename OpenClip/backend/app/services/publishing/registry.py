"""Publishing connector registry."""
from __future__ import annotations

from app.services.publishing.base import PublishConnector

registry: dict[str, PublishConnector] = {}


def register(connector: PublishConnector) -> PublishConnector:
    if not connector.platform:
        raise ValueError("PublishConnector.platform must be set")
    registry[connector.platform] = connector
    return connector


def get_connector(platform: str) -> PublishConnector | None:
    return registry.get(platform)
