"""Smart Video Searcher orchestrator — the job-based, two-stage search engine
behind the "Search & Review First" button.

Stage 1 (start_search → _run_search): builds refined queries, runs them through
YouTube, merges + six-factor scores + de-duplicates the pool, reporting live
progress and persisting everything so the search survives a refresh / restart.
Cooperative cancel is honoured at query boundaries.

Stage 2 (analyze_selected → _run_analyze): deep-analyzes only the chosen videos,
warming the SAME caches autoclips reads, so create_clips() (which reuses the
existing autoclips.run) is fast.
"""
from __future__ import annotations

import threading
import uuid

from .. import config, database, util
from ..jobs import manager
from . import autoclips
from . import comments as comments_svc
from . import metadata as metadata_svc
from . import presets, scoring, search
from . import transcript as transcript_svc

SEARCH_STEPS = [("discover", "Search & rank videos"), ("complete", "Ready")]
ANALYZE_STEPS = [("analyze", "Deep-analyze selected"), ("complete", "Ready")]


def _noop(_: str) -> None:
    pass


def _new_search_stats() -> dict:
    return {"resultsFound": 0, "resultsAnalyzed": 0, "duplicatesRemoved": 0,
            "errors": 0, "searchesCompleted": 0, "searchesPlanned": 0,
            "currentStep": "discover"}


def _spawn(fn, job, *args) -> None:
    def runner():
        try:
            fn(job, *args)
        except Exception as e:  # noqa: BLE001 - last-resort guard
            manager.fail(job, f"Unexpected error: {e}")
            try:
                database.update_search(job.id, status="error")
            except Exception:
                pass
    threading.Thread(target=runner, daemon=True).start()


# --- stage 1: search -----------------------------------------------------
def start_search(request: dict) -> str:
    cfg = presets.normalize_config(request)
    job = manager.create("video_search",
                         url=cfg["topic"] or cfg["channel_url"] or cfg["video_url"],
                         steps=SEARCH_STEPS)
    manager.set_stats(job, **_new_search_stats())
    database.create_search(job.id, job.id, cfg)   # search_id == job.id
    _spawn(_run_search, job, cfg)
    return job.id


def _plan_queries(cfg: dict) -> list[str]:
    scope = cfg.get("search_scope") or search._scope_from(cfg)
    if scope in ("channel", "video"):
        return ["__single__"]
    queries = search.build_queries(cfg)
    if scope == "youtube_web":
        excl = presets.keyword_list(cfg["excluded_keywords"])
        queries = search._dedup_str(queries + search._web_expand(cfg["topic"], excl))[:8]
    return queries or ([cfg["topic"]] if cfg["topic"] else [])


def _search_one(cfg: dict, query: str, scope: str) -> list[dict]:
    if scope == "channel":
        tgt = search._resolve_channel_target(cfg["channel_url"] or cfg["topic"], _noop)
        return search.channel_videos(
            tgt, 15, cfg["sort_method"], cfg["topic"],
            presets.keyword_list(cfg["keywords"]),
            presets.keyword_list(cfg["excluded_keywords"]), cfg["min_views"])
    if scope == "video":
        return search.resolve_video(cfg["video_url"])
    return search.yt_search(query, 15)


def _run_search(job, cfg: dict) -> None:
    manager.start(job)
    database.update_search(job.id, status="searching", step="discover")
    stats = dict(job.stats)
    pool: dict[str, dict] = {}
    id_dupes = 0
    ranked: list[dict] = []
    try:
        scope = cfg.get("search_scope") or search._scope_from(cfg)
        queries = _plan_queries(cfg)
        if not queries:
            raise search.SearchError("Nothing to search — enter a topic, channel or video.")
        stats["searchesPlanned"] = len(queries)
        excl = presets.keyword_list(cfg["excluded_keywords"])
        ctx = scoring.build_ctx(cfg)
        for i, q in enumerate(queries):
            if manager.is_cancelled(job):
                return _finalize_cancelled(job, pool, cfg)
            label = scope if q == "__single__" else q
            manager.step(job, "discover", "running", f"Search {i + 1}/{len(queries)}: {label}")
            manager.log(job, f"Searching ({i + 1}/{len(queries)}): {label}")
            try:
                raw = _search_one(cfg, q, scope)
            except search.SearchError as e:
                stats["errors"] = stats.get("errors", 0) + 1
                manager.log(job, f"Query failed: {e}")
                raw = []
            for c in raw:
                vid = c.get("video_id")
                if not vid:
                    continue
                if vid in pool:
                    id_dupes += 1
                else:
                    pool[vid] = c
            stats["resultsFound"] = len(pool)
            stats["searchesCompleted"] = i + 1
            filtered = search._post_filter(list(pool.values()), cfg, excl)
            ranked = scoring.rank_stage1(filtered, ctx)
            dd = search.dedupe(ranked, log=lambda m: manager.log(job, m))
            ranked = dd["kept"]
            stats["duplicatesRemoved"] = id_dupes + dd["removed"]
            stats["resultsAnalyzed"] = len(ranked)
            # Carry progress in stats: manager.step() recomputes job.progress from
            # step completion (discover stays "running"), so it can't hold a %.
            job.progress = stats["pct"] = int(90 * (i + 1) / max(1, len(queries)))
            manager.set_stats(job, **stats)
            database.update_search(job.id, progress=job.progress, step="discover",
                                   stats=stats, results=ranked)
        if not ranked:
            raise search.SearchError(
                "No strong results were found for the current filters. "
                "Try lowering the minimum view count, removing an excluded keyword, "
                "or widening the date range.")
        ranked = ranked[: max(cfg["result_limit"], cfg["num_videos"])]
        if cfg.get("auto_select"):
            n = cfg["num_videos"]
            for idx, c in enumerate(ranked):
                c["auto_selected"] = idx < n
        stats["pct"] = 100
        manager.step(job, "discover", "done", f"{len(ranked)} videos")
        manager.step(job, "complete", "done", "")
        manager.set_stats(job, **stats)
        manager.finish(job, {"resultsFound": len(ranked)})
        database.update_search(job.id, status="done", step="complete", progress=100,
                               results=ranked, stats=stats)
    except search.SearchError as e:
        if "cancel" in str(e).lower():
            return _finalize_cancelled(job, pool, cfg)
        _fail(job, e, stats)
    except Exception as e:  # noqa: BLE001
        _fail(job, e, stats)


