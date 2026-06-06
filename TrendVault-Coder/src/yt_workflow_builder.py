"""
YouTube → Workflow-Remake-Prompt builder.

Turns a YouTube video's transcript / metadata / notes / comments / frame
descriptions into a detailed, copy-paste "remake this on my server" prompt —
*reliably*, even for very long transcripts, on a small local Ollama model.

The whole point of this module is to never let a long transcript 500 the model:

  * health-check Ollama and validate the model BEFORE sending anything;
  * use a safe native ``/api/generate`` body (no nulls / empties / junk fields);
  * estimate size and CHUNK oversized input instead of shoving it in whole;
  * summarise each chunk, merge, build a structured workflow map, then emit the
    final templated prompt;
  * a retry ladder per model call: smaller prompt → lower context → fallback
    model → finally an offline "emergency template" built from the raw source
    so the feature degrades gracefully instead of crashing.

Pure logic only — no FastAPI here. ``routes/yt_workflow_routes.py`` wraps this
as HTTP/SSE and ``core.database`` persists the results.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "deepseek-r1:8b"
# Tried in order when the requested/default model is missing. Matched loosely so
# "llama3.2" also matches an installed "llama3.2:latest".
FALLBACK_MODELS = ["qwen2.5-coder:7b", "llama3.2", "qwen3"]

DEFAULT_NUM_CTX = 8192
LOWER_NUM_CTX = 4096
MIN_NUM_CTX = 2048

# Chunking: keep each model call's *content* comfortably under the context
# window. 7k chars ≈ 1.7k tokens of content, leaving room for instructions and
# the model's reasoning/answer inside an 8k window.
DEFAULT_CHUNK_CHARS = 7000
MIN_CHUNK_CHARS = 3500
CHUNK_OVERLAP = 200

# Generous per-call timeouts — deepseek-r1 and other "thinking" models are slow.
SUMMARY_TIMEOUT = 150.0
FINAL_TIMEOUT = 240.0


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class OllamaGenerateError(Exception):
    """A single ``/api/generate`` call failed. Carries enough context to build a
    helpful, non-raw error message and drive the retry ladder."""

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        model: Optional[str] = None,
        prompt_len: int = 0,
        num_ctx: Optional[int] = None,
        body: str = "",
        kind: str = "error",
        reason: str = "generic",
    ):
        super().__init__(message)
        self.message = message
        self.status = status
        self.model = model
        self.prompt_len = prompt_len
        self.num_ctx = num_ctx
        self.body = body
        self.kind = kind  # "http" | "timeout" | "connect" | "error"
        # "memory" (model failed to load / OOM — retrying smaller won't help),
        # "context" (prompt too big — chunk + retry), "generic", or "timeout".
        self.reason = reason


# Signatures Ollama/llama.cpp emit when a model can't be *loaded* (out of RAM or
# VRAM, disk, or the runner crashing). These do NOT improve by shrinking the
# prompt or num_ctx — the right move is a smaller model or freeing memory.
_MEMORY_SIGNS = (
    "unable to allocate", "failed to allocate", "process has terminated",
    "out of memory", "requires more system memory", "error loading model",
    "cudamalloc", "cublas", "cuda error", "cuda out of memory", "no space left",
    "insufficient memory", "alloc_tensor", "ggml_backend",
)
# Signatures that mean the *input* was too large for the loaded model.
_CONTEXT_SIGNS = (
    "context", "n_ctx", "exceeds", "too large", "maximum context", "token limit",
    "prompt is too long", "input length",
)


def classify_ollama_error(text: str) -> str:
    """Classify a 500 body / error string into a retry strategy bucket."""
    low = (text or "").lower()
    if any(s in low for s in _MEMORY_SIGNS):
        return "memory"
    if any(s in low for s in _CONTEXT_SIGNS):
        return "context"
    return "generic"


# ---------------------------------------------------------------------------
# Endpoint resolution
# ---------------------------------------------------------------------------

def ollama_native_base() -> str:
    """Resolve the *native* Ollama API root (no ``/v1``, no ``/api`` suffix).

    Mirrors app.py's resolution order (OLLAMA_BASE_URL / OLLAMA_URL, docker
    fallback) but always returns ``scheme://host:port`` since the native API
    (/api/tags, /api/generate) lives at the host root.
    """
    raw = (os.getenv("OLLAMA_BASE_URL") or os.getenv("OLLAMA_URL") or "").strip()
    if raw:
        parsed = urlparse(raw if "://" in raw else f"http://{raw}")
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
    in_docker = os.path.exists("/.dockerenv")
    return "http://host.docker.internal:11434" if in_docker else "http://127.0.0.1:11434"


# ---------------------------------------------------------------------------
# Health check + model validation
# ---------------------------------------------------------------------------

def available_ram_bytes() -> Optional[int]:
    """Best-effort free physical memory, in bytes (psutil → Windows ctypes → None)."""
    try:
        import psutil  # type: ignore
        return int(psutil.virtual_memory().available)
    except Exception:
        pass
    if os.name == "nt":
        try:
            import ctypes

            class _MEMSTATUS(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = _MEMSTATUS()
            stat.dwLength = ctypes.sizeof(_MEMSTATUS)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                return int(stat.ullAvailPhys)
        except Exception:
            return None
    return None


async def health_check(timeout: float = 5.0, selected_model: Optional[str] = None) -> Dict[str, Any]:
    """GET /api/tags. Confirms Ollama is running, reachable, lists models, and —
    crucially for the OOM-on-load failure mode — warns when the selected model is
    unlikely to fit in available RAM.

    Returns ``{reachable, running, models, models_detail, base, error, ram_available,
    fit_warning}``.
    """
    base = ollama_native_base()
    url = f"{base}/api/tags"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(url)
    except (httpx.ConnectError, httpx.ConnectTimeout):
        return {
            "reachable": False, "running": False, "models": [], "models_detail": [], "base": base,
            "error": f"Ollama is not reachable at {base}. Is it running? Start it with `ollama serve`.",
            "ram_available": None, "fit_warning": None,
        }
    except Exception as e:  # pragma: no cover - defensive
        return {"reachable": False, "running": False, "models": [], "models_detail": [], "base": base,
                "error": str(e), "ram_available": None, "fit_warning": None}

    if r.status_code != 200:
        return {
            "reachable": True, "running": False, "models": [], "models_detail": [], "base": base,
            "error": f"Ollama responded {r.status_code} at {url}.",
            "ram_available": None, "fit_warning": None,
        }
    try:
        data = r.json()
    except Exception:
        return {"reachable": True, "running": False, "models": [], "models_detail": [], "base": base,
                "error": "Ollama /api/tags returned a non-JSON response.",
                "ram_available": None, "fit_warning": None}

    models: List[str] = []
    detail: List[Dict[str, Any]] = []
    for m in (data.get("models") or []):
        if not isinstance(m, dict):
            continue
        name = (m.get("name") or m.get("model") or "").strip()
        if not name:
            continue
        models.append(name)
        detail.append({"name": name, "size": m.get("size")})

    ram = available_ram_bytes()
    fit_warning = None
    if selected_model and ram:
        size = next((d["size"] for d in detail if d["name"] == selected_model and d.get("size")), None)
        if not size:
            hit = _model_matches(selected_model, models)
            size = next((d["size"] for d in detail if d["name"] == hit and d.get("size")), None)
        # Loading needs the weights plus working/KV buffers — budget ~1.3× the file.
        if size and size * 1.3 > ram:
            fit_warning = (
                f"'{selected_model}' is ~{size / 1e9:.1f} GB but only ~{ram / 1e9:.1f} GB RAM is free. "
                "It may fail to load (HTTP 500). Free memory or pick a smaller model."
            )

    return {
        "reachable": True, "running": True, "models": models, "models_detail": detail,
        "base": base, "error": None, "ram_available": ram, "fit_warning": fit_warning,
    }


def _model_matches(requested: str, available: List[str]) -> Optional[str]:
    """Resolve ``requested`` against installed model names, loosely.

    Exact match wins; otherwise match on the family before ``:`` so a bare
    "llama3.2" resolves to an installed "llama3.2:latest" and vice-versa.
    """
    if not requested:
        return None
    if requested in available:
        return requested
    req_base = requested.split(":")[0].lower()
    for a in available:
        a_base = a.split(":")[0].lower()
        if a.lower() == requested.lower() or a_base == req_base or a.lower().startswith(requested.lower() + ":"):
            return a
    return None


def resolve_model(requested: Optional[str], available: List[str]) -> Tuple[Optional[str], str, List[str]]:
    """Pick a usable model: the requested one, else the default, else fallbacks.

    Returns ``(resolved_model_or_None, note, tried)``. ``note`` is a short,
    user-facing explanation when we had to substitute.
    """
    available = available or []
    candidates: List[str] = []
    if requested:
        candidates.append(requested)
    for m in [DEFAULT_MODEL] + FALLBACK_MODELS:
        if m not in candidates:
            candidates.append(m)

    tried: List[str] = []
    for cand in candidates:
        tried.append(cand)
        hit = _model_matches(cand, available)
        if hit:
            if requested and _model_matches(requested, available) == hit:
                note = ""
            elif requested:
                note = f"Selected model '{requested}' is not available — using '{hit}' instead."
            else:
                note = f"Using '{hit}'."
            return hit, note, tried

    return None, (
        "Ollama is running but none of the requested or fallback models are "
        "installed. Pull one (e.g. `ollama pull deepseek-r1:8b`) or select another model."
    ), tried


# ---------------------------------------------------------------------------
# Safe request body + the actual generate call
# ---------------------------------------------------------------------------

def build_generate_payload(
    model: str,
    prompt: str,
    num_ctx: int = DEFAULT_NUM_CTX,
    temperature: float = 0.2,
) -> Dict[str, Any]:
    """Build a *safe* native /api/generate body.

    No null values, no empty model/prompt, no unsupported fields, no giant raw
    objects — just the documented shape Ollama accepts.
    """
    if not isinstance(model, str) or not model.strip():
        raise ValueError("Refusing to call Ollama with an empty model name.")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("Refusing to call Ollama with an empty prompt.")

    options: Dict[str, Any] = {"temperature": float(temperature)}
    if isinstance(num_ctx, int) and num_ctx > 0:
        options["num_ctx"] = num_ctx

    return {
        "model": model.strip(),
        "prompt": prompt,
        "stream": False,
        "options": options,
    }


_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_OPEN_THINK_RE = re.compile(r"^\s*<think>", re.IGNORECASE)


def clean_model_text(text: str) -> str:
    """Strip reasoning-model scaffolding (``<think>…</think>``) and trim.

    deepseek-r1 and other thinking models leak their chain-of-thought into the
    ``response`` field wrapped in <think> tags; we only want the answer.
    """
    if not text:
        return ""
    cleaned = _THINK_BLOCK_RE.sub("", text)
    # Truncated/unterminated reasoning: keep whatever follows the last close tag,
    # else drop a dangling opening block.
    if "</think>" in cleaned.lower():
        idx = cleaned.lower().rfind("</think>")
        cleaned = cleaned[idx + len("</think>"):]
    elif _OPEN_THINK_RE.match(cleaned):
        cleaned = _OPEN_THINK_RE.sub("", cleaned, count=1)
    return cleaned.strip()


async def ollama_generate(
    model: str,
    prompt: str,
    *,
    num_ctx: int = DEFAULT_NUM_CTX,
    temperature: float = 0.2,
    timeout: float = FINAL_TIMEOUT,
) -> str:
    """POST one prompt to native /api/generate (stream=False) and return text.

    Raises :class:`OllamaGenerateError` (never a raw httpx error) so callers can
    retry and surface a friendly message.
    """
    base = ollama_native_base()
    url = f"{base}/api/generate"
    payload = build_generate_payload(model, prompt, num_ctx, temperature)
    plen = len(prompt)

    client_timeout = httpx.Timeout(connect=5.0, read=timeout, write=30.0, pool=5.0)
    try:
        async with httpx.AsyncClient(timeout=client_timeout) as client:
            r = await client.post(url, json=payload)
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        raise OllamaGenerateError(
            f"Could not connect to Ollama at {base}.",
            model=model, prompt_len=plen, num_ctx=num_ctx, kind="connect",
        ) from e
    except (httpx.ReadTimeout, httpx.PoolTimeout, httpx.WriteTimeout) as e:
        raise OllamaGenerateError(
            f"Ollama timed out after {timeout:.0f}s generating with '{model}'.",
            model=model, prompt_len=plen, num_ctx=num_ctx, kind="timeout",
        ) from e
    except httpx.HTTPError as e:  # pragma: no cover - defensive
        raise OllamaGenerateError(
            f"Ollama request failed: {e}", model=model, prompt_len=plen, num_ctx=num_ctx,
        ) from e

    if r.status_code != 200:
        body = (r.text or "")[:600]
        raise OllamaGenerateError(
            f"Ollama returned HTTP {r.status_code}.",
            status=r.status_code, model=model, prompt_len=plen, num_ctx=num_ctx,
            body=body, kind="http", reason=classify_ollama_error(body),
        )

    try:
        data = r.json()
    except Exception as e:
        raise OllamaGenerateError(
            "Ollama returned a non-JSON response.", model=model, prompt_len=plen, num_ctx=num_ctx,
        ) from e

    if isinstance(data, dict) and data.get("error"):
        err_text = str(data.get("error"))
        raise OllamaGenerateError(
            f"Ollama error: {err_text}", model=model, prompt_len=plen,
            num_ctx=num_ctx, kind="http", body=err_text,
            reason=classify_ollama_error(err_text),
        )

    return clean_model_text((data or {}).get("response", "") if isinstance(data, dict) else "")


# ---------------------------------------------------------------------------
# Size estimation + chunking
# ---------------------------------------------------------------------------

def estimate_chars(text: str) -> int:
    return len(text or "")


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars/token) — good enough for sizing guards."""
    return (len(text or "") + 3) // 4


