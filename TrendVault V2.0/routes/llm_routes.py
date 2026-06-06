"""LLM model-management routes — status, select model, switch backend, pull.

All paths are under /api/llm and require an authenticated session (the studio
catch-all / auth middleware gate /api/*). Backed by services.llm.model_admin,
which reads/writes the live config and persists to data/llm-settings.json.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from core.config import config
from services.llm import model_admin


def setup_llm_routes() -> APIRouter:
    router = APIRouter(prefix="/api/llm", tags=["llm"])

    @router.get("/status")
    async def status():
        return await asyncio.to_thread(model_admin.get_status)

    @router.post("/select")
    async def select(request: Request):
        body = await request.json()
        model = (body.get("model") or "").strip()
        if not model:
            return JSONResponse({"error": "model is required"}, status_code=400)
        await asyncio.to_thread(model_admin.save_settings, None, model)
        return {"ok": True, "model": config.local_llm_model}

    @router.post("/backend")
    async def backend(request: Request):
        body = await request.json()
        url = (body.get("url") or "").strip()
        if not url:
            return JSONResponse({"error": "url is required"}, status_code=400)
        await asyncio.to_thread(model_admin.save_settings, url, None)
        return {"ok": True, **(await asyncio.to_thread(model_admin.get_status))}

    @router.post("/pull")
    async def pull(request: Request):
        body = await request.json()
        name = (body.get("model") or "").strip()
        if not name:
            return JSONResponse({"error": "model is required"}, status_code=400)
        return StreamingResponse(model_admin.pull_stream(name),
                                 media_type="application/x-ndjson")

    return router
