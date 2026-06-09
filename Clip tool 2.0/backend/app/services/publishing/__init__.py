"""Pluggable publishing connectors.

A connector turns a rendered clip + :class:`~app.models.publishing.PublishingJob`
into a post on a destination platform. The :data:`registry` lets new platforms
drop in without touching the publishing orchestrator.

The built-in ``manual`` connector is fully functional with no external setup: it
finalises the job against the locally exported asset so the operator can download
and post by hand (a real, working "publish queue"). Real social connectors
(YouTube/TikTok/…) require the operator's own OAuth credentials on the
:class:`~app.models.publishing.PublishingConnector` row.
"""
from __future__ import annotations

from app.services.publishing.base import (
    ConnectorNotConfigured,
    PublishConnector,
    PublishResult,
)
from app.services.publishing.registry import get_connector, register, registry

# Import connector modules to register them.
from app.services.publishing import manual, platforms  # noqa: E402,F401

__all__ = [
    "ConnectorNotConfigured",
    "PublishConnector",
    "PublishResult",
    "get_connector",
    "register",
    "registry",
]