def _hard_split(text: str, max_chars: int) -> List[str]:
    """Split a single oversized block on sentence boundaries, then hard slices."""
    pieces: List[str] = []
    sentences = re.split(r"(?<=[.!?])\s+", text)
    cur = ""
    for s in sentences:
        if len(s) > max_chars:
            # A single monster "sentence" (e.g. no punctuation): slice it.
            if cur:
                pieces.append(cur)
                cur = ""
            for i in range(0, len(s), max_chars):
                pieces.append(s[i:i + max_chars])
            continue
        if len(cur) + len(s) + 1 <= max_chars:
            cur = f"{cur} {s}".strip()
        else:
            if cur:
                pieces.append(cur)
            cur = s
    if cur:
        pieces.append(cur)
    return pieces


def chunk_text(text: str, max_chars: int = DEFAULT_CHUNK_CHARS, overlap: int = CHUNK_OVERLAP) -> List[str]:
    """Split text into <= ``max_chars`` chunks on paragraph boundaries.

    Long paragraphs are split on sentence boundaries; a small ``overlap`` of the
    previous chunk's tail is prepended so context isn't lost at the seams.
    """
    text = (text or "").strip()
    if not text:
        return []
    max_chars = max(MIN_CHUNK_CHARS, int(max_chars))
    if len(text) <= max_chars:
        return [text]

    # Reserve room so that prepending the overlap tail below keeps every final
    # chunk within ``max_chars``.
    budget = max(MIN_CHUNK_CHARS, max_chars - (overlap + 3)) if overlap > 0 else max_chars

    paragraphs = re.split(r"\n\s*\n", text)
    blocks: List[str] = []
    cur = ""
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(para) > budget:
            if cur:
                blocks.append(cur)
                cur = ""
            blocks.extend(_hard_split(para, budget))
            continue
        if len(cur) + len(para) + 2 <= budget:
            cur = f"{cur}\n\n{para}" if cur else para
        else:
            if cur:
                blocks.append(cur)
            cur = para
    if cur:
        blocks.append(cur)

    if overlap > 0 and len(blocks) > 1:
        stitched: List[str] = []
        for i, b in enumerate(blocks):
            if i == 0:
                stitched.append(b)
            else:
                tail = blocks[i - 1][-overlap:]
                stitched.append(f"…{tail}\n\n{b}")
        blocks = stitched
    return blocks


