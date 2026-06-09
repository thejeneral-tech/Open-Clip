"""Developer/diagnostic routes — prove the LIVE running server's state.

These exist so a failure can be traced without guessing: they report the exact
routes the running process registered, the live Ollama/model health as seen by
*this* backend, and a self-test that runs every AI task through the real router.

All three are mounted under /api/debug and are auth-exempt (see app.py) so they
work before login on a localhost-only dev box. They expose model names, URLs and
short status strings — never private transcripts or secrets.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, List

from fastapi import APIRouter, Request

from core.config import config
from core.constants import APP_VERSION, BUILD_ID


def setup_debug_routes() -> APIRouter:
    router = APIRouter(prefix="/api/debug", tags=["debug"])

    @router.get("/routes")
    async def list_routes(request: Request):
        """Every route the RUNNING app registered (method + path)."""
        out: List[Dict[str, Any]] = []
        for r in request.app.routes:
            path = getattr(r, "path", None)
            methods = sorted(getattr(r, "methods", None) or [])
            if path:
                out.append({"path": path, "methods": methods})
        out.sort(key=lambda x: x["path"])
        ai = [r for r in out if r["path"].startswith(("/api/ai", "/api/trend-vault"))]
        return {"build": BUILD_ID, "version": APP_VERSION,
                "totalRoutes": len(out), "aiRoutes": ai, "allRoutes": out}

    @router.get("/ai-health")
    async def ai_health():
        """Live LLM health as seen by THIS backend process."""
        from services.ai import model_resolver
        from services.llm import model_admin

        def _probe() -> Dict[str, Any]:
            backend, models = model_admin.list_models()
            names = [m.get("name") for m in models if m.get("name")]
            configured = config.local_llm_model
            provider, resolved = model_resolver.resolve({"taskType": "improve-prompt"})
            healed, warn, err = model_resolver.ensure_available(resolved)
            # A tiny real generation through the full client (think:false path).
            gen_ok, gen_text, gen_err, gen_ms = False, "", None, 0
            from lib import local_llm
            t0 = time.time()
            try:
                gen_text = local_llm.chat(
                    user="Reply with exactly one word: ok",
                    system="You are a health probe. Answer in one word.",
                    model=healed, max_tokens=200, temperature=0.0)
                gen_ok = bool(gen_text and gen_text.strip())
            except Exception as e:  # noqa: BLE001
                gen_err = str(e)[:300]
            gen_ms = int((time.time() - t0) * 1000)
            return {
                "ok": backend != "unknown",
                "ollamaUrl": config.local_llm_url,
                "backend": backend,
                "settingsFile": model_admin._SETTINGS_FILE,  # noqa: SLF001
                "configuredModel": configured,
                "configuredInstalled": configured in names,
                "resolvedModel": resolved,
                "healedModel": healed,
                "healWarning": warn,
                "healError": err,
                "installedModels": names,
                "roleOverrides": model_admin.get_status().get("roles", {}),
                "liveGeneration": {"ok": gen_ok, "ms": gen_ms,
                                   "text": (gen_text or "").strip()[:80],
                                   "error": gen_err},
            }

        return await asyncio.to_thread(_probe)

    @router.get("/ai-selftest")
    async def ai_selftest(task: str = ""):
        """Run AI tasks through the live router with sample input.

        ``?task=<name>`` runs a single task (bounded call); omit to run them all.
        """
        from services.ai.router import run_task

        samples: Dict[str, Dict[str, Any]] = {
            "improve-prompt": {"currentPrompt": "a video about why people quit reading", "tone": "mysterious", "niche": "Books"},
            "generate-categories": {"niche": "Human Psychology"},
            "generate-subjects": {"niche": "Human Psychology", "category": "Dark Psychology"},
            "generate-trending-topics": {"niche": "Human Psychology", "category": "Dark Psychology"},
            "generate-prompts": {"niche": "Human Psychology", "category": "Dark Psychology", "count": 3},
            "extend-script": {"niche": "Human Psychology", "prompt": "why people self-sabotage", "addCount": 2,
                               "existingLines": [{"type": "hook", "text": "You sabotage yourself on purpose."}]},
            "regenerate-script": {"niche": "Human Psychology", "prompt": "why people self-sabotage", "category": "Dark Psychology"},
        }

        def _run_one(task_name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
            t0 = time.time()
            env = run_task({**payload, "taskType": task_name})
            return {"task": task_name, "ok": env["ok"], "model": env["model"],
                    "warning": env.get("warning"), "error": env.get("error"),
                    "ms": int((time.time() - t0) * 1000)}

        if task:
            if task not in samples:
                return {"build": BUILD_ID, "error": f"unknown task '{task}'",
                        "known": sorted(samples)}
            res = await asyncio.to_thread(_run_one, task, samples[task])
            return {"build": BUILD_ID, "passed": int(res["ok"]), "total": 1,
                    "results": [res]}

        results = await asyncio.to_thread(
            lambda: [_run_one(t, p) for t, p in samples.items()])
        return {"build": BUILD_ID, "passed": sum(1 for r in results if r["ok"]),
                "total": len(results), "results": results}

    return router
