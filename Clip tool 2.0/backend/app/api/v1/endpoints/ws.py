"""WebSocket endpoint relaying progress events to the browser.

Connect to ``/api/v1/ws/{scope}/{scope_id}?token=<jwt>`` where scope is
``video`` | ``clip`` | ``export``. On connect we replay the latest snapshot,
then poll the on-disk progress snapshot (written by Celery workers) and stream
each change until the client disconnects.
"""
from __future__ import annotations

import asyncio
import json

import jwt
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.core.events import get_latest_snapshot
from app.core.logging import get_logger
from app.core.security import decode_token

logger = get_logger(__name__)
router = APIRouter()

_VALID_SCOPES = {"video", "clip", "export"}
_POLL_SECONDS = 0.5
_HEARTBEAT_SECONDS = 20.0


@router.websocket("/ws/{scope}/{scope_id}")
async def progress_ws(
    websocket: WebSocket,
    scope: str,
    scope_id: int,
    token: str = Query(...),
) -> None:
    if scope not in _VALID_SCOPES:
        await websocket.close(code=4400)
        return
    try:
        payload = decode_token(token)
        if payload.get("type") != "access":
            raise ValueError
    except (jwt.PyJWTError, ValueError):
        await websocket.close(code=4401)
        return

    await websocket.accept()

    last_ts: float | None = None
    snapshot = get_latest_snapshot(scope, scope_id)
    if snapshot:
        await websocket.send_json(snapshot)
        last_ts = snapshot.get("ts")

    since_heartbeat = 0.0
    try:
        while True:
            await asyncio.sleep(_POLL_SECONDS)
            since_heartbeat += _POLL_SECONDS

            snapshot = get_latest_snapshot(scope, scope_id)
            if snapshot and snapshot.get("ts") != last_ts:
                await websocket.send_text(json.dumps(snapshot))
                last_ts = snapshot.get("ts")
                since_heartbeat = 0.0
            elif since_heartbeat >= _HEARTBEAT_SECONDS:
                # Heartbeat doubles as a disconnect probe.
                await websocket.send_json({"type": "ping"})
                since_heartbeat = 0.0
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # pragma: no cover - client went away mid-send
        logger.debug("WS closed for %s:%s (%s)", scope, scope_id, exc)
