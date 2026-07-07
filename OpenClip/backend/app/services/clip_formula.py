"""Reverse-engineer a campaign video into a reusable "clip formula".

Given a source video's transcript plus the Whop campaign's rules, produce a
section-by-section breakdown — hook, script psychology, retention editing, viral
timestamps, a recreation plan, and a submission checklist — that a creator (or an
automated pipeline) can follow to reproduce the winning formula.

Two kinds of work happen here:

* **Deterministic** — the campaign-derived sections (requirements + submission
  checklist) are built straight from the campaign so they're always accurate and
  never hallucinated.
* **Generative** — the creative analysis comes from two focused LLM calls: a
  *blueprint* (structure · hook · script psychology · retention · integration ·
  footage) and a *playbook* (viral timestamps · visual timeline · editing ·
  recreation plan · automation · reusable template). Splitting the work keeps
  each JSON payload small enough for local models to return reliably, and every
  field is normalized with a safe default so a partial answer still renders.

Framework-agnostic (no FastAPI/Celery imports) so the worker and tests can call
it directly. All inference is local via :data:`ollama_service`.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from app.core.logging import get_logger
from app.services.ollama_service import ollama_service
from app.services.transcript_utils import format_for_llm

logger = get_logger(__name__)

# Cap the transcript fed to the model so long-form sources don't blow the local
# context window. The opening carries the hook/structure signal we most need. When
# a call fails (a slow local reasoning model can exceed the request timeout on a
# full transcript), we retry once on a much shorter slice — a smaller prompt is
# far more likely to return in time.
_MAX_TRANSCRIPT_CHARS = 5000
_RETRY_TRANSCRIPT_CHARS = 2200

_PLATFORM_LABELS = {
    "tiktok": "TikTok",
    "instagram": "Instagram Reels",
    "youtube": "YouTube Shorts",
    "x": "X (Twitter)",
}


# =====================================================================
# Small coercers — keep the rendered report clean whatever the model returns
# =====================================================================
def _s(value: Any, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _clamp_int(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "y", "1"}
    return default


def _str_list(value: Any, *, cap: int = 20, maxlen: int = 240) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list | tuple):
        return []
    out: list[str] = []
    for item in value:
        text = _s(item)
        if text:
            out.append(text[:maxlen])
        if len(out) >= cap:
            break
    return out


# =====================================================================
# Deterministic campaign sections (never hallucinated)
# =====================================================================
_LENGTH_RE = re.compile(
    r"(\d+\s*(?:-|to|–)\s*\d+|\d+)\s*(second|sec|s\b|minute|min|m\b)", re.IGNORECASE
)


def _find_length(requirements: list[str], description: str) -> str:
    """Best-effort scan of the campaign copy for an explicit length rule."""
    for text in [*requirements, description]:
        if not text:
            continue
        m = _LENGTH_RE.search(text)
        if m:
            return m.group(0).strip()
    return "No explicit length — match the platform norm (15–60s vertical)."


def _requirement_hits(requirements: list[str], *keywords: str) -> list[str]:
    keys = [k.lower() for k in keywords]
    return [r for r in requirements if any(k in r.lower() for k in keys)]


def build_requirements(campaign: dict[str, Any]) -> dict[str, Any]:
    """Deterministic 'Campaign Requirements' section, straight from the campaign."""
    requirements = _str_list(campaign.get("requirements"), cap=40)
    description = _s(campaign.get("description"))
    platforms = [
        _PLATFORM_LABELS.get(p, str(p).title()) for p in campaign.get("platforms") or []
    ]

    caption_hits = _requirement_hits(requirements, "caption", "subtitle")
    cta_hits = _requirement_hits(requirements, "cta", "call to action", "link", "bio", "follow")
    logo_hits = _requirement_hits(requirements, "logo", "brand", "watermark", "overlay")
    tag_hits = _requirement_hits(requirements, "tag", "mention", "@")
    hashtag_hits = _requirement_hits(requirements, "hashtag", "#")

    rate = float(campaign.get("rate_per_1k") or 0)
    budget = campaign.get("budget")
    paid_out = float(campaign.get("paid_out") or 0)
    # None means unlimited; 0.0 is a real (exhausted) budget — keep them distinct.
    if budget is not None:
        remaining = max(0.0, float(budget) - paid_out)
        budget_remaining = f"${remaining:,.0f} left of ${float(budget):,.0f}"
    else:
        budget_remaining = "Unlimited budget"

    return {
        "video_length": _find_length(requirements, description),
        "platforms": platforms or ["Not specified — check the campaign"],
        "captions_required": (
            "Yes — " + caption_hits[0] if caption_hits else "Recommended (burned-in captions lift retention)"
        ),
        "cta_required": (
            cta_hits[0] if cta_hits else "Add the campaign link/CTA in caption or on-screen"
        ),
        "logo_required": (
            logo_hits[0] if logo_hits else "Place the campaign logo/brand asset if provided"
        ),
        "hashtags": hashtag_hits or ["Use the campaign's required hashtags (see the brief)"],
        "tags": tag_hits or ["Tag the brand/creator where the brief requires"],
        "valid_submission": requirements or ["Follow the campaign brief on Whop for what counts."],
        "rejection_reasons": [
            "Missing a required tag, hashtag, CTA, or link",
            "Wrong platform or below the required length",
            "Re-used / duplicate content or low effort",
            "Copyrighted audio that isn't a campaign asset",
            "Not posted publicly, or the wrong post link submitted",
        ],
        "join_type": "Check on Whop — campaigns are either instant-join or application-based",
        "rpm": f"${rate:,.2f} per 1,000 views",
        "budget_remaining": budget_remaining,
        "special_instructions": description or "See the campaign page on Whop for owner notes.",
        "how_requirements_control": (
            "These rules gate whether a clip is paid: the length, platform, captions, "
            "tags/hashtags, and CTA/logo requirements decide if a submission is valid, "
            f"and the RPM ({rate:,.2f}/1K) with the remaining budget sets how much each "
            "1,000 views earns. Bake every rule into the edit BEFORE posting."
        ),
    }


def build_checklist(campaign: dict[str, Any], requirements: dict[str, Any]) -> list[dict[str, Any]]:
    """Deterministic pre-post checklist derived from the campaign + requirements."""
    platforms = ", ".join(requirements["platforms"])
    items: list[dict[str, Any]] = [
        {"label": f"Length matches: {requirements['video_length']}", "required": True},
        {"label": "Exported 9:16 vertical, 1080p", "required": True},
        {"label": f"Posted on: {platforms}", "required": True},
    ]
    for req in _str_list(campaign.get("requirements"), cap=15):
        items.append({"label": req, "required": True})
    items += [
        {"label": "Caption includes the campaign CTA / link", "required": True},
        {"label": "Required hashtags and tags added", "required": True},
        {"label": "Campaign logo / brand asset placed (if required)", "required": False},
        {"label": "No copyrighted audio outside campaign assets", "required": True},
        {"label": "Posted publicly (not private/unlisted)", "required": True},
        {"label": "Correct post link submitted to Whop", "required": True},
    ]
    return items


# =====================================================================
# LLM calls
# =====================================================================
_BLUEPRINT_SYSTEM = """You are a world-class short-form video strategist who reverse-\
engineers viral clips into repeatable formulas. You analyze a transcript and the \
campaign it serves, then explain the pacing, psychology, and structure precisely \
enough that the process can be automated. Be concrete and specific — never vague. \
Return ONLY the requested JSON."""

_BLUEPRINT_USER = """Reverse-engineer this campaign video into a reusable formula.

