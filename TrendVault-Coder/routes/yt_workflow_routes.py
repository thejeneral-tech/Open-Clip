"""YouTube → Workflow-Remake-Prompt builder — HTTP/SSE surface.

Drives ``src/yt_workflow_builder.py``: a reliable pipeline that turns a YouTube
video's transcript / metadata / notes / comments / frame descriptions into a
detailed "remake this on my server" prompt, designed never to crash on a long
transcript (chunking + retry ladder + emergency template).

Endpoints (all under /api/yt-workflow):
  GET  /health         — Ollama up? model installed? proactive RAM-fit warning
  POST /extract        — fetch transcript/comments/metadata → clean source
  POST /chunk          — split source text into safe chunks
  POST /summarize      — (SSE) summarise each chunk, live progress
  POST /generate       — (SSE) workflow map → final templated prompt
  POST /run            — (SSE) full n8n-style flow: health→extract→…→save
  POST /save           — persist a generated prompt
  GET  /history        — list saved prompts
  GET  /prompt/{id}    — fetch one (export)
  DELETE /prompt/{id}  — delete one

SSE frames mirror the automation routes: ``data: {json}\n\n`` then ``data: [DONE]``.
"""

import asyncio
import logging
import uuid
from dataclasses import asdict
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from core.database import YtWorkflowPrompt, SessionLocal
from src.auth_helpers import get_current_user
from src import yt_workflow_builder as ywb
from src import youtube_handler as yt

logger = logging.getLogger(__name__)


def _new_id(prefix: str = "ytwf") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _sse(obj: Dict[str, Any]) -> str:
    import json
    return f"data: {json.dumps(obj)}\n\n"


def _diag_dict(diag: ywb.GenDiag) -> Dict[str, Any]:
    return asdict(diag)


def _clamp(value: Optional[int], lo: int, hi: int, default: int) -> int:
    try:
        v = int(value) if value is not None else default
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


# ------------------------------------------------------------------ #
# SSE bridge: run an async producer that calls emit(), stream as SSE  #
# ------------------------------------------------------------------ #

async def _sse_stream(producer):
    """Run ``producer(emit)`` and stream every emitted event as an SSE frame.

    The producer pushes events through ``emit``; we drain them via a queue so the
    long-running pipeline and the HTTP response don't block each other.
    """
    q: "asyncio.Queue[Optional[Dict[str, Any]]]" = asyncio.Queue()

    async def emit(ev: Dict[str, Any]) -> None:
        await q.put(ev)

    async def run() -> None:
        try:
            await producer(emit)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # never leak a raw 500 to the stream
            logger.exception("yt-workflow SSE producer failed")
            await q.put({"type": "error", "message": str(e)})
        finally:
            await q.put(None)

    task = asyncio.create_task(run())
    try:
        while True:
            ev = await q.get()
            if ev is None:
                break
            yield _sse(ev)
        yield "data: [DONE]\n\n"
    finally:
        if not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass


# ------------------------------------------------------------------ #
# Request bodies                                                      #
# ------------------------------------------------------------------ #

class ExtractBody(BaseModel):
    url: Optional[str] = None
    transcript: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    notes: Optional[str] = None
    frames: Optional[List[str]] = None
    include_comments: bool = True
    include_metadata: bool = True


class ChunkBody(BaseModel):
    text: str
    max_chars: Optional[int] = None


class SummarizeBody(BaseModel):
    chunks: List[str]
    model: Optional[str] = None
    num_ctx: Optional[int] = None


class GenerateBody(BaseModel):
    merged: Optional[str] = None
    summaries: Optional[List[str]] = None
    source: Optional[Dict[str, Any]] = None
    model: Optional[str] = None
    num_ctx: Optional[int] = None


class RunBody(BaseModel):
    url: Optional[str] = None
    transcript: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    notes: Optional[str] = None
    frames: Optional[List[str]] = None
    include_comments: bool = True
    include_metadata: bool = True
    model: Optional[str] = None
    num_ctx: Optional[int] = None
    max_chunk_chars: Optional[int] = None
    save: bool = True