# ---------------------------------------------------------------------------
# Source extraction (Step 1) — works fully offline
# ---------------------------------------------------------------------------

# A shell-prompt line: everything after a leading "$ ", "> " or "# ".
_CMD_SHELL = re.compile(r"(?m)^\s*[$>#]\s+([^\n]{1,200})")
# Unambiguous command leaders anywhere on a line (catches inline
# "...then run: docker run -d ..."). Deliberately excludes ambiguous words like
# go/make/node so it won't match prose. Guarded so it won't fire inside a path.
_CMD_INLINE = re.compile(
    r"(?<![\w/.\-])("
    r"(?:sudo\s+)?(?:docker-compose|docker|npm|npx|pnpm|yarn|pip3|pip|python3|python|ollama|git|"
    r"curl|wget|uvicorn|gunicorn|kubectl|conda|cargo|systemctl|apt-get|brew)\s+[^\n]{1,200})"
)
# VAR=value anywhere (UPPER_SNAKE only), ignoring ==/<=/>=/!= comparisons.
_ENV_HINTS = re.compile(r"(?<![\w=<>!])([A-Z][A-Z0-9_]{2,})\s*=(?!=)\s*([^\s,;]{1,100})")
_PATH_HINTS = re.compile(r"(?<![\w/])((?:\.{0,2}/)?(?:[\w.\-]+/){1,}[\w.\-]+\.[A-Za-z0-9]{1,6})")
_PORT_HINTS = re.compile(r"(?:localhost|127\.0\.0\.1|0\.0\.0\.0|:)\s*:?(\d{2,5})\b")
_TOOL_WORDS = [
    "n8n", "ollama", "docker", "flask", "fastapi", "react", "next.js", "nextjs", "node",
    "postgres", "postgresql", "sqlite", "mysql", "redis", "mongodb", "chromadb", "qdrant",
    "pinecone", "supabase", "langchain", "llamaindex", "webhook", "ngrok", "nginx",
    "openai", "anthropic", "claude", "huggingface", "whisper", "ffmpeg", "selenium",
    "playwright", "puppeteer", "celery", "rabbitmq", "kafka", "github actions", "vite",
    "tailwind", "express", "django", "uvicorn", "gunicorn",
]


