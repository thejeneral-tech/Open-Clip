"""Draft routes — file-backed Save/Load for the Vault's in-progress projects.

The Vault's "Save draft / Load drafts" feature (static/trend-vault.html) posts the
full editor state here. Each draft is one JSON file under ``data/drafts/`` named by
its id. These endpoints existed in the original Express backend but were never
ported to the FastAPI app, so every page load hit the GET-only catch-all, got a
404 ``{"detail":"Not found"}`` back, and ``loadDrafts()`` crashed on
``drafts.length`` (undefined) — a visible console error on the Vault page.

Responses always carry a stable ``{"ok", "drafts"/"draft"}`` shape so the UI never
crashes on a missing key, even when there are no drafts yet.
"""
from __future__ import annotations

import glob
import os
import re
import time
from typing import Any, Dict, List

from fastapi import APIRouter, Request

from core.atomic_io import atomic_write_json, read_json
from core.constants import DRAFTS_DIR


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:40] or "draft"


def setup_draft_routes() -> APIRouter:
    router = APIRouter(prefix="/api/trend-vault", tags=["drafts"])

    @router.get("/drafts")
    async def list_drafts() -> Dict[str, Any]:
        out: List[Dict[str, Any]] = []
        for path in glob.glob(os.path.join(DRAFTS_DIR, "*.json")):
            d = read_json(path, None)
            if isinstance(d, dict) and d.get("id"):
                out.append(d)
        out.sort(key=lambda d: d.get("savedAt") or 0, reverse=True)
        return {"ok": True, "drafts": out}

    @router.post("/drafts")
    async def save_draft(request: Request) -> Dict[str, Any]:
        body = await request.json()
        name = str(body.get("name") or "").strip() or "Untitled draft"
        state = body.get("state")
        if not isinstance(state, dict):
            state = {}
        # Reuse an explicit id (update-in-place) or mint a sortable, filesystem-safe one.
        draft_id = str(body.get("id") or "").strip() or f"{int(time.time() * 1000)}-{_slug(name)}"
        draft = {"id": draft_id, "name": name,
                 "savedAt": int(time.time() * 1000), "state": state}
        atomic_write_json(os.path.join(DRAFTS_DIR, os.path.basename(draft_id) + ".json"), draft)
        return {"ok": True, "id": draft_id, "draft": draft}

    @router.delete("/drafts/{draft_id}")
    async def delete_draft(draft_id: str) -> Dict[str, Any]:
        # basename guards against path traversal — only a bare id under DRAFTS_DIR.
        path = os.path.join(DRAFTS_DIR, os.path.basename(draft_id) + ".json")
        if os.path.isfile(path):
            try:
                os.unlink(path)
            except OSError as e:  # noqa: BLE001
                return {"ok": False, "error": f"Could not delete draft: {e}"}
            return {"ok": True}
        return {"ok": False, "error": "Draft not found"}

    return router
