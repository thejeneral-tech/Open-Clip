"""Centralized Ollama service layer.

Every AI request in the automation system passes through :data:`ollama_service`.
It sits on top of the thin :class:`~app.services.ollama_client.OllamaClient` and
adds the cross-cutting concerns the spec calls for:

* **Model routing** — resolve a per-*stage* model from a bot's ``model_assignments``
  (falling back to global settings), so different stages can use different models.
* **Concurrency control** — a process-local semaphore caps simultaneous
  generations (sized by ``OLLAMA_MAX_CONCURRENCY``) so a single GPU isn't
  oversubscribed.
* **Retry** — reuses the client's JSON-coaxing retry loop.
* **Health / load / VRAM** — ``/api/version``, ``/api/ps`` (loaded models + VRAM),
  and an optional ``nvidia-smi`` probe for GPU utilisation.
* **Local embeddings** — ``/api/embed`` with a ``/api/embeddings`` fallback.

It is deliberately framework-agnostic (no FastAPI/Celery imports) so it can be
called from workers, the API, and tests alike. **All inference is local** — this
module only ever talks to the configured Ollama endpoint.
"""
from __future__ import annotations

import shutil
import subprocess
import threading
from typing import Any

import httpx

from app.core.config import settings
from app.core.logging import get_logger
from app.services.ollama_client import OllamaClient, ollama

logger = get_logger(__name__)

# Logical pipeline stages → the settings key holding their default model. A bot's
# ``model_assignments`` may override any of these by stage name.
_STAGE_DEFAULTS: dict[str, str] = {
    "default": "OLLAMA_DEFAULT_MODEL",
    "discovery": "OLLAMA_DEFAULT_MODEL",
    "scoring": "OLLAMA_RANKING_MODEL",
    "clip_selection": "OLLAMA_DEFAULT_MODEL",
    "ranking": "OLLAMA_RANKING_MODEL",
    "reasoning": "OLLAMA_DEFAULT_MODEL",
    "titles": "OLLAMA_DEFAULT_MODEL",
    "metadata": "OLLAMA_DEFAULT_MODEL",
    "description": "OLLAMA_DEFAULT_MODEL",
    "captions": "OLLAMA_DEFAULT_MODEL",
    "thumbnail": "OLLAMA_VISION_MODEL",
    "vision": "OLLAMA_VISION_MODEL",
    "embedding": "OLLAMA_EMBED_MODEL",
}


