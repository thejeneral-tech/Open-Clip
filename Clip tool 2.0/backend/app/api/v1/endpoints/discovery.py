"""Discovery API: trend feed, item review, and the discovery plugin catalog."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.models.bot import Bot
from app.models.enums import TrendItemStatus
from app.models.trend import TrendItem
from app.models.user import User
from app.schemas.common import Message
from app.schemas.trend import TrendItemOut

router = APIRouter()


async def _owned_bot(db: AsyncSession, bot_id: int, user: User) -> Bot:
    bot = await db.get(Bot, bot_id)
    if not bot or bot.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Bot not found")
    return bot


async def _owned_item(db: AsyncSession, item_id: int, user: User) -> TrendItem:
    item = await db.get(TrendItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Trend item not found")
    bot = await db.get(Bot, item.bot_id)
    if not bot or bot.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Trend item not found")
    return item


@router.get("/platforms")
async def list_platforms(_: User = Depends(get_current_user)) -> dict:
    """The discovery plugins currently registered."""
    from app.services.discovery import registry as discovery_registry

    return {"platforms": sorted(discovery_registry.keys())}


@router.get("/bots/{bot_id}/items", response_model=list[TrendItemOut])
async def list_trend_items(
    bot_id: int,
    status: str | None = Query(default=None),
    sort: str = Query(default="score", pattern="^(score|time)$"),
    limit: int = Query(default=50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[TrendItemOut]:
    await _owned_bot(db, bot_id, current_user)
    stmt = select(TrendItem).where(TrendItem.bot_id == bot_id)
    if status:
        stmt = stmt.where(TrendItem.status == status)
    stmt = stmt.order_by(
        TrendItem.trend_score.desc() if sort == "score" else TrendItem.created_at.desc()
    ).limit(limit)
    rows = (await db.execute(stmt)).scalars().all()
    return [TrendItemOut.model_validate(r) for r in rows]


@router.get("/items/{item_id}", response_model=TrendItemOut)
async def get_trend_item(
    item_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> TrendItemOut:
    return TrendItemOut.model_validate(await _owned_item(db, item_id, current_user))


@router.post("/items/{item_id}/approve", response_model=TrendItemOut)
async def approve_item(
    item_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> TrendItemOut:
    item = await _owned_item(db, item_id, current_user)
    item.status = TrendItemStatus.APPROVED.value
    item.reason = "manually approved"
    await db.commit()
    await db.refresh(item)
    return TrendItemOut.model_validate(item)


@router.post("/items/{item_id}/reject", response_model=TrendItemOut)
async def reject_item(
    item_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> TrendItemOut:
    item = await _owned_item(db, item_id, current_user)
    item.status = TrendItemStatus.REJECTED.value
    item.reason = "manually rejected"
    await db.commit()
    await db.refresh(item)
    return TrendItemOut.model_validate(item)


@router.delete("/items/{item_id}", response_model=Message)
async def delete_item(
    item_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    item = await _owned_item(db, item_id, current_user)
    await db.delete(item)
    await db.commit()
    return Message(detail="Trend item deleted")
