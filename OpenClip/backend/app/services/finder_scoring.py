"""Staged, transparent Auto Finder Score for campaign source videos.

A single composite 0-100 score per candidate video, recomputed as heavier
analysis lands. Every score carries a **confidence** (how much of the weight is
backed by real measurements vs. priors), a **delta** vs. the previous stage, a
**factor breakdown**, and a human **reasons** checklist (✓ good / ⚠ warning).

Milestone 1 implements the two *fast* stages:

* **Stage 1** — title/uploader/duration only (what search returns): brief match,
  a title-level hook proxy, rule/duration compliance, a view-count proxy, and a
  brand-safety lexicon check. Cheap, instant, but low confidence.
* **Stage 3** — a full yt-dlp extract (``youtube.enrich``): real view velocity,
  recency, like/comment engagement, plus description/tags folded into the brief
  and brand-safety factors. Higher confidence.

Stages 2 (captions transcript) and 4 (LLM deep read) are reserved slots — their
weight stays *unmeasured* here, which is what keeps the confidence honest (it
tops out around ~70% until those land in Milestone 2).

Deterministic and dependency-light so it's fast and unit-testable; no network in
this module (the caller does the blocking ``youtube.enrich`` and hands us a dict).
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from app.core.logging import get_logger
from app.services import campaign_math
from app.services.campaign_finder import (
    _resolve_finder_model,
    _str_list,
    _tokens,
    understand_campaign,
)
from app.services.storyvault.scoring import _DRAMA_WORDS

logger = get_logger(__name__)

# --- lexicons (title/description level "viral" signal) ----------------------
# Money / stakes, curiosity / open-loop, and proof / authority markers. These
# complement the reused drama + twist lexicons from storyvault scoring.
_MONEY_WORDS = re.compile(
    r"\b(\$\d|money|cash|rich|millionaire|billion|profit|salary|paid|broke|debt|"
    r"revenue|income|fortune|wealth|earn|refund|scam)\b",
    re.IGNORECASE,
)
_CURIOSITY_WORDS = re.compile(
    r"\b(secret|nobody|truth|reveal|exposed|why|how|hidden|mistake|before you|"
    r"what happens|reason|actually|really|surprising)\b",
    re.IGNORECASE,
)
_PROOF_WORDS = re.compile(
    r"\b(proof|study|science|data|results|experiment|test|evidence|expert|"
    r"doctor|research|billion|record)\b",
    re.IGNORECASE,
)
# Brand-safety / copyright risk: content that's risky to reupload for a campaign.
_RISK_WORDS = re.compile(
    r"\b(full movie|full episode|official music video|official video|music video|"
    r"trailer|ufc|wwe|nba|nfl|premier league|espn|copyright|vevo|lyrics|"
    r"live stream|highlights|full match|full fight|full game|ppv)\b",
    re.IGNORECASE,
)

# Pull a required clip length out of a campaign rule ("30-60 seconds", "under 90s").
_LEN_RANGE = re.compile(r"(\d{1,3})\s*[-–to]+\s*(\d{1,3})\s*(?:s|sec|second)", re.IGNORECASE)
_LEN_MAX = re.compile(r"(?:under|max|up to|below|<=?)\s*(\d{1,3})\s*(?:s|sec|second)", re.IGNORECASE)
_LEN_MIN = re.compile(r"(?:over|min|at least|>=?)\s*(\d{1,3})\s*(?:s|sec|second)", re.IGNORECASE)


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


# --------------------------------------------------------------- factor model
@dataclass
class Factor:
    key: str
    label: str
    weight: float
    value: float          # 0-100
    measured: bool        # True = from real data this stage; False = prior/estimate


@dataclass
class PayoutCtx:
    rate_per_1k: float
    min_payout: float | None = None
    max_payout: float | None = None
    remaining: float | None = None      # budget left to pay out
    median_views: float | None = None   # median views of this campaign's own clips


@dataclass
class CampaignCtx:
    keywords: list[str] = field(default_factory=list)
    platforms: list[str] = field(default_factory=list)
    length_min: int | None = None       # required clip length (seconds), if any
    length_max: int | None = None


# The canonical weight vector (sums to 100). Stage 2/4 factors are present so the
# confidence math can see their weight is *unmeasured* until those stages run.
_WEIGHTS = {
    "brief_match": 25.0,
    "transcript_match": 20.0,   # Stage 2 (unmeasured in M1)
    "hook": 15.0,
    "engagement": 10.0,
    "velocity": 10.0,
    "rule_match": 10.0,
    "brand_safety": 5.0,
    "retention": 5.0,
}


def build_campaign_ctx(campaign: dict[str, Any]) -> CampaignCtx:
    """Derive keywords (deterministic understand pass) + rules from a campaign."""
    understanding = understand_campaign(campaign)
    keywords = list(understanding.get("keywords") or [])
    kw = set(keywords) | set(_tokens(understanding.get("topic")))
    length_min, length_max = _length_rule(campaign.get("requirements") or [])
    return CampaignCtx(
        keywords=sorted(kw),
        platforms=[str(p) for p in (campaign.get("platforms") or [])],
        length_min=length_min,
        length_max=length_max,
    )


def _length_rule(requirements: list[str]) -> tuple[int | None, int | None]:
    text = " ".join(str(r) for r in requirements)
    m = _LEN_RANGE.search(text)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        return (min(lo, hi), max(lo, hi))
    lo = _LEN_MIN.search(text)
    hi = _LEN_MAX.search(text)
    return (int(lo.group(1)) if lo else None, int(hi.group(1)) if hi else None)


# ------------------------------------------------------------------ factors
def _brief_match(ctx: CampaignCtx, title: str, uploader: str | None, extra: str = "") -> float:
    """Keyword overlap of the campaign brief with the video title/uploader/desc."""
    kw = set(ctx.keywords)
    if not kw:
        return 45.0
    hay = set(_tokens(f"{title} {uploader or ''} {extra}"))
    overlap = len(kw & hay)
    ratio = overlap / min(len(kw), 6)          # 6 hits already means a strong match
    return _clamp(28.0 + ratio * 72.0)


def _hook_proxy(title: str, extra: str = "") -> float:
    """Title-level hook strength — a proxy until the transcript is read (Stage 2)."""
    text = f"{title} {extra}"[:400]
    score = 34.0
    score += min(30.0, len(_DRAMA_WORDS.findall(text)) * 11)
    score += min(14.0, len(_CURIOSITY_WORDS.findall(text)) * 6)
    score += min(10.0, len(_MONEY_WORDS.findall(text)) * 5)
    score += min(8.0, len(_PROOF_WORDS.findall(text)) * 4)
    if "?" in title:
        score += 6
    if re.search(r"\d", title):                 # numbers/lists hook well
        score += 4
    return _clamp(score)


def _retention_from_duration(duration: float | None) -> float:
    """Long-form source material clips best; shorts/unknown score low."""
    if not duration:
        return 45.0
    if duration < 90:            # already a short/clip — little to pull from
        return 22.0
    if duration < 180:
        return 55.0
    if duration <= 5400:         # 3min–90min: ideal clipping source
        return 92.0
    if duration <= 10800:
        return 78.0
    return 62.0                  # very long (>3h) still fine, a bit unwieldy


def _rule_match(ctx: CampaignCtx, duration: float | None) -> float:
    """Duration fits the required clip-length window; platform coverage."""
    score = 70.0
    if ctx.length_max is not None or ctx.length_min is not None:
        # The source must be long enough to yield a clip in the required window.
        if duration and ctx.length_min and duration < ctx.length_min:
            score -= 30.0
        elif duration and duration >= (ctx.length_max or ctx.length_min or 0):
            score += 20.0
    elif duration and duration >= 180:
        score += 15.0
    if ctx.platforms:
        score += 6.0            # campaign has explicit platforms → clippable everywhere
    return _clamp(score)


def _brand_safety(title: str, extra: str = "") -> tuple[float, bool]:
    """100 = clearly safe, low = copyright/rights risk. Returns (score, risky)."""
    hits = len(_RISK_WORDS.findall(f"{title} {extra}"))
    if hits == 0:
        return 88.0, False
    return _clamp(88.0 - hits * 30.0), True


def _velocity_proxy(view_count: int | None) -> float:
    """Stage-1 stand-in for velocity: log-scaled total views (no age yet)."""
    if not view_count or view_count <= 0:
        return 40.0
    # 1k≈46, 10k≈58, 100k≈70, 1M≈82, 10M≈94
    return _clamp(22.0 + math.log10(view_count) * 12.0)


def _velocity_real(view_count: int | None, upload: date | None) -> tuple[float, float | None]:
    """Real view velocity = views/day since upload. Returns (score, views_per_day)."""
    if not view_count or view_count <= 0 or upload is None:
        return _velocity_proxy(view_count), None
    days = max(1.0, (date.today() - upload).days)
    per_day = view_count / days
    # 100/day≈40, 1k≈58, 10k≈76, 100k≈94
    score = _clamp(22.0 + math.log10(max(1.0, per_day)) * 18.0)
    return score, per_day


def _recency(upload: date | None) -> float | None:
    if upload is None:
        return None
    days = max(0, (date.today() - upload).days)
    if days <= 30:
        return 95.0
    if days <= 180:
        return 78.0
    if days <= 365:
        return 60.0
    if days <= 365 * 3:
        return 45.0
    return 32.0


def _engagement(view_count: int | None, likes: int | None, comments: int | None) -> float | None:
    """Likes+comments per view, log-normalized. None when data is missing."""
    if not view_count or view_count <= 0 or (likes is None and comments is None):
        return None
    interactions = (likes or 0) + (comments or 0) * 3      # comments weigh more
    if interactions <= 0:
        return 35.0
    ratio = interactions / view_count
    # 0.5%≈52, 2%≈72, 5%≈86, 10%≈100
    return _clamp(52.0 + math.log10(max(1e-4, ratio / 0.005)) * 34.0)


# ------------------------------------------------------------- combine + payout
def _projected_payout(score: float, pay: PayoutCtx) -> tuple[float | None, float | None]:
    """A projected earnings range for one clip, from campaign RPM + a view band.

    The view band comes from this campaign's own clip history when available
    (median × 0.5–2), else a default band, scaled by how strong the match is.
    This is a labeled *estimate*, not a guarantee.
    """
    if pay.median_views and pay.median_views > 0:
        lo_views, hi_views = pay.median_views * 0.5, pay.median_views * 2.0
    else:
        lo_views, hi_views = 3000.0, 40000.0
    factor = 0.6 + score / 100.0             # score 40 → ~1.0x, 90 → ~1.5x
    lo_views *= factor
    hi_views *= factor
    lo = campaign_math.project_payout(
        lo_views, pay.rate_per_1k, min_payout=pay.min_payout,
        max_payout=pay.max_payout, remaining=pay.remaining,
    )
    hi = campaign_math.project_payout(
        hi_views, pay.rate_per_1k, min_payout=pay.min_payout,
        max_payout=pay.max_payout, remaining=pay.remaining,
    )
    return lo, hi


def _reasons(factors: dict[str, Factor], brand_risky: bool, per_day: float | None) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    f = factors
    if f["brief_match"].value >= 68:
        out.append({"kind": "ok", "text": "Strong match to the campaign brief"})
    elif f["brief_match"].value < 42:
        out.append({"kind": "warn", "text": "Weak match to the campaign keywords"})
    if f["hook"].value >= 66:
        out.append({"kind": "ok", "text": "Punchy, scroll-stopping title/hook"})
    if f["velocity"].measured and per_day is not None:
        if f["velocity"].value >= 70:
            out.append({"kind": "ok", "text": f"Rising fast — ~{int(per_day):,}/day views"})
    elif f["velocity"].value >= 74:
        out.append({"kind": "ok", "text": "High view count"})
    if f["engagement"].measured and f["engagement"].value >= 70:
        out.append({"kind": "ok", "text": "High like/comment engagement"})
    if f["retention"].value >= 80:
        out.append({"kind": "ok", "text": "Long-form source — lots to clip"})
    elif f["retention"].value <= 30:
        out.append({"kind": "warn", "text": "Very short — already a clip"})
    if f["rule_match"].value <= 45:
        out.append({"kind": "warn", "text": "May not fit the required clip length"})
    if brand_risky:
        out.append({"kind": "warn", "text": "Possible copyright / rights risk"})
    return out


def _combine(factors: dict[str, Factor], pay: PayoutCtx, stage: int, per_day: float | None,
             brand_risky: bool, prev_score: int | None) -> dict[str, Any]:
    total_w = sum(f.weight for f in factors.values())
    score = sum(f.value * f.weight for f in factors.values()) / total_w
    score = int(round(_clamp(score)))
    measured_w = sum(f.weight for f in factors.values() if f.measured)
    # Confidence = share of weight backed by real measurement, floored so a
    # stage-1 card never reads as "0% sure".
    confidence = int(round(_clamp(20.0 + measured_w / total_w * 80.0)))
    lo, hi = _projected_payout(score, pay)
    return {
        "score": score,
        "delta": None if prev_score is None else score - prev_score,
        "confidence": confidence,
        "stage": stage,
        "factors": [
            {"key": f.key, "label": f.label, "weight": f.weight,
             "value": round(f.value, 1), "measured": f.measured}
            for f in factors.values()
        ],
        "reasons": _reasons(factors, brand_risky, per_day),
        "projected_low": lo,
        "projected_high": hi,
    }


def _factor(key: str, label: str, value: float, measured: bool) -> Factor:
    return Factor(key=key, label=label, weight=_WEIGHTS[key], value=value, measured=measured)


def score_stage1(ctx: CampaignCtx, candidate: dict[str, Any], pay: PayoutCtx) -> dict[str, Any]:
    """Fast score from search-only fields (title, uploader, duration, views)."""
    title = candidate.get("title") or ""
    uploader = candidate.get("uploader")
    duration = candidate.get("duration")
    views = candidate.get("view_count")

    brief = _brief_match(ctx, title, uploader)
    hook = _hook_proxy(title)
    brand, risky = _brand_safety(title)
    retention = _retention_from_duration(duration)
    rule = _rule_match(ctx, duration)
    velocity = _velocity_proxy(views)

    factors = {
        "brief_match": _factor("brief_match", "Brief match", brief, True),
        # transcript/engagement not yet read → soft priors, unmeasured.
        "transcript_match": _factor("transcript_match", "Transcript match", brief * 0.6 + 20.0, False),
        "hook": _factor("hook", "Hook", hook, False),         # title proxy → not fully measured
        "engagement": _factor("engagement", "Engagement", 50.0, False),
        "velocity": _factor("velocity", "View velocity", velocity, False),
        "rule_match": _factor("rule_match", "Rule match", rule, True),
        "brand_safety": _factor("brand_safety", "Brand safety", brand, False),
        "retention": _factor("retention", "Retention", retention, True),
    }
    return _combine(factors, pay, stage=1, per_day=None, brand_risky=risky, prev_score=None)


def score_stage3(
    ctx: CampaignCtx, enriched: dict[str, Any], pay: PayoutCtx, *, prev_score: int | None = None
) -> dict[str, Any]:
    """Deeper score once ``youtube.enrich`` has run (velocity/recency/engagement)."""
    title = enriched.get("title") or ""
    uploader = enriched.get("uploader")
    duration = enriched.get("duration")
    views = enriched.get("view_count")
    description = enriched.get("description") or ""
    tags = " ".join(enriched.get("tags") or [])
    extra = f"{description} {tags}"[:1200]
    upload = _parse_upload_date(enriched.get("upload_date"))

    brief = _brief_match(ctx, title, uploader, extra)
    hook = _hook_proxy(title, description[:300])
    brand, risky = _brand_safety(title, extra)
    retention = _retention_from_duration(duration)
    rule = _rule_match(ctx, duration)
    velocity, per_day = _velocity_real(views, upload)
    engagement = _engagement(views, enriched.get("like_count"), enriched.get("comment_count"))

    factors = {
        "brief_match": _factor("brief_match", "Brief match", brief, True),
        "transcript_match": _factor("transcript_match", "Transcript match", brief * 0.6 + 20.0, False),
        "hook": _factor("hook", "Hook", hook, False),
        "engagement": _factor("engagement", "Engagement",
                              engagement if engagement is not None else 50.0,
                              engagement is not None),
        "velocity": _factor("velocity", "View velocity", velocity, per_day is not None),
        "rule_match": _factor("rule_match", "Rule match", rule, True),
        "brand_safety": _factor("brand_safety", "Brand safety", brand, True),
        "retention": _factor("retention", "Retention", retention, True),
    }
    return _combine(factors, pay, stage=3, per_day=per_day, brand_risky=risky, prev_score=prev_score)


def _parse_upload_date(value: Any) -> date | None:
    """yt-dlp upload_date is 'YYYYMMDD'."""
    if not value:
        return None
    try:
        return datetime.strptime(str(value), "%Y%m%d").date()
    except ValueError:
        return None


# ===================================================================== STAGE 2+
# Transcript-driven scoring (from YouTube captions — no download). These flip the
# transcript_match (20%) and hook (15%) weights from *estimated* to *measured*,
# which is what pushes confidence toward ~95%.
def _lexicon_hits(text: str) -> int:
    return (
        len(_DRAMA_WORDS.findall(text))
        + len(_MONEY_WORDS.findall(text))
        + len(_CURIOSITY_WORDS.findall(text))
        + len(_PROOF_WORDS.findall(text))
    )


def _transcript_match(ctx: CampaignCtx, text: str) -> float:
    """How much of the campaign brief actually shows up in what's said."""
    kw = set(ctx.keywords)
    if not kw:
        return 55.0
    toks = set(_tokens(text))
    ratio = len(kw & toks) / len(kw)             # share of brief keywords spoken
    return _clamp(30.0 + ratio * 70.0)


