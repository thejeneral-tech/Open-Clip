"""Six-factor, two-stage scoring for the Smart Video Searcher.

Each result gets six 0-100 sub-scores — Topic Relevance, Popularity, Engagement,
Recency, Clip Potential, Channel Reliability — combined into a Final Score with
mode-dependent weights. Stage 1 scores cheaply from flat ytsearch fields; stage 2
enriches only the top-N with one metadata fetch (like/comment counts, chapters,
heatmap, captions) and re-scores. Signals that aren't available yet degrade to a
neutral value rather than zero, so stage-1 ranking is stable.

score_candidate() is PURE and writes BOTH namespaced keys (topic_relevance,
clip_potential, …) AND the keys the existing frontend/cards already read
(score, relevance_score, popularity_score, engagement_score, clip_score, reason),
so it is the single source of truth on the smart path without breaking anything.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Callable

from . import comments as comments_svc
from . import metadata as metadata_svc
from . import presets, search

Logger = Callable[[str], None]


def _noop(_: str) -> None:
    pass


def _clip01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _pct(x: float) -> int:
    return round(_clip01(x) * 100)


def _ratio_norm(value: float, ceiling: float) -> float:
    return _clip01((value or 0) / ceiling) if ceiling else 0.0


# Weight tables — each row sums to 1.0. Keys: topic, pop, eng, recency, clip, chan.
WEIGHTS = {
    "best-match":          {"topic": 0.35, "pop": 0.20, "eng": 0.15, "recency": 0.10, "clip": 0.15, "chan": 0.05},
    "most-popular":        {"topic": 0.20, "pop": 0.45, "eng": 0.15, "recency": 0.05, "clip": 0.10, "chan": 0.05},
    "most-recent":         {"topic": 0.25, "pop": 0.10, "eng": 0.10, "recency": 0.45, "clip": 0.05, "chan": 0.05},
    "highest-engagement":  {"topic": 0.20, "pop": 0.15, "eng": 0.45, "recency": 0.05, "clip": 0.10, "chan": 0.05},
    "best-clip-potential": {"topic": 0.25, "pop": 0.10, "eng": 0.10, "recency": 0.05, "clip": 0.45, "chan": 0.05},
    "most-commented":      {"topic": 0.20, "pop": 0.15, "eng": 0.35, "recency": 0.05, "clip": 0.20, "chan": 0.05},
}
SORT_ALIAS = {
    "relevance": "best-match", "best-match": "best-match", "best_match": "best-match",
    "views": "most-popular", "most-popular": "most-popular", "popular": "most-popular",
    "recent": "most-recent", "most-recent": "most-recent",
    "rating": "highest-engagement", "engagement": "highest-engagement",
    "highest-engagement": "highest-engagement",
    "clip": "best-clip-potential", "clip_potential": "best-clip-potential",
    "best-clip-potential": "best-clip-potential",
    "commented": "most-commented", "most-commented": "most-commented",
    "longest": "best-match", "shortest": "best-match",
}


def _weights(sort: str | None) -> dict:
    return WEIGHTS.get(SORT_ALIAS.get(sort or "best-match", "best-match"), WEIGHTS["best-match"])


def _kw_tokens(keywords: list[str]) -> set:
    out: set = set()
    for k in keywords:
        out |= search._tokens(k)
    return out


def build_ctx(cfg: dict, *, now_ts: float | None = None) -> dict:
    cfg = presets.normalize_config(cfg)
    kws = presets.keyword_list(cfg["keywords"])
    return {
        "topic": cfg["topic"],
        "query_tokens": search._tokens(cfg["topic"]),
        "kw_tokens": _kw_tokens(kws),
        "keywords": kws,
        "excluded_tokens": _kw_tokens(presets.keyword_list(cfg["excluded_keywords"])),
        "now_ts": now_ts or datetime.now(timezone.utc).timestamp(),
        "sort": cfg["sort_method"],
        "median_views": None,
        "max_followers": None,
        "deep": False,
    }


# --- sub-scorers (each -> 0..100) ----------------------------------------
def _s_topic(c, ctx) -> int:
    return _pct(search._relevance(c, ctx["query_tokens"], ctx["kw_tokens"]))


def _velocity(c, now_ts) -> float | None:
    v, ts = c.get("view_count"), c.get("upload_ts")
    if not v or not ts:
        return None
    age_days = max(1.0, (now_ts - ts) / 86400.0)
    return _clip01(math.log10(v / age_days + 1) / math.log10(50000))  # ~50k/day saturates


def _s_popularity(c, ctx) -> int:
    pop = search._popularity(c.get("view_count"))           # 0..1, log of total views
    vel = _velocity(c, ctx["now_ts"])
    velc = vel if vel is not None else pop
    foll = c.get("channel_followers")
    if foll:
        size = _clip01(math.log10(foll + 1) / 7.0)          # 10M subs ~ 1.0
    else:
        size = 0.5                                           # neutral when unknown (stage-1)
    return _pct(0.40 * velc + 0.35 * pop + 0.25 * size)


def _s_engagement(c, ctx) -> int:
    lc, cc, v = c.get("like_count"), c.get("comment_count"), c.get("view_count")
    if lc is None and cc is None:
        return 50                                           # neutral until enriched
    lr = _ratio_norm((lc or 0) / v, 0.06) if v else 0.0
    cr = _ratio_norm((cc or 0) / v, 0.01) if v else 0.0
    activity = _clip01(math.log10((cc or 0) + 1) / math.log10(50000))
    return _pct(0.50 * lr + 0.30 * cr + 0.20 * activity)


def _s_recency(c, ctx) -> int:
    return _pct(search._recency(c.get("upload_ts"), ctx["now_ts"]))


def _duration_sweetspot(dur) -> float:
    if not dur:
        return 0.4
    m = dur / 60.0
    if 8 <= m <= 90:
        return 1.0
    if m < 8:
        return _clip01(m / 8.0)
    return _clip01(1 - (m - 90) / 120.0)


def _keyword_density(c, ctx) -> float:
    toks = search._tokens(f"{c.get('title', '')} {c.get('description', '')}")
    want = ctx["kw_tokens"] or ctx["query_tokens"]
    if not want or not toks:
        return 0.0
    return _clip01(len(want & toks) / len(want))


def _s_clip_potential(c, ctx) -> int:
    score = 0.20 * _duration_sweetspot(c.get("duration"))
    score += 0.15 * _keyword_density(c, ctx)
    score += 0.20 * _clip01(len(c.get("chapters") or []) / 8.0)
    heat = c.get("heatmap") or []
    if heat:
        peaks = comments_svc.most_replayed(heat)
        top = max((p.get("intensity") or 0) for p in peaks) if peaks else 0
        score += 0.20 * _clip01(top)
    score += 0.15 * _clip01(len(c.get("mentioned_timestamps") or []) / 6.0)
    if c.get("has_captions") or c.get("has_auto_captions"):
        score += 0.10
    return _pct(score)


def _originality(c) -> float:
    hay = f"{c.get('title', '')} {c.get('channel', '')}".lower()
    bad = ("reupload", "re-upload", "mirror", "fan edit", "fan-edit", "clips channel")
    return 0.3 if any(b in hay for b in bad) else 1.0


def _s_channel_reliability(c, ctx) -> int:
    verified = 1.0 if c.get("channel_verified") else 0.0
    foll = c.get("channel_followers")
    size = _clip01(math.log10(foll + 1) / 7.0) if foll else 0.45
    return _pct(0.45 * verified + 0.35 * size + 0.20 * _originality(c))


# --- reason / matched keywords -------------------------------------------
def matched_keywords(c, ctx) -> list[str]:
    toks = search._tokens(f"{c.get('title', '')} {c.get('description', '')}")
    return [kw for kw in ctx["keywords"] if search._tokens(kw) & toks]


def reason_selected(c, subs, ctx, matched) -> str:
    bits = []
    if subs["topic"] >= 66:
        bits.append(f'strongly matches "{ctx["topic"]}"' if ctx["topic"] else "is highly relevant")
    elif subs["topic"] >= 40:
        bits.append(f'matches "{ctx["topic"]}"' if ctx["topic"] else "is relevant")
    if c.get("view_count"):
        bits.append(f"has {search._human(c['view_count'])} views")
    if subs["engagement"] >= 60 and c.get("comment_count"):
        bits.append("strong comment activity")
    if subs["clip"] >= 55:
        bits.append("high clip potential")
    if c.get("channel_verified"):
        bits.append("is from a verified channel")
    if matched:
        bits.append("matches keywords: " + ", ".join(matched[:4]))
    return ("Selected because it " + "; ".join(bits) + ".") if bits else "Selected as a relevant result."


# --- the scorer ----------------------------------------------------------
def score_candidate(c: dict, ctx: dict) -> dict:
    """Pure: compute all scores for one candidate. Caller merges the result."""
    subs = {
        "topic": _s_topic(c, ctx),
        "popularity": _s_popularity(c, ctx),
        "engagement": _s_engagement(c, ctx),
        "recency": _s_recency(c, ctx),
        "clip": _s_clip_potential(c, ctx),
        "channel": _s_channel_reliability(c, ctx),
    }
    w = _weights(ctx["sort"])
    final = round(w["topic"] * subs["topic"] + w["pop"] * subs["popularity"]
                  + w["eng"] * subs["engagement"] + w["recency"] * subs["recency"]
                  + w["clip"] * subs["clip"] + w["chan"] * subs["channel"])
    matched = matched_keywords(c, ctx)
    reason = reason_selected(c, subs, ctx, matched)
    return {
        # namespaced (rich card)
        "topic_relevance": subs["topic"], "popularity_score": subs["popularity"],
        "engagement_score": subs["engagement"], "recency_score": subs["recency"],
        "clip_potential": subs["clip"], "channel_reliability": subs["channel"],
        "final_score": final,
        # reconciled with existing keys the frontend already reads
        "score": final, "relevance_score": subs["topic"], "clip_score": subs["clip"],
        "matched_keywords": matched, "reason_selected": reason, "reason": reason,
        "_enriched": bool(c.get("_enriched")),
    }


# --- two-stage pipeline --------------------------------------------------
def _apply_post_sort(cands: list[dict], sort: str) -> None:
    if sort == "longest":
        cands.sort(key=lambda c: c.get("duration") or 0, reverse=True)
    elif sort == "shortest":
        cands.sort(key=lambda c: c.get("duration") or 1e12)


def rank_stage1(cands: list[dict], ctx: dict) -> list[dict]:
    """Score every candidate cheaply (flat fields) and sort by final score."""
    views = [c["view_count"] for c in cands if c.get("view_count")]
    if views:
        views.sort()
        ctx["median_views"] = views[len(views) // 2]
    for c in cands:
        c.update(score_candidate(c, ctx))
    cands.sort(key=lambda c: c.get("final_score", 0), reverse=True)
    _apply_post_sort(cands, ctx.get("sort"))
    return cands


def enrich_and_rescore(top: list[dict], ctx: dict, deep: bool = False,
                       log: Logger | None = None) -> list[dict]:
    """Fetch full metadata (no download) for the given subset, merge stage-2
    signals, optionally pull comments, then re-score with the now-richer data."""
    log = log or _noop
    max_foll = ctx.get("max_followers") or 0
    for c in top:
        try:
            meta = metadata_svc.fetch_metadata(c["url"])
        except Exception as e:  # noqa: BLE001
            log(f"Could not enrich {c.get('video_id')}: {e}")
            continue
        c.update({
            "like_count": meta.get("like_count"), "comment_count": meta.get("comment_count"),
            "channel_followers": meta.get("channel_followers"),
            "chapters": meta.get("chapters") or [], "heatmap": meta.get("heatmap") or [],
            "has_captions": meta.get("has_captions"), "has_auto_captions": meta.get("has_auto_captions"),
            "language": meta.get("language"), "tags": meta.get("tags") or [],
            "is_short": meta.get("is_short"), "_enriched": True,
        })
        if c.get("channel_followers"):
            max_foll = max(max_foll, c["channel_followers"])
        if deep:
            try:
                fetched = comments_svc.fetch_comments(c["video_id"], c["url"], max_comments=80, log=log)
                c["comment_count"] = c.get("comment_count") or len(fetched["comments"])
                c["mentioned_timestamps"] = comments_svc.mentioned_timestamps(fetched["comments"])
                c["most_replayed"] = comments_svc.most_replayed(c.get("heatmap") or [])
            except Exception as e:  # noqa: BLE001
                log(f"Comment fetch failed for {c.get('video_id')}: {e}")
    ctx["max_followers"] = max_foll or None
    for c in top:
        c.update(score_candidate(c, ctx))
    top.sort(key=lambda c: c.get("final_score", 0), reverse=True)
    _apply_post_sort(top, ctx.get("sort"))
    return top


def smart_rank(cands: list[dict], cfg: dict, *, top_n: int = 12, deep: bool = False,
               log: Logger | None = None) -> list[dict]:
    """Full smart ranking: stage-1 over all, enrich the head, re-sort."""
    ctx = build_ctx(cfg)
    ranked = rank_stage1(cands, ctx)
    head_n = max(8, min(15, top_n))
    head, tail = ranked[:head_n], ranked[head_n:]
    enrich_and_rescore(head, ctx, deep=deep, log=log)
    merged = head + tail
    merged.sort(key=lambda c: c.get("final_score", 0), reverse=True)
    _apply_post_sort(merged, ctx.get("sort"))
    return merged