def heuristic_signals(text: str) -> Dict[str, List[str]]:
    """Best-effort, model-free extraction of build signals from raw text.

    Used both to pre-seed the model and to power the offline emergency template,
    so the feature still yields something useful when Ollama is unavailable.
    """
    text = text or ""
    low = text.lower()

    def _dedupe(items: List[str], limit: int) -> List[str]:
        seen: set = set()
        out: List[str] = []
        for it in items:
            it = it.strip()
            key = it.lower()
            if it and key not in seen:
                seen.add(key)
                out.append(it)
            if len(out) >= limit:
                break
        return out

    commands = _dedupe(
        [m.group(1).strip() for m in _CMD_INLINE.finditer(text)]
        + [m.group(1).strip() for m in _CMD_SHELL.finditer(text)],
        40,
    )
    env_vars = _dedupe([f"{m.group(1)}={m.group(2).strip()}" for m in _ENV_HINTS.finditer(text)], 30)
    file_paths = _dedupe([m.group(1) for m in _PATH_HINTS.finditer(text)], 40)
    ports = _dedupe([m.group(1) for m in _PORT_HINTS.finditer(text)], 15)
    tools = _dedupe([w for w in _TOOL_WORDS if w in low], 30)

    return {
        "tools": tools,
        "commands": commands,
        "env_vars": env_vars,
        "file_paths": file_paths,
        "ports": ports,
    }


def _as_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, (list, tuple)):
        out = []
        for v in value:
            if isinstance(v, str) and v.strip():
                out.append(v.strip())
            elif isinstance(v, dict):
                # chapters/segments/frames as dicts -> readable line
                title = v.get("title") or v.get("text") or v.get("description") or ""
                ts = v.get("timestamp") or v.get("start_time") or v.get("start") or ""
                line = f"[{ts}] {title}".strip() if ts else str(title).strip()
                if line:
                    out.append(line)
        return out
    return []


@dataclass
class CleanSource:
    """The normalised, model-ready source document (Step 1 output)."""
    meta: Dict[str, Any] = field(default_factory=dict)
    source_text: str = ""
    signals: Dict[str, List[str]] = field(default_factory=dict)
    sections: Dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "meta": self.meta,
            "source_text": self.source_text,
            "signals": self.signals,
            "sections": self.sections,
            "char_count": len(self.source_text),
            "token_estimate": estimate_tokens(self.source_text),
        }


def extract_clean_source(payload: Dict[str, Any]) -> CleanSource:
    """Step 1 — assemble clean source content from whatever the caller provides.

    Accepts any subset of: url, video_id, title, channel, description, duration,
    chapters, tags, transcript, segments, comments, notes, frames, plus
    pre-extracted tools/commands/ui_actions/file_paths/env_vars/dependencies.
    """
    payload = payload or {}

    meta = {
        "url": (payload.get("url") or "").strip(),
        "video_id": (payload.get("video_id") or "").strip(),
        "title": (payload.get("title") or "").strip(),
        "channel": (payload.get("channel") or payload.get("uploader") or "").strip(),
        "duration": payload.get("duration"),
        "chapters": _as_list(payload.get("chapters")),
        "tags": _as_list(payload.get("tags"))[:25],
    }

    sections: Dict[str, str] = {}

    if meta["title"]:
        sections["Title"] = meta["title"]
    if meta["channel"]:
        sections["Channel"] = meta["channel"]
    desc = (payload.get("description") or "").strip()
    if desc:
        sections["Description"] = desc[:4000]
    if meta["chapters"]:
        sections["Chapters"] = "\n".join(meta["chapters"][:60])

    transcript = (payload.get("transcript") or "").strip()
    if not transcript and payload.get("segments"):
        seg_lines = []
        for s in payload["segments"]:
            if isinstance(s, dict):
                ts = s.get("timestamp") or ""
                txt = (s.get("text") or "").strip()
                if txt:
                    seg_lines.append(f"[{ts}] {txt}" if ts else txt)
        transcript = "\n".join(seg_lines)
    if transcript:
        sections["Transcript"] = transcript

    notes = (payload.get("notes") or "").strip()
    if notes:
        sections["Video notes"] = notes

    frames = _as_list(payload.get("frames"))
    if frames:
        sections["Frame descriptions"] = "\n".join(frames[:120])

    comments = payload.get("comments") or []
    if comments:
        clines = []
        for c in comments[:30]:
            if isinstance(c, dict):
                txt = (c.get("text") or "").strip()
                if txt:
                    clines.append(f"- {txt}")
            elif isinstance(c, str) and c.strip():
                clines.append(f"- {c.strip()}")
        if clines:
            sections["Top comments"] = "\n".join(clines)

    # Caller-provided pre-extracted lists (optional).
    for key, label in (
        ("tools", "Tools mentioned"),
        ("commands", "Server commands"),
        ("ui_actions", "UI actions"),
        ("file_paths", "File paths"),
        ("env_vars", "Environment variables"),
        ("dependencies", "Dependencies"),
    ):
        vals = _as_list(payload.get(key))
        if vals:
            sections[label] = "\n".join(f"- {v}" for v in vals[:40])

    # Combined source text, labelled for the model.
    parts = []
    for label, body in sections.items():
        parts.append(f"## {label}\n{body}")
    source_text = "\n\n".join(parts).strip()

    signals = heuristic_signals(source_text)

    return CleanSource(meta=meta, source_text=source_text, signals=signals, sections=sections)