def _hook_from_transcript(segments: list[dict[str, Any]]) -> float:
    """Hook strength from the actual opening lines (first ~20s of speech)."""
    opening = " ".join(s.get("text", "") for s in segments if (s.get("start") or 0) <= 20.0)
    if not opening:
        return 45.0
    score = 32.0
    score += min(34.0, _lexicon_hits(opening) * 9)
    if "?" in opening:
        score += 8
    if re.search(r"\b(you|your)\b", opening, re.IGNORECASE):   # direct address hooks
        score += 6
    if re.search(r"\d", opening):
        score += 4
    return _clamp(score)


def _fmt_time(seconds: float) -> str:
    seconds = int(max(0, seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


def best_moment(segments: list[dict[str, Any]] | None, duration: float | None,
                *, window: float = 45.0) -> dict[str, Any] | None:
    """Densest ~45s stretch of viral-lexicon language — a candidate clip moment."""
    if not segments:
        return None
    best_start, best_end, best_hits = None, None, -1
    n = len(segments)
    for i in range(n):
        start = segments[i].get("start") or 0.0
        text_parts: list[str] = []
        end = start
        j = i
        while j < n and (segments[j].get("start") or 0.0) - start <= window:
            text_parts.append(segments[j].get("text", ""))
            end = segments[j].get("start") or end
            j += 1
        hits = _lexicon_hits(" ".join(text_parts))
        if hits > best_hits:
            best_hits, best_start, best_end = hits, start, min(end + 6.0, duration or end + 6.0)
    if best_start is None or best_hits <= 0:
        return None
    return {
        "start": round(best_start, 1),
        "end": round(best_end, 1),
        "label": f"{_fmt_time(best_start)}–{_fmt_time(best_end)}",
    }


def score_stage4(
    ctx: CampaignCtx, enriched: dict[str, Any], pay: PayoutCtx, *,
    transcript: dict[str, Any] | None = None, prev_score: int | None = None,
) -> dict[str, Any]:
    """Deepest fast score: enrichment (Stage 3) + captions transcript (Stage 2).

    When a transcript is available, transcript_match + hook become *measured* and
    a best-moment timestamp is attached; otherwise it degrades to Stage-3 priors
    (and the confidence honestly reflects that).
    """
    title = enriched.get("title") or ""
    uploader = enriched.get("uploader")
    duration = enriched.get("duration")
    views = enriched.get("view_count")
    description = enriched.get("description") or ""
    tags = " ".join(enriched.get("tags") or [])
    upload = _parse_upload_date(enriched.get("upload_date"))
    t_text = (transcript or {}).get("text") or ""
    segments = (transcript or {}).get("segments") or []
    have_t = bool(t_text)

    brief = _brief_match(ctx, title, uploader, f"{description} {tags} {t_text[:800]}"[:1600])
    transcript_v = _transcript_match(ctx, t_text) if have_t else brief * 0.6 + 20.0
    hook = _hook_from_transcript(segments) if segments else _hook_proxy(title, description[:300])
    brand, risky = _brand_safety(title, f"{description} {tags}"[:1200])
    retention = _retention_from_duration(duration)
    rule = _rule_match(ctx, duration)
    velocity, per_day = _velocity_real(views, upload)
    engagement = _engagement(views, enriched.get("like_count"), enriched.get("comment_count"))

    factors = {
        "brief_match": _factor("brief_match", "Brief match", brief, True),
        "transcript_match": _factor("transcript_match", "Transcript match", transcript_v, have_t),
        "hook": _factor("hook", "Hook", hook, bool(segments)),
        "engagement": _factor("engagement", "Engagement",
                              engagement if engagement is not None else 50.0,
                              engagement is not None),
        "velocity": _factor("velocity", "View velocity", velocity, per_day is not None),
        "rule_match": _factor("rule_match", "Rule match", rule, True),
        "brand_safety": _factor("brand_safety", "Brand safety", brand, True),
        "retention": _factor("retention", "Retention", retention, True),
    }
    result = _combine(factors, pay, stage=4, per_day=per_day, brand_risky=risky, prev_score=prev_score)

    moment = best_moment(segments, duration)
    if have_t and transcript_v >= 62:
        result["reasons"].insert(0, {"kind": "ok", "text": "Transcript matches the campaign brief"})
    if moment:
        result["best_moment_start"] = moment["start"]
        result["best_moment_end"] = moment["end"]
        result["reasons"].append({"kind": "ok", "text": f"Strong moment ~{moment['label']}"})
    return result


# ================================================================== CAMPAIGN COPILOT
# A single LLM synthesis over the ranked candidates → a plain-English strategy:
# best opportunity + why, a clip plan, and whether the campaign's worth the effort.
# Bounded + heuristic fallback so it never hangs or blocks the UI.
_STRAT_SYSTEM = """You are a sharp short-form clipping strategist advising a creator which \
source video to clip for a paid campaign. You are concrete, honest, and encouraging. Base your \
advice ONLY on the campaign brief and the ranked candidates given. Return ONLY JSON."""

_STRAT_USER = """Campaign: {name}
What it wants: {description}
Payout: ${rate}/1K views{budget}. Rules: {rules}

Ranked candidate source videos (already scored 0-100 for fit):
{videos}

Advise the creator. Return ONLY JSON:
{{
  "headline": "one punchy sentence on the single best opportunity",
  "best_video": <the number of the video you'd clip first>,
  "why": ["2-4 short concrete reasons it's the pick"],
  "clip_plan": "one sentence: how many clips and roughly how long",
  "worth_joining": true or false,
  "opportunity_score": <0-100, how good this campaign looks overall>
}}"""

_STRAT_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "best_video": {"type": "integer"},
        "why": {"type": "array", "items": {"type": "string"}},
        "clip_plan": {"type": "string"},
        "worth_joining": {"type": "boolean"},
        "opportunity_score": {"type": "integer"},
    },
    "required": ["headline"],
}


