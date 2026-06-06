"""HTML page routes — serve the copied studio frontend (no-cache, like the Coder)."""
from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from core.constants import STATIC_DIR

# route path -> file in static/
_PAGES = {
    "/": "index.html",
    "/trend-vault": "trend-vault.html",
    "/voice-lab": "voice-lab.html",
    "/mainframe": "mainframe.html",
    "/accounts": "accounts.html",
    "/tiktok": "tiktok.html",
    "/youtube": "youtube.html",
    "/instagram": "instagram.html",
    "/voice-editor": "voice-editor.html",
}


def _serve_html(filename: str) -> HTMLResponse:
    path = os.path.join(STATIC_DIR, filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail=f"{filename} not found")
    with open(path, "r", encoding="utf-8") as f:
        html = f.read()
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


def setup_page_routes() -> APIRouter:
    router = APIRouter(tags=["pages"])

    def _make(filename: str):
        async def handler() -> HTMLResponse:
            return _serve_html(filename)
        return handler

    for route_path, filename in _PAGES.items():
        router.add_api_route(route_path, _make(filename), methods=["GET"],
                             response_class=HTMLResponse)
    return router
