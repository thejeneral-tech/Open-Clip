"""Topic-to-Clips orchestrator: the AUTO CREATE flow.

Discovers YouTube videos for a source, analyzes each one (metadata, transcript,
deterministic engagement signals), finds clip moments, ranks/dedupes across all
videos, selects the strongest (never padding weak ones), then renders each into
a real vertical clip with captions. Reuses the existing per-video services and
reports live progress through the JobManager + the run's stats.

Runs one video at a time (16GB-box friendly) and caches the expensive work
(metadata, transcript, comments, source downloads) so re-runs are cheap.
"""
from __future__ import annotations

import math
from typing import Callable

from .. import config, database, llm, util
from ..jobs import Job, manager
from . import comments as comments_svc
from . import clips as clips_svc
from . import metadata as metadata_svc
from . import presets, render, search
from . import transcript as transcript_svc

Logger = Callable[[str], None]

STEPS = [
    ("discover", "Search & rank videos"),
    ("analyze", "Analyze videos"),
    ("select", "Score & select moments"),
    ("render", "Create clips"),
]

_STYLE_FILTER = {
    "funny": "funny", "heated": "controversial", "controversial": "controversial",
    "reaction": "emotional", "story": None, "highlight": None, "auto": None,
}


def _new_stats() -> dict:
    return {"phase": "queued", "pct": 0, "videos_found": 0, "videos_selected": 0,
            "videos_done": 0, "moments_found": 0, "clips_total": 0, "clips_done": 0,
            "clips_failed": 0, "errors": 0, "current_video": ""}


def _pct(stats: dict) -> int:
    phase = stats.get("phase")
    if phase == "discover":
        return 4
    if phase == "analyze":
        vt = stats.get("videos_selected") or 1
        return 8 + int(50 * stats.get("videos_done", 0) / vt)
    if phase == "select":
        return 60
    if phase == "render":
        ct = stats.get("clips_total") or 1
        return 64 + int(34 * stats.get("clips_done", 0) / ct)
    if phase == "done":
        return 100
    return 0


def _windows_per_video(num_videos: int) -> int:
    """Bound LLM clip-scanning cost as the number of videos grows."""
    if num_videos <= 3:
        return 12
    if num_videos <= 6:
        return 9
    if num_videos <= 10:
        return 7
    return 5


def _build_intent(cfg: dict) -> dict:
    return {
        "mode": "clips", "platform": "shorts",
        "filter": _STYLE_FILTER.get(cfg["clip_style"]),
        "min_duration": cfg["min_len"], "max_duration": cfg["max_len"],
        "count": max(4, min(8, cfg["num_clips"])),
        "focus": cfg["topic"] or cfg["clip_style"],
    }


# --- per-video analysis (cached) ----------------------------------------
def _analyze_video(url: str, cfg: dict, log: Logger) -> tuple[dict, list[dict]]:
    meta = metadata_svc.fetch_metadata(url)
    vid = meta.get("video_id")
    if not vid:
        raise RuntimeError("Could not resolve the video id.")
    database.upsert_video(meta)

    # transcript (cached — whisper is very expensive)
    t = database.get_transcript(vid)
    if not t or not t.get("segments"):
        t = transcript_svc.get_transcript(vid, url, prefer_whisper=False, log=log)
        database.save_transcript(vid, t)

    # comments + deterministic signals (cached, no LLM)
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

    record = database.get_full_record(vid)
    intent = _build_intent(cfg)
    moments = clips_svc.find_clips(record, intent, log,
                                   max_windows=_windows_per_video(cfg["num_videos"]),
                                   include_signals=True)
    database.save_clips(vid, moments)
    for m in moments:
        m["video_id"] = vid
        m["source_url"] = util.watch_url(vid)
        m["video_title"] = meta.get("title")
        m["channel"] = meta.get("channel")
    return meta, moments


# --- cross-video selection ----------------------------------------------
def _select_clips(all_moments: list[dict], cfg: dict) -> list[dict]:
    """Strongest moments across all videos, spread so one video can't dominate,
    never padded below the quality bar."""
    num = cfg["num_clips"]
    strong = [m for m in all_moments if m.get("viral_score", 0) >= config.MIN_STRONG_CLIP_SCORE]
    strong.sort(key=lambda m: m.get("viral_score", 0), reverse=True)

    chosen: list[dict] = []
    per_video: dict[str, int] = {}
    cap = max(2, math.ceil(num / 2))
    for m in strong:
        if len(chosen) >= num:
            break
        vid = m.get("video_id")
        if per_video.get(vid, 0) >= cap:
            continue
        chosen.append(m)
        per_video[vid] = per_video.get(vid, 0) + 1
    # fill remaining slots ignoring the per-video cap if we came up short
    if len(chosen) < num:
        for m in strong:
            if len(chosen) >= num:
                break
            if m not in chosen:
                chosen.append(m)
    for i, m in enumerate(chosen, 1):
        m["rank"] = i
        _score_clip(m, cfg)
    return chosen


