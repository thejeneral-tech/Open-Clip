"""YouTube discovery, ranking and topic refinement (YouTube-only, no API key).

Topic search uses yt-dlp's `ytsearchN:` flat extraction; channel search flat-
extracts a channel's Videos tab. Candidates are ranked by a composite of topic
relevance, popularity, recency and channel credibility — deliberately NOT views
alone (spec) — and clearly unrelated / excluded-keyword videos are dropped.
"""
from __future__ import annotations

import difflib
import math
import re
import unicodedata
from datetime import datetime, timezone
from typing import Callable
from urllib.parse import urlparse

from yt_dlp import YoutubeDL

from .. import config, database, llm, util
from ..ffmpeg_utils import ffmpeg_location_for_ytdlp
from . import presets

Logger = Callable[[str], None]


def _noop(_: str) -> None:
    pass


class SearchError(RuntimeError):
    pass


_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
    "this", "that", "best", "top", "new", "video", "videos", "youtube", "clip",
    "clips", "moment", "moments", "podcast", "ep", "episode", "full", "part",
}
_YT_HOSTS = ("youtube.com", "youtu.be", "m.youtube.com", "music.youtube.com",
             "www.youtube.com")


# --- YouTube-only guard --------------------------------------------------
def is_youtube_url(url: str) -> bool:
    if not url:
        return False
    if util.extract_video_id(url):
        return True
    try:
        host = (urlparse(url).hostname or "").lower().lstrip("www.")
    except Exception:
        return False
    return any(host == h or host.endswith("." + h) for h in _YT_HOSTS)


def _require_youtube(url: str, what: str) -> None:
    if not is_youtube_url(url):
        raise SearchError(
            f"{what} must be a YouTube URL. This workflow only pulls from YouTube "
            f"(not TikTok, Instagram, X, Reddit or other sites)."
        )


# --- yt-dlp flat extraction ---------------------------------------------
def _flat_opts(limit: int | None = None) -> dict:
    opts: dict = {
        "quiet": True, "no_warnings": True, "skip_download": True,
        "extract_flat": True, "ignoreerrors": True,
    }
    if limit:
        opts["playlistend"] = limit
        opts["playlist_items"] = f"1:{limit}"
    loc = ffmpeg_location_for_ytdlp()
    if loc:
        opts["ffmpeg_location"] = loc
    return opts


def _extract(target: str, limit: int | None = None) -> list[dict]:
    try:
        with YoutubeDL(_flat_opts(limit)) as ydl:
            info = ydl.extract_info(target, download=False)
    except Exception as e:  # noqa: BLE001
        raise SearchError(str(e)) from e
    if not info:
        return []
    entries = info.get("entries")
    if entries is None:
        entries = [info]
    return [e for e in entries if e]


def _norm_entry(e: dict) -> dict | None:
    vid = e.get("id") or util.extract_video_id(e.get("url") or "")
    if not vid or not re.match(r"^[A-Za-z0-9_-]{11}$", vid):
        return None
    if (e.get("live_status") in ("is_live", "is_upcoming")) or e.get("is_live"):
        return None
    ts = e.get("timestamp") or e.get("release_timestamp")
    upload_date = None
    if ts:
        try:
            upload_date = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
        except Exception:
            upload_date = None
    thumb = e.get("thumbnail")
    if not thumb and e.get("thumbnails"):
        thumb = (e["thumbnails"][-1] or {}).get("url")
    if not thumb:
        thumb = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    dur = e.get("duration")
    cand = {
        "video_id": vid,
        "url": util.watch_url(vid),
        "title": e.get("title") or "",
        "channel": e.get("channel") or e.get("uploader") or "",
        "channel_url": e.get("channel_url") or e.get("uploader_url") or "",
        "channel_verified": bool(e.get("channel_is_verified")),
        "duration": dur,
        "duration_str": util.fmt_timestamp(dur) if dur else "",
        "view_count": e.get("view_count"),
        "upload_ts": ts,
        "upload_date": upload_date,
        "description": (e.get("description") or "")[:500],
        "thumbnail": thumb,
    }
    cand["video_type"] = _infer_video_type(cand)
    return cand


# --- ranking -------------------------------------------------------------
def _tokens(text: str) -> set[str]:
    raw = re.findall(r"[a-z0-9']+", (text or "").lower())
    return {t for t in raw if len(t) > 1 and t not in _STOPWORDS}