class OllamaService:
    def __init__(self, client: OllamaClient | None = None, max_concurrency: int | None = None):
        self.client = client or ollama
        self._sem = threading.Semaphore(max(1, max_concurrency or settings.OLLAMA_MAX_CONCURRENCY))

    @property
    def base_url(self) -> str:
        return self.client.base_url

    # ----------------------------------------------------------- model routing
    def resolve_model(
        self, stage: str, assignments: dict[str, Any] | None = None, fallback: str | None = None
    ) -> str:
        """Pick the model for ``stage``.

        Order of precedence: explicit per-bot assignment → ``fallback`` →
        the stage's configured default → the global default model.
        """
        assignments = assignments or {}
        chosen = assignments.get(stage)
        if chosen:
            return str(chosen)
        if fallback:
            return fallback
        settings_key = _STAGE_DEFAULTS.get(stage, "OLLAMA_DEFAULT_MODEL")
        return getattr(settings, settings_key, settings.OLLAMA_DEFAULT_MODEL)

    # ---------------------------------------------------------------- generate
    def generate_json(
        self,
        stage: str,
        prompt: str,
        *,
        assignments: dict[str, Any] | None = None,
        model: str | None = None,
        system: str | None = None,
        schema: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
        retries: int = 2,
    ) -> tuple[Any, dict[str, Any]]:
        """Routed, concurrency-gated structured generation. Returns ``(json, meta)``."""
        resolved = self.resolve_model(stage, assignments, fallback=model)
        with self._sem:
            parsed, meta = self.client.generate_json(
                prompt,
                model=resolved,
                system=system,
                schema=schema,
                options=options,
                retries=retries,
            )
        meta.setdefault("stage", stage)
        meta.setdefault("model", resolved)
        return parsed, meta

    def generate_text(
        self,
        stage: str,
        prompt: str,
        *,
        assignments: dict[str, Any] | None = None,
        model: str | None = None,
        system: str | None = None,
        options: dict[str, Any] | None = None,
    ) -> str:
        resolved = self.resolve_model(stage, assignments, fallback=model)
        with self._sem:
            resp = self.client.generate(prompt, model=resolved, system=system, options=options)
        from app.services.ollama_client import strip_reasoning

        return strip_reasoning(resp.get("response", ""))

    # -------------------------------------------------------------- embeddings
    def embed(
        self, texts: list[str], *, model: str | None = None, assignments: dict[str, Any] | None = None
    ) -> list[list[float]]:
        """Return one local embedding vector per input string.

        Tries the modern batched ``/api/embed`` first, then falls back to the
        per-prompt ``/api/embeddings`` endpoint for older Ollama builds.
        """
        if not texts:
            return []
        resolved = self.resolve_model("embedding", assignments, fallback=model)
        url = f"{self.base_url}/api/embed"
        with self._sem:
            try:
                with httpx.Client(timeout=120) as client:
                    resp = client.post(url, json={"model": resolved, "input": texts})
                    if resp.status_code == 200:
                        data = resp.json()
                        if data.get("embeddings"):
                            return [list(map(float, v)) for v in data["embeddings"]]
            except httpx.HTTPError as exc:
                logger.debug("Batched /api/embed failed, falling back: %s", exc)

            out: list[list[float]] = []
            legacy = f"{self.base_url}/api/embeddings"
            with httpx.Client(timeout=120) as client:
                for text in texts:
                    try:
                        resp = client.post(legacy, json={"model": resolved, "prompt": text})
                        resp.raise_for_status()
                        out.append([float(x) for x in resp.json().get("embedding", [])])
                    except httpx.HTTPError as exc:
                        logger.warning("Embedding failed for one item: %s", exc)
                        out.append([])
            return out

    # ----------------------------------------------------------- health / load
    def health(self) -> bool:
        return self.client.health()

    def running_models(self) -> list[dict[str, Any]]:
        """Models currently loaded in Ollama (``/api/ps``) with VRAM sizing."""
        try:
            with httpx.Client(timeout=10) as client:
                resp = client.get(f"{self.base_url}/api/ps")
                resp.raise_for_status()
                return resp.json().get("models", [])
        except httpx.HTTPError as exc:
            logger.debug("Could not read /api/ps: %s", exc)
            return []

    def gpu_status(self) -> dict[str, Any]:
        """Combine Ollama's loaded-model VRAM with an optional nvidia-smi probe.

        Works headless: if ``nvidia-smi`` is absent (CPU-only host) the ``gpus``
        list is simply empty — callers should treat that as "CPU mode", not an
        error.
        """
        loaded = self.running_models()
        loaded_vram = sum(int(m.get("size_vram", 0) or 0) for m in loaded)
        status: dict[str, Any] = {
            "ollama_up": self.health(),
            "base_url": self.base_url,
            "max_concurrency": settings.OLLAMA_MAX_CONCURRENCY,
            "loaded_models": [
                {
                    "name": m.get("name") or m.get("model"),
                    "size": m.get("size"),
                    "size_vram": m.get("size_vram"),
                    "expires_at": m.get("expires_at"),
                }
                for m in loaded
            ],
            "loaded_vram_bytes": loaded_vram,
            "gpus": self._nvidia_smi(),
        }
        return status

    @staticmethod
    def _nvidia_smi() -> list[dict[str, Any]]:
        exe = shutil.which("nvidia-smi")
        if not exe:
            return []
        query = (
            "index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu"
        )
        try:
            out = subprocess.run(  # noqa: S603 - fixed args, no shell
                [exe, f"--query-gpu={query}", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            logger.debug("nvidia-smi probe failed: %s", exc)
            return []
        gpus: list[dict[str, Any]] = []
        for line in out.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 7:
                continue
            try:
                gpus.append(
                    {
                        "index": int(parts[0]),
                        "name": parts[1],
                        "memory_total_mb": int(float(parts[2])),
                        "memory_used_mb": int(float(parts[3])),
                        "memory_free_mb": int(float(parts[4])),
                        "utilization_pct": int(float(parts[5])),
                        "temperature_c": int(float(parts[6])),
                    }
                )
            except ValueError:
                continue
        return gpus


# Convenience singleton shared by workers, the API, and the discovery/scoring
# services — the single gateway every AI request flows through.
ollama_service = OllamaService()
