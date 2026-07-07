"""Find YouTube source videos that correlate to a Whop campaign.

Reads the campaign's title and description, derives search queries for the
*source material* a clipper would pull from (e.g. the podcast/stream/creator the
campaign is about), searches YouTube, and ranks the candidates by how well they
correlate to the campaign. Deterministic (no LLM) so it's fast and never hangs an
interactive request; blocking (yt-dlp), so call ``find_matches`` off the event
loop (``asyncio.to_thread``).
"""
from __future__ import annotations

import math
import re
from typing import Any

from app.core.logging import get_logger
from app.services import youtube

logger = get_logger(__name__)

# Words that carry no topical signal for a source-material search. The clipping
# vocabulary ("clips", "campaign", "ugc" …) is stripped so the query targets the
# actual subject, not the fact that it's a clipping campaign.
_STOP = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "your", "you",
    "my", "our", "his", "her", "their", "this", "that", "these", "those", "is", "are",
    "be", "by", "at", "as", "it", "its", "from", "get", "how", "why", "what", "new",
    "clip", "clips", "clipping", "clipper", "campaign", "campaigns", "content", "reward",
    "rewards", "whop", "video", "videos", "ugc", "official", "channel", "edit", "edits",
    "post", "posts", "viral", "short", "shorts", "reel", "reels", "tiktok", "instagram",
    "youtube", "twitter", "podcast",  # 'podcast' re-added as a query flavor below, not a keyword
    # Payout / pricing boilerplate — signal about the deal, not the subject.
    "creator", "creators", "paid", "pay", "budget", "cpm", "cpc", "cpv", "rpm",
    "per", "usd", "dollar", "dollars", "views", "bonus", "payout",
}

# Marks a placeholder/imported description that carries no real detail.
_GENERIC_DESC = re.compile(r"whop content rewards|content rewards", re.IGNORECASE)

# Trailing "…Clips" / "…Clipping Campaign" style words to peel off a campaign
# name to recover the underlying source name ("Rob the Bank Podcast Clips" →
# "Rob the Bank Podcast").
_SUFFIX = re.compile(
    r"\b(clips?|clipping|campaign|content\s+rewards?|ugc|edits?|reposting|repost|v\d+"
    r"|clipfarm|clipr|clip\s*farm)\b",   # clipping-agency tags ("… x Clipfarm")
    re.IGNORECASE,
)
# Emoji / pictographs / dingbats that campaign names love to prefix ("🚨 LEVI …").
# Left in a query, YouTube returns nothing — strip them (but keep real letters of
# every language: accents, Arabic, CJK are all preserved).
_EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "\U00002190-\U000021FF\U00002B00-\U00002BFF\U0000FE00-\U0000FE0F\U0000200D\U00002122\U00002139]"
)
_WORD = re.compile(r"[A-Za-z0-9']+")

# Payout / pricing / budget boilerplate that leaks into campaign NAMES and muddies
# search queries ("$10/10,000", "$1.50 CPM", "$7k Budget", "1CPM", "$15 per clip").
# Stripped from the source name so we search the subject, not the deal terms.
_PAYOUT_JUNK = re.compile(
    r"\$\s*\d[\d,.]*\s*(?:k|m)?(?:\s*/\s*[\d,]+)?"        # $10  $1.50  $7k  $10/10,000
    r"|\b\d+\s*(?:cpm|cpc|cpv|rpm)\b"                      # 1CPM  3 RPM
    r"|\b\d[\d,.]*\s*k\b"                                  # 10k  37.5k  (budgets)
    r"|\bcpm\b|\bcpc\b|\brpm\b|\bbudget\b|\bpayout\b"      # bare pricing words
    r"|\bper\s+(?:clip|post|video|\d[\d,]*)\b"             # per clip / per 1000
    r"|\b(?:get\s+)?paid\s+to\s+post\b|\bget\s+paid\b",
    re.IGNORECASE,
)
# A single token that is really a number/amount ("10k", "1cpm", "20k") — no topic.
_MONEY_TOKEN = re.compile(r"\d[\d,]*(?:k|m|b|cpm|cpc|cpv|rpm|x)?", re.IGNORECASE)


