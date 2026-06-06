"""Local LLM client — talks to a local OpenAI-compatible /v1 endpoint.

Works with either backend out of the box (no API key required):
  • Ollama     — http://localhost:11434/v1   (default; `ollama pull llama3.1:8b`)
  • llama.cpp  — http://localhost:8080/v1     (`llama-server -m model.gguf`)

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


def _endpoint() -> str:
    return config.local_llm_url.rstrip("/") + "/chat/completions"


def chat(user: str, system: Optional[str] = None, *, max_tokens: int = 3500,
         temperature: float = 1.0, top_p: float = 0.95,
         model: Optional[str] = None) -> str:
    """Single-turn chat completion against the local model. Returns the text.

    Raises RuntimeError on transport/HTTP/empty-response errors so callers can
    fall back to the built-in template.
    """
    messages: List[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user})
    payload = {
        "model": model or config.local_llm_model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "top_p": top_p,
        "stream": False,
    }
    try:
        r = httpx.post(_endpoint(), json=payload, timeout=_TIMEOUT,
                       headers={"Content-Type": "application/json"})
    except httpx.HTTPError as e:
        raise RuntimeError(
            f"Local LLM unreachable at {config.local_llm_url}: {e}") from e
    if r.status_code != 200:
        raise RuntimeError(f"Local LLM {r.status_code}: {(r.text or '')[:200]}")
    data = r.json()
    text = (((data.get("choices") or [{}])[0]).get("message") or {}).get("content")
    if not text:
        raise RuntimeError("Local LLM returned empty response")
    return text


def probe_reachable() -> bool:
    """True if the local server answers GET /models (cheap reachability check)."""
    url = config.local_llm_url.rstrip("/") + "/models"
    try:
        r = httpx.get(url, timeout=httpx.Timeout(connect=3.0, read=5.0,
                                                 write=5.0, pool=3.0))
        return r.status_code == 200
    except httpx.HTTPError:
        return False
