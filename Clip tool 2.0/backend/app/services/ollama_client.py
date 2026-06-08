"""Ollama HTTP client.

A thin, dependency-light wrapper over the Ollama REST API (``/api/generate``,
``/api/chat``, ``/api/tags``). Designed to be called synchronously from Celery
workers, with extra care taken to coax *reliable JSON* out of reasoning models
such as Qwen3 and DeepSeek-R1 (which interleave ``<think>…</think>`` blocks).
"""
from __future__ import annotations

import json
import re
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


class OllamaError(RuntimeError):
    pass


def strip_reasoning(text: str) -> str:
    """Remove ``<think>`` blocks emitted by reasoning models."""
    return _THINK_RE.sub("", text).strip()


def extract_json(text: str) -> Any:
    """Best-effort extraction of a JSON value from a model's text response.

    Handles markdown fences, leading prose, and reasoning tags. Raises
    :class:`OllamaError` if nothing parseable is found.
    """
    cleaned = strip_reasoning(text).strip()

    # 1) Direct parse.
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # 2) Fenced code block.
    fence = _FENCE_RE.search(cleaned)
    if fence:
        try:
            return json.loads(fence.group(1).strip())
        except json.JSONDecodeError:
            cleaned = fence.group(1).strip()

    # 3) Slice from the first opening bracket to the matching close.
    for opener, closer in (("[", "]"), ("{", "}")):
        start = cleaned.find(opener)
        end = cleaned.rfind(closer)
        if start != -1 and end != -1 and end > start:
            candidate = cleaned[start : end + 1]
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                continue

    raise OllamaError(f"Could not parse JSON from model output: {text[:300]!r}")


class OllamaClient:
    def __init__(
        self,
        base_url: str | None = None,
        timeout: int | None = None,
    ) -> None:
        self.base_url = (base_url or settings.OLLAMA_BASE_URL).rstrip("/")
        self.timeout = timeout or settings.OLLAMA_TIMEOUT

    # ------------------------------------------------------------------ core
    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.post(url, json=payload)
                resp.raise_for_status()
                return resp.json()
        except httpx.HTTPStatusError as exc:
            raise OllamaError(f"Ollama {path} -> {exc.response.status_code}: {exc.response.text[:200]}") from exc
        except httpx.HTTPError as exc:
            raise OllamaError(f"Ollama request to {url} failed: {exc}") from exc

    def generate(
        self,
        prompt: str,
        *,
        model: str | None = None,
        system: str | None = None,
        format: str | dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
        images: list[str] | None = None,
    ) -> dict[str, Any]:
        """Call ``/api/generate`` (non-streaming). Returns the raw Ollama response."""
        payload: dict[str, Any] = {
            "model": model or settings.OLLAMA_DEFAULT_MODEL,
            "prompt": prompt,
            "stream": False,
            "keep_alive": settings.OLLAMA_KEEP_ALIVE,
            "options": {"num_ctx": settings.OLLAMA_NUM_CTX, **(options or {})},
        }
        if system:
            payload["system"] = system
        if format is not None:
            payload["format"] = format
        if images:
            payload["images"] = images
        return self._post("/api/generate", payload)

    def chat(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str | None = None,
        format: str | dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model or settings.OLLAMA_DEFAULT_MODEL,
            "messages": messages,
            "stream": False,
            "keep_alive": settings.OLLAMA_KEEP_ALIVE,
            "options": {"num_ctx": settings.OLLAMA_NUM_CTX, **(options or {})},
        }
        if format is not None:
            payload["format"] = format
        return self._post("/api/chat", payload)

    # --------------------------------------------------------------- helpers
    def generate_json(
        self,
        prompt: str,
        *,
        model: str | None = None,
        system: str | None = None,
        schema: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
        retries: int = 2,
    ) -> tuple[Any, dict[str, Any]]:
        """Generate and parse JSON, retrying with a stricter nudge on failure.

        Returns ``(parsed_json, meta)`` where ``meta`` carries timing & token
        stats for audit logging.
        """
        # Prefer schema-constrained decoding when a schema is supplied; fall
        # back to plain JSON mode otherwise.
        fmt: str | dict[str, Any] = schema if schema else "json"
        last_err: Exception | None = None
        attempt_prompt = prompt

        for attempt in range(retries + 1):
            started = time.perf_counter()
            resp = self.generate(
                attempt_prompt,
                model=model,
                system=system,
                format=fmt,
                options=options,
            )
            elapsed_ms = (time.perf_counter() - started) * 1000
            raw = resp.get("response", "")
            meta = {
                "model": resp.get("model"),
                "duration_ms": elapsed_ms,
                "eval_count": resp.get("eval_count"),
                "prompt_eval_count": resp.get("prompt_eval_count"),
            }
            try:
                return extract_json(raw), meta
            except OllamaError as exc:
                last_err = exc
                logger.warning("JSON parse failed (attempt %d/%d): %s", attempt + 1, retries + 1, exc)
                attempt_prompt = (
                    prompt
                    + "\n\nIMPORTANT: Respond with ONLY valid JSON. No prose, no markdown, no <think> tags."
                )
                fmt = "json"  # drop schema constraint on retry in case it's the issue

        raise OllamaError(f"Failed to obtain valid JSON after {retries + 1} attempts: {last_err}")

    def list_models(self) -> list[dict[str, Any]]:
        url = f"{self.base_url}/api/tags"
        try:
            with httpx.Client(timeout=30) as client:
                resp = client.get(url)
                resp.raise_for_status()
                return resp.json().get("models", [])
        except httpx.HTTPError as exc:
            logger.warning("Could not list Ollama models: %s", exc)
            return []

    def health(self) -> bool:
        try:
            with httpx.Client(timeout=5) as client:
                return client.get(f"{self.base_url}/api/version").status_code == 200
        except httpx.HTTPError:
            return False