def _tokens(text: str | None) -> list[str]:
    if not text:
        return []
    out: list[str] = []
    for w in _WORD.findall(text.lower()):
        if len(w) < 3 or w in _STOP or w.isdigit():
            continue
        if _MONEY_TOKEN.fullmatch(w):        # "10k", "1cpm", "20k" — an amount, not a topic
            continue
        out.append(w)
    return out


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for it in items:
        key = it.lower().strip()
        if key and key not in seen:
            seen.add(key)
            out.append(it.strip())
    return out


def _source_name(name: str) -> str:
    """Strip clipping-vocabulary suffixes to recover the underlying source name.

    Returns "" when the name was ENTIRELY clipping vocabulary (e.g. "UGC Clips
    Campaign") — callers must not fall back to the raw name, or they'd search for
    the clipping words themselves instead of the source material.
    """
    cleaned = _EMOJI.sub(" ", name or "")         # drop "🚨" & friends (0-result queries)
    cleaned = _SUFFIX.sub(" ", cleaned)
    cleaned = _PAYOUT_JUNK.sub(" ", cleaned)      # drop "$10/10,000", "1CPM", "$7k Budget"…
    cleaned = re.sub(r"[\[\](){}|·•—–-]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    # A dangling collab/separator token left after stripping an agency ("… x").
    cleaned = re.sub(r"\s+[x&]$", "", cleaned, flags=re.IGNORECASE).strip()
    return cleaned


# Category-specific flavor appended to a keyword query to bias toward long-form
# source material rather than existing shorts/clips.
_CATEGORY_FLAVOR = {
    "personal_brand": "podcast interview",
    "education": "full explanation",
    "entertainment": "podcast highlights",
    "music": "full performance",
    "gaming": "full stream",
    "products": "review",
    "other": "podcast interview",
}


def understand_campaign(campaign: dict[str, Any]) -> dict[str, Any]:
    """Read the campaign and derive what to search for.

    Returns ``{topic, keywords, queries, description_reliable, understanding}``.
    """
    name = (campaign.get("name") or "").strip()
    description = (campaign.get("description") or "").strip()
    category = campaign.get("category") or "other"

    reliable = bool(description) and not _GENERIC_DESC.search(description) and len(description) >= 15
    source = _source_name(name)
    # Only treat the source name as a query when it still carries a real (non
    # clipping-vocabulary) token — otherwise we'd search for "UGC Clips Campaign".
    has_source = bool(source) and bool(_tokens(source))

    # Keywords come from the title always, and the description only when it's real.
    keywords = _dedupe(_tokens(name) + (_tokens(description) if reliable else []))[:8]
    flavor = _CATEGORY_FLAVOR.get(category, "podcast interview")

    # Build a DIVERSE query set (each angle surfaces different videos): the exact
    # source, a keyword+flavor query, and the description keywords. The redundant
    # "source + flavor" only fills a leftover slot — never displaces the diverse
    # ones (that starved product campaigns of results).
    queries: list[str] = []
    if has_source:
        queries.append(source)                                         # 1) exact source
    if keywords:
        queries.append(f"{' '.join(keywords[:4])} {flavor}".strip())   # 2) keywords + flavor
    if reliable:
        desc_kw = _dedupe(_tokens(description))[:4]
        if desc_kw:
            queries.append(" ".join(desc_kw))                          # 3) description keywords
    if has_source and len(_dedupe(queries)) < 3:
        queries.append(f"{source} {flavor}".strip())                   # 4) filler if room
    # Last resort (name was all clipping-vocab AND no usable description): search
    # generic source material for the category, never the clipping words.
    if not queries:
        queries.append(flavor)
    queries = _dedupe(queries)[:3]

    display = source if has_source else (name or "this campaign")
    if has_source or reliable:
        understanding = (
            f"Read the campaign's title and description → searching for its source material "
            f"(“{display}”). Queries: {', '.join(queries)}."
        )
    else:
        understanding = (
            f"The campaign name had little to go on, so we searched broadly for its "
            f"category. Queries: {', '.join(queries)}."
        )

    return {
        "topic": display,
        "keywords": keywords,
        "queries": queries,
        "description_reliable": reliable,
        "understanding": understanding,
    }


def _duration_bonus(duration: float | None) -> float:
    """Reward long-form source material (3min–2h); penalize shorts/unknown."""
    if not duration:
        return 0.0
    if duration < 90:            # almost certainly an existing clip/short
        return -10.0
    if duration < 180:
        return 2.0
    if duration <= 7200:         # 3min–2h: ideal source for clipping
        return 12.0
    return 6.0                   # very long (>2h) still fine, slightly less ideal


def rank_matches(
    understanding: dict[str, Any],
    candidates: list[dict[str, Any]],
    *,
    primary_query: str | None,
    limit: int,
) -> list[dict[str, Any]]:
    """Score candidates by keyword overlap + source/channel-match + filters + duration."""
    kw = set(understanding.get("keywords") or [])
    kw |= set(_tokens(understanding.get("topic")))
    topic = understanding.get("topic") or "the campaign"
    filter_tokens = set(understanding.get("filter_tokens") or [])
    channel_name = understanding.get("channel_name") or ""
    channel_tokens = set(_tokens(channel_name))

    ranked: list[dict[str, Any]] = []
    seen: set[str] = set()
    for c in candidates:
        vid = c.get("id")
        if not vid or vid in seen:
            continue
        seen.add(vid)

        uploader_tokens = set(_tokens(c.get("uploader")))
        title_tokens = set(_tokens(c.get("title"))) | uploader_tokens
        matched = sorted(kw & title_tokens)
        overlap = len(matched)
        filter_hits = sorted(filter_tokens & title_tokens)
        channel_match = bool(channel_tokens) and bool(channel_tokens & uploader_tokens)

        score = 30.0 + min(54.0, overlap * 18.0)
        if c.get("_from_channel"):
            score += 30.0                                  # pulled straight from the pinned channel
        elif c.get("_from_primary"):
            score += 16.0
        if channel_match:
            score += 20.0                                  # uploader IS the pinned channel
        score += min(24.0, len(filter_hits) * 12.0)        # matches the user's filter words
        score += _duration_bonus(c.get("duration"))
        score = int(max(0, min(100, round(score))))

        if c.get("_from_channel") or channel_match:
            reason = f"From the {channel_name or topic} channel"
            if filter_hits:
                reason += " · " + ", ".join(filter_hits[:3])
        elif filter_hits:
            reason = "Matches filters: " + ", ".join(filter_hits[:4])
        elif matched:
            reason = f"Matches “{topic}” on: " + ", ".join(matched[:4])
        elif c.get("_from_primary"):
            reason = f"From the campaign's source: {topic}"
        else:
            reason = f"Related to {topic}"

        ranked.append(
            {
                "url": c.get("url"),
                "title": c.get("title"),
                "duration": c.get("duration"),
                "uploader": c.get("uploader"),
                "thumbnail": c.get("thumbnail"),
                "view_count": c.get("view_count"),
                "score": score,
                "reason": reason,
            }
        )

    ranked.sort(key=lambda r: r["score"], reverse=True)
    return ranked[:limit]


# --------------------------------------------------------------- LLM layer
# The heuristic above is the always-on, instant fallback. When a local model is
# reachable we ALSO ask it to read the campaign and name the exact creator/show/
# brand the campaign wants clips of — so a campaign like "Rob the Bank" is
# understood as the creator, not matched as three literal words. Bounded by a
# short client timeout with the heuristic as the safety net, so it never hangs.
_LLM_SYSTEM = """You identify the exact creator, show, podcast, streamer, or brand that a \
short-form "clipping" campaign wants SOURCE videos of, then write YouTube search queries \
to find that source's long-form videos (full episodes, streams, interviews) — NOT existing \
clips. Think about who/what the campaign is really about; a name like "Rob the Bank" is a \
creator, not three separate words. Return ONLY JSON."""

_LLM_USER = """Campaign to clip:
Name: {name}
Description: {description}
Category: {category}
Rules: {requirements}

Identify the source and return ONLY JSON:
{{
  "creator": "the exact creator/show/brand name (or '' if unclear)",
  "topic": "a short phrase for what the content is about",
  "keywords": ["distinctive", "search", "words"],
  "queries": ["3-4 YouTube search queries that find this source's long-form videos"]
}}"""

_LLM_SCHEMA = {
    "type": "object",
    "properties": {
        "creator": {"type": "string"},
        "topic": {"type": "string"},
        "keywords": {"type": "array", "items": {"type": "string"}},
        "queries": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["queries"],
}

# Vision-only tags can't do text reasoning — never pick them for understanding.
_VISION_HINTS = ("moondream", "llava", "bakllava", "-vl", "vision", "minicpm-v")
# Reasoning models (deepseek-r1, qwq, o1…) are far slower for this tiny task —
# deprioritize them so an interactive "Find" stays snappy (a 1B model answers in
# ~10s vs ~40s for an 8B reasoning model).
_REASONING_HINTS = ("-r1", "r1:", "reasoning", "qwq", "o1-", "thinking")
_SIZE_RE = re.compile(r"(\d+(?:\.\d+)?)\s*b\b", re.IGNORECASE)


def _resolve_finder_model(requested: str | None, client: Any) -> str | None:
    """Pick a fast, capable text model for understanding: the requested one if
    installed, else the smallest non-reasoning installed text model in the ~1–9B
    sweet spot (avoids sub-1B junk AND slow >9B models). None if none available."""
    try:
        installed = {m.get("name") for m in client.list_models() if m.get("name")}
    except Exception:
        return requested  # can't list — try the requested name, or None
    if not installed:
        return None
    if requested and requested in installed:
        return requested
    text = [n for n in installed if not any(h in n.lower() for h in _VISION_HINTS)]
    if not text:
        return None

    def _size(name: str) -> float:
        m = _SIZE_RE.search(name)
        return float(m.group(1)) if m else 0.0

    def _rank(name: str) -> tuple[bool, bool, float]:
        size = _size(name)
        reasoning = any(h in name.lower() for h in _REASONING_HINTS)
        in_band = 1.0 <= size <= 9.0
        # non-reasoning first · in the fast/capable band first · then smallest.
        return (reasoning, not in_band, size)

    text.sort(key=_rank)
    return text[0]


def _clean_query_list(value: Any, cap: int) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        text = str(item).strip() if item is not None else ""
        if text and len(text) <= 120:
            out.append(text)
        if len(out) >= cap:
            break
    return out


def _llm_understand(campaign: dict[str, Any], *, model: str | None, timeout: int = 8) -> dict[str, Any] | None:
    """Best-effort LLM read of the campaign. Returns None on any failure.

    ``timeout`` is deliberately SHORT (this is an interactive request the user is
    waiting on): the LLM only refines the search queries, and the heuristic is a
    solid fallback, so we never let a cold/slow/queued Ollama stall the finder.
    An over-long wait here overruns the dev proxy's socket timeout and surfaces
    to the user as a spurious "Internal Server Error" — so the whole LLM step is
    strictly bounded and degrades to the heuristic well within a few seconds.
    """
    from app.services.ollama_client import OllamaClient

    name = (campaign.get("name") or "").strip()
    description = (campaign.get("description") or "").strip()
    if not name and not description:
        return None

    client = OllamaClient(timeout=timeout)
    resolved = _resolve_finder_model(model, client)
    if not resolved:
        return None

    reqs = "; ".join(_str_list(campaign.get("requirements"), cap=8)) or "(none)"
    prompt = _LLM_USER.format(
        name=name or "(untitled)",
        description=(description or "(none)")[:600],
        category=campaign.get("category") or "other",
        requirements=reqs,
    )
    try:
        parsed, _meta = client.generate_json(
            prompt, model=resolved, system=_LLM_SYSTEM, schema=_LLM_SCHEMA,
            # Tiny prompt → a small context keeps prompt-eval cheap so a warm
            # model answers well inside the short timeout above (the default 8k
            # ctx needlessly slows this on a weak GPU).
            options={"temperature": 0.3, "num_ctx": 2048}, retries=0,
        )
    except Exception as exc:
        logger.info("Finder LLM understanding unavailable (%s); using heuristic", exc)
        return None
    if not isinstance(parsed, dict):
        return None

    queries = _clean_query_list(parsed.get("queries"), cap=4)
    if not queries:
        return None
    creator = str(parsed.get("creator") or "").strip()
    topic = str(parsed.get("topic") or "").strip() or creator or _source_name(name) or name
    # Normalize keywords into lowercase single tokens so they actually match the
    # tokenized candidate titles in rank_matches (raw multi-word/cased LLM
    # keywords would intersect nothing).
    raw_keywords = _clean_query_list(parsed.get("keywords"), cap=8)
    keywords = _dedupe([t for k in raw_keywords for t in _tokens(k)]) or _tokens(f"{creator} {topic}")
    detail = f" (creator: {creator})" if creator and creator.lower() not in topic.lower() else ""
    understanding = (
        f"Understood this campaign as {topic}{detail} and searched YouTube for its source "
        f"videos. Queries: {', '.join(queries)}."
    )
    return {"topic": topic, "keywords": keywords, "queries": queries, "understanding": understanding}


def _str_list(value: Any, *, cap: int) -> list[str]:
    return _clean_query_list(value, cap)


def _channel_display_name(channel: str) -> str:
    """A human/keyword name for a pinned channel ref (name, @handle, or URL)."""
    ch = (channel or "").strip()
    if not ch:
        return ""
    if ch.lower().startswith(("http://", "https://")):
        m = re.search(r"/@([^/?]+)", ch) or re.search(r"/(?:c|user|channel)/([^/?]+)", ch)
        return m.group(1).replace("-", " ") if m else ""
    return ch.lstrip("@")


# Creator/brand names mined from a description ("...content creator Rob The Bank...",
# "Clip for Jane Doe..."). Case-sensitive on purpose — proper nouns are capitalized,
# which separates a real name from ordinary words.
_CREATOR_PHRASE = re.compile(
    r"(?:content\s+)?creator[s]?\s+([A-Z][\w'.&]*(?:\s+[A-Z][\w'.&]*){0,3})"
    r"|clip(?:s|ping)?\s+(?:for\s+)?([A-Z][\w'.&]*(?:\s+[A-Z][\w'.&]*){1,3})"
    r"|\bfor\s+([A-Z][\w'.&]*(?:\s+[A-Z][\w'.&]*){1,3})"
)


def _creator_phrases(description: str) -> list[str]:
    """Capitalized creator/brand phrases mentioned in the description."""
    out: list[str] = []
    for m in _CREATOR_PHRASE.finditer(description or ""):
        phrase = (m.group(1) or m.group(2) or m.group(3) or "").strip()
        if phrase:
            out.append(phrase)
    return _dedupe(out)


def _auto_creator(campaign: dict[str, Any]) -> dict[str, Any] | None:
    """Best-effort: identify the creator/brand the campaign is about and resolve
    their channel, so the finder pulls that creator's FULL catalog even when the
    user hasn't pinned a channel. Tries the cleaned campaign name, then creator
    phrases mined from the description. Bounded to 2 resolve attempts (each is one
    yt-dlp search, ~1-2s) and degrades to ``None`` — the keyword search still runs.
    """
    name = campaign.get("name") or ""
    src = _source_name(name)
    candidates: list[str] = []
    # Require a real signal (multi-word, or a single token ≥4 chars) so we never
    # resolve on a lone ambiguous word like "Rob".
    if src and (len(src.split()) >= 2 or len(src.replace(" ", "")) >= 4):
        candidates.append(src)
    candidates.extend(_creator_phrases(campaign.get("description") or ""))

    for cand in _dedupe(candidates)[:2]:
        if len(cand.strip()) < 3:
            continue
        resolved = youtube.resolve_channel(cand)
        if resolved:
            return resolved
    return None


def find_matches(
    campaign: dict[str, Any],
    *,
    limit: int = 12,
    model: str | None = None,
    use_llm: bool = True,
    channel: str | None = None,
    strict_channel: bool = False,
    filters: list[str] | None = None,
) -> dict[str, Any]:
    """Full flow: understand (LLM + heuristic) → search YouTube → rank. Blocking.

    Optional user refinements: ``channel`` (a creator name / @handle / URL — a
    plain name is resolved to that creator's actual channel), ``strict_channel``
    (return ONLY that creator's own videos, dropping other people's videos about
    them), and ``filters`` (words that steer the search + ranking).
    """
    limit = max(3, min(int(limit), 100))
    channel = (channel or "").strip()
    filter_terms = [str(f).strip() for f in (filters or []) if str(f).strip()][:12]
    filter_tokens = _dedupe([t for f in filter_terms for t in _tokens(f)])

    heuristic = understand_campaign(campaign)

    # --- resolve the creator FIRST ---
    # A pinned plain NAME → their actual channel (so the finder pulls that creator's
    # own uploads, not other people's videos ABOUT them); an @handle/URL is used
    # as-is. When nothing is pinned, AUTO-detect the creator from the campaign itself
    # so the user gets their full catalog with zero input. Auto-detected → never strict.
    if channel:
        resolved = youtube.resolve_channel(channel)
        auto_creator = False
    else:
        resolved = _auto_creator(campaign)
        auto_creator = resolved is not None
    if auto_creator:
        strict_channel = False
    channel_ref = resolved["ref"] if resolved else channel
    channel_name = resolved["name"] if resolved else _channel_display_name(channel)
    channel_id_hint = resolved.get("channel_id") if resolved else None

    # The LLM's only job here is to NAME the creator so we can search for their
    # source videos — redundant once we've already resolved their channel (we have
    # the whole catalog). So skip that slow, often-timing-out call in the common
    # case and only spend it when we're still unsure who the campaign is about.
    llm = _llm_understand(campaign, model=model) if (use_llm and not resolved) else None
    if llm:
        # LLM's targeted queries lead; heuristic queries back them up.
        queries = _dedupe(llm["queries"] + heuristic["queries"])[:4]
        keywords = _dedupe(llm["keywords"] + heuristic["keywords"])[:12]
        understanding = llm["understanding"]
        topic = llm["topic"]
    else:
        queries = heuristic["queries"]
        keywords = heuristic["keywords"]
        understanding = heuristic["understanding"]
        topic = heuristic["topic"]

    if channel_name:
        keywords = _dedupe(_tokens(channel_name) + keywords)[:16]
        queries = _dedupe([channel_name, f"{channel_name} {topic}".strip()] + queries)[:4]
    if filter_terms:
        keywords = _dedupe(filter_tokens + keywords)[:20]
        lead = queries[0] if queries else topic
        queries = _dedupe([f"{lead} {' '.join(filter_terms)}".strip()] + queries)[:4]

    u = {
        "topic": topic,
        "keywords": keywords,
        "filter_tokens": filter_tokens,
        "channel_name": channel_name,
    }
    primary = queries[0] if queries else None
    per_query = min(40, max(8, math.ceil(limit * 1.5 / max(1, len(queries)))))

    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    # The creator (pinned OR auto-detected) contributes their actual uploads first,
    # in bulk — this is the richest vein of usable source material and it's a single
    # yt-dlp call regardless of depth, so pull deep (60–150) to give the user tons.
    if channel_ref:
        channel_pull = min(150, max(limit * 2, 60))
        for r in youtube.channel_videos(channel_ref, channel_pull):
            vid = r.get("id")
            if vid and vid not in seen:
                seen.add(vid)
                r["_from_channel"] = True
                candidates.append(r)
    for q in queries:
        for r in youtube.search(q, per_query):
            vid = r.get("id")
            if not vid or vid in seen:
                continue
            seen.add(vid)
            r["_from_primary"] = q == primary
            candidates.append(r)

    # Strict "only this creator": keep just the creator's OWN videos — their
    # channel uploads, an exact channel-id match, or an uploader whose name
    # contains the whole creator name. Drops other people's videos about them.
    if strict_channel and channel:
        ch_tokens = set(_tokens(channel_name))

        def _is_creator(c: dict[str, Any]) -> bool:
            if c.get("_from_channel"):
                return True
            if channel_id_hint and c.get("channel_id") == channel_id_hint:
                return True
            up = set(_tokens(c.get("uploader"))) | set(_tokens(c.get("channel")))
            return bool(ch_tokens) and ch_tokens <= up

        candidates = [c for c in candidates if _is_creator(c)]

    matches = rank_matches(u, candidates, primary_query=primary, limit=limit)

    extra: list[str] = []
    if channel_name:
        if auto_creator:
            extra.append(f"auto-detected creator “{channel_name}” — pulled their full catalog")
        elif strict_channel:
            extra.append(f"only {channel_name}’s own videos")
        else:
            extra.append(f"channel “{channel_name}”")
    if filter_terms:
        extra.append("filters: " + ", ".join(filter_terms))
    if extra:
        understanding = understanding.rstrip(".") + ". Refined by " + " · ".join(extra) + "."

    logger.info(
        "Campaign finder: %d queries -> %d candidates -> %d matches "
        "(llm=%s, channel=%s, auto=%s, strict=%s, filters=%d)",
        len(queries), len(candidates), len(matches),
        bool(llm), bool(channel), auto_creator, strict_channel, len(filter_terms),
    )
    return {"understanding": understanding, "queries": queries, "matches": matches}
