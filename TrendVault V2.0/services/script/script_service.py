"""Script generation service — port of the /api/trend-vault/generate-script handler.

Resolves niche/subject, then: Anthropic (claude-sonnet-4-6) → on billing failure
OpenAI (gpt-4o-mini) → template fallback. Blocking network I/O; call via
asyncio.to_thread from the async route.
"""
from __future__ import annotations

import json
import random
import re
import time
from typing import Any, Dict, List, Optional

import httpx

from core.config import config
from core.constants import ANTHROPIC_MODEL
from lib.prompts_lib import append_recent_hook, build_prompts, uppercase_script_lines
from lib.script_fallback import generate_fallback_script

_BILLING_RE = re.compile(r"credit|billing|balance|quota|429|insufficient|402|400", re.I)


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


def _generate_with_claude(niche: str, params: Dict[str, Any], tone: str) -> Dict[str, Any]:
    import anthropic  # lazy so the module imports even before deps are installed
    prompts = build_prompts(params)
    client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    resp = client.messages.create(
        model=ANTHROPIC_MODEL, max_tokens=3500, temperature=1.0, top_p=0.95,
        system=prompts["system"], messages=[{"role": "user", "content": prompts["user"]}],
    )
    block = resp.content[0]
    text = getattr(block, "text", None)
    if text is None:
        raise RuntimeError("Unexpected response type from Claude")
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


def _openai_chat(user: str, max_tokens: int = 3500, temperature: float = 0.8,
                 system: Optional[str] = None) -> str:
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user})
    r = httpx.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {config.openai_api_key}"},
        json={"model": "gpt-4o-mini", "max_tokens": max_tokens,
              "temperature": temperature, "messages": messages},
        timeout=45.0,
    )
    if r.status_code != 200:
        raise RuntimeError(f"OpenAI {r.status_code}: {(r.text or '')[:200]}")
    data = r.json()
    text = (((data.get("choices") or [{}])[0]).get("message") or {}).get("content")
    if not text:
        raise RuntimeError("OpenAI returned empty response")
    return text


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

        if not config.anthropic_api_key:
            return fallback()

        params = {
            "niche": niche, "subject": subject, "category": category,
            "trendingTopic": trending, "prompt": final_prompt or final_subject,
            "angle": angle, "emotionalTone": tone, "targetDuration": 90,
            "randomSeed": random_seed, "randomAngle": random_angle,
        }
        try:
            script = _generate_with_claude(niche, params, tone)
            return {"ok": True, "script": script, "source": "claude"}
        except Exception as err:  # noqa: BLE001
            msg = str(err)
            is_billing = bool(_BILLING_RE.search(msg))
            if config.openai_api_key and is_billing:
                try:
                    user = (
                        "You are generating a 1 minute 30 second short-form video narration script.\n\n"
                        f"Niche: {niche}\nCategory: {category or ''}\n"
                        f"Trending Topic: {trending or ''}\nStory Prompt: {final_prompt or final_subject}\n"
                        f"Emotional Tone: {tone or 'mysterious'}\nCreative Angle: {random_angle or 'hidden truth'}\n"
                        f"Random Seed: {random_seed or int(time.time() * 1000)}\n\n"
                        f"Final subject: \"{final_subject}\"\n"
                        "You must stay locked to this subject. Do NOT write about love, relationships, "
                        "heartbreak, or zodiac unless the Story Prompt explicitly asks for it.\n\n"
                        "Write 18–24 lines, 200–230 words, targeting 90 seconds total duration.\n\n"
                        "Return ONLY valid JSON:\n"
                        "{\n  \"lines\": [\n    {\"text\": \"...\", \"type\": \"hook\", \"durationSeconds\": 3}\n  ],\n"
                        "  \"totalDuration\": 90,\n  \"title\": \"Short memorable title\",\n"
                        "  \"hook\": \"Opening line\",\n  \"estimatedWords\": 215\n}"
                    )
                    text = _openai_chat(user, max_tokens=3500)
                    parsed = parse_ai_json(text)
                    parsed = {**parsed, "trendVaultSign": niche, "topic": final_subject,
                              "emotionalTone": tone}
                    return {"ok": True, "script": parsed, "source": "openai",
                            "notice": "Using OpenAI (Anthropic credits exhausted)."}
                except Exception:
                    pass
            return fallback("Both AI providers unavailable — using built-in template."
                            if is_billing else None)


_service: Optional[ScriptService] = None


def get_script_service() -> ScriptService:
    global _service
    if _service is None:
        _service = ScriptService()
    return _service
