"""Local-LLM model administration — list/select models, switch backend, pull.

Talks to the configured local endpoint (``config.local_llm_url``, an OpenAI-
compatible /v1 base). Model listing prefers Ollama's native ``/api/tags`` (richer:
includes size) and falls back to the OpenAI ``/v1/models`` shape (llama.cpp).
Pulling is Ollama-only (``POST /api/pull``). Settings (url/model) persist to
``data/llm-settings.json`` and override the .env defaults on startup.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Tuple

import httpx

from core.config import config
from core.constants import DATA_DIR

_SETTINGS_FILE = os.path.join(DATA_DIR, "llm-settings.json")
_PROBE_TIMEOUT = httpx.Timeout(connect=3.0, read=5.0, write=5.0, pool=3.0)


def _ollama_base() -> str:
    """Host root for Ollama's native API — the config URL with a trailing /v1 removed."""
    url = (config.local_llm_url or "").rstrip("/")
    if url.endswith("/v1"):
        url = url[: -len("/v1")].rstrip("/")
    return url


def list_models() -> Tuple[str, List[Dict[str, Any]]]:
    """Return ``(backend, models)``. backend is ollama | llamacpp | unknown;
    models is ``[{"name": str, "size": int|None}]``."""
    # Ollama native — richest (name + size in bytes).
    try:
        r = httpx.get(f"{_ollama_base()}/api/tags", timeout=_PROBE_TIMEOUT)
        if r.status_code == 200:
            tags = (r.json() or {}).get("models") or []
            models = [{"name": m.get("name"), "size": m.get("size")}
                      for m in tags if m.get("name")]
            return "ollama", models
    except httpx.HTTPError:
        pass
    # OpenAI-compatible /v1/models (llama.cpp, or any compatible server).
    try:
        base = (config.local_llm_url or "").rstrip("/")
        r = httpx.get(f"{base}/models", timeout=_PROBE_TIMEOUT)
        if r.status_code == 200:
            data = (r.json() or {}).get("data") or []
            models = [{"name": m.get("id"), "size": None}
                      for m in data if m.get("id")]
            return "llamacpp", models
    except httpx.HTTPError:
        pass
    return "unknown", []


def get_status() -> Dict[str, Any]:
    """Current backend + reachability + installed models, for the settings UI."""
    backend, models = list_models()
    return {
        "url": config.local_llm_url,
        "model": config.local_llm_model,
        "backend": backend,
        "reachable": backend != "unknown",
        "pullable": backend == "ollama",
        "models": models,
    }


def save_settings(url: Optional[str] = None, model: Optional[str] = None) -> None:
    """Apply (in-memory ``config``) + persist url/model. Only non-None fields change."""
    if url is not None:
        url = url.strip()
        if url:
            config.local_llm_url = url
    if model is not None:
        model = model.strip()
        if model:
            config.local_llm_model = model
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = _SETTINGS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"url": config.local_llm_url, "model": config.local_llm_model},
                  f, indent=2)
    os.replace(tmp, _SETTINGS_FILE)


def load_overrides() -> None:
    """Apply persisted url/model over the .env-derived defaults. Call at startup."""
    try:
        with open(_SETTINGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return
    url = (data.get("url") or "").strip()
    model = (data.get("model") or "").strip()
    if url:
        config.local_llm_url = url
    if model:
        config.local_llm_model = model


async def pull_stream(name: str):
    """Stream Ollama pull progress as ndjson lines (one JSON object per line).

    Ollama-only. Each line is e.g. ``{"status":"downloading","total":N,"completed":M}``,
    ending with ``{"status":"success"}`` or ``{"status":"error","error":...}``.
    """
    payload = {"name": name, "stream": True}
    # No read timeout: a model pull can take many minutes.
    timeout = httpx.Timeout(connect=10.0, read=None, write=30.0, pool=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", f"{_ollama_base()}/api/pull",
                                     json=payload) as r:
                if r.status_code != 200:
                    body = (await r.aread()).decode("utf-8", "ignore")[:200]
                    yield json.dumps({"status": "error",
                                      "error": f"pull HTTP {r.status_code}: {body}"}) + "\n"
                    return
                async for line in r.aiter_lines():
                    if line.strip():
                        yield line + "\n"
    except httpx.HTTPError as e:
        yield json.dumps({"status": "error",
                          "error": f"Ollama unreachable at {_ollama_base()}: {e}"}) + "\n"