class SaveBody(BaseModel):
    video_url: Optional[str] = None
    video_id: Optional[str] = None
    title: Optional[str] = None
    model_used: Optional[str] = None
    chunk_count: Optional[int] = None
    final_output: str
    errors: Optional[str] = None
    emergency: bool = False
    diagnostics: Optional[Dict[str, Any]] = None


# ------------------------------------------------------------------ #
# Shared helpers                                                      #
# ------------------------------------------------------------------ #

async def _fetch_and_build_source(body) -> Dict[str, Any]:
    """Fetch transcript/comments/metadata (when a URL is given) and assemble the
    clean source. Returns ``{source: CleanSource, extras: {...}}``. Never raises
    for fetch failures — they're recorded in extras and the build proceeds with
    whatever content is available.
    """
    extras: Dict[str, Any] = {"transcript_error": None, "metadata_error": None,
                              "comments": [], "thumbnail": "", "segments": []}

    payload: Dict[str, Any] = {
        "url": body.url or "",
        "title": body.title or "",
        "description": body.description or "",
        "notes": body.notes or "",
        "frames": body.frames or [],
        "transcript": body.transcript or "",
    }

    url = (body.url or "").strip()
    if url and yt.is_youtube_url(url):
        video_id = yt.extract_youtube_id(url)
        payload["video_id"] = video_id or ""

        if video_id and getattr(body, "include_metadata", True):
            try:
                md = await yt.fetch_youtube_metadata(video_id)
                if md.get("success"):
                    payload.setdefault("title", "")
                    if not payload["title"]:
                        payload["title"] = md.get("title", "")
                    if not payload["description"]:
                        payload["description"] = md.get("description", "")
                    payload["channel"] = md.get("channel", "")
                    payload["duration"] = md.get("duration")
                    payload["chapters"] = md.get("chapters", [])
                    payload["tags"] = md.get("tags", [])
                    extras["thumbnail"] = md.get("thumbnail", "")
                else:
                    extras["metadata_error"] = md.get("error")
            except Exception as e:
                extras["metadata_error"] = str(e)

        if video_id and not payload["transcript"]:
            try:
                tr = await yt.extract_transcript_async(url, video_id)
                if tr.get("success"):
                    payload["transcript"] = tr.get("transcript", "")
                    payload["segments"] = tr.get("segments", [])
                    extras["segments"] = tr.get("segments", [])
                else:
                    extras["transcript_error"] = tr.get("error")
            except Exception as e:
                extras["transcript_error"] = str(e)

        if video_id and getattr(body, "include_comments", True):
            try:
                cm = await yt.fetch_youtube_comments(video_id)
                if cm.get("success"):
                    payload["comments"] = cm.get("comments", [])
                    extras["comments"] = cm.get("comments", [])
            except Exception as e:
                logger.debug("comment fetch failed: %s", e)

    source = ywb.extract_clean_source(payload)
    return {"source": source, "extras": extras}


