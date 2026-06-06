"""Automation Map routes — HTTP surface for the visual AI workflow builder.

Persistence: workflow CRUD, debounced autosave with an optimistic revision
guard, export/import, read-only run/file history.
Execution: model discovery, single-node runs, full-graph runs and cancellation
— all delegating to ``src/workflow_executor.py`` (which yields envelope dicts;
this layer wraps them as SSE ``data: …`` frames).

Storage model (see core/database.py): Workflow · WorkflowRun · NodeRun ·
GeneratedFile.
"""

import asyncio
import json
import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from core.database import Workflow, WorkflowRun, NodeRun, GeneratedFile, SessionLocal
from src.auth_helpers import get_current_user
from core.middleware import require_admin
from src import workspaces
from src import workflow_executor as wfe

logger = logging.getLogger(__name__)

# Must match APP_ID in static/js/automation/io.js so exports interop.
APP_ID = "trendvault-automation-map"


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _sse(obj: Dict[str, Any]) -> str:
    return f"data: {json.dumps(obj)}\n\n"


# ------------------------------------------------------------------ #
# Request bodies                                                      #
# ------------------------------------------------------------------ #

class WorkflowCreate(BaseModel):
    name: Optional[str] = None
    doc: Optional[Dict[str, Any]] = None


class WorkflowUpdate(BaseModel):
    name: Optional[str] = None
    doc: Optional[Dict[str, Any]] = None
    rev: Optional[int] = None  # last-seen revision; mismatch -> 409 conflict


class ImportBody(BaseModel):
    # Tolerates the full export envelope {app, version, nodes, edges, spaces}
    # as well as a bare {name, doc}.
    name: Optional[str] = None
    nodes: Optional[List[Any]] = None
    edges: Optional[List[Any]] = None
    spaces: Optional[List[Any]] = None
    doc: Optional[Dict[str, Any]] = None
    app: Optional[str] = None
    version: Optional[int] = None


class RunNodeBody(BaseModel):
    workflow_id: Optional[str] = None
    node: Dict[str, Any]
    inputs: Optional[Dict[str, str]] = None
    model: Optional[str] = None
    endpoint_id: Optional[str] = None


class RunWorkflowBody(BaseModel):
    workflow_id: str
    doc: Optional[Dict[str, Any]] = None   # run the live canvas graph if provided
    run_token: Optional[str] = None        # client token used to cancel


class CancelBody(BaseModel):
    run_token: str


# ------------------------------------------------------------------ #
# Helpers                                                             #
# ------------------------------------------------------------------ #

def _owns(w: Workflow, user: Optional[str]) -> bool:
    if user is None:
        return True
    return (w.owner or None) == user