async def list_models_async() -> list[dict[str, Any]]:
    """Async variant used by the FastAPI ``/models`` endpoint."""
    url = f"{settings.OLLAMA_BASE_URL.rstrip('/')}/api/tags"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            return resp.json().get("models", [])
    except httpx.HTTPError as exc:
        logger.warning("Could not list Ollama models (async): %s", exc)
        return []


async def pull_model_stream(name: str) -> AsyncIterator[dict[str, Any]]:
    """Pull a model via Ollama's ``/api/pull``, yielding each NDJSON progress event.

    Ollama streams objects like ``{"status": "downloading ...", "total": N,
    "completed": M}`` and finally ``{"status": "success"}``. On failure it yields a
    single ``{"status": "error", "error": "..."}`` event. The download can take a
    long time and be large, so there is no overall timeout.
    """
    url = f"{settings.OLLAMA_BASE_URL.rstrip('/')}/api/pull"
    timeout = httpx.Timeout(30.0, read=None)  # no read timeout: downloads are slow
    try:
        async with (
            httpx.AsyncClient(timeout=timeout) as client,
            client.stream("POST", url, json={"name": name, "stream": True}) as resp,
        ):
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", "replace")
                yield {"status": "error", "error": f"HTTP {resp.status_code}: {body[:200]}"}
                return
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except httpx.HTTPError as exc:
        yield {"status": "error", "error": f"Could not reach Ollama: {exc}"}


async def delete_model_async(name: str) -> bool:
    """Remove a model via Ollama's ``/api/delete``. Returns True on success."""
    url = f"{settings.OLLAMA_BASE_URL.rstrip('/')}/api/delete"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request("DELETE", url, json={"name": name})
            return resp.status_code == 200
    except httpx.HTTPError as exc:
        logger.warning("Could not delete Ollama model %s: %s", name, exc)
        return False


# Convenience singleton for workers.
ollama = OllamaClient()