def _relevance(cand: dict, query_tokens: set[str], kw_tokens: set[str]) -> float:
    if not query_tokens and not kw_tokens:
        return 0.6
    title_tok = _tokens(cand["title"])
    chan_tok = _tokens(cand["channel"])
    desc_tok = _tokens(cand["description"])
    want = query_tokens | kw_tokens
    if not want:
        return 0.6
    in_title = len(want & title_tok) / len(want)
    in_other = len(want & (chan_tok | desc_tok)) / len(want)
    score = 0.75 * in_title + 0.25 * in_other
    # keyword presence is a meaningful bonus on top of base relevance
    if kw_tokens:
        kw_hits = len(kw_tokens & (title_tok | desc_tok)) / len(kw_tokens)
        score = min(1.0, score + 0.2 * kw_hits)
    return round(min(1.0, score), 3)


def _popularity(views: int | None) -> float:
    if not views or views <= 0:
        return 0.0
    # ~10M views saturates to 1.0
    return round(min(1.0, math.log10(views + 1) / 7.0), 3)


def _recency(upload_ts: int | None, now_ts: float) -> float:
    if not upload_ts:
        return 0.5  # unknown age — neutral, don't punish
    age_days = max(0.0, (now_ts - upload_ts) / 86400.0)
    if age_days <= 30:
        return 1.0
    # linear decay to 0 at ~5 years
    return round(max(0.0, 1.0 - (age_days - 30) / (5 * 365)), 3)


def _duration_ok(cand: dict) -> bool:
    dur = cand.get("duration")
    if dur is None:
        return True
    return dur >= 45  # drop tiny reupload noise; podcasts/long-form are fine


def _excluded_hit(cand: dict, excluded: list[str]) -> str | None:
    hay = f"{cand['title']} {cand['channel']} {cand['description']}".lower()
    for ex in excluded:
        if ex and ex.lower() in hay:
            return ex
    return None


_SORT_WEIGHTS = {
    "relevance": (0.50, 0.30, 0.20),
    "views":     (0.35, 0.50, 0.15),
    "rating":    (0.40, 0.45, 0.15),
    "recent":    (0.35, 0.15, 0.50),
}


def _reason(cand: dict) -> str:
    bits = []
    rel = cand["relevance_score"]
    if rel >= 0.66:
        bits.append("strong topic match")
    elif rel >= 0.4:
        bits.append("good topic match")
    else:
        bits.append("loose topic match")
    if cand.get("view_count"):
        bits.append(f"{_human(cand['view_count'])} views")
    if cand.get("upload_date"):
        bits.append(cand["upload_date"])
    if cand.get("channel_verified"):
        bits.append("verified channel")
    return " · ".join(bits)


