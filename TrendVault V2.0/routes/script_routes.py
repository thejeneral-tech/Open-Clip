"""Script-generation routes (Phase 1: generate-script)."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from services.script.script_service import ScriptInputError, ScriptService


def setup_script_routes(script_service: ScriptService) -> APIRouter:
    router = APIRouter(prefix="/api/trend-vault", tags=["script"])

    @router.post("/generate-script")
    async def generate_script(request: Request):
        payload = await request.json()
        try:
            return await asyncio.to_thread(script_service.generate_script, payload)
        except ScriptInputError as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
        except Exception as e:  # noqa: BLE001
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    return router
