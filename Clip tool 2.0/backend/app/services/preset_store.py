"""Persistence helpers for presets.

Built-in presets live in code (:mod:`app.services.presets`); this module mirrors
them into ``bot_presets`` rows (``is_system=True``) so the API can list system +
user presets uniformly and users can clone them. Seeding is idempotent.
"""
from __future__ import annotations

from sqlalchemy import select

from app.core.database import session_scope
from app.core.logging import get_logger
from app.models.bot import BotPreset
from app.services import presets

logger = get_logger(__name__)


def seed_system_presets() -> int:
    """Upsert all built-in presets as system rows. Returns the number written."""
    written = 0
    with session_scope() as db:
        for spec in presets.list_builtin():
            row = db.execute(
                select(BotPreset).where(
                    BotPreset.key == spec["key"], BotPreset.is_system.is_(True)
                )
            ).scalar_one_or_none()
            if row is None:
                db.add(
                    BotPreset(
                        owner_id=None,
                        key=spec["key"],
                        name=spec["name"],
                        description=spec.get("description"),
                        version=spec.get("version", 1),
                        is_system=True,
                        based_on=None,
                        config=spec["config"],
                    )
                )
                written += 1
            else:
                # Keep system rows in sync with code as presets evolve.
                row.name = spec["name"]
                row.description = spec.get("description")
                row.config = spec["config"]
    if written:
        logger.info("Seeded %d system presets", written)
    return written