# ---------------------------------------------------------------------------
# Prompt templates
# ---------------------------------------------------------------------------

def _summary_prompt(chunk: str, index: int, total: int) -> str:
    return (
        f"You are reverse-engineering a YouTube tutorial so it can be rebuilt on another server.\n"
        f"This is excerpt {index} of {total} from the video's transcript/notes.\n\n"
        "Extract ONLY concrete, build-relevant facts that appear in THIS excerpt. Be terse and "
        "factual. Do NOT invent anything that is not present. Skip any heading that has nothing.\n\n"
        "- Steps performed (in order)\n"
        "- Tools / services / apps used\n"
        "- Commands run (verbatim)\n"
        "- UI actions (buttons, screens, nodes, connections)\n"
        "- File paths / files created\n"
        "- Environment variables / config keys\n"
        "- Dependencies / versions / ports\n"
        "- Backend / API / database / model calls\n\n"
        f'EXCERPT:\n"""\n{chunk}\n"""\n'
    )


def _map_prompt(merged_summaries: str, meta: Dict[str, Any]) -> str:
    head = _meta_header(meta)
    return (
        "You are assembling a structured workflow map from notes extracted across a YouTube "
        "tutorial. Merge and de-duplicate the notes below into ONE coherent, ordered build map. "
        "Keep it factual; do not pad. Output these sections:\n\n"
        "1. One-paragraph summary of what the video builds.\n"
        "2. Ordered build steps (numbered, each a concrete action).\n"
        "3. Tools & services (with the role of each).\n"
        "4. Commands (verbatim, in run order).\n"
        "5. UI / automation flow (screens, buttons, nodes, connections).\n"
        "6. Backend flow (APIs, database, queues, file processing, model calls).\n"
        "7. Files to create (path + purpose).\n"
        "8. Environment variables / config.\n\n"
        f"{head}\n\nEXTRACTED NOTES:\n{merged_summaries}\n"
    )


FINAL_TEMPLATE_HEADINGS = (
    "# Exact Workflow Remake Prompt",
    "## Goal",
    "## Required Server Setup",
    "## Tools Needed",
    "## Step-by-Step Build Process",
    "## UI/Automation Flow",
    "## Backend Flow",
    "## Commands",
    "## Files To Create",
    "## Environment Variables",
    "## Error Handling",
    "## Final Prompt For Claude/Cursor",
)


def _final_prompt(workflow_map: str, meta: Dict[str, Any]) -> str:
    head = _meta_header(meta)
    return (
        "Using the structured workflow map below, write a COMPLETE, copy-paste prompt that lets an "
        "AI coding agent rebuild this exact system on my own server. Be specific and concrete; infer "
        "sensible details only where the map clearly implies them, and never contradict it.\n\n"
        "Return GitHub-flavoured Markdown using EXACTLY these headings, in this order:\n\n"
        "# Exact Workflow Remake Prompt\n"
        "## Goal\n(Explain what the video is building.)\n"
        "## Required Server Setup\n(List OS, folders, ports, models, dependencies, services.)\n"
        "## Tools Needed\n(List each tool and why it is needed.)\n"
        "## Step-by-Step Build Process\n(Write the exact workflow in order.)\n"
        "## UI/Automation Flow\n(Describe every button, screen, node, and connection.)\n"
        "## Backend Flow\n(Describe APIs, database, queues, file processing, and model calls.)\n"
        "## Commands\n(Include terminal commands when detected.)\n"
        "## Files To Create\n(List file paths and what each file does.)\n"
        "## Environment Variables\n(List .env keys.)\n"
        "## Error Handling\n(List failure states and fixes.)\n"
        "## Final Prompt For Claude/Cursor\n(Write a complete copy-paste prompt that can rebuild the system on my server.)\n\n"
        f"{head}\n\nWORKFLOW MAP:\n{workflow_map}\n"
    )