def _score_clip(m: dict, cfg: dict) -> None:
    """Attach the three review scores: clip (overall), hook, and topic relevance."""
    base = int(m.get("viral_score", 50))
    m["clip_score"] = base
    hook = m.get("hook") or ""
    m["hook_score"] = min(100, base + 8) if len(hook) > 8 else max(0, base - 20)
    want = search._tokens(cfg.get("topic", "")) | {
        tok for kw in presets.keyword_list(cfg.get("keywords", "")) for tok in search._tokens(kw)}
    if not want:
        m["topic_score"] = 75
        return
    have = search._tokens(
        f"{m.get('title', '')} {m.get('reason', '')} {m.get('caption', '')} {m.get('video_title', '')}")
    m["topic_score"] = round(100 * len(want & have) / len(want))


# --- clip title / description -------------------------------------------
def _clip_meta(m: dict, cfg: dict) -> dict:
    fallback = {
        "title": (m.get("title") or "Clip")[:90],
        "description": (m.get("hook") or m.get("reason") or "")[:300],
        "hashtags": [],
    }
    prompt = f"""A short vertical clip about "{cfg['topic'] or 'this video'}".
Clip hook: {m.get('hook', '')}
Why it's strong: {m.get('reason', '')}
On-screen caption: {m.get('caption', '')}

Write a punchy YouTube Shorts / TikTok TITLE (<= 80 chars) and a 1-2 sentence
DESCRIPTION, plus 3-5 relevant hashtags. Return ONLY JSON:
{{"title": "...", "description": "...", "hashtags": ["#tag"]}}"""
    try:
        data = llm.generate_json(prompt, temperature=0.6, default=None)
        if isinstance(data, dict) and data.get("title"):
            return {
                "title": str(data["title"]).strip()[:90],
                "description": str(data.get("description", "")).strip()[:400],
                "hashtags": [str(h).strip() for h in (data.get("hashtags") or []) if str(h).strip()][:6],
            }
    except Exception:  # noqa: BLE001
        pass
    return fallback


