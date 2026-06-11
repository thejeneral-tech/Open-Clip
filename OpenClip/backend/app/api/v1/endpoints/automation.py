"""Automation status API: bot analytics + the Ollama service / GPU dashboard."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.models.bot import Bot
from app.models.user import User
from app.schemas.analytics import BotAnalyticsOut, OllamaStatusOut

router = APIRouter()


@router.get("/ollama/status", response_model=OllamaStatusOut)
async def ollama_status(_: User = Depends(get_current_user)) -> OllamaStatusOut:
    """Centralized Ollama service health: loaded models, VRAM, and GPUs."""
    from app.services.ollama_service import ollama_service

    status = await asyncio.to_thread(ollama_service.gpu_status)
    return OllamaStatusOut(**status)


class ProcessSuspendRequest(BaseModel):
    suspended: bool


@router.post("/gpu/processes/{pid}/suspend")
async def suspend_gpu_process(
    pid: int,
    payload: ProcessSuspendRequest,
    _: User = Depends(get_current_user),
) -> dict:
    """Pause (suspend) or resume a GPU process — the dashboard on/off toggle.

    Protected processes (kernel/session-critical, the API server itself) are
    rejected by the service layer regardless of what the client requests.
    """
    from app.services.gpu_processes import set_process_suspended

    ok = await asyncio.to_thread(set_process_suspended, pid, payload.suspended)
    if not ok:
        raise HTTPException(status_code=400, detail="Process not found or cannot be controlled")
    return {"pid": pid, "suspended": payload.suspended}


@router.delete("/gpu/processes/{pid}")
async def terminate_gpu_process(pid: int, _: User = Depends(get_current_user)) -> dict:
    """Hard-terminate a GPU process to free its VRAM.

    Protected processes (kernel/session-critical, the API server itself) are
    rejected by the service layer so the dashboard can't crash the machine.
    """
    from app.services.gpu_processes import terminate_gpu_process as _terminate

    ok = await asyncio.to_thread(_terminate, pid)
    if not ok:
        raise HTTPException(status_code=400, detail="Process not found or cannot be controlled")
    return {"terminated": pid}


@router.get("/bots/{bot_id}/analytics", response_model=BotAnalyticsOut)
async def bot_analytics(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> BotAnalyticsOut:
    bot = await db.get(Bot, bot_id)
    if not bot or bot.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Bot not found")

    def _aggregate() -> dict:
        from app.core.database import session_scope
        from app.services import analytics

        with session_scope() as s:
            b = s.get(Bot, bot_id)
            return analytics.aggregate_performance(s, b)

    summary = await asyncio.to_thread(_aggregate)
    return BotAnalyticsOut(bot_id=bot_id, summary=summary, insights=bot.insights or {})