def _meta_header(meta: Dict[str, Any]) -> str:
    meta = meta or {}
    lines = []
    if meta.get("title"):
        lines.append(f"VIDEO TITLE: {meta['title']}")
    if meta.get("channel"):
        lines.append(f"CHANNEL: {meta['channel']}")
    if meta.get("url"):
        lines.append(f"URL: {meta['url']}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Retry ladder — one logical model call, hardened
# ---------------------------------------------------------------------------

def _shrink_prompt(prompt: str, keep_ratio: float = 0.6) -> str:
    """Shrink an oversized prompt while keeping the (instruction-heavy) head and
    a slice of the tail."""
    if keep_ratio >= 1.0 or len(prompt) <= 1200:
        return prompt
    keep = int(len(prompt) * keep_ratio)
    head = int(keep * 0.75)
    tail = keep - head
    return prompt[:head] + "\n…[trimmed for size]…\n" + prompt[-tail:]


@dataclass
class GenDiag:
    """Diagnostics accumulated across a build so the UI can explain what happened."""
    selected_model: str = ""
    final_model: str = ""
    retry_count: int = 0
    prompt_size: int = 0
    context_size: int = DEFAULT_NUM_CTX
    attempts: List[Dict[str, Any]] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    last_reason: str = ""      # "memory" | "context" | "timeout" | "generic"
    last_error_body: str = ""  # raw Ollama error (e.g. "unable to allocate CPU buffer")


async def robust_generate(
    prompt: str,
    *,
    model: str,
    fallback_models: List[str],
    num_ctx: int = DEFAULT_NUM_CTX,
    temperature: float = 0.2,
    timeout: float = FINAL_TIMEOUT,
    diag: Optional[GenDiag] = None,
    label: str = "generate",
) -> str:
    """Run one prompt through the retry ladder:

      1. selected model, full prompt, normal ctx
      2. selected model, smaller prompt
      3. selected model, lower ctx
      4. first available fallback model, smaller prompt + lower ctx

    Raises the last :class:`OllamaGenerateError` only after the whole ladder is
    exhausted, so the caller can fall back to emergency mode.
    """
    diag = diag if diag is not None else GenDiag()
    fb = [m for m in (fallback_models or []) if m and m != model]

    plan: List[Dict[str, Any]] = [
        {"model": model, "prompt": prompt, "num_ctx": num_ctx, "why": "primary"},
        {"model": model, "prompt": _shrink_prompt(prompt, 0.6), "num_ctx": num_ctx, "why": "smaller prompt"},
        {"model": model, "prompt": _shrink_prompt(prompt, 0.6), "num_ctx": max(MIN_NUM_CTX, LOWER_NUM_CTX), "why": "lower context"},
    ]
    if fb:
        plan.append({"model": fb[0], "prompt": _shrink_prompt(prompt, 0.5),
                     "num_ctx": max(MIN_NUM_CTX, LOWER_NUM_CTX), "why": f"fallback model {fb[0]}"})

    last_err: Optional[OllamaGenerateError] = None
    dead_models: set = set()  # models that failed to LOAD (OOM) — don't retry them
    used = 0
    for i, step in enumerate(plan):
        # Shrinking the prompt or num_ctx can't fix a model that won't load. Once a
        # model OOMs, skip every remaining attempt on that same model and jump to
        # the fallback model (which is smaller). Fast + accurate instead of 4×3.5s.
        if step["model"] in dead_models:
            diag.attempts.append({"label": label, "attempt": i + 1, "model": step["model"],
                                  "num_ctx": step["num_ctx"], "why": step["why"], "ok": False,
                                  "skipped": True, "error": "skipped (model failed to load)"})
            continue
        used += 1
        try:
            out = await ollama_generate(
                step["model"], step["prompt"],
                num_ctx=step["num_ctx"], temperature=temperature, timeout=timeout,
            )
            if not out.strip():
                raise OllamaGenerateError("Ollama returned an empty response.", model=step["model"],
                                          prompt_len=len(step["prompt"]), num_ctx=step["num_ctx"])
            diag.attempts.append({"label": label, "attempt": i + 1, "model": step["model"],
                                  "num_ctx": step["num_ctx"], "why": step["why"], "ok": True})
            diag.final_model = step["model"]
            diag.context_size = step["num_ctx"]
            if used > 1:
                diag.retry_count += used - 1
                diag.notes.append(f"{label}: succeeded on attempt {i + 1} ({step['why']}).")
            return out
        except OllamaGenerateError as e:
            last_err = e
            diag.last_reason = e.reason
            if e.body:
                diag.last_error_body = e.body
            if e.reason == "memory":
                dead_models.add(step["model"])
            diag.attempts.append({"label": label, "attempt": i + 1, "model": step["model"],
                                  "num_ctx": step["num_ctx"], "why": step["why"], "ok": False,
                                  "error": e.message, "status": e.status, "reason": e.reason})
            logger.warning("robust_generate[%s] attempt %d failed (%s, reason=%s): %s",
                           label, i + 1, step["why"], e.reason, e.message)

    diag.retry_count += used
    if last_err:
        diag.errors.append(f"{label}: {last_err.message}")
        raise last_err
    raise OllamaGenerateError(f"{label}: generation failed.", model=model)


# ---------------------------------------------------------------------------
# Emergency mode — a usable prompt with NO model (Step 12: never fail silently)
# ---------------------------------------------------------------------------

def emergency_template(source: CleanSource, diag: Optional[GenDiag] = None) -> str:
    """Build a structured remake prompt from the raw source alone.

    Lower quality than a model pass, but it always produces the right shape so
    the user is never left empty-handed when Ollama is down or 500ing.
    """
    meta = source.meta or {}
    sig = source.signals or {}
    sections = source.sections or {}

    title = meta.get("title") or "the workflow shown in the video"
    transcript = sections.get("Transcript", "") or sections.get("Description", "")

    # Heuristic "steps": numbered/bulleted lines or imperative sentences.
    step_lines: List[str] = []
    for raw in re.split(r"[\n.]", transcript):
        line = raw.strip(" -•\t")
        if not line:
            continue
        if re.match(r"^(?:\d+[.)]|step\b)", line, re.IGNORECASE) or re.match(
            r"^(open|click|create|install|run|add|connect|configure|set|deploy|build|"
            r"download|paste|enter|select|drag|drop|copy|import|export|start|launch|"
            r"navigate|type|upload|save|enable|disable)\b", line, re.IGNORECASE
        ):
            step_lines.append(line)
        if len(step_lines) >= 25:
            break

    def _bullets(items: List[str]) -> str:
        return "\n".join(f"- {it}" for it in items) if items else "- (none detected — fill in from the video)"

    commands_block = "\n".join(sig.get("commands", [])) or "# (no commands detected in the source)"

    diag_line = ""
    if diag:
        diag_line = (
            f"\n> _Generated in emergency mode (model unavailable). "
            f"Selected model: {diag.selected_model or 'n/a'}; retries: {diag.retry_count}._\n"
        )

    return (
        "# Exact Workflow Remake Prompt\n"
        f"{diag_line}\n"
        "## Goal\n"
        f"Rebuild {title} on my own server, reproducing the workflow demonstrated in the video.\n\n"
        "## Required Server Setup\n"
        "- OS: Linux/macOS/Windows with the runtimes below installed\n"
        f"- Ports: {', '.join(sig.get('ports', [])) or 'as required by the tools below'}\n"
        f"- Models/services: {', '.join(sig.get('tools', [])) or '(see Tools Needed)'}\n\n"
        "## Tools Needed\n"
        f"{_bullets(sig.get('tools', []))}\n\n"
        "## Step-by-Step Build Process\n"
        f"{_bullets(step_lines)}\n\n"
        "## UI/Automation Flow\n"
        "- Recreate each screen/button/node shown in the video in the same order as the steps above.\n\n"
        "## Backend Flow\n"
        "- Wire the APIs, database, file processing and model calls implied by the steps and commands.\n\n"
        "## Commands\n"
        f"```bash\n{commands_block}\n```\n\n"
        "## Files To Create\n"
        f"{_bullets(sig.get('file_paths', []))}\n\n"
        "## Environment Variables\n"
        f"{_bullets(sig.get('env_vars', []))}\n\n"
        "## Error Handling\n"
        "- Validate each external service is reachable before calling it; retry transient failures; "
        "log and surface clear errors.\n\n"
        "## Final Prompt For Claude/Cursor\n"
        f"Rebuild {title} on my server. Follow the Step-by-Step Build Process above in order, install "
        "the Tools Needed, run the Commands, create the Files To Create, and set the Environment "
        "Variables. Implement the UI/Automation Flow and Backend Flow as described, with the Error "
        "Handling noted above.\n"
    )


# ---------------------------------------------------------------------------
# Full pipeline (Steps 2–5) with progress callbacks
# ---------------------------------------------------------------------------

ProgressCB = Callable[[Dict[str, Any]], Awaitable[None]]


async def _noop(_: Dict[str, Any]) -> None:
    return None


def resolve_fallbacks(model: str, available_models: List[str]) -> List[str]:
    """Installed fallback models (resolved to real names), excluding the primary."""
    out: List[str] = []
    for fb in FALLBACK_MODELS:
        hit = _model_matches(fb, available_models)
        if hit and hit != model and hit not in out:
            out.append(hit)
    return out


def merge_summaries(summaries: List[str]) -> str:
    return "\n\n---\n\n".join(f"[Excerpt {i}]\n{s}" for i, s in enumerate(summaries, 1))


async def summarize_chunks(
    chunks: List[str],
    *,
    model: str,
    available_models: List[str],
    num_ctx: int = DEFAULT_NUM_CTX,
    diag: Optional[GenDiag] = None,
    on_progress: Optional[ProgressCB] = None,
) -> Dict[str, Any]:
    """Step 3 — summarise each chunk through the retry ladder, emitting progress.

    Never raises: a chunk the model can't handle degrades to a trimmed raw
    excerpt so later stages still have signal. Returns ``{summaries, merged, diag}``.
    """
    emit = on_progress or _noop
    diag = diag if diag is not None else GenDiag(selected_model=model, final_model=model, context_size=num_ctx)
    fallbacks = resolve_fallbacks(model, available_models)
    total = len(chunks)

    summaries: List[str] = []
    for i, ch in enumerate(chunks, 1):
        await emit({"type": "step", "id": "summarize", "status": "running",
                    "progress": int((i - 1) / total * 100) if total else 0,
                    "detail": {"chunk": i, "total": total}})
        try:
            s = await robust_generate(
                _summary_prompt(ch, i, total),
                model=model, fallback_models=fallbacks,
                num_ctx=num_ctx, timeout=SUMMARY_TIMEOUT, diag=diag,
                label=f"summary {i}/{total}",
            )
            summaries.append(s)
        except OllamaGenerateError as e:
            diag.errors.append(f"summary {i}: {e.message}")
            summaries.append(f"(model failed on excerpt {i}: {e.message})\n{ch[:1200]}")
        await emit({"type": "step", "id": "summarize", "status": "running",
                    "progress": int(i / total * 100) if total else 100,
                    "detail": {"chunk": i, "total": total}})

    merged = merge_summaries(summaries)
    await emit({"type": "step", "id": "summarize", "status": "done",
                "detail": {"summary_count": len(summaries)}})
    return {"summaries": summaries, "merged": merged, "diag": diag}


async def generate_from_summaries(
    merged: str,
    *,
    source: CleanSource,
    model: str,
    available_models: List[str],
    num_ctx: int = DEFAULT_NUM_CTX,
    diag: Optional[GenDiag] = None,
    on_progress: Optional[ProgressCB] = None,
) -> Dict[str, Any]:
    """Steps 4–5 — build the structured workflow map, then the final templated
    prompt. Falls back to :func:`emergency_template` if the model path collapses.

    Returns ``{final_output, workflow_map, emergency, diag}``.
    """
    emit = on_progress or _noop
    diag = diag if diag is not None else GenDiag(selected_model=model, final_model=model, context_size=num_ctx)
    fallbacks = resolve_fallbacks(model, available_models)

    # --- Step 4: structured workflow map ---
    await emit({"type": "step", "id": "map", "status": "running"})
    try:
        workflow_map = await robust_generate(
            _map_prompt(merged, source.meta),
            model=model, fallback_models=fallbacks,
            num_ctx=num_ctx, timeout=FINAL_TIMEOUT, diag=diag, label="workflow map",
        )
        await emit({"type": "step", "id": "map", "status": "done"})
    except OllamaGenerateError as e:
        diag.errors.append(f"workflow map: {e.message}")
        workflow_map = merged  # fall through with the merged notes
        await emit({"type": "step", "id": "map", "status": "error", "detail": {"error": e.message}})

    # --- Step 5: final templated prompt ---
    await emit({"type": "step", "id": "final", "status": "running"})
    try:
        final_output = await robust_generate(
            _final_prompt(workflow_map, source.meta),
            model=model, fallback_models=fallbacks,
            num_ctx=num_ctx, timeout=FINAL_TIMEOUT, diag=diag, label="final prompt",
        )
        emergency = False
        await emit({"type": "step", "id": "final", "status": "done"})
    except OllamaGenerateError as e:
        diag.errors.append(f"final prompt: {e.message}")
        final_output = emergency_template(source, diag)
        emergency = True
        await emit({"type": "step", "id": "final", "status": "error",
                    "detail": {"error": e.message, "emergency": True}})

    if not emergency and not final_output.strip():
        final_output = emergency_template(source, diag)
        emergency = True
        diag.errors.append("final prompt: empty output, used emergency template.")

    return {"final_output": final_output, "workflow_map": workflow_map,
            "emergency": emergency, "diag": diag}


async def run_pipeline(
    source: CleanSource,
    *,
    model: str,
    available_models: List[str],
    num_ctx: int = DEFAULT_NUM_CTX,
    max_chunk_chars: int = DEFAULT_CHUNK_CHARS,
    on_progress: Optional[ProgressCB] = None,
) -> Dict[str, Any]:
    """Run chunk → summarise → map → final, emitting progress events.

    Always returns a result dict (never raises) — if the model path collapses it
    falls back to :func:`emergency_template` so the user still gets output.

    Result: ``{final_output, workflow_map, summaries, chunks, diag, emergency, errors}``.
    """
    emit = on_progress or _noop
    diag = GenDiag(selected_model=model, final_model=model, context_size=num_ctx)

    # --- Step 2: chunk ---
    chunks = chunk_text(source.source_text, max_chars=max_chunk_chars)
    diag.prompt_size = len(source.source_text)
    await emit({"type": "step", "id": "chunk", "status": "done",
                "detail": {"chunk_count": len(chunks), "chars": len(source.source_text)}})

    if not chunks:
        out = emergency_template(source, diag)
        diag.errors.append("No source content to summarise.")
        return {"final_output": out, "workflow_map": "", "summaries": [], "chunks": [],
                "diag": diag, "emergency": True, "errors": diag.errors}

    # --- Step 3: summarise ---
    sres = await summarize_chunks(chunks, model=model, available_models=available_models,
                                  num_ctx=num_ctx, diag=diag, on_progress=emit)

    # --- Steps 4–5: map + final ---
    gres = await generate_from_summaries(sres["merged"], source=source, model=model,
                                         available_models=available_models, num_ctx=num_ctx,
                                         diag=diag, on_progress=emit)

    return {
        "final_output": gres["final_output"],
        "workflow_map": gres["workflow_map"],
        "summaries": sres["summaries"],
        "chunks": chunks,
        "diag": diag,
        "emergency": gres["emergency"],
        "errors": diag.errors,
    }


def friendly_failure_message(diag: GenDiag, emergency: bool) -> str:
    """The replacement for the raw 500, with the diagnostics the spec asks for.

    The wording adapts to *why* it failed: an out-of-memory model-load failure
    needs different advice ("use a smaller model") than a context overflow
    ("chunked and retried").
    """
    if diag.last_reason == "memory":
        base = (
            "Ollama could not load the model — your machine ran out of memory (RAM/VRAM). "
            "This is not a prompt-size problem: shrinking the transcript won't help. "
            "Free up memory (close other apps) or switch to a smaller model "
            "(e.g. `llama3.2:1b`, `qwen2.5:3b`, or `phi3:mini`)."
        )
    elif diag.last_reason == "context":
        base = (
            "The prompt was too large for the model's context window. I reduced the transcript "
            "into chunks and retried with a smaller context."
        )
    elif diag.last_reason == "timeout":
        base = (
            "Ollama took too long to respond. The model may be loading for the first time or the "
            "machine is under load. I retried with a smaller prompt and a fallback model."
        )
    else:
        base = (
            "Ollama crashed while generating. This usually means the prompt was too large or the "
            "selected model failed. I reduced the transcript into chunks and retried."
        )

    bits = [
        f"Selected model: {diag.selected_model or 'n/a'}",
        f"Final model used: {diag.final_model or 'n/a'}",
        f"Prompt size: {diag.prompt_size:,} chars (~{estimate_tokens('x' * diag.prompt_size):,} tokens)",
        f"Context size: {diag.context_size}",
        f"Retries: {diag.retry_count}",
    ]
    if emergency:
        bits.append("Output: emergency template (built from the transcript without the model)")
    msg = base + "\n\n" + "\n".join(f"• {b}" for b in bits)
    if diag.last_error_body:
        msg += f"\n\nOllama said:\n{diag.last_error_body.strip()[:400]}"
    return msg