def _finalize_cancelled(job, pool: dict, cfg: dict) -> None:
    excl = presets.keyword_list(cfg["excluded_keywords"])
    filtered = search._post_filter(list(pool.values()), cfg, excl)
    ranked = scoring.rank_stage1(filtered, scoring.build_ctx(cfg))
    ranked = search.dedupe(ranked)["kept"][: max(cfg["result_limit"], cfg["num_videos"])]
    if cfg.get("auto_select"):
        for idx, c in enumerate(ranked):
            c["auto_selected"] = idx < cfg["num_videos"]
    manager.step(job, "discover", "done", f"cancelled — {len(ranked)} partial results")
    manager.cancelled(job)
    database.update_search(job.id, status="cancelled", step="discover",
                           results=ranked, stats=job.stats)


def _fail(job, e, stats) -> None:
    stats["errors"] = stats.get("errors", 0) + 1
    manager.set_stats(job, **stats)
    manager.fail(job, str(e))
    database.update_search(job.id, status="error", stats=stats)


def retry_search(old_id: str) -> str:
    old = database.get_search(old_id, with_results=False)
    if not old:
        raise KeyError("no such search job")
    return start_search(old["request"])


# --- stage 2: deep analyze selected --------------------------------------
def analyze_selected(search_id: str, video_ids: list[str]) -> str:
    job = manager.create("video_analyze", steps=ANALYZE_STEPS)
    manager.set_stats(job, **_new_search_stats())
    database.create_search(job.id, job.id, {"parent": search_id, "video_ids": video_ids})
    _spawn(_run_analyze, job, search_id, video_ids)
    return job.id


def _run_analyze(job, search_id: str, video_ids: list[str]) -> None:
    manager.start(job)
    database.update_search(job.id, status="searching", step="analyzing")
    stats = dict(job.stats)
    results: list[dict] = []
    try:
        for i, vid in enumerate(video_ids):
            if manager.is_cancelled(job):
                manager.cancelled(job)
                database.update_search(job.id, status="cancelled", results=results)
                return
            url = util.watch_url(vid)
            manager.step(job, "analyze", "running", f"{i + 1}/{len(video_ids)}: {vid}")
            try:
                results.append(_deep_analyze_one(vid, url, log=lambda m: manager.log(job, m)))
            except Exception as e:  # noqa: BLE001
                stats["errors"] = stats.get("errors", 0) + 1
                manager.log(job, f"Analyze failed for {vid}: {e}")
                results.append({"video_id": vid, "url": url, "_analyzed": False, "error": str(e)})
            stats["resultsAnalyzed"] = i + 1
            job.progress = stats["pct"] = int(100 * (i + 1) / max(1, len(video_ids)))
            manager.set_stats(job, **stats)
            database.update_search(job.id, progress=job.progress, stats=stats, results=results)
        stats["pct"] = 100
        manager.step(job, "analyze", "done", f"{len(results)} videos analyzed")
        manager.step(job, "complete", "done", "")
        manager.finish(job, {"resultsAnalyzed": len(results)})
        database.update_search(job.id, status="done", step="complete", progress=100, results=results)
    except Exception as e:  # noqa: BLE001
        _fail(job, e, stats)


