"""Discovery plugin registry."""
from __future__ import annotations

from typing import TYPE_CHECKING

from app.core.logging import get_logger
from app.services.discovery.base import DiscoveredItem, DiscoveryPlugin

if TYPE_CHECKING:
    from app.models.trend import TrendSource

logger = get_logger(__name__)

registry: dict[str, DiscoveryPlugin] = {}


def register(plugin: DiscoveryPlugin) -> DiscoveryPlugin:
    """Register a plugin instance under its ``platform`` key."""
    if not plugin.platform:
        raise ValueError("DiscoveryPlugin.platform must be set")
    registry[plugin.platform] = plugin
    return plugin


def get_plugin(platform: str) -> DiscoveryPlugin | None:
    return registry.get(platform)


def discover_source(
    source: "TrendSource", *, limit: int = 25, lookback_hours: int = 168
) -> list[DiscoveredItem]:
    """Run the plugin matching ``source.platform``; never raises."""
    plugin = get_plugin(source.platform)
    if plugin is None:
        logger.warning("No discovery plugin for platform %r", source.platform)
        return []
    try:
        return plugin.discover(source, limit=limit, lookback_hours=lookback_hours)
    except Exception as exc:  # pragma: no cover - network/parse errors are expected
        logger.warning("Discovery failed for source %s (%s): %s", source.id, source.platform, exc)
        return []