def _heuristic_strategy(campaign: dict[str, Any], videos: list[dict[str, Any]]) -> dict[str, Any]:
    top = videos[0]
    dur = top.get("duration") or 0
    short = dur and dur < 300
    opp = int(top.get("score") or 0)
    return {
        "opportunity_score": opp,
        "recommended_index": 0,
        "headline": f"“{top.get('title')}” is your strongest shot at this campaign.",
        "reasoning": list(top.get("reasons") or [])[:4],
        "clip_plan": (
            "Make one tight 20–40s clip from the strongest moment."
            if short
            else "Pull 3 clips from the highest-scoring moments to spread your shots."
        ),
        "worth_joining": opp >= 55,
        "source": "heuristic",
    }


def strategize(
    campaign: dict[str, Any], videos: list[dict[str, Any]], *, model: str | None = None
) -> dict[str, Any]:
    """Copilot strategy over the ranked candidates. LLM with heuristic fallback.

    ``videos`` are the top scored candidates: ``{title, score, duration,
    projected_low, projected_high, reasons: [str]}`` (best first).
    """
    if not videos:
        return {
            "opportunity_score": 0, "recommended_index": None,
            "headline": "Run the finder to see your best opportunity.",
            "reasoning": [], "clip_plan": "", "worth_joining": False, "source": "heuristic",
        }

    base = _heuristic_strategy(campaign, videos)

    from app.services.ollama_client import OllamaClient

    client = OllamaClient(timeout=30)
    resolved = _resolve_finder_model(model, client)
    if not resolved:
        return base

    lines = []
    for i, v in enumerate(videos[:6], start=1):
        pay = ""
        if v.get("projected_low") is not None and v.get("projected_high") is not None:
            pay = f", projected ${v['projected_low']:.0f}-${v['projected_high']:.0f}"
        reasons = "; ".join(list(v.get("reasons") or [])[:3])
        lines.append(f"{i}. [{int(v.get('score') or 0)}/100] {v.get('title')}{pay}. {reasons}")

    budget = ""
    if campaign.get("budget"):
        budget = f", ${campaign['budget']:.0f} budget"
    prompt = _STRAT_USER.format(
        name=campaign.get("name") or "(untitled)",
        description=(campaign.get("description") or "(none)")[:400],
        rate=campaign.get("rate_per_1k") or 0,
        budget=budget,
        rules="; ".join(_str_list(campaign.get("requirements"), cap=6)) or "none",
        videos="\n".join(lines),
    )
    try:
        parsed, _meta = client.generate_json(
            prompt, model=resolved, system=_STRAT_SYSTEM, schema=_STRAT_SCHEMA,
            options={"temperature": 0.4}, retries=0,
        )
    except Exception as exc:
        logger.info("Copilot strategy LLM unavailable (%s); using heuristic", exc)
        return base
    if not isinstance(parsed, dict) or not parsed.get("headline"):
        return base

    idx = parsed.get("best_video")
    rec = (int(idx) - 1) if isinstance(idx, int) and 1 <= idx <= len(videos) else 0
    why = [str(w).strip() for w in (parsed.get("why") or []) if str(w).strip() and not _echoes(str(w))][:4]
    opp = parsed.get("opportunity_score")
    headline = str(parsed.get("headline") or "").strip()
    clip_plan = str(parsed.get("clip_plan") or "").strip()
    return {
        "opportunity_score": int(opp) if isinstance(opp, int) else base["opportunity_score"],
        "recommended_index": rec,
        # Small local models sometimes parrot the JSON field hints — fall back to
        # the (already solid) heuristic text when that happens.
        "headline": headline[:200] if headline and not _echoes(headline) else base["headline"],
        "reasoning": why or base["reasoning"],
        "clip_plan": clip_plan[:200] if clip_plan and not _echoes(clip_plan) else base["clip_plan"],
        "worth_joining": bool(parsed.get("worth_joining", base["worth_joining"])),
        "source": "ai",
    }


# Tell-tale phrases from the prompt's JSON hints — a weak model echoing these
# means it didn't really answer, so we prefer the heuristic text.
_ECHO = re.compile(
    r"punchy|one sentence|single best opportunity|0-100|best_video|<\d|how many clips|\[\d",
    re.IGNORECASE,
)


def _echoes(text: str) -> bool:
    return bool(_ECHO.search(text)) or len(text.strip()) < 12
