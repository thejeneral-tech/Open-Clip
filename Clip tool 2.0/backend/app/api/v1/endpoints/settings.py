"""Per-user settings (model selection, defaults, preferences)."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.models.settings import UserSettings
from app.models.user import User
from app.schemas.settings import SettingsOut, SettingsUpdate

router = APIRouter()


async def _get_or_create(db: AsyncSession, user_id: int) -> UserSettings:
    result = await db.execute(select(UserSettings).where(UserSettings.user_id == user_id))
    settings_row = result.scalar_one_or_none()
    if not settings_row:
        settings_row = UserSettings(user_id=user_id)
        db.add(settings_row)
        await db.commit()
        await db.refresh(settings_row)
    return settings_row


@router.get("", response_model=SettingsOut)
async def get_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> UserSettings:
    return await _get_or_create(db, current_user.id)


@router.patch("", response_model=SettingsOut)
async def update_settings(
    payload: SettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> UserSettings:
    row = await _get_or_create(db, current_user.id)
    data = payload.model_dump(exclude_unset=True, mode="json")
    for key, value in data.items():
        if value is not None:
            setattr(row, key, value)
    await db.commit()
    await db.refresh(row)
    return row
