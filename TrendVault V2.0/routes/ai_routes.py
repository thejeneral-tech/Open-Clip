"""AI routes — the central router endpoint plus the named feature endpoints.

Everything funnels through ``services.ai.router.run_task`` so prompt building,
model selection, structured parsing, and error handling live in ONE place.

  • POST /api/ai/task                         generic AITaskRequest entry point
  • POST /api/trend-vault/improve-prompt      "Apply AI" on the story prompt
  • POST /api/trend-vault/generate-categories niche -> categories
  • POST /api/trend-vault/generate-subjects   niche/category -> subjects
  • POST /api/trend-vault/generate-trending-topics  niche/category -> topics
  • POST /api/trend-vault/generate-prompts    fresh story prompts (with exclusions)
  • POST /api/trend-vault/extend-script       add lines to an existing script
  • POST /api/trend-vault/regenerate-script   reframe an existing script

The named endpoints shape the router's envelope into the exact legacy response
each frontend feature already expects. Task-level failures (model down, empty
output) return HTTP 200 with ``{"ok": false, "error": "<specific message>"}`` —
the original content is preserved client-side, and the error is never vague.
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict

from fastapi import APIRouter, Request

from services.ai.router import run_task


def setup_ai_routes() -> APIRouter:
    router = APIRouter(tags=["ai"])

    async def _run(req: Dict[str, Any]) -> Dict[str, Any]:
        # run_task does blocking network I/O to the local model — keep the loop free.
        return await asyncio.to_thread(run_task, req)

    # ── Generic router endpoint (full AITaskRequest in, full envelope out) ────
    @router.post("/api/ai/task")
    async def ai_task(request: Request):
        body = await request.json()
        return await _run(body)

    # ── Named feature endpoints (legacy-compatible response shapes) ───────────
    @router.post("/api/trend-vault/improve-prompt")
    async def improve_prompt(request: Request):
        body = await request.json()
        env = await _run({**body, "taskType": "improve-prompt", "modelRole": "improve",
                          "pageId": "trend-vault", "featureId": "apply-ai"})
        if not env["ok"]:
            return {"ok": False, "error": env["error"], "provider": env["provider"]}
        res = env["result"]
        return {
            "ok": True,
            "improvedPrompt": res["improvedPrompt"],
            "addedDetails": res.get("addedDetails"),
            "explanation": res.get("explanation"),
            "emotionalToneApplied": res.get("emotionalToneApplied", False),
            "provider": env["provider"],
            "model": env["model"],
            "warning": env.get("warning"),
        }

    @router.post("/api/trend-vault/generate-categories")
    async def generate_categories(request: Request):
        body = await request.json()
        env = await _run({**body, "taskType": "generate-categories",
                          "pageId": "trend-vault", "featureId": "categories"})
        if not env["ok"]:
            return {"ok": False, "error": env["error"]}
        return {"ok": True, "categories": env["result"]["categories"],
                "provider": env["provider"], "model": env["model"]}

    @router.post("/api/trend-vault/generate-subjects")
    async def generate_subjects(request: Request):
        body = await request.json()
        env = await _run({**body, "taskType": "generate-subjects",
                          "pageId": "trend-vault", "featureId": "subjects"})
        if not env["ok"]:
            return {"ok": False, "error": env["error"]}
        return {"ok": True, "subjects": env["result"]["subjects"],
                "provider": env["provider"], "model": env["model"]}

    @router.post("/api/trend-vault/generate-trending-topics")
    async def generate_trending_topics(request: Request):
        body = await request.json()
        env = await _run({**body, "taskType": "generate-trending-topics",
                          "pageId": "trend-vault", "featureId": "trending-topics"})
        if not env["ok"]:
            return {"ok": False, "error": env["error"]}
        return {"ok": True, "topics": env["result"]["topics"],
                "provider": env["provider"], "model": env["model"]}

    @router.post("/api/trend-vault/generate-prompts")
    async def generate_prompts(request: Request):
        body = await request.json()
        env = await _run({**body, "taskType": "generate-prompts",
                          "pageId": "trend-vault", "featureId": "fresh-prompts"})
        if not env["ok"]:
            return {"ok": False, "error": env["error"]}
        return {"ok": True, "prompts": env["result"]["prompts"],
                "provider": env["provider"], "model": env["model"],
                "warning": env.get("warning")}

    @router.post("/api/trend-vault/extend-script")
    async def extend_script(request: Request):
        body = await request.json()
        env = await _run({**body, "taskType": "extend-script",
                          "pageId": "trend-vault", "featureId": "add-lines"})
        if not env["ok"]:
            return {"ok": False, "error": env["error"]}
        return {"ok": True, "lines": env["result"]["lines"], "source": "local",
                "provider": env["provider"], "model": env["model"]}

    @router.post("/api/trend-vault/regenerate-script")
    async def regenerate_script(request: Request):
        body = await request.json()
        env = await _run({**body, "taskType": "regenerate-script",
                          "pageId": "trend-vault", "featureId": "reframe"})
        if not env["ok"]:
            return {"ok": False, "error": env["error"]}
        return {"ok": True, "lines": env["result"]["lines"], "source": "local",
                "provider": env["provider"], "model": env["model"],
                "warning": env.get("warning")}

    return router
