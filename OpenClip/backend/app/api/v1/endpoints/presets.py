"""Preset Manager API: list/create/edit/duplicate/export/import + versioning."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.models.bot import BotPreset
from app.models.user import User
from app.schemas.common import Message
from app.schemas.preset import PresetCreate, PresetImport, PresetOut, PresetUpdate
from app.services import presets as preset_svc

router = APIRouter()


async def _owned_preset(db: AsyncSession, preset_id: int, user: User) -> BotPreset:
    row = await db.get(BotPreset, preset_id)
    if not row or (row.owner_id not in (None, user.id)):
        raise HTTPException(status_code=404, detail="Preset not found")
    return row


@router.get("", response_model=list[PresetOut])
async def list_presets(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[PresetOut]:
    rows = (
        await db.execute(
            select(BotPreset)
            .where(or_(BotPreset.is_system.is_(True), BotPreset.owner_id == current_user.id))
            .order_by(BotPreset.is_system.desc(), BotPreset.name)
        )
    ).scalars().all()
    return [PresetOut.model_validate(r) for r in rows]


@router.post("", response_model=PresetOut, status_code=201)
async def create_preset(
    payload: PresetCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> PresetOut:
    row = BotPreset(
        owner_id=current_user.id,
        key=payload.key,
        name=payload.name,
        description=payload.description,
        based_on=payload.based_on,
        is_system=False,
        version=1,
        config=preset_svc.resolve_config(payload.config),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return PresetOut.model_validate(row)


@router.get("/{preset_id}", response_model=PresetOut)
async def get_preset(
    preset_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> PresetOut:
    return PresetOut.model_validate(await _owned_preset(db, preset_id, current_user))


@router.patch("/{preset_id}", response_model=PresetOut)
async def update_preset(
    preset_id: int,
    payload: PresetUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> PresetOut:
    row = await _owned_preset(db, preset_id, current_user)
    if row.is_system:
        raise HTTPException(status_code=403, detail="System presets are read-only — duplicate first")
    if payload.name is not None:
        row.name = payload.name
    if payload.description is not None:
        row.description = payload.description
    if payload.config is not None:
        row.config = preset_svc.resolve_config(payload.config)
    if payload.bump_version:
        row.version += 1
    await db.commit()
    await db.refresh(row)
    return PresetOut.model_validate(row)


@router.delete("/{preset_id}", response_model=Message)
async def delete_preset(
    preset_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    row = await _owned_preset(db, preset_id, current_user)
    if row.is_system:
        raise HTTPException(status_code=403, detail="System presets cannot be deleted")
    await db.delete(row)
    await db.commit()
    return Message(detail="Preset deleted")


@router.post("/{preset_id}/duplicate", response_model=PresetOut, status_code=201)
async def duplicate_preset(
    preset_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> PresetOut:
    src = await _owned_preset(db, preset_id, current_user)
    row = BotPreset(
        owner_id=current_user.id,
        key=f"{src.key}_COPY",
        name=f"{src.name} (copy)",
        description=src.description,
        based_on=src.key,
        is_system=False,
        version=1,
        config=dict(src.config or {}),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return PresetOut.model_validate(row)


@router.post("/import", response_model=PresetOut, status_code=201)
async def import_preset(
    payload: PresetImport,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> PresetOut:
    row = BotPreset(
        owner_id=current_user.id,
        key=payload.key or "IMPORTED",
        name=payload.name or "Imported preset",
        is_system=False,
        version=1,
        config=preset_svc.resolve_config(payload.config),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return PresetOut.model_validate(row)
