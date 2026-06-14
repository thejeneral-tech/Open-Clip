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

    Also backfills the cloning reference (``ref_key`` + ``prompt_text``) onto any
    built-in clone preset that was seeded before those fields existed, so existing
    accounts get working cloned-voice narration without re-creating the presets.

    The caller owns the transaction (``session_scope`` commits on exit).
    """
    existing = {
        p.preset_key: p
        for p in db.execute(
            select(SvVoicePreset).where(
                SvVoicePreset.owner_id == user_id,
                SvVoicePreset.preset_key.is_not(None),
            )
        ).scalars().all()
    }
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
        # Copy the bundled audition clip into storage once (shared across users).
        # It also serves as the clone reference, so a clone preset records its key.
        preview_key = sv_voice_preset_preview_key(f"builtin_{spec['key']}")
        if not storage.exists(preview_key):
            asset = voice_preset_asset(spec["preview"])
            if asset is not None:
                storage.save_file(str(asset), preview_key)
        has_clip = storage.exists(preview_key)
        preview_url = storage.url(preview_key) if has_clip else None
        is_clone = (spec.get("engine") or "sapi") != "sapi"
        transcript = spec.get("transcript") or None
        ref_key = preview_key if (is_clone and has_clip) else None

        prior = existing.get(spec["key"])
        if prior is not None:
            # Already seeded — backfill the cloning reference if it's missing.
            if is_clone and ref_key and not prior.ref_key:
                prior.ref_key = ref_key
            if is_clone and transcript and not prior.prompt_text:
                prior.prompt_text = transcript
            continue

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
                ref_key=ref_key,
                prompt_text=transcript,
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