def _human(n: int | None) -> str:
    if not n:
        return "0"
    for unit, div in (("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if n >= div:
            return f"{n / div:.1f}{unit}"
    return str(n)


def rank_candidates(cands: list[dict], topic: str, keywords: list[str],
                    excluded: list[str], sort: str = "relevance",
                    min_views: int = 0) -> list[dict]:
    now_ts = datetime.now(timezone.utc).timestamp()
    query_tokens = _tokens(topic)
    kw_tokens = set()
    for k in keywords:
        kw_tokens |= _tokens(k)
    w_rel, w_pop, w_rec = _SORT_WEIGHTS.get(sort, _SORT_WEIGHTS["relevance"])

    ranked: list[dict] = []
    seen: set[str] = set()
    for c in cands:
        if not c or c["video_id"] in seen:
            continue
        seen.add(c["video_id"])
        if _excluded_hit(c, excluded):
            continue
        if min_views and (c.get("view_count") or 0) < min_views:
            continue
        if not _duration_ok(c):
            continue
        c["relevance_score"] = _relevance(c, query_tokens, kw_tokens)
        c["popularity_score"] = _popularity(c.get("view_count"))
        c["recency_score"] = _recency(c.get("upload_ts"), now_ts)
        cred = 0.05 if c["channel_verified"] else 0.0
        combined = (w_rel * c["relevance_score"] + w_pop * c["popularity_score"]
                    + w_rec * c["recency_score"] + cred)
        c["score"] = round(min(1.0, combined) * 100)
        c["relevance_score"] = round(c["relevance_score"] * 100)
        c["popularity_score"] = round(c["popularity_score"] * 100)
        c["reason"] = _reason(c)
        ranked.append(c)
    ranked.sort(key=lambda x: x["score"], reverse=True)
    return ranked


# --- public discovery ----------------------------------------------------
def search_topic(topic: str, keywords: list[str] | None = None,
                 excluded: list[str] | None = None, limit: int = 8,
                 sort: str = "relevance", min_views: int = 0,
                 log: Logger | None = None) -> list[dict]:
    log = log or _noop
    topic = (topic or "").strip()
    if not topic:
        raise SearchError("Enter a topic to search for.")
    keywords = keywords or []
    excluded = excluded or []
    fetch_n = min(max(limit * 3, limit + 6), 40)
    log(f"Searching YouTube for \"{topic}\" ({fetch_n} candidates)...")
    raw = _extract(f"ytsearch{fetch_n}:{topic}")
    cands = [c for c in (_norm_entry(e) for e in raw) if c]
    log(f"Found {len(cands)} possible videos. Ranking by relevance + popularity + recency...")
    ranked = rank_candidates(cands, topic, keywords, excluded, sort, min_views)
    log(f"Selected top {min(limit, len(ranked))} of {len(ranked)} relevant videos.")
    return ranked[:limit]


def channel_videos(channel_url: str, limit: int = 8, sort: str = "recent",
                   topic: str = "", keywords: list[str] | None = None,
                   excluded: list[str] | None = None, min_views: int = 0,
                   log: Logger | None = None) -> list[dict]:
    log = log or _noop
    _require_youtube(channel_url, "Channel URL")
    target = _channel_target(channel_url)
    fetch_n = min(max(limit * 3, 20), 60)
    log(f"Listing videos from channel ({fetch_n} most recent)...")
    raw = _extract(target, limit=fetch_n)
    cands = [c for c in (_norm_entry(e) for e in raw) if c]
    if not cands:
        raise SearchError("No videos found for that channel URL.")
    log(f"Found {len(cands)} channel videos. Ranking...")
    # Stay inside the channel: rank by topic/recency/views but never drop on
    # relevance — the channel itself is the filter.
    ranked = rank_candidates(cands, topic, keywords or [], excluded or [],
                             sort if sort in _SORT_WEIGHTS else "recent", min_views)
    if not topic:
        # no topic given: respect the requested ordering directly
        key = {"views": "popularity_score", "recent": "recency_score"}.get(sort, "score")
        ranked.sort(key=lambda x: x.get(key, 0), reverse=True)
    return ranked[:limit]


def _channel_target(url: str) -> str:
    """Normalize a channel URL to its Videos tab for flat extraction."""
    url = url.strip().rstrip("/")
    if util.extract_video_id(url):
        # a video URL was pasted — fall back to the watch URL (handled upstream)
        return url
    low = url.lower()
    if any(low.endswith(tab) for tab in ("/videos", "/streams", "/shorts", "/featured")):
        return url
    if "/playlist?" in low or "list=" in low:
        return url
    return url + "/videos"


def resolve_video(url: str, log: Logger | None = None) -> list[dict]:
    log = log or _noop
    _require_youtube(url, "Video URL")
    vid = util.extract_video_id(url)
    if not vid:
        raise SearchError("That doesn't look like a valid YouTube video URL or id.")
    log(f"Resolving video {vid}...")
    raw = _extract(util.watch_url(vid))
    cand = _norm_entry(raw[0]) if raw else None
    if not cand:
        cand = {"video_id": vid, "url": util.watch_url(vid), "title": vid,
                "channel": "", "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                "duration": None, "duration_str": "", "view_count": None,
                "upload_date": None, "description": "", "channel_verified": False,
                "channel_url": "", "upload_ts": None}
    cand.update({
        "relevance_score": 100,
        "popularity_score": round(_popularity(cand.get("view_count")) * 100),
        "recency_score": 100,
        "score": 100,
        "reason": "Video you selected",
    })
    return [cand]


# --- topic refinement ----------------------------------------------------
def _fallback_suggestions(topic: str) -> list[str]:
    t = topic.strip()
    return [
        f"{t} funniest moments",
        f"{t} heated arguments",
        f"{t} best clips",
        f"{t} funniest stories",
        f"{t} guest reactions",
        f"{t} controversial moments",
    ]


def refine_topic(topic: str, log: Logger | None = None) -> list[str]:
    log = log or _noop
    topic = (topic or "").strip()
    if not topic:
        return []
    prompt = f"""A user wants to find YouTube videos to make short clips about: "{topic}".

Suggest 6 sharper, specific YouTube search queries that would surface the most
clippable moments (funny, heated, surprising, story payoffs, reactions, etc.).
Keep each query short and natural, and keep the core subject "{topic}".

Return ONLY JSON: {{"suggestions": ["query 1", "query 2", ...]}}"""
    try:
        data = llm.generate_json(prompt, temperature=0.6, default=None)
        sugg = (data or {}).get("suggestions") if isinstance(data, dict) else None
        out = [str(s).strip() for s in (sugg or []) if str(s).strip()]
        if out:
            return out[:6]
    except Exception as e:  # noqa: BLE001
        log(f"Topic refinement LLM call failed: {e}")
    return _fallback_suggestions(topic)


# --- Smart Video Searcher: query builder, scope routing, post-filter -----
_RECENCY_CUTOFF_DAYS = {"any": None, "year": 365, "month": 30, "week": 7, "day": 1}
_SCOPES = ("youtube", "youtube_web", "channel", "video")


def _q(s: str) -> str:
    """Quote a multi-word phrase so ytsearch treats it as one subject."""
    s = (s or "").strip()
    return f'"{s}"' if " " in s else s


def _dedup_str(items: list[str]) -> list[str]:
    seen, out = set(), []
    for s in items:
        low = (s or "").strip().lower()
        if low and low not in seen:
            seen.add(low)
            out.append(s.strip())
    return out


def _scope_from(cfg: dict) -> str:
    """Derive a search scope from the legacy source_type."""
    return {"channel": "channel", "video": "video"}.get((cfg or {}).get("source_type"), "youtube")


def build_queries(cfg: dict, log: Logger | None = None) -> list[str]:
    """Refined, on-topic search phrases: the raw topic, a keyword-folded variant,
    and LLM expansions (best-effort) — each with excluded terms negated. Cap 6."""
    log = log or _noop
    cfg = presets.normalize_config(cfg)
    topic = cfg["topic"].strip()
    if not topic:
        return []
    kws = presets.keyword_list(cfg["keywords"])
    excl = presets.keyword_list(cfg["excluded_keywords"])
    neg = " ".join(f"-{_q(e)}" for e in excl[:4])
    queries = [topic]
    if kws:
        queries.append(f'{_q(topic)} {" ".join(kws[:4])}')
    try:
        queries.extend(refine_topic(topic, log)[:4])
    except Exception as e:  # noqa: BLE001 - search must work without the LLM
        log(f"Query expansion skipped (LLM unavailable): {e}")
    out = [(q + (" " + neg if neg else "")).strip() for q in queries]
    return _dedup_str(out)[:6]


def _web_expand(topic: str, excl: list[str]) -> list[str]:
    """Broader, on-topic phrasings used for the 'youtube + web discovery' scope.
    Pure-local (no external web calls): widens recall toward source material."""
    neg = " ".join(f"-{_q(e)}" for e in (excl or [])[:3])
    return [f"{_q(topic)} {sfx} {neg}".strip()
            for sfx in ("interview", "full clip", "highlights")]


def _web_discover_watch_urls(cfg: dict, log: Logger | None = None) -> list[str]:
    """Hook for general web-search discovery of youtube.com/watch links. The local
    server has no web-search backend, so this returns [] and the scope degrades to
    a broadened YouTube search. Any URLs a future implementation finds MUST be run
    through util.extract_video_id + resolve_video so only valid YouTube videos pass."""
    return []


def _post_filter(cands: list[dict], cfg: dict, excl: list[str]) -> list[dict]:
    """Apply excluded keywords + recency cutoff + max-duration + language. Missing
    signals (e.g. language at stage-1) are treated as 'keep'."""
    now = datetime.now(timezone.utc).timestamp()
    cutoff = _RECENCY_CUTOFF_DAYS.get(cfg.get("recency", "any"))
    max_dur = (cfg.get("max_duration_min") or 0) * 60
    lang = (cfg.get("language") or "").strip().lower()
    vtype = cfg.get("video_type")
    out = []
    for c in cands:
        if _excluded_hit(c, excl):
            continue
        if cutoff is not None and c.get("upload_ts"):
            if (now - c["upload_ts"]) / 86400 > cutoff:
                continue
        if max_dur and c.get("duration") and c["duration"] > max_dur:
            continue
        if lang and c.get("language") and not str(c["language"]).lower().startswith(lang):
            continue
        if not _video_type_matches(c, vtype):
            continue
        out.append(c)
    return out


def _resolve_channel_target(value: str, log: Logger | None = None) -> str:
    """Accept a channel URL, @handle, UC… id, or a bare channel name and return a
    Videos-tab URL suitable for flat extraction."""
    log = log or _noop
    value = (value or "").strip()
    if not value:
        raise SearchError("Enter a YouTube channel.")
    if value.startswith("@"):
        return f"https://www.youtube.com/{value}/videos"
    if re.fullmatch(r"UC[\w-]{22}", value):
        return f"https://www.youtube.com/channel/{value}/videos"
    if value.lower().startswith("http"):
        if not is_youtube_url(value):
            raise SearchError("Channel URL must be a YouTube URL.")
        return _channel_target(value)
    # bare name → find the channel via search
    log(f"Resolving channel by name: {value}...")
    for e in _extract(f"ytsearch5:{value}"):
        cu = e.get("channel_url") or e.get("uploader_url")
        if cu:
            return cu.rstrip("/") + "/videos"
    raise SearchError(f"Could not find a YouTube channel named '{value}'.")


def _per_query_n(limit: int, n_queries: int) -> int:
    """How many results to pull per ytsearch so the merged pool is ~3x the limit."""
    return max(8, min(20, (limit * 3) // max(1, n_queries) + 5))


def yt_search(query: str, n: int, log: Logger | None = None, use_cache: bool = True) -> list[dict]:
    """Run one ytsearch and return normalized candidates, with a short-lived cache
    so retry / find-more don't re-hit YouTube for the same query."""
    log = log or _noop
    key = f"yt:{n}:{(query or '').strip().lower()}"
    if use_cache:
        cached = database.get_search_cache(key, config.SEARCH_CACHE_TTL)
        if cached is not None:
            log(f"Using cached results for: {query}")
            return [c for c in cached if c]
    cands = [c for c in (_norm_entry(e) for e in _extract(f"ytsearch{n}:{query}")) if c]
    if use_cache and cands:
        database.put_search_cache(key, cands)
    return cands


# --- video type inference (best-effort; flat search has no type field) ---
_COMPILATION_HINTS = ("compilation", "best of", "best moments", "funniest", "highlights", "montage")


def _infer_video_type(c: dict) -> str:
    dur = c.get("duration")
    text = f"{c.get('title', '')} {c.get('description', '')}".lower()
    if "/shorts/" in (c.get("url") or "") or c.get("is_short") or (dur is not None and dur <= 60):
        return "shorts"
    if any(h in text for h in _COMPILATION_HINTS):
        return "compilation"
    if "interview" in text:
        return "interview"
    if "podcast" in text or _episode_key(c.get("title", "")) or (dur is not None and dur >= 2400):
        return "podcast"
    if dur is not None and dur >= 1200:
        return "long-form"
    return "video"


def _video_type_matches(c: dict, vt: str | None) -> bool:
    if not vt or vt == "any":
        return True
    label = c.get("video_type") or _infer_video_type(c)
    dur = c.get("duration")
    if vt == "long-form":
        return (dur is not None and dur >= 1200) or label in ("long-form", "podcast", "interview")
    if vt == "shorts":
        return label == "shorts"
    return label == vt


# --- duplicate / near-duplicate removal ----------------------------------
_TITLE_FILLER = {
    "official", "video", "clip", "clips", "full", "episode", "ep", "podcast",
    "hd", "4k", "new", "best", "moments", "highlights", "compilation", "reupload",
    "part", "feat", "ft", "the", "a", "with", "vs",
}
_EP_RE = re.compile(r"(?:\bep(?:isode)?\.?\s*|#)\s*(\d{1,4})\b", re.IGNORECASE)


def _norm_title(title: str) -> list[str]:
    t = unicodedata.normalize("NFKD", title or "")
    t = "".join(ch for ch in t if not unicodedata.combining(ch)).lower()
    t = re.sub(r"[^\w\s]", " ", t)
    return [w for w in t.split() if w not in _TITLE_FILLER and len(w) > 1]


def _episode_key(title: str) -> str | None:
    m = _EP_RE.search(title or "")
    return m.group(1) if m else None


def _authority(c: dict) -> tuple:
    """Prefer verified channel, then more views, then longer (original), then
    earliest upload, then higher score — for picking the version to keep."""
    return (
        1 if c.get("channel_verified") else 0,
        c.get("view_count") or 0,
        c.get("duration") or 0,
        -(c.get("upload_ts") or 0),
        c.get("score", c.get("final_score", 0)) or 0,
    )


def dedupe(candidates: list[dict], title_jaccard: float = 0.82,
           title_ratio: float = 0.88, episode_overlap: float = 0.35,
           log: Logger | None = None) -> dict:
    """Group reuploads / mirrors / same-episode / near-identical titles and keep
    the most authoritative version of each. Returns {kept, removed, groups, message}."""
    log = log or _noop
    cands = [c for c in candidates if c]
    n = len(cands)
    if n <= 1:
        return {"kept": cands, "removed": 0, "groups": [], "message": ""}

    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    ids = [c.get("video_id") for c in cands]
    toks = [set(_norm_title(c.get("title", ""))) for c in cands]
    norm = [" ".join(sorted(t)) for t in toks]
    eps = [_episode_key(c.get("title", "")) for c in cands]
    for i in range(n):
        for j in range(i + 1, n):
            if ids[i] and ids[i] == ids[j]:
                union(i, j)
                continue
            if not toks[i] or not toks[j]:
                continue
            inter = len(toks[i] & toks[j])
            # same episode number + overlapping show tokens = same episode upload
            if eps[i] and eps[i] == eps[j] and inter / min(len(toks[i]), len(toks[j])) >= episode_overlap:
                union(i, j)
                continue
            jac = inter / len(toks[i] | toks[j])
            if jac >= title_jaccard and difflib.SequenceMatcher(None, norm[i], norm[j]).ratio() >= title_ratio:
                union(i, j)

    clusters: dict[int, list[int]] = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(i)
    kept, removed, groups = [], 0, []
    for idxs in clusters.values():
        if len(idxs) == 1:
            kept.append(cands[idxs[0]])
            continue
        best = max(idxs, key=lambda i: _authority(cands[i]))
        kept.append(cands[best])
        removed += len(idxs) - 1
        groups.append([cands[i].get("video_id") for i in idxs])
    kept.sort(key=lambda c: c.get("score", c.get("final_score", 0)) or 0, reverse=True)
    message = f"Removed {removed} duplicate or repeated result(s)." if removed else ""
    if message:
        log(message)
    return {"kept": kept, "removed": removed, "groups": groups, "message": message}


# --- unified entry used by the API ---------------------------------------
def run_search(cfg: dict, scope: str | None = None, cancel_event=None,
               progress_cb: Callable[[str, int], None] | None = None,
               log: Logger | None = None) -> list[dict]:
    """Scope-aware search: routes single-target scopes, otherwise runs a YouTube
    search, applies post-filters + ranking + duplicate removal. Keeps the legacy
    /api/search + autoclips behaviour (single ytsearch, rank_candidates shape)."""
    log = log or _noop
    cfg = presets.normalize_config(cfg)
    scope = scope or cfg.get("search_scope") or _scope_from(cfg)
    kws = presets.keyword_list(cfg["keywords"])
    excl = presets.keyword_list(cfg["excluded_keywords"])
    limit = max(cfg.get("result_limit") or 0, cfg.get("num_videos") or 8)

    if scope == "video":
        return resolve_video(cfg["video_url"], log)
    if scope == "channel":
        tgt = _resolve_channel_target(cfg["channel_url"] or cfg["topic"], log)
        cands = channel_videos(tgt, max(limit, 8), cfg["sort_method"], cfg["topic"],
                               kws, excl, cfg["min_views"], log)
        cands = _post_filter(cands, cfg, excl)
        return dedupe(cands, log=log)["kept"][:limit]

    topic = cfg["topic"].strip()
    if not topic:
        raise SearchError("Enter a topic to search for.")
    fetch_n = min(max(limit * 3, limit + 6), 40)
    log(f"Searching YouTube for \"{topic}\" ({fetch_n} candidates)...")
    cands = yt_search(topic, fetch_n, log)
    cands = _post_filter(cands, cfg, excl)
    ranked = rank_candidates(cands, topic, kws, excl, cfg["sort_method"], cfg["min_views"])
    ranked = dedupe(ranked, log=log)["kept"]
    if progress_cb:
        progress_cb("discover", 90)
    return ranked[:limit]


def discover(cfg: dict, log: Logger | None = None) -> list[dict]:
    """Run discovery for a normalized run/preset config and return candidates.
    Now scope-aware (topic/channel/video/youtube_web) with post-filters + dedupe."""
    return run_search(cfg, log=log)