CAMPAIGN CONTEXT:
{campaign}

VIDEO DURATION: about {duration} seconds.

TRANSCRIPT (each line is "[start-end] text"):
---
{transcript}
---

Return ONLY JSON with this exact shape:
{{
  "structure": [
    {{ "start": "0:00", "end": "0:03", "label": "Hook",
       "purpose": "why this section exists", "visual": "what the viewer sees",
       "narration": "what is said", "why": "why it works",
       "supports": "which campaign requirement it supports" }}
  ],
  "hook": {{
    "rating": 8,                                  // 1-10, how well the first 3s stop the scroll
    "why_it_stops_scroll": "specific reason",
    "triggers": ["pattern interrupt", "curiosity gap", "money claim"],
    "best_hook_lines": ["punchy hook line to reuse", "..."]
  }},
  "script": {{
    "framework": "the storytelling framework (e.g. Hook-Problem-Solution-Proof-CTA)",
    "sentences": [
      {{ "text": "a line from the script", "purpose": "why it was said",
         "serves": "curiosity | authority | urgency | trust | excitement | proof",
         "action": "keep | shorten | move | remove" }}
    ]
  }},
  "retention": {{
    "avg_seconds_between_changes": "e.g. 2-3s",
    "techniques": ["fast cuts", "zooms", "open loops", "..."]
  }},
  "campaign_integration": {{
    "blend_type": "whole video is the ad | ad added at start | introduced later | native w/ branding | logo/song only",
    "feels_natural": true,
    "notes": "how the campaign is woven in and whether it feels forced"
  }},
  "background_footage": {{
    "footage_type": "podcast | stream | gameplay | screen recording | UGC facecam | stock | mixed",
    "must_match": true,
    "notes": "whether random b-roll works or footage must match the campaign"
  }}
}}

