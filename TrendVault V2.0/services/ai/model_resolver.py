"""Per-task model + provider resolution for the central AI Task Router.

The studio runs a single local OpenAI-compatible backend (Ollama / llama.cpp),
so the *provider* is always ``"local"``. What varies per task is the *model*:

1. A request may pin an explicit model (``selectedModel``).
2. Otherwise it may address a model *role* (``modelRole`` — e.g. "improve",
   "script", "ideas") that an operator mapped to a specific installed model via
   ``model_admin.set_role_model`` (persisted in ``data/llm-settings.json``).
3. Anything unmapped falls back to the global ``config.local_llm_model``.

Resolution is reported back in every AI response so the UI can show exactly which
model answered — addressing "use the model selected for that specific task".
"""
from __future__ import annotations

from typing import List, Optional, Tuple

from core.config import config
from services.llm import model_admin

# Models we must NOT auto-pick as a text model when healing a missing selection.
_VISION_HINTS = ("moondream", "llava", "vision", "-vl", "bakllava", "minicpm-v")
_EMBED_HINTS = ("embed", "bge", "nomic")
# Pure-reasoning models that ignore Ollama's think:false and burn their whole
# token budget on hidden reasoning (returning empty content). Avoid auto-picking
# them — they're a last resort behind any tameable model.
_REASONING_HINTS = ("deepseek-r1", "-r1", "qwq", "marco-o1", "reasoning", "thinking")

# Default role -> task hints. The resolver also accepts the taskType itself as a
# role so callers don't have to pass modelRole explicitly.
_TASK_DEFAULT_ROLE = {
    "improve-prompt": "improve",
    "generate-categories": "ideas",
    "generate-subjects": "ideas",
    "generate-trending-topics": "ideas",
    "generate-prompts": "ideas",
    "extend-script": "script",
    "regenerate-script": "script",
    "generate-script": "script",
}


def resolve(req: dict) -> Tuple[str, str]:
    """Return ``(provider, model)`` for this AI task request.

    Never raises — always yields a usable model (falls back to the global one).
    """
    explicit = str(req.get("selectedModel") or "").strip()
    if explicit:
        return "local", explicit

    # Prefer an explicit modelRole; else map the taskType to a default role.
    role = str(req.get("modelRole") or "").strip()
    if not role:
        task_type = str(req.get("taskType") or req.get("action") or "").strip()
        role = _TASK_DEFAULT_ROLE.get(task_type, task_type)

    if role:
        role_model = model_admin.get_role_model(role)
        if role_model:
            return "local", role_model

    return "local", (config.local_llm_model or "").strip() or "llama3.1:8b"


def _pick_fallback_text_model(models: List[dict], exclude: Optional[str] = None) -> Optional[str]:
    """Best installed general text model: skip vision/embedding, prefer the
    SMALLEST (fastest on CPU), with non-reasoning models winning ties."""
    cands = [
        m for m in models
        if m.get("name") and m["name"] != exclude
        and not any(h in m["name"].lower() for h in _VISION_HINTS)
        and not any(h in m["name"].lower() for h in _EMBED_HINTS)
    ]
    if not cands:
        return None

    def key(m: dict):
        low = m["name"].lower()
        size = m.get("size") or float("inf")        # unknown size sorts last
        # Primary: avoid pure-reasoning models (they can't be tamed). Then smallest.
        is_reasoning = 1 if any(h in low for h in _REASONING_HINTS) else 0
        return (is_reasoning, size)

    return sorted(cands, key=key)[0]["name"]


def ensure_available(model: str) -> Tuple[str, Optional[str], Optional[str]]:
    """Validate ``model`` against the installed list, healing if it's missing.

    Returns ``(model_to_use, warning, error)``:
      • model installed (or backend can't enumerate) → ``(model, None, None)``
      • model missing, a substitute exists           → ``(substitute, warning, None)``
      • model missing, nothing else installed         → ``(model, None, error)``

    Backend unreachable is left to the LLM call (it produces the precise
    "start your backend" message), so this never blocks on a transient probe.
    """
    backend, models = model_admin.list_models()
    names = [m.get("name") for m in models if m.get("name")]
    if backend == "unknown" or not names:
        return model, None, None  # can't enumerate — let the actual call decide
    if model in names:
        return model, None, None
    substitute = _pick_fallback_text_model(models, exclude=model)
    if substitute:
        return substitute, (
            f"Selected model '{model}' is not installed — using '{substitute}' instead. "
            f"Pull '{model}' (e.g. `ollama pull {model}`) or pick an installed model "
            f"in Settings → AI Model."
        ), None
    return model, None, (
        f"The selected AI model '{model}' is not installed and no usable model was found. "
        f"Pull one first (e.g. `ollama pull {model}`)."
    )
