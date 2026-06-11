"""Bot Manager API: CRUD, lifecycle, clone/export/import, runs, and sources."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.models.bot import Bot, BotPreset, BotRun
from app.models.enums import ApprovalMode, BotRunTrigger, BotStatus
from app.models.trend import TrendSource
from app.models.user import User
from app.schemas.bot import (
    BotCreate,
    BotExport,
    BotOut,
    BotRunOut,
    BotUpdate,
)
from app.schemas.common import Message, TaskResponse
from app.schemas.trend import TrendSourceCreate, TrendSourceOut, TrendSourceUpdate
from app.services import presets

router = APIRouter()


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _owned_bot(db: AsyncSession, bot_id: int, user: User) -> Bot:
    bot = await db.get(Bot, bot_id)
    if not bot or bot.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Bot not found")
    return bot


async def _to_out(db: AsyncSession, bot: Bot) -> BotOut:
    count = (
        await db.execute(select(func.count(TrendSource.id)).where(TrendSource.bot_id == bot.id))
    ).scalar_one()
    out = BotOut.model_validate(bot)
    out.source_count = count
    return out


async def _resolve_preset_config(
    db: AsyncSession, user: User, preset_key: str, preset_id: int | None
) -> tuple[str, dict, str | None]:
    """Return ``(preset_key, resolved_config, default_bot_type)``.

    Resolves either a user preset (by id) or a built-in (by key).
    """
    if preset_id is not None:
        row = await db.get(BotPreset, preset_id)
        if not row or (row.owner_id not in (None, user.id)):
            raise HTTPException(status_code=404, detail="Preset not found")
        bt = presets.BUILTIN_PRESETS.get(row.key, {}).get("bot_type")
        return row.key, presets.resolve_config(row.config), bt
    builtin = presets.builtin(preset_key)
    if builtin is None:
        raise HTTPException(status_code=400, detail=f"Unknown preset '{preset_key}'")
    return preset_key, builtin["config"], builtin.get("bot_type")


# ---------------------------------------------------------------------- CRUD
@router.get("", response_model=list[BotOut])
async def list_bots(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[BotOut]:
    rows = (
        await db.execute(
            select(Bot).where(Bot.owner_id == current_user.id).order_by(Bot.created_at.desc())
        )
    ).scalars().all()
    return [await _to_out(db, b) for b in rows]


@router.post("", response_model=BotOut, status_code=201)
async def create_bot(
    payload: BotCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> BotOut:
    preset_key, config, default_bot_type = await _resolve_preset_config(
        db, current_user, payload.preset_key, payload.preset_id
    )
    config = presets.deep_merge(config, payload.config_overrides or {})
    columns = presets.config_to_bot_columns(config)

    # Honor an explicit bot_type; otherwise inherit the preset's natural type.
    bot_type = payload.bot_type if payload.bot_type and payload.bot_type != "custom" else (
        default_bot_type or "custom"
    )
    schedule = {"interval_minutes": 360, **(payload.schedule_config or {})}
    bot = Bot(
        owner_id=current_user.id,
        name=payload.name,
        description=payload.description,
        bot_type=bot_type,
        preset_key=preset_key,
        approval_mode=payload.approval_mode.value,
        status=BotStatus.STOPPED.value,
        schedule_config=schedule,
        **columns,
    )
    if payload.model_assignments:
        bot.model_assignments = {**bot.model_assignments, **payload.model_assignments}
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    return await _to_out(db, bot)


@router.get("/{bot_id}", response_model=BotOut)
async def get_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> BotOut:
    bot = await _owned_bot(db, bot_id, current_user)
    return await _to_out(db, bot)


@router.patch("/{bot_id}", response_model=BotOut)
async def update_bot(
    bot_id: int,
    payload: BotUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> BotOut:
    bot = await _owned_bot(db, bot_id, current_user)
    data = payload.model_dump(exclude_unset=True)
    for field in ("approval_mode", "status"):
        if field in data and data[field] is not None:
            data[field] = data[field].value if hasattr(data[field], "value") else data[field]
    for key, value in data.items():
        if value is not None:
            setattr(bot, key, value)
    await db.commit()
    await db.refresh(bot)
    return await _to_out(db, bot)


@router.delete("/{bot_id}", response_model=Message)
async def delete_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    bot = await _owned_bot(db, bot_id, current_user)
    await db.delete(bot)
    await db.commit()
    return Message(detail="Bot deleted")


# ----------------------------------------------------------- clone / export
@router.post("/{bot_id}/clone", response_model=BotOut, status_code=201)
async def clone_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> BotOut:
    src = await _owned_bot(db, bot_id, current_user)
    clone = Bot(
        owner_id=current_user.id,
        name=f"{src.name} (copy)",
        description=src.description,
        bot_type=src.bot_type,
        preset_key=src.preset_key,
        approval_mode=src.approval_mode,
        status=BotStatus.STOPPED.value,
        model_assignments=dict(src.model_assignments or {}),
        discovery_config=dict(src.discovery_config or {}),
        filter_config=dict(src.filter_config or {}),
        scoring_config=dict(src.scoring_config or {}),
        clipping_config=dict(src.clipping_config or {}),
        publishing_config=dict(src.publishing_config or {}),
        schedule_config=dict(src.schedule_config or {}),
    )
    db.add(clone)
    await db.flush()
    # Copy sources too.
    srcs = (
        await db.execute(select(TrendSource).where(TrendSource.bot_id == src.id))
    ).scalars().all()
    for s in srcs:
        db.add(TrendSource(
            owner_id=current_user.id, bot_id=clone.id, platform=s.platform, name=s.name,
            identifier=s.identifier, list_mode=s.list_mode, enabled=s.enabled, config=dict(s.config or {}),
        ))
    await db.commit()
    await db.refresh(clone)
    return await _to_out(db, clone)


@router.get("/{bot_id}/export", response_model=BotExport)
async def export_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> BotExport:
    bot = await _owned_bot(db, bot_id, current_user)
    srcs = (
        await db.execute(select(TrendSource).where(TrendSource.bot_id == bot.id))
    ).scalars().all()
    return BotExport(
        name=bot.name,
        description=bot.description,
        bot_type=bot.bot_type,
        approval_mode=bot.approval_mode,
        preset_key=bot.preset_key,
        config=presets.bot_columns_to_config(bot),
        model_assignments=bot.model_assignments or {},
        schedule_config=bot.schedule_config or {},
        sources=[
            {"platform": s.platform, "name": s.name, "identifier": s.identifier,
             "list_mode": s.list_mode, "enabled": s.enabled, "config": s.config}
            for s in srcs
        ],
    )


@router.post("/import", response_model=BotOut, status_code=201)
async def import_bot(
    payload: BotExport,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> BotOut:
    columns = presets.config_to_bot_columns(payload.config)
    bot = Bot(
        owner_id=current_user.id,
        name=payload.name,
        description=payload.description,
        bot_type=payload.bot_type or "custom",
        preset_key=payload.preset_key or "CUSTOM",
        approval_mode=payload.approval_mode or ApprovalMode.MANUAL.value,
        status=BotStatus.STOPPED.value,
        schedule_config={"interval_minutes": 360, **(payload.schedule_config or {})},
        **columns,
    )
    if payload.model_assignments:
        bot.model_assignments = {**bot.model_assignments, **payload.model_assignments}
    db.add(bot)
    await db.flush()
    for s in payload.sources or []:
        db.add(TrendSource(
            owner_id=current_user.id, bot_id=bot.id,
            platform=s.get("platform", "rss"), name=s.get("name", "source"),
            identifier=s.get("identifier", ""), list_mode=s.get("list_mode", "allow"),
            enabled=s.get("enabled", True), config=s.get("config", {}),
        ))
    await db.commit()
    await db.refresh(bot)
    return await _to_out(db, bot)


# ------------------------------------------------------------- lifecycle
@router.post("/{bot_id}/start", response_model=BotOut)
async def start_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> BotOut:
    bot = await _owned_bot(db, bot_id, current_user)
    bot.status = BotStatus.ACTIVE.value
    bot.next_run_at = _now()  # run on the next scheduler tick
    bot.last_error = None
    await db.commit()
    await db.refresh(bot)
    return await _to_out(db, bot)


@router.post("/{bot_id}/pause", response_model=BotOut)
async def pause_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> BotOut:
    bot = await _owned_bot(db, bot_id, current_user)
    bot.status = BotStatus.PAUSED.value
    await db.commit()
    await db.refresh(bot)
    return await _to_out(db, bot)


@router.post("/{bot_id}/resume", response_model=BotOut)
async def resume_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> BotOut:
    bot = await _owned_bot(db, bot_id, current_user)
    bot.status = BotStatus.ACTIVE.value
    if not bot.next_run_at:
        bot.next_run_at = _now()
    await db.commit()
    await db.refresh(bot)
    return await _to_out(db, bot)


@router.post("/{bot_id}/stop", response_model=BotOut)
async def stop_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> BotOut:
    bot = await _owned_bot(db, bot_id, current_user)
    bot.status = BotStatus.STOPPED.value
    bot.next_run_at = None
    await db.commit()
    await db.refresh(bot)
    return await _to_out(db, bot)


@router.post("/{bot_id}/run", response_model=TaskResponse)
async def run_bot_now(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> TaskResponse:
    bot = await _owned_bot(db, bot_id, current_user)
    run = BotRun(bot_id=bot.id, status="pending", trigger=BotRunTrigger.MANUAL.value, stage="queued")
    db.add(run)
    await db.commit()
    await db.refresh(run)

    from app.workers.bot_tasks import run_bot_cycle

    task = run_bot_cycle.apply_async((run.id,))
    return TaskResponse(task_id=task.id, detail=f"Bot run #{run.id} started")


@router.post("/{bot_id}/improve", response_model=TaskResponse)
async def improve_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> TaskResponse:
    bot = await _owned_bot(db, bot_id, current_user)

    from app.workers.bot_tasks import bot_self_improve

    task = bot_self_improve.apply_async((bot.id,))
    return TaskResponse(task_id=task.id, detail="Self-improvement analysis started")


# ---------------------------------------------------------------- runs
@router.get("/{bot_id}/runs", response_model=list[BotRunOut])
async def list_runs(
    bot_id: int,
    limit: int = 25,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[BotRunOut]:
    await _owned_bot(db, bot_id, current_user)
    rows = (
        await db.execute(
            select(BotRun).where(BotRun.bot_id == bot_id)
            .order_by(BotRun.created_at.desc()).limit(min(limit, 100))
        )
    ).scalars().all()
    return [BotRunOut.model_validate(r) for r in rows]


# ---------------------------------------------------------- sources subresource
@router.get("/{bot_id}/sources", response_model=list[TrendSourceOut])
async def list_sources(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[TrendSourceOut]:
    await _owned_bot(db, bot_id, current_user)
    rows = (
        await db.execute(select(TrendSource).where(TrendSource.bot_id == bot_id)
                         .order_by(TrendSource.created_at.desc()))
    ).scalars().all()
    return [TrendSourceOut.model_validate(s) for s in rows]


@router.post("/{bot_id}/sources", response_model=TrendSourceOut, status_code=201)
async def add_source(
    bot_id: int,
    payload: TrendSourceCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> TrendSourceOut:
    await _owned_bot(db, bot_id, current_user)
    source = TrendSource(
        owner_id=current_user.id, bot_id=bot_id, platform=payload.platform.value,
        name=payload.name, identifier=payload.identifier, list_mode=payload.list_mode.value,
        enabled=payload.enabled, config=payload.config,
    )
    db.add(source)
    await db.commit()
    await db.refresh(source)
    return TrendSourceOut.model_validate(source)


@router.patch("/{bot_id}/sources/{source_id}", response_model=TrendSourceOut)
async def update_source(
    bot_id: int,
    source_id: int,
    payload: TrendSourceUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> TrendSourceOut:
    await _owned_bot(db, bot_id, current_user)
    source = await db.get(TrendSource, source_id)
    if not source or source.bot_id != bot_id:
        raise HTTPException(status_code=404, detail="Source not found")
    data = payload.model_dump(exclude_unset=True)
    if "list_mode" in data and data["list_mode"] is not None:
        data["list_mode"] = data["list_mode"].value if hasattr(data["list_mode"], "value") else data["list_mode"]
    for key, value in data.items():
        if value is not None:
            setattr(source, key, value)
    await db.commit()
    await db.refresh(source)
    return TrendSourceOut.model_validate(source)


@router.delete("/{bot_id}/sources/{source_id}", response_model=Message)
async def delete_source(
    bot_id: int,
    source_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    await _owned_bot(db, bot_id, current_user)
    source = await db.get(TrendSource, source_id)
    if not source or source.bot_id != bot_id:
        raise HTTPException(status_code=404, detail="Source not found")
    await db.delete(source)
    await db.commit()
    return Message(detail="Source deleted")
