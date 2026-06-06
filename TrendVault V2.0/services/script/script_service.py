"""Script generation service — port of the /api/trend-vault/generate-script handler.

Resolves niche/subject, then generates with a local LLM (Ollama / llama.cpp via
the OpenAI-compatible /v1 endpoint). On any failure (server unreachable, bad
JSON) it falls back to the built-in template. Blocking network I/O; call via
asyncio.to_thread from the async route.
"""
from __future__ import annotations

import json
import random
import re
import time
from typing import Any, Dict, List, Optional

from core.config import config
from lib import local_llm
from lib.prompts_lib import append_recent_hook, build_prompts, uppercase_script_lines
from lib.script_fallback import generate_fallback_script


class ScriptInputError(ValueError):
    """Raised when there's no usable subject/prompt — maps to HTTP 400."""


def parse_ai_json(raw: str) -> Dict[str, Any]:
    """Port of parseAIJson: try raw, then ```fence```, then first {..}/[..] block."""
    txt = (raw or "").strip()
    candidates: List[str] = [txt]
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", txt)
    if fence:
        candidates.append(fence.group(1).strip())
    fo, lo = txt.find("{"), txt.rfind("}")
    if fo != -1 and lo > fo:
        candidates.append(txt[fo:lo + 1])
    fa, la = txt.find("["), txt.rfind("]")
    if fa != -1 and la > fa:
        candidates.append(txt[fa:la + 1])
    last_err: Optional[Exception] = None
    for c in candidates:
        try:
            return json.loads(c)
        except Exception as e:  # noqa: BLE001
            last_err = e
    snippet = re.sub(r"\s+", " ", txt[:200])
    raise RuntimeError(f"parseAIJson: no valid JSON found. First 200 chars: \"{snippet}\". "
                       f"Underlying error: {last_err}")


def _word_count(text: str) -> int:
    return len([w for w in (text or "").split() if w])


def _generate_with_local(niche: str, params: Dict[str, Any], tone: str) -> Dict[str, Any]:
    prompts = build_prompts(params)
    text = local_llm.chat(
        user=prompts["user"], system=prompts["system"],
        max_tokens=3500, temperature=1.0, top_p=0.95,
    )
    parsed = parse_ai_json(text)
    parsed["trendVaultSign"] = niche
    parsed["topic"] = prompts["finalSubject"]
    parsed["emotionalTone"] = tone
    line_sum = sum(l.get("durationSeconds", 0) for l in parsed.get("lines", []))
    if line_sum > 0:
        parsed["totalDuration"] = line_sum
    parsed["estimatedWords"] = sum(_word_count(l.get("text", "")) for l in parsed.get("lines", []))
    try:
        first_text = (parsed.get("lines") or [{}])[0].get("text", "")
        append_recent_hook(parsed.get("hook") or first_text or "")
    except Exception:
        pass
    return uppercase_script_lines(parsed)


class ScriptService:
    def generate_script(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        niche = (payload.get("niche") or payload.get("trendVaultSign")
                 or payload.get("subject") or "General")
        final_prompt = (payload.get("storyPrompt") or payload.get("prompt") or "").strip()
        final_subject = (
            final_prompt
            or str(payload.get("trendingTopic") or "").strip()
            or str(payload.get("category") or "").strip()
            or niche
        )
        if not final_subject or final_subject == "General":
            raise ScriptInputError("Pick or type a niche/prompt first.")

        category = payload.get("category") or "general"
        trending = payload.get("trendingTopic") or ""
        angle = payload.get("angle") or ""
        tone = payload.get("emotionalTone") or "mysterious"
        subject = payload.get("subject") or ""
        random_seed = payload.get("randomSeed") or f"{int(time.time() * 1000)}-{random.random():.10f}"
        random_angle = payload.get("randomAngle") or ""

        def fallback(notice: Optional[str] = None) -> Dict[str, Any]:
            script = generate_fallback_script(niche, final_prompt or final_subject, angle, tone)
            out = {"ok": True, "script": script, "source": "fallback"}
            if notice:
                out["notice"] = notice
            return out

        params = {
            "niche": niche, "subject": subject, "category": category,
            "trendingTopic": trending, "prompt": final_prompt or final_subject,
            "angle": angle, "emotionalTone": tone, "targetDuration": 90,
            "randomSeed": random_seed, "randomAngle": random_angle,
        }
        try:
            script = _generate_with_local(niche, params, tone)
            return {"ok": True, "script": script, "source": "local"}
        except Exception as err:  # noqa: BLE001
            print(f"[script] local generation failed "
                  f"({type(err).__name__}): {str(err)[:200]}", flush=True)
            return fallback("Local model unavailable or timed out — using built-in "
                            "template. Check that Ollama/llama.cpp is running and the "
                            "model is pulled.")


_service: Optional[ScriptService] = None


def get_script_service() -> ScriptService:
    global _service
    if _service is None:
        _service = ScriptService()
    return _service
