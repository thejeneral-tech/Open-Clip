"""Plugin-based trend discovery.

Each supported platform registers a :class:`DiscoveryPlugin` that turns a
:class:`~app.models.trend.TrendSource` into a list of :class:`DiscoveredItem`.
The registry lets new sources be added without touching the orchestrator.

All plugins are network-only (no AI) and use dependencies already in the stack
(``yt-dlp``, ``httpx``, the stdlib XML parser) so the engine works out of the box
and stays fully self-hosted.
"""
from __future__ import annotations

from app.services.discovery.base import DiscoveredItem, DiscoveryPlugin
from app.services.discovery.registry import discover_source, get_plugin, register, registry

# Importing the plugin modules registers them as a side effect.
from app.services.discovery import reddit, rss, youtube  # noqa: E402,F401

__all__ = [
    "DiscoveredItem",
    "DiscoveryPlugin",
    "discover_source",
    "get_plugin",
    "register",
    "registry",
]