# --- main orchestrator ---------------------------------------------------
def run(job: Job, run_id: str, cfg: dict, selected: list[dict] | None = None) -> None:
    cfg = presets.normalize_config(cfg)
    log: Logger = lambda msg: manager.log(job, msg)
    stats = _new_stats()

    def save(**run_fields):
        stats["pct"] = _pct(stats)
        database.update_run(run_id, stats=stats, progress=stats["pct"], **run_fields)

    manager.start(job)
    stats["phase"] = "discover"
    save(status="running")

    try:
        # 1. discover ----------------------------------------------------
        manager.step(job, "discover", "running")
        if selected:
            candidates = selected[:cfg["num_videos"]]
            log(f"Using {len(candidates)} videos you selected.")
        else:
            candidates = search.discover(cfg, log)[:cfg["num_videos"]]
        if not candidates:
            raise RuntimeError("No YouTube videos were found for this source.")
        stats["videos_found"] = stats["videos_selected"] = len(candidates)
        database.update_run(run_id, selected=candidates)
        save()
        manager.step(job, "discover", "done", f"{len(candidates)} videos selected")

        # 2. analyze each video -----------------------------------------
        manager.step(job, "analyze", "running")
        stats["phase"] = "analyze"
        all_moments: list[dict] = []
        for i, cand in enumerate(candidates):
            title = (cand.get("title") or cand.get("video_id") or "")[:60]
            stats["current_video"] = title
            save()
            manager.step(job, "analyze", "running", f"{i + 1}/{len(candidates)}: {title}")
            log(f"Analyzing video {i + 1}/{len(candidates)}: {title}")
            try:
                _meta, moments = _analyze_video(cand.get("url") or util.watch_url(cand["video_id"]),
                                                cfg, log)
                all_moments += moments
                stats["moments_found"] = len(all_moments)
                log(f"  Found {len(moments)} candidate moments.")
            except Exception as e:  # noqa: BLE001
                stats["errors"] += 1
                log(f"  Skipped (error): {e}")
            stats["videos_done"] = i + 1
            save()
        manager.step(job, "analyze", "done",
                     f"{stats['moments_found']} moments from {stats['videos_done']} videos")

        # 3. select strongest -------------------------------------------
        manager.step(job, "select", "running")
        stats["phase"] = "select"
        save()
        chosen = _select_clips(all_moments, cfg)
        stats["clips_total"] = len(chosen)
        save()
        if not chosen:
            manager.step(job, "select", "done", "No strong moments found")
            log("No clip moments met the quality bar. Try a broader topic or more videos.")
            stats["phase"] = "done"
            stats["pct"] = 100
            database.update_run(run_id, status="done", stats=stats, progress=100)
            manager.finish(job, {"run_id": run_id, "clips": 0})
            return
        manager.step(job, "select", "done", f"Selected {len(chosen)} strong clips")
        if len(chosen) < cfg["num_clips"]:
            log(f"Only {len(chosen)} strong clip moments met the quality bar "
                f"(you asked for {cfg['num_clips']}). Not padding with weak clips.")

        # 4. render ------------------------------------------------------
        manager.step(job, "render", "running")
        stats["phase"] = "render"
        save()
        sources: dict[str, str] = {}
        for m in chosen:
            rank = m["rank"]
            stats["current_video"] = (m.get("title") or "")[:60]
            save()
            manager.step(job, "render", "running",
                         f"Clip {rank}/{len(chosen)}: {(m.get('title') or '')[:46]}")
            clip_id = database.add_run_clip(run_id, m["video_id"], m["source_url"], rank,
                                            m, cfg["framing"], cfg["caption_style"], "rendering")
            try:
                if m["video_id"] not in sources:
                    log(f"Downloading source for clip {rank} ({m.get('video_title', '')[:40]})...")
                    sources[m["video_id"]] = str(
                        render.download_render_source(m["video_id"], m["source_url"], log=log))
                src = sources[m["video_id"]]
                segs = (database.get_transcript(m["video_id"]) or {}).get("segments") or []
                m.update(_clip_meta(m, cfg))
                res = render.render_clip(m, src, segs, run_id, rank, cfg["framing"],
                                         cfg["caption_style"], cfg["aspect_ratio"], log)
                m["framing_mode"] = res["framing_mode"]
                database.update_run_clip(
                    clip_id, status="rendered", clip=m, framing_mode=res["framing_mode"],
                    caption_style=cfg["caption_style"], file_path=res["file_path"],
                    poster_path=res["poster_path"], srt_path=res["srt_path"])
                stats["clips_done"] += 1
                log(f"  Clip {rank} done: {m.get('title', '')[:50]}")
            except Exception as e:  # noqa: BLE001
                stats["clips_failed"] += 1
                stats["errors"] += 1
                database.update_run_clip(clip_id, status="failed", error=str(e))
                log(f"  Clip {rank} failed: {e}")
            save()
        manager.step(job, "render", "done", f"{stats['clips_done']} clips created")

        stats["phase"] = "done"
        stats["pct"] = 100
        stats["current_video"] = ""
        database.update_run(run_id, status="done", stats=stats, progress=100)
        manager.finish(job, {"run_id": run_id, "clips": stats["clips_done"],
                             "requested": cfg["num_clips"]})
    except Exception as e:  # noqa: BLE001
        database.update_run(run_id, status="error", stats=stats)
        manager.fail(job, str(e))


# --- single-clip actions (review screen) --------------------------------
def rerender_clip(clip_row: dict, framing_mode: str | None = None,
                  caption_style: str | None = None, start: float | None = None,
                  end: float | None = None, log: Logger | None = None) -> dict:
    """Re-render one stored clip with new framing / captions / trim. Returns the
    updated clip dict (already persisted)."""
    log = log or (lambda m: None)
    run_id = clip_row["run_id"]
    vid = clip_row["video_id"]
    rank = clip_row.get("rank") or 1
    framing_mode = framing_mode or clip_row.get("framing_mode") or "smart"
    caption_style = caption_style or clip_row.get("caption_style") or "bold"
    run = database.get_run(run_id) or {}
    aspect = (run.get("params") or {}).get("aspect_ratio", "9:16")

    if start is not None:
        clip_row["start"] = float(start)
    if end is not None:
        clip_row["end"] = float(end)
    clip_row["start"] = max(0.0, float(clip_row["start"]))
    clip_row["end"] = max(clip_row["start"] + 1.0, float(clip_row["end"]))
    clip_row["duration"] = round(clip_row["end"] - clip_row["start"], 1)
    clip_row["start_str"] = util.fmt_timestamp(clip_row["start"])
    clip_row["end_str"] = util.fmt_timestamp(clip_row["end"])

    src = str(render.download_render_source(vid, clip_row["source_url"], log=log))
    segs = (database.get_transcript(vid) or {}).get("segments") or []
    res = render.render_clip(clip_row, src, segs, run_id, rank, framing_mode,
                             caption_style, aspect, log)
    clip_row["framing_mode"] = res["framing_mode"]
    database.update_run_clip(
        clip_row["id"], status="rendered", clip=clip_row, framing_mode=res["framing_mode"],
        caption_style=caption_style, file_path=res["file_path"],
        poster_path=res["poster_path"], srt_path=res["srt_path"], error=None)
    return database.get_run_clip(clip_row["id"])