def _deep_analyze_one(vid: str, url: str, log) -> dict:
    """Warm metadata/transcript/comments caches (the same ones autoclips reads)
    and return a stage-2 enriched card."""
    meta = database.get_video(vid) or metadata_svc.fetch_metadata(url)
    database.upsert_video(meta)

    t = database.get_transcript(vid)
    if not t or not t.get("segments"):
        try:
            t = transcript_svc.get_transcript(vid, url, prefer_whisper=False, log=log)
            database.save_transcript(vid, t)
        except Exception as e:  # noqa: BLE001
            log(f"Transcript unavailable: {e}")
            t = t or {}

    c = database.get_comments(vid)
    if not c:
        fetched = comments_svc.fetch_comments(vid, url, max_comments=120, log=log)
        heatmap = meta.get("heatmap", [])
        insights = {
            "available": bool(fetched["comments"]),
            "most_replayed": comments_svc.most_replayed(heatmap),
            "mentioned_timestamps": comments_svc.mentioned_timestamps(fetched["comments"]),
        }
        database.save_comments(vid, fetched["comments"], heatmap, insights)
        c = database.get_comments(vid)

    fr = database.get_frames(vid)   # not extracted here — just report what's cached
    insights = (c or {}).get("insights", {})
    cnt = len((c or {}).get("comments") or [])
    return {
        **_stage1_fields(meta), "_analyzed": True, "_enriched": True,
        "transcript_chars": len((t or {}).get("full_text") or ""),
        "has_transcript": bool((t or {}).get("segments")),
        "comment_count": meta.get("comment_count") or cnt,
        "like_count": meta.get("like_count"),
        "channel_followers": meta.get("channel_followers"),
        "chapters": meta.get("chapters") or [],
        "heatmap": meta.get("heatmap") or [],
        "has_captions": meta.get("has_captions") or meta.get("has_auto_captions"),
        "most_replayed": insights.get("most_replayed", []),
        "mentioned_timestamps": insights.get("mentioned_timestamps", []),
        "frames_count": len(fr or []),
        "engagement_summary": (f"{cnt} comments · {len(insights.get('most_replayed', []))} "
                               f"replay peaks · {len(fr or [])} frames"),
    }


def _stage1_fields(meta: dict) -> dict:
    """Map a full metadata dict to the flat candidate shape stage-1 produces."""
    vid = meta.get("video_id")
    dur = meta.get("duration")
    return {
        "video_id": vid, "url": meta.get("url") or util.watch_url(vid),
        "title": meta.get("title") or vid, "channel": meta.get("channel") or "",
        "channel_url": meta.get("channel_url") or "", "channel_verified": False,
        "duration": dur, "duration_str": meta.get("duration_string") or util.fmt_timestamp(dur),
        "view_count": meta.get("view_count"), "upload_ts": None,
        "upload_date": meta.get("upload_date"),
        "description": (meta.get("description") or "")[:500],
        "thumbnail": meta.get("thumbnail") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
    }


# --- bridge into the existing clip pipeline ------------------------------
def create_clips(search_id: str, selected: list[dict], cfg_overrides: dict | None) -> dict:
    sj = database.get_search(search_id, with_results=False) or {}
    req = sj.get("request") or {}
    cfg = presets.normalize_config({**req, **(cfg_overrides or {})})
    # Honor the user's explicit selection: analyze at least as many videos as
    # they ticked (capped for the low-RAM box), so none are silently dropped.
    if selected:
        cfg["num_videos"] = min(max(cfg["num_videos"], len(selected)), config.MAX_VIDEOS_TO_ANALYZE)
    run_id = uuid.uuid4().hex[:12]
    query = cfg["topic"] or cfg["channel_url"] or cfg["video_url"] or cfg["source_type"]
    clip_job = manager.create("autoclips", url=query, steps=autoclips.STEPS)
    database.create_run(run_id, cfg["source_type"], query, cfg, clip_job.id)
    if sj:
        database.update_search(search_id, run_id=run_id)
    _spawn(autoclips.run, clip_job, run_id, cfg, selected)
    return {"run_id": run_id, "job_id": clip_job.id}


def refresh_meta(video_ids: list[str], cfg: dict | None = None, log=None) -> list[dict]:
    """Re-enrich + re-score a small set of videos (per-card "Refresh Metadata")."""
    log = log or _noop
    ctx = scoring.build_ctx(cfg or {})
    cands = []
    for vid in video_ids:
        try:
            meta = metadata_svc.fetch_metadata(util.watch_url(vid))
        except Exception as e:  # noqa: BLE001
            log(f"Refresh failed for {vid}: {e}")
            continue
        c = _stage1_fields(meta)
        c.update({
            "like_count": meta.get("like_count"), "comment_count": meta.get("comment_count"),
            "channel_followers": meta.get("channel_followers"),
            "chapters": meta.get("chapters") or [], "heatmap": meta.get("heatmap") or [],
            "has_captions": meta.get("has_captions"), "has_auto_captions": meta.get("has_auto_captions"),
            "language": meta.get("language"), "is_short": meta.get("is_short"), "_enriched": True,
        })
        c.update(scoring.score_candidate(c, ctx))
        cands.append(c)
    return cands
