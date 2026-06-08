"""Local LLM client — talks to a local OpenAI-compatible /v1 endpoint.

Works with either backend out of the box (no API key required):
  • Ollama     — http://localhost:11434/v1   (default; `ollama pull llama3.1:8b`)
  • llama.cpp  — http://localhost:8080/v1     (`llama-server -m model.gguf`)

When the backend is Ollama we prefer its NATIVE /api/chat endpoint with
``think: false``. This matters a lot: "thinking" models (qwen3, deepseek-r1,
gpt-oss…) otherwise spend their whole token budget on hidden reasoning and return
an EMPTY answer over the OpenAI /v1 endpoint (which has no way to disable it).
Disabling thinking makes those models return real content — and far faster.
Non-Ollama backends transparently fall back to the OpenAI /v1 endpoint.

Switch backends by changing LOCAL_LLM_URL in .env. Blocking network I/O — call
via asyncio.to_thread from async routes.
"""
from __future__ import annotations

from typing import List, Optional

import httpx

from core.config import config

# Local CPU inference can be slow: fail fast if the server is down (connect),
# but allow a long read window for a full script generation. The first call
# after the model is idle/unloaded pays a cold-load cost (Ollama unloads after
# ~5 min), so the read budget is generous to avoid an unwanted template fallback.
_TIMEOUT = httpx.Timeout(connect=5.0, read=600.0, write=30.0, pool=5.0)
_PROBE_TIMEOUT = httpx.Timeout(connect=3.0, read=5.0, write=5.0, pool=3.0)

# Cached transport choice: True = backend speaks Ollama's native API (use it so we
# can pass think:false); False = OpenAI /v1 only (llama.cpp etc.); None = unprobed.
_NATIVE_OK: Optional[bool] = None


def _v1_endpoint() -> str:
    return config.local_llm_url.rstrip("/") + "/chat/completions"


def _ollama_base() -> str:
    """Host root for Ollama's native API — the config URL with a trailing /v1 removed."""
    url = (config.local_llm_url or "").rstrip("/")
    if url.endswith("/v1"):
        url = url[: -len("/v1")].rstrip("/")
    return url


def reset_backend_cache() -> None:
    """Forget the cached transport choice. Call after the backend URL changes."""
    global _NATIVE_OK
    _NATIVE_OK = None


def _detect_native() -> bool:
    """Cached probe: does the backend answer Ollama's native /api/tags?"""
    global _NATIVE_OK
    if _NATIVE_OK is not None:
        return _NATIVE_OK
    try:
        r = httpx.get(_ollama_base() + "/api/tags", timeout=_PROBE_TIMEOUT)
        _NATIVE_OK = r.status_code == 200
    except httpx.HTTPError:
        _NATIVE_OK = False
    return _NATIVE_OK


def _chat_ollama_native(model: str, messages: List[dict], max_tokens: int,
                        temperature: float, top_p: float) -> str:
    """Ollama /api/chat with thinking disabled. Raises RuntimeError on failure."""
    base = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {"temperature": temperature, "top_p": top_p,
                    "num_predict": max_tokens},
    }
    url = _ollama_base() + "/api/chat"
    try:
        r = httpx.post(url, json={**base, "think": False}, timeout=_TIMEOUT,
                       headers={"Content-Type": "application/json"})
        # Some models reject the think flag ("does not support thinking") — retry plain.
        if r.status_code == 400 and "think" in (r.text or "").lower():
            r = httpx.post(url, json=base, timeout=_TIMEOUT,
                           headers={"Content-Type": "application/json"})
    except httpx.HTTPError as e:
        raise RuntimeError(f"Local LLM unreachable at {config.local_llm_url}: {e}") from e
    if r.status_code != 200:
        raise RuntimeError(f"Local LLM {r.status_code}: {(r.text or '')[:200]}")
    data = r.json()
    msg = data.get("message") or {}
    text = msg.get("content")
    if not text:
        # A thinking model that ignored think:false and used its whole budget reasoning.
        if msg.get("thinking") and data.get("done_reason") == "length":
            raise RuntimeError(
                f"model '{model}' spent its token budget thinking and returned no "
                f"answer — pick a non-reasoning model in Settings → AI Model")
        raise RuntimeError("Local LLM returned empty response")
    return text


def _chat_openai_v1(model: str, messages: List[dict], max_tokens: int,
                    temperature: float, top_p: float) -> str:
    """OpenAI-compatible /v1/chat/completions. Raises RuntimeError on failure."""
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "top_p": top_p,
        "stream": False,
    }
    try:
        r = httpx.post(_v1_endpoint(), json=payload, timeout=_TIMEOUT,
                       headers={"Content-Type": "application/json"})
    except httpx.HTTPError as e:
        raise RuntimeError(f"Local LLM unreachable at {config.local_llm_url}: {e}") from e
    if r.status_code != 200:
        raise RuntimeError(f"Local LLM {r.status_code}: {(r.text or '')[:200]}")
    data = r.json()
    text = (((data.get("choices") or [{}])[0]).get("message") or {}).get("content")
    if not text:
        raise RuntimeError("Local LLM returned empty response")
    return text


def chat(user: str, system: Optional[str] = None, *, max_tokens: int = 3500,
         temperature: float = 1.0, top_p: float = 0.95,
         model: Optional[str] = None) -> str:
    """Single-turn chat completion against the local model. Returns the text.

    Routes to Ollama's native endpoint (thinking disabled) when available, else
    the OpenAI /v1 endpoint. Raises RuntimeError on transport/HTTP/empty-response
    errors so callers can fall back or surface a clear message.
    """
    messages: List[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user})
    mdl = model or config.local_llm_model
    if _detect_native():
        return _chat_ollama_native(mdl, messages, max_tokens, temperature, top_p)
    return _chat_openai_v1(mdl, messages, max_tokens, temperature, top_p)


def probe_reachable() -> bool:
    """True if the local server answers GET /models (cheap reachability check)."""
    url = config.local_llm_url.rstrip("/") + "/models"
    try:
        r = httpx.get(url, timeout=httpx.Timeout(connect=3.0, read=5.0,
                                                 write=5.0, pool=3.0))
        return r.status_code == 200
    except httpx.HTTPError:
        return False
