"""Prompt templates & JSON schemas for the automation layer's LLM tasks.

Companion to :mod:`app.services.prompts` (the clip-pipeline prompts), kept
separate so the bot-specific behaviour is auditable in one place. Every prompt
is executed locally through :data:`app.services.ollama_service.ollama_service`.
"""
from __future__ import annotations

# --------------------------------------------------------------- relevance
RELEVANCE_SYSTEM = """You are a content strategist judging whether a piece of \
source content fits a specific channel/niche and has short-form viral potential. \
Be calibrated: generic or off-topic content scores low; highly on-topic, \
clip-worthy content scores high."""

RELEVANCE_USER_TEMPLATE = """Niche/topic: {topic}
Target keywords: {keywords}

Candidate content:
Title: {title}
Description: {description}

Rate how relevant and clip-worthy this is for the niche.

Return ONLY JSON:
{{
  "relevance": int,     // 0-100
  "reason": "one sentence"
}}"""

RELEVANCE_SCHEMA = {
    "type": "object",
    "properties": {
        "relevance": {"type": "integer"},
        "reason": {"type": "string"},
    },
    "required": ["relevance"],
}

# -------------------------------------------------------------- thumbnail
THUMBNAIL_SYSTEM = """You are a thumbnail strategist for short-form video. You \
propose punchy on-frame text overlays and pick the most arresting frame, in the \
style of high-CTR Shorts/Reels/TikTok thumbnails."""

THUMBNAIL_USER_TEMPLATE = """Clip title: {title}
Clip transcript:
---
{text}
---

Propose thumbnail concepts.

Return ONLY JSON:
{{
  "suggestions": [
    {{
      "text_overlay": "<= 5 words, ALL CAPS ok",
      "frame_hint": "which moment/expression to grab",
      "rationale": "why it stops the scroll",
      "ctr_score": int            // 0-100 predicted click appeal
    }}
  ]
}}"""

THUMBNAIL_SCHEMA = {
    "type": "object",
    "properties": {
        "suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text_overlay": {"type": "string"},
                    "frame_hint": {"type": "string"},
                    "rationale": {"type": "string"},
                    "ctr_score": {"type": "integer"},
                },
                "required": ["text_overlay", "ctr_score"],
            },
        }
    },
    "required": ["suggestions"],
}

# ------------------------------------------------------- self-improvement
SELF_IMPROVEMENT_SYSTEM = """You are a growth analyst for a short-form video \
operation. Given aggregated performance data, you infer what is working and \
recommend concrete, actionable config changes. Be specific and data-driven; do \
not invent numbers that aren't in the data."""

SELF_IMPROVEMENT_USER_TEMPLATE = """Bot: {bot_name} (niche: {bot_type})
Performance summary (JSON):
{summary}

Analyze and recommend.

Return ONLY JSON:
{{
  "best_clip_length_seconds": [int, int],   // recommended min,max
  "best_caption_style": "string",
  "best_sources": ["..."],                  // source names/ids that perform
  "best_posting_hours": [int, ...],         // 0-23 UTC
  "best_topics": ["..."],
  "title_patterns": ["..."],                // patterns of top titles
  "recommendations": ["concrete change", "..."],
  "summary": "2-3 sentence narrative"
}}"""

SELF_IMPROVEMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "best_clip_length_seconds": {"type": "array", "items": {"type": "integer"}},
        "best_caption_style": {"type": "string"},
        "best_sources": {"type": "array", "items": {"type": "string"}},
        "best_posting_hours": {"type": "array", "items": {"type": "integer"}},
        "best_topics": {"type": "array", "items": {"type": "string"}},
        "title_patterns": {"type": "array", "items": {"type": "string"}},
        "recommendations": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["recommendations", "summary"],
}
