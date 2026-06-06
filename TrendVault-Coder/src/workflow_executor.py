"""Automation Map — workflow execution engine.

Central home for *running* a workflow graph: model/endpoint resolution, the
streaming Agent node runner, an Executor abstraction for code execution
(subprocess now, Docker later), topological ordering with cycle detection, and
the WorkflowExecutor that walks the graph passing each node's output to its
downstream neighbours.

Everything here yields **envelope dicts** (not SSE strings); the route layer
(routes/automation_routes.py) wraps them with `data: …\\n\\n` for the client.

Envelope event types:
  workflow_status {status, run_id, error?}
  node_status     {node_id, status, error?, run_id?, model?, output?}
  reasoning       {node_id, delta}      — hidden chain-of-thought (R1)
  output          {node_id, delta}      — visible answer text
  log             {node_id, stream, data}
  progress        {node_id, elapsed_s, tail}
  usage           {node_id, data}
  file            {node_id, rel_path}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import sys
import time
import uuid
from abc import ABC, abstractmethod
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx

from core.database import (
    WorkflowRun, NodeRun, ModelEndpoint, SessionLocal, utcnow_naive,
)
from src.auth_helpers import owner_filter
from src.endpoint_resolver import (
    normalize_base, build_chat_url, build_models_url,
    resolve_endpoint, resolve_endpoint_by_id, _endpoint_enabled_models,
)
from src.llm_core import stream_llm, _detect_provider
from src import workspaces

logger = logging.getLogger(__name__)

_MAX_PERSIST_CHARS = 200_000
# Models advertise huge context windows (131072); allocating that KV cache
# OOM-crashes the llama runner on modest/CPU hosts. Cap agent runs here; a node
# can raise it via its `contextWindow` field.
_DEFAULT_NUM_CTX = int(os.getenv("AUTOMATION_OLLAMA_NUM_CTX", "8192") or 8192)

# Node kinds that produce executable behaviour. Everything else is "design"
# (pass-through: its description becomes its output for downstream context).
DESIGN_KINDS = {
    "feature", "file", "folder", "api", "database", "github", "bug", "test",
    "deployment", "documentation", "env",
}


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _cap(text: Optional[str]) -> Optional[str]:
    if text is None:
        return None
    return text if len(text) <= _MAX_PERSIST_CHARS else text[-_MAX_PERSIST_CHARS:]


# ------------------------------------------------------------------ #
# Model discovery + endpoint resolution                              #
# ------------------------------------------------------------------ #

def _ollama_base() -> str:
    """Native Ollama API root (…/api) so endpoint_resolver/_detect_provider treat
    it as 'ollama' (giving /api/tags + /api/chat, and split reasoning for R1)."""
    raw = os.getenv("OLLAMA_BASE_URL") or os.getenv("OLLAMA_URL") or "http://localhost:11434"
    p = urlparse(raw if "://" in raw else "http://" + raw)
    return f"{p.scheme or 'http'}://{p.hostname or 'localhost'}:{p.port or 11434}/api"


def _pick_default(ids: List[str]) -> Optional[str]:
    for m in ids:
        if re.search(r"deepseek-?r1", m, re.I):
            return m
    return ids[0] if ids else None


async def _ollama_tags(base: str) -> List[Dict[str, Any]]:
    """Installed Ollama models as [{name, size}] via /api/tags (size in bytes)."""
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get(build_models_url(base))
            if r.status_code == 200:
                return [{"name": m.get("name"), "size": m.get("size") or 0}
                        for m in (r.json().get("models") or []) if m.get("name")]
    except Exception as e:
        logger.debug("ollama tags probe failed: %s", e)
    return []


async def probe_ollama_models(base: str) -> List[str]:
    return [t["name"] for t in await _ollama_tags(base)]


async def _ollama_model_size_gb(base: str, model: str) -> float:
    """Approx on-disk size (GB) of an installed Ollama model, or 0 if unknown."""
    for t in await _ollama_tags(base):
        if t["name"] == model:
            return (t["size"] or 0) / (1024 ** 3)
    return 0.0


# ------------------------------------------------------------------ #
# Local-model capability preflight (defer when RAM can't fit it)     #
# ------------------------------------------------------------------ #

def available_ram_gb() -> float:
    """Best-effort *available* (not total) RAM in GB, cross-platform.
    0.0 means we couldn't measure (callers then fail open)."""
    try:
        import psutil  # type: ignore
        return psutil.virtual_memory().available / (1024 ** 3)
    except Exception:
        pass
    if os.name == "nt":
        try:
            import ctypes

            class _MEMSTAT(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]
            m = _MEMSTAT()
            m.dwLength = ctypes.sizeof(_MEMSTAT)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
                return m.ullAvailPhys / (1024 ** 3)
        except Exception:
            pass
    try:
        return (os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")) / (1024 ** 3)
    except Exception:
        return 0.0


def total_ram_gb() -> float:
    try:
        import psutil  # type: ignore
        return psutil.virtual_memory().total / (1024 ** 3)
    except Exception:
        pass
    if os.name == "nt":
        try:
            import ctypes

            class _MEMSTAT(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]
            m = _MEMSTAT()
            m.dwLength = ctypes.sizeof(_MEMSTAT)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
                return m.ullTotalPhys / (1024 ** 3)
        except Exception:
            pass
    try:
        return (os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")) / (1024 ** 3)
    except Exception:
        return 0.0


async def preflight_local_model(chat_url: str, model: str, num_ctx: int) -> Dict[str, Any]:
    """Decide whether a *local* Ollama model can plausibly load given free RAM.

    Returns {ok, reason?, num_ctx} — num_ctx may be reduced to fit the KV cache.
    Only enforced for local Ollama; fails open if RAM/size can't be measured."""
    if _detect_provider(chat_url) != "ollama":
        return {"ok": True, "num_ctx": num_ctx}
    avail = available_ram_gb()
    size_gb = await _ollama_model_size_gb(_ollama_base(), model)
    if avail <= 0 or size_gb <= 0:
        return {"ok": True, "num_ctx": num_ctx}  # can't measure → don't block
    overhead = 0.8
    if avail < size_gb + overhead:
        return {"ok": False, "num_ctx": num_ctx, "reason": (
            f"Not enough free memory to run '{model}' locally: it needs about "
            f"{size_gb + overhead:.1f} GB (model ~{size_gb:.1f} GB) but only ~{avail:.1f} GB is free "
            f"(of {total_ram_gb():.0f} GB, CPU-only). Close some apps, pick a smaller model "
            f"(e.g. llama3.2:1b, qwen3:1.7b), or point this agent at a remote endpoint."
        )}
    # Fits the weights — shrink the context window so the KV cache fits too.
    headroom = avail - size_gb - overhead
    max_ctx = int((headroom / 1.5) * 8192)
    fit_ctx = max(1024, min(num_ctx, max_ctx if max_ctx > 0 else 1024))
    return {"ok": True, "num_ctx": fit_ctx, "downgraded": fit_ctx < num_ctx, "available_gb": round(avail, 1)}


async def list_models(owner: Optional[str]) -> Dict[str, Any]:
    out: List[Dict[str, Any]] = []
    seen = set()
    db = SessionLocal()
    try:
        q = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)  # noqa: E712
        eps = (owner_filter(q, ModelEndpoint, owner) if owner else q).all()
        for ep in eps:
            base = normalize_base(ep.base_url)
            chat_url = build_chat_url(base)
            for m in _endpoint_enabled_models(ep):
                if m in seen:
                    continue
                seen.add(m)
                out.append({"id": m, "endpointId": ep.id, "endpointUrl": chat_url,
                            "endpointName": ep.name, "label": f"{m}  ·  {ep.name}", "offline": False})
    except Exception as e:
        logger.debug("endpoint model list failed: %s", e)
    finally:
        db.close()

    avail = available_ram_gb()
    base = _ollama_base()
    ollama_chat = build_chat_url(base)
    for t in await _ollama_tags(base):
        m = t["name"]
        if m in seen:
            continue
        seen.add(m)
        size_gb = (t["size"] or 0) / (1024 ** 3)
        fits = avail <= 0 or size_gb <= 0 or avail >= size_gb + 0.8
        out.append({"id": m, "endpointId": "", "endpointUrl": ollama_chat,
                    "endpointName": "Ollama (local)",
                    "label": f"{m}  ·  Ollama (local)" + ("" if fits else "  ·  ⚠ low memory"),
                    "offline": False, "size_gb": round(size_gb, 1), "fits": fits, "local": True})

    default_id = _pick_default([m["id"] for m in out])
    capability = {
        "available_ram_gb": round(avail, 1) if avail > 0 else None,
        "total_ram_gb": round(total_ram_gb(), 1) or None,
        "low_memory": bool(avail > 0 and avail < 6.0),
    }
    return {"models": out, "default": next((m for m in out if m["id"] == default_id), None), "capability": capability}


async def resolve_target(owner: Optional[str], endpoint_id: str, model: str) -> Tuple[str, str, Dict[str, str]]:
    """(chat_url, model, headers). Priority: node endpoint → user default → local Ollama."""
    model = (model or "").strip()
    endpoint_id = (endpoint_id or "").strip()
    if endpoint_id:
        r = resolve_endpoint_by_id(endpoint_id, model, owner=owner)
        if r:
            return r[0], (model or r[1]), (r[2] or {})
    url, m, headers = resolve_endpoint("default", owner=owner)
    if url:
        return url, (model or m or ""), (headers or {})
    base = _ollama_base()
    if not model:
        model = _pick_default(await probe_ollama_models(base)) or "deepseek-r1:8b"
    return build_chat_url(base), model, {}


# ------------------------------------------------------------------ #
# Run persistence (best-effort)                                      #
# ------------------------------------------------------------------ #

def create_run(owner, workflow_id, mode, root_node_id=None) -> Optional[str]:
    db = SessionLocal()
    try:
        run = WorkflowRun(id=_new_id("run"), workflow_id=workflow_id or "", owner=owner,
                          mode=mode, root_node_id=root_node_id, status="running")
        db.add(run)
        db.commit()
        return run.id
    except Exception as e:
        db.rollback()
        logger.debug("create_run failed (continuing without persistence): %s", e)
        return None
    finally:
        db.close()


def create_node_run(run_id, node_id, kind) -> Optional[str]:
    if not run_id:
        return None
    db = SessionLocal()
    try:
        nr = NodeRun(id=_new_id("nr"), run_id=run_id, node_id=node_id or "", kind=kind,
                     status="running", started_at=utcnow_naive())
        db.add(nr)
        db.commit()
        return nr.id
    except Exception as e:
        db.rollback()
        logger.debug("create_node_run failed: %s", e)
        return None
    finally:
        db.close()


def finish_node_run(node_run_id, status, output=None, logs=None, error=None, exit_code=None, inputs=None):
    if not node_run_id:
        return
    db = SessionLocal()
    try:
        nr = db.query(NodeRun).filter(NodeRun.id == node_run_id).first()
        if nr:
            nr.status = status
            nr.output = _cap(output)
            nr.logs = _cap(logs)
            nr.error = _cap(error)
            nr.exit_code = exit_code
            if inputs is not None:
                nr.inputs = inputs
            nr.finished_at = utcnow_naive()
            db.commit()
    except Exception as e:
        db.rollback()
        logger.debug("finish_node_run failed: %s", e)
    finally:
        db.close()


def finish_run(run_id, status, error=None):
    if not run_id:
        return
    db = SessionLocal()
    try:
        run = db.query(WorkflowRun).filter(WorkflowRun.id == run_id).first()
        if run:
            run.status = status
            run.error = _cap(error)
            run.finished_at = utcnow_naive()
            db.commit()
    except Exception as e:
        db.rollback()
        logger.debug("finish_run failed: %s", e)
    finally:
        db.close()


# ------------------------------------------------------------------ #
# Agent node runner (streaming reasoning + output)                   #
# ------------------------------------------------------------------ #

def _build_agent_messages(data: Dict[str, Any], inputs: Dict[str, str]) -> List[Dict[str, str]]:
    msgs: List[Dict[str, str]] = []
    system = (data.get("systemPrompt") or "").strip()
    if system:
        msgs.append({"role": "system", "content": system})
    parts: List[str] = []
    context = (data.get("contextPrompt") or "").strip()
    if context:
        parts.append(context)
    if inputs:
        joined = "\n\n".join(f"### Output of `{k}`\n{v}" for k, v in inputs.items() if (v or "").strip())
        if joined:
            parts.append("## Context from upstream nodes\n" + joined)
    task = (data.get("taskPrompt") or "").strip() or (data.get("prompt") or "").strip()
    body = ("\n\n".join(parts + ([task] if task else []))).strip() or "Proceed with the task."
    if data.get("outputMode") == "files":
        body += (
            "\n\n---\nProduce the deliverable as a set of project files. For EACH "
            "file, output a fenced code block whose info line includes its path, e.g.:\n"
            "```python path=app/main.py\n<file contents>\n```\n"
            "Use a separate block per file and include every file needed."
        )
    msgs.append({"role": "user", "content": body})
    return msgs


def _parse_llm_chunk(chunk: str) -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []
    is_error = False
    for line in chunk.split("\n"):
        line = line.strip()
        if not line:
            continue
        if line.startswith("event:"):
            is_error = line.split(":", 1)[1].strip() == "error"
            continue
        if not line.startswith("data:"):
            continue
        raw = line.split(":", 1)[1].strip()
        if raw == "[DONE]":
            events.append({"done": True})
            continue
        try:
            j = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if is_error or "error" in j or ("status" in j and "text" in j):
            events.append({"error": j.get("error") or j.get("text") or f"LLM error {j.get('status', '')}".strip()})
        elif j.get("type") == "usage":
            events.append({"usage": j.get("data")})
        elif j.get("type") == "tool_calls":
            continue
        elif j.get("thinking"):
            events.append({"thinking": True, "delta": j.get("delta", "")})
        elif "delta" in j:
            events.append({"delta": j.get("delta", "")})
    return events


_FENCE_RE = re.compile(r"```([^\n]*)\n(.*?)```", re.DOTALL)


def _extract_path(info: str) -> Optional[str]:
    """Pull a file path out of a fence info line: `python path=app/main.py`,
    `js app/x.js`, or a bare `app/main.py`."""
    info = (info or "").strip()
    if not info:
        return None
    m = re.search(r"(?:path|file|name)\s*=\s*([^\s]+)", info, re.I)
    if m:
        return m.group(1).strip().strip("\"'")
    for tok in info.split():
        if "/" in tok or re.search(r"\.\w{1,6}$", tok):
            return tok.strip().strip("\"'")
    return None


def parse_code_files(text: str) -> List[Dict[str, str]]:
    """Extract {path, content} for every fenced block that names a file path."""
    out: List[Dict[str, str]] = []
    for m in _FENCE_RE.finditer(text or ""):
        path = _extract_path(m.group(1))
        if path:
            out.append({"path": path, "content": m.group(2)})
    return out


async def agent_node_events(owner, node, inputs, run_id=None, model=None, endpoint_id=None, workflow_id=None) -> AsyncGenerator[Dict[str, Any], None]:
    """Stream an Agent node as envelope dicts; persists a NodeRun under run_id.
    In `outputMode == 'files'` (prompt-to-code), parses the answer into files and
    writes them into the workflow's workspace."""
    data = (node or {}).get("data") or {}
    nid = (node or {}).get("id")
    chat_url, resolved_model, headers = await resolve_target(
        owner, endpoint_id or data.get("endpointId"), model or data.get("model"))
    messages = _build_agent_messages(data, inputs or {})
    try:
        temperature = float(data.get("temperature", 0.7))
    except (TypeError, ValueError):
        temperature = 0.7
    try:
        ctx_window = int(data.get("contextWindow") or 0)
    except (TypeError, ValueError):
        ctx_window = 0
    num_ctx = ctx_window if ctx_window > 0 else _DEFAULT_NUM_CTX

    # Capability preflight: if this is a local Ollama model the host can't fit
    # in free RAM, defer with guidance instead of triggering an OOM crash.
    pf = await preflight_local_model(chat_url, resolved_model, num_ctx)
    node_run_id = create_node_run(run_id, nid, "agent")
    if not pf["ok"]:
        finish_node_run(node_run_id, "failed", "", "", pf["reason"], inputs=inputs)
        yield {"type": "node_status", "node_id": nid, "status": "failed", "error": pf["reason"]}
        return
    num_ctx = pf["num_ctx"]
    yield {"type": "node_status", "node_id": nid, "status": "running", "run_id": run_id, "model": resolved_model}
    if pf.get("downgraded"):
        yield {"type": "log", "node_id": nid, "stream": "stdout",
               "data": f"[low memory: context reduced to {num_ctx} tokens to fit ~{pf.get('available_gb')} GB free]\n"}

    out_parts: List[str] = []
    reason_parts: List[str] = []
    error: Optional[str] = None
    try:
        async for chunk in stream_llm(chat_url, resolved_model, messages,
                                      temperature=temperature, headers=headers or None, num_ctx=num_ctx):
            for ev in _parse_llm_chunk(chunk):
                if ev.get("done"):
                    continue
                if ev.get("error"):
                    error = ev["error"]
                elif ev.get("thinking"):
                    reason_parts.append(ev["delta"])
                    yield {"type": "reasoning", "node_id": nid, "delta": ev["delta"]}
                elif "delta" in ev:
                    out_parts.append(ev["delta"])
                    yield {"type": "output", "node_id": nid, "delta": ev["delta"]}
                elif ev.get("usage"):
                    yield {"type": "usage", "node_id": nid, "data": ev["usage"]}
    except asyncio.CancelledError:
        finish_node_run(node_run_id, "cancelled", "".join(out_parts), "".join(reason_parts), "cancelled", inputs=inputs)
        raise
    except Exception as e:
        logger.warning("agent node run failed: %s", e)
        error = str(e)

    output = "".join(out_parts)
    status = "failed" if error else "success"
    files_written: List[str] = []
    if not error and data.get("outputMode") == "files" and workflow_id:
        for f in parse_code_files(output):
            try:
                size = workspaces.write_text(workflow_id, f["path"], f["content"])
                record_generated_file(workflow_id, run_id, nid, f["path"], size, owner)
                files_written.append(f["path"])
                yield {"type": "file", "node_id": nid, "rel_path": f["path"]}
            except Exception as e:
                logger.debug("write generated file failed (%s): %s", f.get("path"), e)
    finish_node_run(node_run_id, status, output, "".join(reason_parts), error, inputs=inputs)
    if error:
        yield {"type": "node_status", "node_id": nid, "status": "failed", "error": error}
    else:
        yield {"type": "node_status", "node_id": nid, "status": "success", "output": output, "files": files_written}


# ------------------------------------------------------------------ #
# Executor abstraction (subprocess now; Docker later)                #
# ------------------------------------------------------------------ #

DEFAULT_EXEC_TIMEOUT = int(os.getenv("AUTOMATION_EXEC_TIMEOUT", "120") or 120)


class ExecContext:
    """Per-run execution context: the workflow's isolated workspace dir + a
    cancellation Event the executor polls between/within node runs."""

    def __init__(self, workflow_id: str, owner: Optional[str], cancel_event: Optional[asyncio.Event] = None):
        self.workflow_id = workflow_id
        self.owner = owner
        self.cancel_event = cancel_event or asyncio.Event()
        self.workspace_dir = workspaces.workspace_dir(workflow_id)


async def _stream_subprocess(argv, cwd, cancel_event, timeout, env=None) -> AsyncGenerator[Dict[str, Any], None]:
    """Run argv in cwd, streaming stdout/stderr line-by-line as
    {type:'log', stream, data} events, then {type:'exit', code}. Honors
    cancellation (kills the process) and a wall-clock timeout."""
    full_env = {**os.environ, **(env or {})}
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=cwd, env=full_env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as e:
        yield {"type": "error", "error": f"Runtime not found: {argv[0]} ({e}). Is it installed and on PATH?"}
        yield {"type": "exit", "code": 127}
        return
    except Exception as e:
        yield {"type": "error", "error": f"Could not start process: {e}"}
        yield {"type": "exit", "code": 1}
        return

    queue: asyncio.Queue = asyncio.Queue()

    async def _reader(stream, tag):
        try:
            while True:
                line = await stream.readline()
                if not line:
                    break
                await queue.put((tag, line.decode("utf-8", errors="replace")))
        finally:
            await queue.put((tag, None))

    readers = [
        asyncio.create_task(_reader(proc.stdout, "stdout")),
        asyncio.create_task(_reader(proc.stderr, "stderr")),
    ]
    start = time.monotonic()
    done = 0
    killed_reason = None
    while done < 2:
        try:
            tag, data = await asyncio.wait_for(queue.get(), timeout=0.4)
        except asyncio.TimeoutError:
            if cancel_event and cancel_event.is_set():
                killed_reason = "cancelled"
                break
            if time.monotonic() - start > timeout:
                killed_reason = f"timed out after {timeout}s"
                break
            continue
        if data is None:
            done += 1
            continue
        yield {"type": "log", "stream": tag, "data": data}

    if killed_reason:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        for t in readers:
            t.cancel()
        yield {"type": "error", "error": killed_reason}
        yield {"type": "exit", "code": -1}
        return

    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
    for t in readers:
        if not t.done():
            t.cancel()
    yield {"type": "exit", "code": proc.returncode if proc.returncode is not None else -1}


class Executor(ABC):
    """Swappable code-execution backend. SubprocessExecutor runs locally in the
    workflow's workspace; DockerExecutor (future) will run the same argv inside
    an isolated container with the workspace bind-mounted."""

    @abstractmethod
    def run(self, argv: List[str], ctx: ExecContext, env=None,
            timeout: int = DEFAULT_EXEC_TIMEOUT) -> AsyncGenerator[Dict[str, Any], None]:
        ...


class SubprocessExecutor(Executor):
    async def run(self, argv, ctx, env=None, timeout=DEFAULT_EXEC_TIMEOUT):
        async for ev in _stream_subprocess(argv, ctx.workspace_dir, ctx.cancel_event, timeout, env):
            yield ev


class DockerExecutor(Executor):
    """Placeholder for container-isolated execution (future upgrade path)."""

    async def run(self, argv, ctx, env=None, timeout=DEFAULT_EXEC_TIMEOUT):
        raise NotImplementedError("DockerExecutor not implemented yet")
        if False:  # pragma: no cover - marks this as an async generator
            yield {}


# Active executor (swap to DockerExecutor later without touching node runners).
default_executor: Executor = SubprocessExecutor()


# ------------------------------------------------------------------ #
# Code-execution node runners (terminal / function / file)           #
# ------------------------------------------------------------------ #

_LANG_EXT = {"python": "py", "javascript": "js", "typescript": "ts"}


def _shell_argv(command: str) -> List[str]:
    if os.name == "nt":
        return ["cmd", "/c", command]
    return ["/bin/sh", "-c", command]


async def terminal_node_events(node, inputs, run_id, ctx) -> AsyncGenerator[Dict[str, Any], None]:
    nid = (node or {}).get("id")
    data = (node or {}).get("data") or {}
    command = (data.get("command") or "").strip()
    node_run_id = create_node_run(run_id, nid, "terminal")
    yield {"type": "node_status", "node_id": nid, "status": "running"}
    if not command:
        finish_node_run(node_run_id, "failed", "", "", "Terminal node has no command.", inputs=inputs)
        yield {"type": "node_status", "node_id": nid, "status": "failed", "error": "Terminal node has no command."}
        return
    logs: List[str] = []
    code = None
    err = None
    async for ev in default_executor.run(_shell_argv(command), ctx, env=_inputs_env(inputs)):
        if ev["type"] == "log":
            logs.append(ev["data"])
            yield {"type": "log", "node_id": nid, "stream": ev["stream"], "data": ev["data"]}
        elif ev["type"] == "error":
            err = ev["error"]
        elif ev["type"] == "exit":
            code = ev["code"]
    out = "".join(logs)
    status = "cancelled" if err == "cancelled" else ("success" if code == 0 and not err else "failed")
    finish_node_run(node_run_id, status, out, out, err, exit_code=code, inputs=inputs)
    yield {"type": "node_status", "node_id": nid, "status": status, "output": out, "exit_code": code,
           **({"error": err} if err and status != "cancelled" else {})}


async def function_node_events(node, inputs, run_id, ctx) -> AsyncGenerator[Dict[str, Any], None]:
    nid = (node or {}).get("id")
    data = (node or {}).get("data") or {}
    code_src = data.get("code") or ""
    lang = (data.get("language") or "python").lower()
    node_run_id = create_node_run(run_id, nid, "function")
    yield {"type": "node_status", "node_id": nid, "status": "running"}
    if not code_src.strip():
        finish_node_run(node_run_id, "failed", "", "", "Function node has no code.", inputs=inputs)
        yield {"type": "node_status", "node_id": nid, "status": "failed", "error": "Function node has no code."}
        return

    ext = _LANG_EXT.get(lang, "py")
    rel = f".run/{nid}.{ext}"
    try:
        workspaces.write_text(ctx.workflow_id, rel, code_src)
    except Exception as e:
        finish_node_run(node_run_id, "failed", "", "", str(e), inputs=inputs)
        yield {"type": "node_status", "node_id": nid, "status": "failed", "error": str(e)}
        return
    script = workspaces.resolve(ctx.workflow_id, rel)

    if lang == "python":
        argv = [sys.executable or "python", script]
    elif lang == "javascript":
        node_bin = shutil.which("node")
        if not node_bin:
            finish_node_run(node_run_id, "failed", "", "", "Node.js not found on PATH.", inputs=inputs)
            yield {"type": "node_status", "node_id": nid, "status": "failed", "error": "Node.js runtime not found on PATH."}
            return
        argv = [node_bin, script]
    elif lang == "typescript":
        runner = shutil.which("ts-node") or shutil.which("tsx")
        if not runner:
            finish_node_run(node_run_id, "failed", "", "", "ts-node/tsx not found on PATH.", inputs=inputs)
            yield {"type": "node_status", "node_id": nid, "status": "failed", "error": "TypeScript runner (ts-node/tsx) not found on PATH."}
            return
        argv = [runner, script]
    else:
        finish_node_run(node_run_id, "failed", "", "", f"Unsupported language: {lang}", inputs=inputs)
        yield {"type": "node_status", "node_id": nid, "status": "failed", "error": f"Unsupported language: {lang}"}
        return

    logs: List[str] = []
    code = None
    err = None
    async for ev in default_executor.run(argv, ctx, env=_inputs_env(inputs)):
        if ev["type"] == "log":
            logs.append(ev["data"])
            yield {"type": "log", "node_id": nid, "stream": ev["stream"], "data": ev["data"]}
        elif ev["type"] == "error":
            err = ev["error"]
        elif ev["type"] == "exit":
            code = ev["code"]
    out = "".join(logs)
    status = "cancelled" if err == "cancelled" else ("success" if code == 0 and not err else "failed")
    finish_node_run(node_run_id, status, out, out, err, exit_code=code, inputs=inputs)
    yield {"type": "node_status", "node_id": nid, "status": status, "output": out, "exit_code": code,
           **({"error": err} if err and status != "cancelled" else {})}


async def file_node_events(node, inputs, run_id, ctx) -> AsyncGenerator[Dict[str, Any], None]:
    nid = (node or {}).get("id")
    data = (node or {}).get("data") or {}
    rel = (data.get("path") or data.get("title") or "").strip()
    content = data.get("code") or ""
    node_run_id = create_node_run(run_id, nid, "file")
    yield {"type": "node_status", "node_id": nid, "status": "running"}
    if not rel:
        finish_node_run(node_run_id, "failed", "", "", "File node has no path.", inputs=inputs)
        yield {"type": "node_status", "node_id": nid, "status": "failed", "error": "File node has no path (set the Path field)."}
        return
    try:
        size = workspaces.write_text(ctx.workflow_id, rel, content)
    except Exception as e:
        finish_node_run(node_run_id, "failed", "", "", str(e), inputs=inputs)
        yield {"type": "node_status", "node_id": nid, "status": "failed", "error": str(e)}
        return
    record_generated_file(ctx.workflow_id, run_id, nid, rel, size, ctx.owner)
    msg = f"Wrote {rel} ({size} bytes)"
    finish_node_run(node_run_id, "success", content, msg, None, inputs=inputs)
    yield {"type": "log", "node_id": nid, "stream": "stdout", "data": msg + "\n"}
    yield {"type": "file", "node_id": nid, "rel_path": rel}
    yield {"type": "node_status", "node_id": nid, "status": "success", "output": content}


async def design_node_events(node, inputs, run_id) -> AsyncGenerator[Dict[str, Any], None]:
    """Run a non-executable "design" node (feature, api, database, test, …).

    These have no runtime behaviour, so — exactly like the full-graph executor —
    the node simply passes its description (or title) downstream as its output.
    Persisted as a NodeRun so manual runs of any node kind show up in history.
    """
    nid = (node or {}).get("id")
    data = (node or {}).get("data") or {}
    kind = data.get("kind") or "feature"
    node_run_id = create_node_run(run_id, nid, kind)
    yield {"type": "node_status", "node_id": nid, "status": "running"}
    out = ((data.get("description") or "").strip() or (data.get("title") or "").strip())
    msg = f"'{kind}' is a design node — it passed its description downstream as output.\n"
    finish_node_run(node_run_id, "success", out, msg, None, inputs=inputs)
    yield {"type": "log", "node_id": nid, "stream": "stdout", "data": msg}
    yield {"type": "node_status", "node_id": nid, "status": "success", "output": out}


def _inputs_env(inputs: Optional[Dict[str, str]]) -> Dict[str, str]:
    """Expose upstream outputs to executed code via an env var."""
    try:
        return {"AUTOMATION_INPUTS": json.dumps(inputs or {})}
    except Exception:
        return {}


def record_generated_file(workflow_id, run_id, node_id, rel_path, size, owner):
    from core.database import GeneratedFile
    db = SessionLocal()
    try:
        existing = db.query(GeneratedFile).filter(
            GeneratedFile.workflow_id == workflow_id, GeneratedFile.rel_path == rel_path).first()
        if existing:
            existing.size = size
            existing.run_id = run_id
            existing.node_id = node_id
        else:
            db.add(GeneratedFile(id=_new_id("gf"), workflow_id=workflow_id, run_id=run_id,
                                 node_id=node_id, rel_path=rel_path, size=size, owner=owner))
        db.commit()
    except Exception as e:
        db.rollback()
        logger.debug("record_generated_file failed: %s", e)
    finally:
        db.close()


# Dispatch table: node kind -> events generator(node, inputs, run_id, ctx).
EXEC_NODE_RUNNERS = {
    "terminal": terminal_node_events,
    "function": function_node_events,
    "file": file_node_events,
}


# ------------------------------------------------------------------ #
# Graph ordering                                                     #
# ------------------------------------------------------------------ #

def topo_order(nodes: List[Dict], edges: List[Dict]) -> Dict[str, Any]:
    """Kahn topological sort. Returns {order:[ids], cycle:bool, cycle_nodes:[ids]}.

    cycle_nodes lists the ids that never reached in-degree 0 (i.e. are part of,
    or downstream of, a cycle) so the UI can point at the offending nodes.
    """
    ids = [n["id"] for n in nodes if n.get("id")]
    idset = set(ids)
    indeg = {i: 0 for i in ids}
    adj: Dict[str, List[str]] = {i: [] for i in ids}
    for e in edges:
        s, t = e.get("source"), e.get("target")
        if s in idset and t in idset:
            adj[s].append(t)
            indeg[t] += 1
    queue = [i for i in ids if indeg[i] == 0]
    order: List[str] = []
    while queue:
        cur = queue.pop(0)
        order.append(cur)
        for nxt in adj[cur]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                queue.append(nxt)
    if len(order) != len(ids):
        cycle_nodes = [i for i in ids if indeg[i] > 0]
        return {"order": order, "cycle": True, "cycle_nodes": cycle_nodes}
    return {"order": order, "cycle": False, "cycle_nodes": []}


# ------------------------------------------------------------------ #
# Workflow executor                                                  #
# ------------------------------------------------------------------ #

class WorkflowExecutor:
    """Resolve → validate → topo-sort → execute, passing each node's output to
    its downstream neighbours, streaming envelope dicts throughout."""

    def __init__(self, doc: Dict[str, Any], owner: Optional[str], workflow_id: str,
                 cancel_event: Optional[asyncio.Event] = None):
        self.nodes = doc.get("nodes") or []
        self.edges = doc.get("edges") or []
        self.owner = owner
        self.workflow_id = workflow_id
        self.cancel_event = cancel_event or asyncio.Event()
        self.by_id = {n["id"]: n for n in self.nodes if n.get("id")}
        self.ctx = ExecContext(workflow_id, owner, self.cancel_event)

    def _predecessors(self, nid: str) -> List[str]:
        return [e.get("source") for e in self.edges if e.get("target") == nid and e.get("source") in self.by_id]

    async def stream(self) -> AsyncGenerator[Dict[str, Any], None]:
        run_id = create_run(self.owner, self.workflow_id, "graph")
        yield {"type": "workflow_status", "status": "running", "run_id": run_id}

        topo = topo_order(self.nodes, self.edges)
        if topo["cycle"]:
            names = ", ".join((self.by_id.get(i, {}).get("data", {}).get("title") or i) for i in topo["cycle_nodes"][:6])
            err = f"Cycle detected — these nodes form a loop: {names}"
            finish_run(run_id, "failed", err)
            yield {"type": "workflow_status", "status": "failed", "run_id": run_id, "error": err,
                   "cycle_nodes": topo["cycle_nodes"]}
            return

        outputs: Dict[str, str] = {}
        statuses: Dict[str, str] = {}

        for nid in topo["order"]:
            if self.cancel_event.is_set():
                statuses[nid] = "cancelled"
                yield {"type": "node_status", "node_id": nid, "status": "cancelled"}
                continue

            node = self.by_id[nid]
            preds = self._predecessors(nid)
            # Skip if any upstream dependency didn't succeed.
            if preds and not all(statuses.get(p) == "success" for p in preds):
                statuses[nid] = "skipped"
                yield {"type": "node_status", "node_id": nid, "status": "skipped"}
                continue

            inputs = {p: outputs.get(p, "") for p in preds}
            kind = (node.get("data") or {}).get("kind") or "feature"

            if kind == "agent":
                runner = agent_node_events(self.owner, node, inputs, run_id=run_id, workflow_id=self.workflow_id)
            elif kind in EXEC_NODE_RUNNERS:
                runner = EXEC_NODE_RUNNERS[kind](node, inputs, run_id, self.ctx)
            else:
                runner = None

            if runner is not None:
                last: Dict[str, Any] = {}
                try:
                    async for ev in runner:
                        yield ev
                        if ev.get("type") == "node_status":
                            last = ev
                except asyncio.CancelledError:
                    statuses[nid] = "cancelled"
                    raise
                st = last.get("status")
                statuses[nid] = st if st in ("success", "failed", "cancelled") else "failed"
                outputs[nid] = last.get("output", "") if statuses[nid] == "success" else ""
            else:
                # Design kinds: pass their description downstream as context.
                node_run_id = create_node_run(run_id, nid, kind)
                yield {"type": "node_status", "node_id": nid, "status": "running"}
                out = (node.get("data") or {}).get("description") or ""
                finish_node_run(node_run_id, "success", out, "", None, inputs=inputs)
                statuses[nid] = "success"
                outputs[nid] = out
                yield {"type": "node_status", "node_id": nid, "status": "success", "output": out}

        final = ("cancelled" if self.cancel_event.is_set()
                 else "failed" if any(s == "failed" for s in statuses.values())
                 else "success")
        finish_run(run_id, final)
        yield {"type": "workflow_status", "status": final, "run_id": run_id}


# In-process registry of cancellable runs: run token -> cancel Event.
_CANCEL_EVENTS: Dict[str, asyncio.Event] = {}


def register_cancel(token: str) -> asyncio.Event:
    ev = asyncio.Event()
    _CANCEL_EVENTS[token] = ev
    return ev


def signal_cancel(token: str) -> bool:
    ev = _CANCEL_EVENTS.get(token)
    if ev:
        ev.set()
        return True
    return False


def clear_cancel(token: str) -> None:
    _CANCEL_EVENTS.pop(token, None)
