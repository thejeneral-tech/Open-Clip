"""Seed the bundled built-in voice presets (the TikTok clone voices) per user.

The three presets — "Tiktok Adam/Anton/Jessie Voice" — are promoted to built-ins
so every user always has them: seeded for all existing users at startup
(:func:`seed_all_voice_presets`, called from the app lifespan) and lazily for any
user created later (:func:`ensure_voice_presets`, called when Voice Lab loads).

Idempotent by ``preset_key``: a removed built-in (soft-deleted) is never
resurrected and re-seeding never duplicates. Each preset's bundled audition clip
is copied into storage once (a shared ``builtin_<key>`` key) so Preview plays it.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import session_scope
from app.core.logging import get_logger
from app.models.storyvault import SvVoicePreset
from app.models.user import User
from app.services.storage import storage, sv_voice_preset_preview_key
from app.services.storyvault.voice_presets_data import (
    BUILTIN_VOICE_PRESETS,
    voice_preset_asset,
)

logger = get_logger(__name__)


def seed_voice_presets_for_user(db: Session, user_id: int) -> int:
    """Seed the built-ins for one user on an open session. Returns count added.

    The caller owns the transaction (``session_scope`` commits on exit).
    """
    have = set(
        db.execute(
            select(SvVoicePreset.preset_key).where(
                SvVoicePreset.owner_id == user_id,
                SvVoicePreset.preset_key.is_not(None),
            )
        ).scalars().all()
    )
    has_default = bool(
        db.execute(
            select(SvVoicePreset.id).where(
                SvVoicePreset.owner_id == user_id,
                SvVoicePreset.deleted_at.is_(None),
                SvVoicePreset.is_default.is_(True),
            )
        ).scalars().first()
    )
    added = 0
    for spec in BUILTIN_VOICE_PRESETS:
        if spec["key"] in have:
            continue
        # Copy the bundled audition clip into storage once (shared across users).
        preview_url: str | None = None
        key = sv_voice_preset_preview_key(f"builtin_{spec['key']}")
        if not storage.exists(key):
            asset = voice_preset_asset(spec["preview"])
            if asset is not None:
                storage.save_file(str(asset), key)
        if storage.exists(key):
            preview_url = storage.url(key)

        make_default = bool(spec.get("isDefault")) and not has_default
        if make_default:
            has_default = True
        db.add(
            SvVoicePreset(
                owner_id=user_id,
                name=spec["name"],
                voice=spec["voice"],
                speed=spec["speed"],
                engine=spec["engine"],
                preview_url=preview_url,
                is_default=make_default,
                builtin=True,
                preset_key=spec["key"],
            )
        )
        added += 1
    return added


def ensure_voice_presets(user_id: int) -> int:
    """Seed (and commit) the built-ins for a single user in its own session."""
    with session_scope() as db:
        return seed_voice_presets_for_user(db, user_id)


def seed_all_voice_presets() -> int:
    """Seed the built-ins for every existing user. Returns the total added."""
    total = 0
    with session_scope() as db:
        for uid in db.execute(select(User.id)).scalars().all():
            total += seed_voice_presets_for_user(db, uid)
    if total:
        logger.info("Seeded %d built-in voice preset(s)", total)
    return total
