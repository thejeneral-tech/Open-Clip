"""Central AI Task Router — the single entry point every AI feature flows through.

``run_task`` accepts a structured request (see the AITaskRequest shape the UI
sends), resolves the provider + model for that specific task, dispatches to the
matching handler, and returns a uniform envelope:

    {
      ok, taskId, taskType, pageId, featureId,
      provider, model,          # which model actually answered
      result,                   # task-specific structured output (or None)
      warning, error,           # human-readable; error is never vague
      fallbackUsed,
    }

It never throws: every failure becomes ``ok=False`` with a specific ``error`` so
the caller can surface a useful message and preserve the user's original content.
"""
from __future__ import annotations

import time
from typing import Any, Dict

from services.ai import model_resolver, tasks
from services.ai.tasks import AITaskError


def run_task(req: Dict[str, Any]) -> Dict[str, Any]:
    req = req or {}
    task_type = str(req.get("taskType") or req.get("action") or "").strip()
    task_id = str(req.get("taskId") or "").strip() or f"task_{int(time.time() * 1000)}"
    provider, model = model_resolver.resolve(req)
    model, heal_warning, heal_error = model_resolver.ensure_available(model)

    envelope: Dict[str, Any] = {
        "ok": False,
        "taskId": task_id,
        "taskType": task_type,
        "pageId": req.get("pageId"),
        "featureId": req.get("featureId"),
        "provider": provider,
        "model": model,
        "result": None,
        "warning": None,
        "error": None,
        "fallbackUsed": False,
    }

    # Selected model missing and nothing usable to substitute — stop with a clear fix.
    if heal_error:
        envelope["error"] = heal_error
        return envelope

    handler = tasks.HANDLERS.get(task_type)
    if handler is None:
        known = ", ".join(sorted(tasks.HANDLERS)) or "(none)"
        envelope["error"] = (f"Unknown AI task '{task_type or '(empty)'}'. "
                             f"Supported tasks: {known}.")
        return envelope

    try:
        out = handler(req, model) or {}
        envelope["ok"] = True
        envelope["result"] = out.get("result")
        # Surface both the auto-substitution notice and any handler warning.
        envelope["warning"] = "; ".join(
            w for w in (heal_warning, out.get("warning")) if w) or None
        envelope["fallbackUsed"] = bool(out.get("fallbackUsed") or heal_warning)
    except AITaskError as e:
        envelope["error"] = str(e)
    except Exception as e:  # noqa: BLE001 — never let an AI task crash the route
        envelope["error"] = f"AI task failed unexpectedly: {type(e).__name__}: {str(e)[:200]}"
    return envelope