Give 4-7 structure sections, 5-10 script sentences, 4-8 retention techniques."""

_BLUEPRINT_SCHEMA = {
    "type": "object",
    "properties": {
        "structure": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "string"},
                    "end": {"type": "string"},
                    "label": {"type": "string"},
                    "purpose": {"type": "string"},
                    "visual": {"type": "string"},
                    "narration": {"type": "string"},
                    "why": {"type": "string"},
                    "supports": {"type": "string"},
                },
                "required": ["label", "purpose"],
            },
        },
        "hook": {
            "type": "object",
            "properties": {
                "rating": {"type": "integer"},
                "why_it_stops_scroll": {"type": "string"},
                "triggers": {"type": "array", "items": {"type": "string"}},
                "best_hook_lines": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["rating", "why_it_stops_scroll"],
        },
        "script": {
            "type": "object",
            "properties": {
                "framework": {"type": "string"},
                "sentences": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "text": {"type": "string"},
                            "purpose": {"type": "string"},
                            "serves": {"type": "string"},
                            "action": {"type": "string"},
                        },
                        "required": ["text", "purpose"],
                    },
                },
            },
            "required": ["framework"],
        },
        "retention": {
            "type": "object",
            "properties": {
                "avg_seconds_between_changes": {"type": "string"},
                "techniques": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["techniques"],
        },
        "campaign_integration": {
            "type": "object",
            "properties": {
                "blend_type": {"type": "string"},
                "feels_natural": {"type": "boolean"},
                "notes": {"type": "string"},
            },
            "required": ["blend_type", "notes"],
        },
        "background_footage": {
            "type": "object",
            "properties": {
                "footage_type": {"type": "string"},
                "must_match": {"type": "boolean"},
                "notes": {"type": "string"},
            },
            "required": ["footage_type", "notes"],
        },
    },
    "required": ["structure", "hook", "script", "retention", "campaign_integration", "background_footage"],
}

_PLAYBOOK_SYSTEM = """You are a short-form video producer and editor who turns a long \
transcript into a shot-by-shot production plan and picks the moments most likely to \
go viral. You know CapCut / Opus Clip workflows cold and you write instructions an \
AI editor could follow step by step. Be concrete. Return ONLY the requested JSON."""

_PLAYBOOK_USER = """Build the production playbook for clipping this campaign video.

CAMPAIGN CONTEXT:
{campaign}

VIDEO DURATION: about {duration} seconds.

TRANSCRIPT (each line is "[start-end] text"):
---
{transcript}
---

Return ONLY JSON with this exact shape:
{{
  "viral_moments": [
    {{ "rank": 1, "start": "1:20", "end": "1:48",
       "why_viral": "why this could pop", "hook_line": "the opening line to lead with",
       "caption_title": "on-screen title", "best_platform": "TikTok | Reels | Shorts",
       "needs_context": false, "strength": 88 }}   // strength 0-100
  ],
  "visual_timeline": {{
    "change_frequency": "e.g. a visual change every 2-3s",
    "changes": [ {{ "time": "0:00", "visual": "facecam + caption pops in" }} ]
  }},
  "editing": {{
    "caption_style": "e.g. bold word-by-word, Hormozi style",
    "font": "font family", "size": "large", "placement": "centered lower third",
    "animation": "word pop / karaoke highlight", "zooms": "punch-in on key words",
    "cuts": "hard cuts on beat", "sfx": "whooshes, dings on reveals",
    "music": "low trending bed", "motion_graphics": "arrows / highlight boxes",
    "logo_placement": "corner bug throughout",
    "retention_notes": "how these choices hold attention"
  }},
  "recreation_plan": ["step 1 in CapCut/Opus", "step 2", "..."],
  "automation_workflow": ["step an AI system follows", "..."],
  "template": "a short reusable pipeline template a creator can reuse for any campaign"
}}