def _persist(owner: Optional[str], *, video_url, video_id, title, model_used,
             chunk_count, final_output, errors, emergency, diagnostics) -> Optional[str]:
    db = SessionLocal()
    try:
        row = YtWorkflowPrompt(
            id=_new_id(),
            owner=owner,
            video_url=(video_url or "")[:1000] or None,
            video_id=(video_id or "")[:64] or None,
            title=(title or "")[:500] or None,
            model_used=(model_used or "")[:200] or None,
            chunk_count=chunk_count,
            final_output=final_output or "",
            errors=("\n".join(errors) if isinstance(errors, list) else errors) or None,
            emergency=bool(emergency),
            diagnostics=diagnostics or None,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return row.id
    except Exception as e:
        db.rollback()
        logger.warning("yt-workflow save failed: %s", e)
        return None
    finally:
        db.close()


# ------------------------------------------------------------------ #
# Routes                                                              #
# ------------------------------------------------------------------ #

def setup_yt_workflow_routes() -> APIRouter:
    router = APIRouter(tags=["yt-workflow"])

    DEFAULTS = {"default_model": ywb.DEFAULT_MODEL, "fallback_models": ywb.FALLBACK_MODELS,
                "default_num_ctx": ywb.DEFAULT_NUM_CTX, "default_chunk_chars": ywb.DEFAULT_CHUNK_CHARS}

    # ---- Health / models (Check Ollama + Load Models buttons) ---- #

    @router.get("/api/yt-workflow/health")
    async def health(request: Request, model: Optional[str] = None) -> Dict[str, Any]:
        get_current_user(request)
        selected = (model or ywb.DEFAULT_MODEL).strip()
        h = await ywb.health_check(selected_model=selected)
        resolved, note, tried = ywb.resolve_model(selected, h.get("models", []))
        return {
            **h,
            "selected_model": selected,
            "resolved_model": resolved,
            "resolve_note": note,
            "tried": tried,
            **DEFAULTS,
        }

    # ---- Clean transcript / extract source ----------------------- #

    @router.post("/api/yt-workflow/extract")
    async def extract(request: Request, body: ExtractBody) -> Dict[str, Any]:
        get_current_user(request)
        built = await _fetch_and_build_source(body)
        source = built["source"]
        return {
            **source.to_dict(),
            "extras": built["extras"],
        }

    # ---- Chunk --------------------------------------------------- #

    @router.post("/api/yt-workflow/chunk")
    async def chunk(request: Request, body: ChunkBody) -> Dict[str, Any]:
        get_current_user(request)
        max_chars = _clamp(body.max_chars, ywb.MIN_CHUNK_CHARS, 16000, ywb.DEFAULT_CHUNK_CHARS)
        chunks = ywb.chunk_text(body.text or "", max_chars=max_chars)
        return {
            "chunks": chunks,
            "count": len(chunks),
            "sizes": [len(c) for c in chunks],
            "max_chars": max_chars,
            "token_estimate": ywb.estimate_tokens(body.text or ""),
        }

    # ---- Summarize chunks (SSE) ---------------------------------- #

    @router.post("/api/yt-workflow/summarize")
    async def summarize(request: Request, body: SummarizeBody) -> StreamingResponse:
        get_current_user(request)
        num_ctx = _clamp(body.num_ctx, ywb.MIN_NUM_CTX, 131072, ywb.DEFAULT_NUM_CTX)

        async def producer(emit):
            h = await ywb.health_check(selected_model=body.model or ywb.DEFAULT_MODEL)
            resolved, note, _ = ywb.resolve_model(body.model or ywb.DEFAULT_MODEL, h.get("models", []))
            if not h.get("running"):
                await emit({"type": "error", "message": h.get("error") or "Ollama is not running."})
                return
            if not resolved:
                await emit({"type": "error", "message": note})
                return
            if note:
                await emit({"type": "log", "message": note})
            diag = ywb.GenDiag(selected_model=resolved, final_model=resolved, context_size=num_ctx)
            res = await ywb.summarize_chunks(
                body.chunks or [], model=resolved, available_models=h.get("models", []),
                num_ctx=num_ctx, diag=diag, on_progress=emit,
            )
            await emit({"type": "result", "summaries": res["summaries"], "merged": res["merged"],
                        "diag": _diag_dict(res["diag"])})

        return StreamingResponse(_sse_stream(producer), media_type="text/event-stream")

    # ---- Generate workflow map + final prompt (SSE) -------------- #

    @router.post("/api/yt-workflow/generate")
    async def generate(request: Request, body: GenerateBody) -> StreamingResponse:
        get_current_user(request)
        num_ctx = _clamp(body.num_ctx, ywb.MIN_NUM_CTX, 131072, ywb.DEFAULT_NUM_CTX)
        source = ywb.extract_clean_source(body.source or {})
        merged = body.merged or ywb.merge_summaries(body.summaries or [])

        async def producer(emit):
            h = await ywb.health_check(selected_model=body.model or ywb.DEFAULT_MODEL)
            resolved, note, _ = ywb.resolve_model(body.model or ywb.DEFAULT_MODEL, h.get("models", []))
            if note:
                await emit({"type": "log", "message": note})
            # Even if Ollama is down we still emit a result via emergency template.
            model = resolved or (body.model or ywb.DEFAULT_MODEL)
            diag = ywb.GenDiag(selected_model=model, final_model=model, context_size=num_ctx)
            diag.prompt_size = len(merged)
            if not merged.strip():
                final = ywb.emergency_template(source, diag)
                await emit({"type": "result", "final_output": final, "workflow_map": "",
                            "emergency": True, "diag": _diag_dict(diag),
                            "message": "No summaries to work from — produced an emergency template."})
                return
            res = await ywb.generate_from_summaries(
                merged, source=source, model=model, available_models=h.get("models", []),
                num_ctx=num_ctx, diag=diag, on_progress=emit,
            )
            payload = {"type": "result", "final_output": res["final_output"],
                       "workflow_map": res["workflow_map"], "emergency": res["emergency"],
                       "diag": _diag_dict(res["diag"])}
            if res["diag"].errors:
                payload["message"] = ywb.friendly_failure_message(res["diag"], res["emergency"])
            await emit(payload)

        return StreamingResponse(_sse_stream(producer), media_type="text/event-stream")

    # ---- Run the full n8n-style flow (SSE) ----------------------- #

    @router.post("/api/yt-workflow/run")
    async def run_full(request: Request, body: RunBody) -> StreamingResponse:
        owner = get_current_user(request)
        num_ctx = _clamp(body.num_ctx, ywb.MIN_NUM_CTX, 131072, ywb.DEFAULT_NUM_CTX)
        max_chunk = _clamp(body.max_chunk_chars, ywb.MIN_CHUNK_CHARS, 16000, ywb.DEFAULT_CHUNK_CHARS)

        async def producer(emit):
            # 1) Check Ollama
            await emit({"type": "step", "id": "health", "status": "running"})
            h = await ywb.health_check(selected_model=body.model or ywb.DEFAULT_MODEL)
            resolved, note, _ = ywb.resolve_model(body.model or ywb.DEFAULT_MODEL, h.get("models", []))
            await emit({"type": "step", "id": "health",
                        "status": "done" if h.get("running") else "error",
                        "detail": {"running": h.get("running"), "base": h.get("base"),
                                   "error": h.get("error"), "fit_warning": h.get("fit_warning")}})
            # 2) Load Models
            await emit({"type": "step", "id": "models",
                        "status": "done" if h.get("models") else "error",
                        "detail": {"models": h.get("models", []), "resolved": resolved, "note": note}})
            if h.get("fit_warning"):
                await emit({"type": "log", "level": "warn", "message": h["fit_warning"]})

            # 3) Clean transcript / extract
            await emit({"type": "step", "id": "extract", "status": "running"})
            built = await _fetch_and_build_source(body)
            source = built["source"]
            extras = built["extras"]
            await emit({"type": "output", "key": "source", "value": source.to_dict(), "extras": extras})
            if extras.get("transcript_error"):
                await emit({"type": "log", "level": "warn",
                            "message": f"Transcript: {extras['transcript_error']}"})
            await emit({"type": "step", "id": "extract",
                        "status": "done" if source.source_text else "error",
                        "detail": {"chars": len(source.source_text),
                                   "tokens": ywb.estimate_tokens(source.source_text),
                                   "title": source.meta.get("title")}})

            model = resolved or (body.model or ywb.DEFAULT_MODEL)

            # If Ollama is unreachable, don't hammer it with slow timeouts — go
            # straight to the emergency template so the user still gets output.
            if not h.get("reachable"):
                diag = ywb.GenDiag(selected_model=model, final_model=model, context_size=num_ctx)
                diag.prompt_size = len(source.source_text)
                diag.last_reason = "connect"
                diag.errors.append(h.get("error") or "Ollama unreachable")
                chunks = ywb.chunk_text(source.source_text, max_chars=max_chunk)
                for sid in ("chunk", "summarize", "map"):
                    await emit({"type": "step", "id": sid, "status": "skipped"})
                final = ywb.emergency_template(source, diag)
                await emit({"type": "step", "id": "final", "status": "error",
                            "detail": {"emergency": True}})
                await _finish(emit, owner, body, source, final, [], len(chunks), diag, True)
                return

            # 4–7) chunk → summarize → map → final (run_pipeline emits these steps)
            res = await ywb.run_pipeline(
                source, model=model, available_models=h.get("models", []),
                num_ctx=num_ctx, max_chunk_chars=max_chunk, on_progress=emit,
            )
            await _finish(emit, owner, body, source, res["final_output"], res["summaries"],
                          len(res["chunks"]), res["diag"], res["emergency"])

        async def _finish(emit, owner, body, source, final_output, summaries, chunk_count, diag, emergency):
            saved_id = None
            if body.save:
                await emit({"type": "step", "id": "save", "status": "running"})
                saved_id = _persist(
                    owner,
                    video_url=body.url, video_id=source.meta.get("video_id"),
                    title=source.meta.get("title"), model_used=diag.final_model,
                    chunk_count=chunk_count, final_output=final_output,
                    errors=diag.errors, emergency=emergency,
                    diagnostics={**_diag_dict(diag), "source_meta": source.meta},
                )
                await emit({"type": "step", "id": "save",
                            "status": "done" if saved_id else "error",
                            "detail": {"id": saved_id}})
            message = ywb.friendly_failure_message(diag, emergency) if (diag.errors or emergency) else None
            await emit({
                "type": "done", "saved_id": saved_id, "final_output": final_output,
                "summaries": summaries, "emergency": emergency, "diag": _diag_dict(diag),
                "message": message,
            })

        return StreamingResponse(_sse_stream(producer), media_type="text/event-stream")

    # ---- Save / history / export --------------------------------- #

    @router.post("/api/yt-workflow/save")
    async def save(request: Request, body: SaveBody) -> Dict[str, Any]:
        owner = get_current_user(request)
        saved_id = _persist(
            owner, video_url=body.video_url, video_id=body.video_id, title=body.title,
            model_used=body.model_used, chunk_count=body.chunk_count,
            final_output=body.final_output, errors=body.errors, emergency=body.emergency,
            diagnostics=body.diagnostics,
        )
        if not saved_id:
            raise HTTPException(500, "Could not save prompt")
        return {"id": saved_id, "status": "saved"}

    @router.get("/api/yt-workflow/history")
    async def history(request: Request) -> Dict[str, List[Dict[str, Any]]]:
        owner = get_current_user(request)
        db = SessionLocal()
        try:
            q = db.query(YtWorkflowPrompt)
            if owner is not None:
                q = q.filter(YtWorkflowPrompt.owner == owner)
            rows = q.order_by(YtWorkflowPrompt.created_at.desc()).limit(100).all()
            return {"items": [{
                "id": r.id, "title": r.title, "video_url": r.video_url, "video_id": r.video_id,
                "model_used": r.model_used, "chunk_count": r.chunk_count, "emergency": r.emergency,
                "has_errors": bool(r.errors),
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "preview": (r.final_output or "")[:240],
            } for r in rows]}
        finally:
            db.close()

    @router.get("/api/yt-workflow/prompt/{pid}")
    async def get_prompt(request: Request, pid: str) -> Dict[str, Any]:
        owner = get_current_user(request)
        db = SessionLocal()
        try:
            r = db.query(YtWorkflowPrompt).filter(YtWorkflowPrompt.id == pid).first()
            if not r or (owner is not None and r.owner not in (None, owner)):
                raise HTTPException(404, "Prompt not found")
            return {
                "id": r.id, "title": r.title, "video_url": r.video_url, "video_id": r.video_id,
                "model_used": r.model_used, "chunk_count": r.chunk_count, "emergency": r.emergency,
                "errors": r.errors, "diagnostics": r.diagnostics,
                "final_output": r.final_output,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
        finally:
            db.close()

    @router.delete("/api/yt-workflow/prompt/{pid}")
    async def delete_prompt(request: Request, pid: str) -> Dict[str, str]:
        owner = get_current_user(request)
        db = SessionLocal()
        try:
            r = db.query(YtWorkflowPrompt).filter(YtWorkflowPrompt.id == pid).first()
            if not r or (owner is not None and r.owner not in (None, owner)):
                raise HTTPException(404, "Prompt not found")
            db.delete(r)
            db.commit()
            return {"status": "deleted", "id": pid}
        finally:
            db.close()

    return router
