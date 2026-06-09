"""Ollama model discovery, install (pull), removal + health."""
from __future__ import annotations

import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.api.deps import get_current_user
from app.models.user import User
from app.schemas.settings import OllamaModelInfo
from app.services.ollama_client import (
    delete_model_async,
    list_models_async,
    ollama,
    pull_model_stream,
)

router = APIRouter()


class ModelPullRequest(BaseModel):
    name: str = Field(min_length=1, description="Ollama model name, e.g. 'qwen3:8b'")


@router.get("", response_model=list[OllamaModelInfo])
async def list_models(_: User = Depends(get_current_user)) -> list[OllamaModelInfo]:
    raw = await list_models_async()
    out: list[OllamaModelInfo] = []
    for m in raw:
        details = m.get("details", {}) or {}
        out.append(
            OllamaModelInfo(
                name=m.get("name", ""),
                size=m.get("size"),
                parameter_size=details.get("parameter_size"),
                family=details.get("family"),
                modified_at=m.get("modified_at"),
            )
        )
    return out


@router.post("/pull")
async def pull_model(
    payload: ModelPullRequest,
    _: User = Depends(get_current_user),
) -> StreamingResponse:
    """Install a model. Streams Ollama's download progress as NDJSON so the web
    app can show a progress bar. The user picks *which* model to install — nothing
    is downloaded automatically."""
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Model name is required")

    async def _events() -> AsyncIterator[bytes]:
        async for event in pull_model_stream(name):
            yield (json.dumps(event) + "\n").encode("utf-8")

    return StreamingResponse(
        _events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.delete("/{name:path}")
async def delete_model(name: str, _: User = Depends(get_current_user)) -> dict:
    """Remove an installed model to free disk space."""
    if not await delete_model_async(name):
        raise HTTPException(status_code=404, detail="Model not found or could not be removed")
    return {"deleted": name}


@router.get("/health")
async def ollama_health(_: User = Depends(get_current_user)) -> dict:
    return {"ollama_up": ollama.health(), "base_url": ollama.base_url}