Rank 3-6 viral moments strongest-first. Give 6-10 recreation steps and 6-12 automation steps."""

_PLAYBOOK_SCHEMA = {
    "type": "object",
    "properties": {
        "viral_moments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "rank": {"type": "integer"},
                    "start": {"type": "string"},
                    "end": {"type": "string"},
                    "why_viral": {"type": "string"},
                    "hook_line": {"type": "string"},
                    "caption_title": {"type": "string"},
                    "best_platform": {"type": "string"},
                    "needs_context": {"type": "boolean"},
                    "strength": {"type": "integer"},
                },
                "required": ["why_viral", "hook_line"],
            },
        },
        "visual_timeline": {
            "type": "object",
            "properties": {
                "change_frequency": {"type": "string"},
                "changes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "time": {"type": "string"},
                            "visual": {"type": "string"},
                        },
                        "required": ["visual"],
                    },
                },
            },
            "required": ["change_frequency"],
        },
        "editing": {
            "type": "object",
            "properties": {
                "caption_style": {"type": "string"},
                "font": {"type": "string"},
                "size": {"type": "string"},
                "placement": {"type": "string"},
                "animation": {"type": "string"},
                "zooms": {"type": "string"},
                "cuts": {"type": "string"},
                "sfx": {"type": "string"},
                "music": {"type": "string"},
                "motion_graphics": {"type": "string"},
                "logo_placement": {"type": "string"},
                "retention_notes": {"type": "string"},
            },
            "required": ["caption_style", "cuts"],
        },
        "recreation_plan": {"type": "array", "items": {"type": "string"}},
        "automation_workflow": {"type": "array", "items": {"type": "string"}},
        "template": {"type": "string"},
    },
    "required": ["viral_moments", "editing", "recreation_plan", "automation_workflow"],
}

_EDITING_FIELDS = (
    "caption_style", "font", "size", "placement", "animation", "zooms",
    "cuts", "sfx", "music", "motion_graphics", "logo_placement",
)


def _campaign_summary(campaign: dict[str, Any], requirements: dict[str, Any]) -> str:
    """A compact, readable brief the LLM can condition on."""
    lines = [
        f"Name: {_s(campaign.get('name'), 'Campaign')}",
        f"Type: {_s(campaign.get('campaign_type'), 'clipping')} · Category: {_s(campaign.get('category'), 'other')}",
        f"Platforms: {', '.join(requirements['platforms'])}",
        f"Pays: {requirements['rpm']} · Budget: {requirements['budget_remaining']}",
        f"Required length: {requirements['video_length']}",
    ]
    reqs = _str_list(campaign.get("requirements"), cap=12)
    if reqs:
        lines.append("Requirements: " + "; ".join(reqs))
    desc = _s(campaign.get("description"))
    if desc:
        lines.append(f"Owner notes: {desc[:400]}")
    return "\n".join(lines)


def _cap(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + "\n… (truncated)"


def _generate(stage: str, system: str, user: str, schema: dict[str, Any], model: str | None) -> dict[str, Any]:
    parsed, _meta = ollama_service.generate_json(
        stage,
        user,
        system=system,
        schema=schema,
        model=model,
        options={"temperature": 0.5},
    )
    return parsed if isinstance(parsed, dict) else {}


def _generate_resilient(
    stage: str,
    system: str,
    user_template: str,
    schema: dict[str, Any],
    model: str | None,
    *,
    summary: str,
    duration: int,
    transcript: str,
) -> dict[str, Any]:
    """Run one structured call, retrying on a much shorter transcript if it fails.

    A slow local reasoning model can exceed the request timeout on a full
    transcript; a smaller prompt usually returns in time. The second failure
    propagates to the caller so it can decide (blueprint fails the run; playbook
    falls back to defaults).
    """
    def _call(tx: str) -> dict[str, Any]:
        return _generate(
            stage, system, user_template.format(campaign=summary, duration=duration, transcript=tx),
            schema, model,
        )

    try:
        return _call(transcript)
    except Exception as exc:
        short = _cap(transcript, _RETRY_TRANSCRIPT_CHARS)
        logger.warning("%s call failed (%s); retrying on a shorter transcript", stage, exc)
        return _call(short)


# =====================================================================
# Normalization → the stable shape the frontend renders
# =====================================================================
def _norm_blueprint(data: dict[str, Any]) -> dict[str, Any]:
    hook = data.get("hook") if isinstance(data.get("hook"), dict) else {}
    script = data.get("script") if isinstance(data.get("script"), dict) else {}
    retention = data.get("retention") if isinstance(data.get("retention"), dict) else {}
    integ = data.get("campaign_integration") if isinstance(data.get("campaign_integration"), dict) else {}
    footage = data.get("background_footage") if isinstance(data.get("background_footage"), dict) else {}

    structure = []
    for row in data.get("structure") or []:
        if not isinstance(row, dict):
            continue
        structure.append(
            {
                "start": _s(row.get("start")),
                "end": _s(row.get("end")),
                "label": _s(row.get("label"), "Section"),
                "purpose": _s(row.get("purpose")),
                "visual": _s(row.get("visual")),
                "narration": _s(row.get("narration")),
                "why": _s(row.get("why")),
                "supports": _s(row.get("supports")),
            }
        )
        if len(structure) >= 12:
            break

    sentences = []
    for row in script.get("sentences") or []:
        if not isinstance(row, dict):
            continue
        action = _s(row.get("action"), "keep").lower()
        if action not in {"keep", "shorten", "move", "remove"}:
            action = "keep"
        sentences.append(
            {
                "text": _s(row.get("text")),
                "purpose": _s(row.get("purpose")),
                "serves": _s(row.get("serves")),
                "action": action,
            }
        )
        if len(sentences) >= 20:
            break

    return {
        "structure": structure,
        "hook": {
            "rating": _clamp_int(hook.get("rating"), 1, 10, 7),
            "why_it_stops_scroll": _s(hook.get("why_it_stops_scroll")),
            "triggers": _str_list(hook.get("triggers"), cap=10),
            "best_hook_lines": _str_list(hook.get("best_hook_lines"), cap=6),
        },
        "script": {
            "framework": _s(script.get("framework"), "Hook · Problem · Solution · Proof · CTA"),
            "sentences": sentences,
        },
        "retention": {
            "avg_seconds_between_changes": _s(retention.get("avg_seconds_between_changes"), "~2-3s"),
            "techniques": _str_list(retention.get("techniques"), cap=12),
        },
        "campaign_integration": {
            "blend_type": _s(integ.get("blend_type"), "native content with campaign branding"),
            "feels_natural": _bool(integ.get("feels_natural"), True),
            "notes": _s(integ.get("notes")),
        },
        "background_footage": {
            "footage_type": _s(footage.get("footage_type"), "mixed media"),
            "must_match": _bool(footage.get("must_match"), True),
            "notes": _s(footage.get("notes")),
        },
    }


def _norm_playbook(data: dict[str, Any]) -> dict[str, Any]:
    timeline = data.get("visual_timeline") if isinstance(data.get("visual_timeline"), dict) else {}
    editing = data.get("editing") if isinstance(data.get("editing"), dict) else {}

    moments = []
    for i, row in enumerate(data.get("viral_moments") or []):
        if not isinstance(row, dict):
            continue
        moments.append(
            {
                "rank": _clamp_int(row.get("rank"), 1, 99, i + 1),
                "start": _s(row.get("start")),
                "end": _s(row.get("end")),
                "why_viral": _s(row.get("why_viral")),
                "hook_line": _s(row.get("hook_line")),
                "caption_title": _s(row.get("caption_title")),
                "best_platform": _s(row.get("best_platform")),
                "needs_context": _bool(row.get("needs_context"), False),
                "strength": _clamp_int(row.get("strength"), 0, 100, 70),
            }
        )
        if len(moments) >= 8:
            break
    moments.sort(key=lambda m: m["rank"])

    changes = []
    for row in timeline.get("changes") or []:
        if not isinstance(row, dict):
            continue
        visual = _s(row.get("visual"))
        if visual:
            changes.append({"time": _s(row.get("time")), "visual": visual})
        if len(changes) >= 20:
            break

    editing_out = {field: _s(editing.get(field)) for field in _EDITING_FIELDS}
    editing_out["retention_notes"] = _s(editing.get("retention_notes"))

    return {
        "viral_moments": moments,
        "visual_timeline": {
            "change_frequency": _s(timeline.get("change_frequency"), "~2-3s"),
            "changes": changes,
        },
        "editing": editing_out,
        "recreation_plan": _str_list(data.get("recreation_plan"), cap=14, maxlen=400),
        "automation_workflow": _str_list(data.get("automation_workflow"), cap=16, maxlen=400),
        "template": _s(data.get("template")),
    }


def _default_template(campaign: dict[str, Any]) -> str:
    name = _s(campaign.get("name"), "the campaign")
    return (
        "CAMPAIGN REQUIREMENTS\n  ↓\nSOURCE VIDEO / TRANSCRIPT\n  ↓\n"
        "VIRAL MOMENT SELECTION\n  ↓\nHOOK (first 3s)\n  ↓\nMAIN CLIP\n  ↓\n"
        "RETENTION EDITING (captions · zooms · cuts · sfx)\n  ↓\n"
        f"CAMPAIGN BRANDING ({name} logo / CTA)\n  ↓\nCAPTIONS\n  ↓\nCTA\n  ↓\n"
        "PLATFORM CAPTION + HASHTAGS\n  ↓\nSUBMISSION CHECKLIST → post → submit link to Whop"
    )


# =====================================================================
# Orchestration
# =====================================================================
def analyze_formula(
    *,
    segments: list[dict[str, Any]],
    full_text: str,
    duration: float,
    campaign: dict[str, Any],
    model: str | None = None,
    on_stage: Callable[[str, float], None] | None = None,
) -> tuple[dict[str, Any], int]:
    """Produce the full clip-formula breakdown for one source video.

    Returns ``(result, hook_score)``. The blueprint call must succeed (it carries
    the hook rating and the core analysis); if the playbook call fails we fall
    back to sensible defaults so the report still renders.
    """
    transcript_text = _cap(format_for_llm(segments) or _s(full_text), _MAX_TRANSCRIPT_CHARS)

    requirements = build_requirements(campaign)
    checklist = build_checklist(campaign, requirements)
    summary = _campaign_summary(campaign, requirements)
    dur = int(round(duration or 0))

    # Blueprint carries the hook rating + core analysis, so it must succeed (with a
    # shorter-transcript retry as the safety net); a hard failure fails the run.
    if on_stage:
        on_stage("blueprint", 0.6)
    blueprint = _norm_blueprint(
        _generate_resilient(
            "reasoning", _BLUEPRINT_SYSTEM, _BLUEPRINT_USER, _BLUEPRINT_SCHEMA, model,
            summary=summary, duration=dur, transcript=transcript_text,
        )
    )

    # Playbook is best-effort: even both attempts failing yields a usable report
    # (deterministic defaults for the clip-picks/editing sections).
    if on_stage:
        on_stage("playbook", 0.8)
    try:
        playbook = _norm_playbook(
            _generate_resilient(
                "reasoning", _PLAYBOOK_SYSTEM, _PLAYBOOK_USER, _PLAYBOOK_SCHEMA, model,
                summary=summary, duration=dur, transcript=transcript_text,
            )
        )
    except Exception as exc:  # pragma: no cover - keep a partial report on flake
        logger.warning("Formula playbook call failed, using defaults: %s", exc)
        playbook = _norm_playbook({})

    if not playbook["template"]:
        playbook["template"] = _default_template(campaign)

    result = {
        "requirements": requirements,
        "checklist": checklist,
        **blueprint,
        **playbook,
    }
    return result, blueprint["hook"]["rating"]