def _norm_doc(doc: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Coerce a graph doc to the canonical {nodes, edges, spaces} shape."""
    doc = doc or {}
    return {
        "nodes": doc.get("nodes") or [],
        "edges": doc.get("edges") or [],
        "spaces": doc.get("spaces") or [],
    }


def _summary(w: Workflow) -> Dict[str, Any]:
    doc = w.doc or {}
    return {
        "id": w.id,
        "name": w.name or "Untitled board",
        "rev": w.rev or 0,
        "node_count": len(doc.get("nodes") or []),
        "created_at": w.created_at.isoformat() if w.created_at else None,
        "updated_at": w.updated_at.isoformat() if w.updated_at else None,
    }


def _full(w: Workflow) -> Dict[str, Any]:
    return {**_summary(w), "doc": _norm_doc(w.doc), "schema_version": w.schema_version or 1}


def _get_owned(db, wid: str, user: Optional[str]) -> Workflow:
    w = db.query(Workflow).filter(Workflow.id == wid, Workflow.is_active == True).first()  # noqa: E712
    if not w or not _owns(w, user):
        raise HTTPException(404, "Workflow not found")
    return w


# ------------------------------------------------------------------ #
# Routes                                                              #
# ------------------------------------------------------------------ #

def setup_automation_routes() -> APIRouter:
    router = APIRouter(tags=["automation"])

    # ---- Workflow CRUD ------------------------------------------- #

    @router.get("/api/automation/workflows")
    async def list_workflows(request: Request) -> Dict[str, List[Dict[str, Any]]]:
        user = get_current_user(request)
        db = SessionLocal()
        try:
            q = db.query(Workflow).filter(Workflow.is_active == True)  # noqa: E712
            if user is not None:
                q = q.filter(Workflow.owner == user)
            rows = q.order_by(Workflow.updated_at.desc()).limit(500).all()
            return {"workflows": [_summary(w) for w in rows]}
        finally:
            db.close()

    @router.post("/api/automation/workflows")
    async def create_workflow(request: Request, body: WorkflowCreate) -> Dict[str, Any]:
        user = get_current_user(request)
        db = SessionLocal()
        try:
            w = Workflow(
                id=_new_id("board"), owner=user,
                name=(body.name or "Untitled board")[:300],
                doc=_norm_doc(body.doc), schema_version=1, rev=0, is_active=True,
            )
            db.add(w)
            db.commit()
            db.refresh(w)
            return _full(w)
        except Exception as e:
            db.rollback()
            logger.warning("workflow create failed: %s", e)
            raise HTTPException(500, "Could not create workflow")
        finally:
            db.close()

    @router.get("/api/automation/workflows/{wid}")
    async def get_workflow(request: Request, wid: str) -> Dict[str, Any]:
        user = get_current_user(request)
        db = SessionLocal()
        try:
            return _full(_get_owned(db, wid, user))
        finally:
            db.close()

    @router.put("/api/automation/workflows/{wid}")
    async def update_workflow(request: Request, wid: str, body: WorkflowUpdate) -> Dict[str, Any]:
        user = get_current_user(request)
        db = SessionLocal()
        try:
            w = _get_owned(db, wid, user)
            # Optimistic concurrency: reject a write based on a stale revision so
            # a slow autosave can't clobber a newer save. Client refetches on 409.
            if body.rev is not None and body.rev != (w.rev or 0):
                raise HTTPException(status_code=409, detail={"message": "stale revision", "current": _full(w)})
            if body.name is not None and body.name.strip():
                w.name = body.name[:300]
            if body.doc is not None:
                w.doc = _norm_doc(body.doc)
            w.rev = (w.rev or 0) + 1
            db.commit()
            db.refresh(w)
            return {"id": w.id, "rev": w.rev, "updated_at": w.updated_at.isoformat() if w.updated_at else None}
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.warning("workflow update failed: %s", e)
            raise HTTPException(500, "Could not save workflow")
        finally:
            db.close()

    @router.delete("/api/automation/workflows/{wid}")
    async def delete_workflow(request: Request, wid: str) -> Dict[str, str]:
        user = get_current_user(request)
        db = SessionLocal()
        try:
            w = _get_owned(db, wid, user)
            w.is_active = False
            db.commit()
            return {"status": "deleted", "id": wid}
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            raise HTTPException(500, str(e))
        finally:
            db.close()

    # ---- Export / import ----------------------------------------- #

    @router.get("/api/automation/workflows/{wid}/export")
    async def export_workflow(request: Request, wid: str) -> Dict[str, Any]:
        from datetime import datetime, timezone
        user = get_current_user(request)
        db = SessionLocal()
        try:
            w = _get_owned(db, wid, user)
            doc = _norm_doc(w.doc)
            return {
                "app": APP_ID, "version": 1,
                "exportedAt": datetime.now(timezone.utc).isoformat(),
                "name": w.name, "nodes": doc["nodes"], "edges": doc["edges"], "spaces": doc["spaces"],
            }
        finally:
            db.close()

    @router.post("/api/automation/workflows/import")
    async def import_workflow(request: Request, body: ImportBody) -> Dict[str, Any]:
        user = get_current_user(request)
        if body.doc is not None:
            doc = _norm_doc(body.doc)
        else:
            doc = _norm_doc({"nodes": body.nodes, "edges": body.edges, "spaces": body.spaces})
        db = SessionLocal()
        try:
            w = Workflow(
                id=_new_id("board"), owner=user,
                name=(body.name or "Imported workflow")[:300],
                doc=doc, schema_version=1, rev=0, is_active=True,
            )
            db.add(w)
            db.commit()
            db.refresh(w)
            return _full(w)
        except Exception as e:
            db.rollback()
            logger.warning("workflow import failed: %s", e)
            raise HTTPException(500, "Could not import workflow")
        finally:
            db.close()

    # ---- Run history --------------------------------------------- #

    @router.get("/api/automation/workflows/{wid}/runs")
    async def list_runs(request: Request, wid: str) -> Dict[str, List[Dict[str, Any]]]:
        user = get_current_user(request)
        db = SessionLocal()
        try:
            _get_owned(db, wid, user)
            rows = (db.query(WorkflowRun).filter(WorkflowRun.workflow_id == wid)
                    .order_by(WorkflowRun.started_at.desc()).limit(100).all())
            return {"runs": [{
                "id": r.id, "mode": r.mode, "status": r.status, "root_node_id": r.root_node_id,
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "finished_at": r.finished_at.isoformat() if r.finished_at else None,
                "error": r.error,
            } for r in rows]}
        finally:
            db.close()

    @router.get("/api/automation/runs/{run_id}")
    async def get_run(request: Request, run_id: str) -> Dict[str, Any]:
        user = get_current_user(request)
        db = SessionLocal()
        try:
            run = db.query(WorkflowRun).filter(WorkflowRun.id == run_id).first()
            if not run:
                raise HTTPException(404, "Run not found")
            _get_owned(db, run.workflow_id, user)  # ownership via parent workflow
            node_rows = (db.query(NodeRun).filter(NodeRun.run_id == run_id)
                         .order_by(NodeRun.started_at.asc().nullslast()).all())
            return {
                "run": {
                    "id": run.id, "workflow_id": run.workflow_id, "mode": run.mode,
                    "status": run.status, "root_node_id": run.root_node_id,
                    "started_at": run.started_at.isoformat() if run.started_at else None,
                    "finished_at": run.finished_at.isoformat() if run.finished_at else None,
                    "error": run.error,
                },
                "node_runs": [{
                    "id": n.id, "node_id": n.node_id, "kind": n.kind, "status": n.status,
                    "inputs": n.inputs, "output": n.output, "logs": n.logs,
                    "exit_code": n.exit_code, "error": n.error,
                    "started_at": n.started_at.isoformat() if n.started_at else None,
                    "finished_at": n.finished_at.isoformat() if n.finished_at else None,
                } for n in node_rows],
            }
        finally:
            db.close()

    # ---- Workspace files ----------------------------------------- #

    @router.get("/api/automation/workflows/{wid}/files")
    async def list_workflow_files(request: Request, wid: str) -> Dict[str, List[Dict[str, Any]]]:
        user = get_current_user(request)
        db = SessionLocal()
        try:
            _get_owned(db, wid, user)
            on_disk = workspaces.list_files(wid)
            rows = db.query(GeneratedFile).filter(GeneratedFile.workflow_id == wid).all()
            origin = {r.rel_path: r for r in rows}
            files = [{
                "rel_path": f["rel_path"], "size": f["size"],
                "node_id": origin[f["rel_path"]].node_id if f["rel_path"] in origin else None,
                "run_id": origin[f["rel_path"]].run_id if f["rel_path"] in origin else None,
            } for f in on_disk]
            return {"files": files}
        finally:
            db.close()

    @router.get("/api/automation/workflows/{wid}/file")
    async def read_workflow_file(request: Request, wid: str, path: str) -> Dict[str, Any]:
        user = get_current_user(request)
        db = SessionLocal()
        try:
            _get_owned(db, wid, user)
        finally:
            db.close()
        try:
            content = workspaces.read_text(wid, path)
        except (ValueError, FileNotFoundError):
            raise HTTPException(404, "File not found")
        return {"rel_path": path, "content": content}

    # ---- Models + execution -------------------------------------- #

    @router.get("/api/automation/models")
    async def list_models(request: Request) -> Dict[str, Any]:
        return await wfe.list_models(get_current_user(request))

    @router.post("/api/automation/run-node")
    async def run_node(request: Request, body: RunNodeBody) -> StreamingResponse:
        owner = get_current_user(request)
        node = body.node or {}
        nid = node.get("id")
        kind = (node.get("data") or {}).get("kind") or "agent"

        if kind == "agent":
            run_id = wfe.create_run(owner, body.workflow_id, "single", nid)

            async def _stream():
                final = "success"
                try:
                    async for ev in wfe.agent_node_events(owner, node, body.inputs,
                                                          run_id=run_id, model=body.model,
                                                          endpoint_id=body.endpoint_id,
                                                          workflow_id=body.workflow_id):
                        if ev.get("type") == "node_status" and ev.get("status") in ("failed", "cancelled"):
                            final = ev["status"]
                        yield _sse(ev)
                except asyncio.CancelledError:
                    final = "cancelled"
                    raise
                finally:
                    wfe.finish_run(run_id, final)
                yield "data: [DONE]\n\n"

            return StreamingResponse(_stream(), media_type="text/event-stream")

        if kind in wfe.EXEC_NODE_RUNNERS:
            require_admin(request)  # code execution is admin-gated
            if not body.workflow_id:
                raise HTTPException(400, "workflow_id is required to run code nodes")
            run_id = wfe.create_run(owner, body.workflow_id, "single", nid)
            ctx = wfe.ExecContext(body.workflow_id, owner)

            async def _exec_stream():
                final = "success"
                try:
                    async for ev in wfe.EXEC_NODE_RUNNERS[kind](node, body.inputs, run_id, ctx):
                        if ev.get("type") == "node_status" and ev.get("status") in ("failed", "cancelled"):
                            final = ev["status"]
                        yield _sse(ev)
                except asyncio.CancelledError:
                    final = "cancelled"
                    raise
                finally:
                    wfe.finish_run(run_id, final)
                yield "data: [DONE]\n\n"

            return StreamingResponse(_exec_stream(), media_type="text/event-stream")

        # Everything else is a "design" node (feature, api, database, test, …):
        # pass its description downstream as output. Real, persisted, no runtime.
        run_id = wfe.create_run(owner, body.workflow_id, "single", nid)

        async def _design_stream():
            final = "success"
            try:
                async for ev in wfe.design_node_events(node, body.inputs, run_id):
                    if ev.get("type") == "node_status" and ev.get("status") in ("failed", "cancelled"):
                        final = ev["status"]
                    yield _sse(ev)
            except asyncio.CancelledError:
                final = "cancelled"
                raise
            finally:
                wfe.finish_run(run_id, final)
            yield "data: [DONE]\n\n"

        return StreamingResponse(_design_stream(), media_type="text/event-stream")

    @router.post("/api/automation/run-workflow")
    async def run_workflow(request: Request, body: RunWorkflowBody) -> StreamingResponse:
        owner = get_current_user(request)
        # Run the live canvas graph if the client sent it; else the saved doc.
        if body.doc is not None:
            db = SessionLocal()
            try:
                _get_owned(db, body.workflow_id, owner)  # ownership check
            finally:
                db.close()
            doc = _norm_doc(body.doc)
        else:
            db = SessionLocal()
            try:
                doc = _norm_doc(_get_owned(db, body.workflow_id, owner).doc)
            finally:
                db.close()

        # Code execution anywhere in the graph is admin-gated.
        if any((n.get("data") or {}).get("kind") in wfe.EXEC_NODE_RUNNERS for n in doc.get("nodes", [])):
            require_admin(request)

        token = body.run_token or _new_id("rt")
        cancel_event = wfe.register_cancel(token)
        executor = wfe.WorkflowExecutor(doc, owner, body.workflow_id, cancel_event)

        async def _stream():
            yield _sse({"type": "run_token", "token": token})
            try:
                async for ev in executor.stream():
                    yield _sse(ev)
            except asyncio.CancelledError:
                cancel_event.set()
                raise
            finally:
                wfe.clear_cancel(token)
            yield "data: [DONE]\n\n"

        return StreamingResponse(_stream(), media_type="text/event-stream")

    @router.post("/api/automation/cancel")
    async def cancel_run(request: Request, body: CancelBody) -> Dict[str, bool]:
        get_current_user(request)
        return {"cancelled": wfe.signal_cancel(body.run_token)}

    return router
