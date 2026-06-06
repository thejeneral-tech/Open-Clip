"""FastAPI server: REST API for every pipeline step + full run, job polling,
history, exports, and static hosting of the dashboard and extracted frames."""
from __future__ import annotations

import threading
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, database, ffmpeg_utils, llm, pipeline, util
from .jobs import manager
from .services import autoclips, exporters, presets, render, search, video_search
from .services.intent import MODES


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    # Restart recovery: any search left mid-flight by a dead process becomes
    # 'error' so the UI can offer Retry instead of hanging forever.
    reaped = database.reap_orphan_search_jobs()
    if reaped:
        print(f"  Recovered {reaped} interrupted search job(s).")
    config.VIDEO_DATA_DIR.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="YouTube Video Intelligence Agent", version="1.0.0", lifespan=lifespan)


# --- no-cache for the dashboard (so HTML/CSS/JS edits show up on reload) --
@app.middleware("http")
async def _no_cache_dashboard(request, call_next):
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static"):
        # Allow caching but force the browser to revalidate every load.
        # Combined with StaticFiles' ETag/Last-Modified this yields a fast 304
        # when unchanged and the fresh file the moment you edit it.
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


# --- request models ------------------------------------------------------
class AnalyzeReq(BaseModel):
    url: str
    prompt: str = ""
    do_frames: bool = True
    prefer_whisper: bool = False


class StepReq(BaseModel):
    url: str
    prompt: str = ""
    do_vision: bool = True
    prefer_whisper: bool = False


class ModelReq(BaseModel):
    model: str = ""           # for vision, "" means auto-detect
    kind: str = "reasoning"   # "reasoning" or "vision"


# --- Topic-to-Clips request models ---------------------------------------
class RefineReq(BaseModel):
    topic: str = ""


class SearchReq(BaseModel):
    config: dict = {}


class AutoClipsReq(BaseModel):
    config: dict = {}
    selected: list[dict] | None = None   # candidates chosen in the review panel


# --- Smart Video Searcher request models ---------------------------------
class VSStartReq(BaseModel):
    config: dict = {}


class VSAnalyzeReq(BaseModel):
    jobId: str
    videoIds: list[str] = []


class VSCreateReq(BaseModel):
    jobId: str = ""
    selected: list[dict] = []
    config: dict | None = None


class VSRefreshReq(BaseModel):
    video_ids: list[str] = []
    config: dict | None = None


class PresetReq(BaseModel):
    name: str = ""
    config: dict = {}


class ClipActionReq(BaseModel):
    start: float | None = None
    end: float | None = None
    framing: str | None = None
    caption_style: str | None = None
    title: str | None = None
    description: str | None = None


# --- job spawning --------------------------------------------------------
def _run_job(job, fn, *args) -> None:
    try:
        fn(job, *args)
    except Exception as e:  # noqa: BLE001 - last-resort guard
        manager.fail(job, f"Unexpected error: {e}")


def _spawn(fn, job, *args) -> None:
    threading.Thread(target=_run_job, args=(job, fn, *args), daemon=True).start()


STEP_RUNNERS = {
    "metadata": (pipeline.run_metadata, [("metadata", "Fetch metadata")]),
    "transcript": (pipeline.run_transcript, [("transcript", "Fetch transcript")]),
    "comments": (pipeline.run_comments, [("comments", "Analyze comments")]),
    "frames": (pipeline.run_frames, [("frames", "Extract & analyze frames")]),
    "clips": (pipeline.run_clips, [("clips", "Find clips")]),
    "output": (pipeline.run_output, [("output", "Generate output")]),
}


# --- API: config / health ------------------------------------------------
@app.get("/api/config")
def get_config():
    return {
        **config.public_config(),
        "modes": [{"key": k, "label": v["label"]} for k, v in MODES.items()],
    }


@app.get("/api/health")
def health():
    return {
        "ollama": llm.health(),
        "ffmpeg": ffmpeg_utils.ffmpeg_path(),
        "ffmpeg_ok": ffmpeg_utils.have_ffmpeg(),
        "whisper_model": config.WHISPER_MODEL,
        "config": config.public_config(),
    }


@app.post("/api/model")
def set_model(req: ModelReq):
    """Switch the active reasoning or vision model at runtime (this session).

    Reverts to the YIA_REASONING_MODEL / YIA_VISION_MODEL env defaults on
    server restart — it's a live override, not a persisted setting."""
    name = req.model.strip()
    installed = llm.list_models()
    if name and installed and name not in installed:
        raise HTTPException(400, f"Model '{name}' is not installed in Ollama.")
    if req.kind == "vision":
        config.VISION_MODEL = name          # "" -> fall back to auto-detection
        llm.detect_vision_model.cache_clear()
    elif req.kind == "reasoning":
        if not name:
            raise HTTPException(400, "A reasoning model name is required.")
        config.REASONING_MODEL = name
    else:
        raise HTTPException(400, f"Unknown model kind '{req.kind}'.")
    # Return the full, fresh health payload so the UI can refresh its pills
    # immediately without a second round-trip.
    return {"ok": True, "health": health()}


# --- API: run ------------------------------------------------------------
@app.post("/api/analyze")
def analyze(req: AnalyzeReq):
    if not util.extract_video_id(req.url):
        raise HTTPException(400, "That doesn't look like a valid YouTube URL or video id.")
    job = manager.create("full", url=req.url, prompt=req.prompt, steps=pipeline.FULL_STEPS)
    _spawn(pipeline.run_full, job, req.url, req.prompt, req.do_frames, req.prefer_whisper)
    return {"job_id": job.id}


@app.post("/api/step/{step}")
def run_step(step: str, req: StepReq):
    if step not in STEP_RUNNERS:
        raise HTTPException(400, f"Unknown step '{step}'.")
    if not util.extract_video_id(req.url):
        raise HTTPException(400, "That doesn't look like a valid YouTube URL or video id.")
    runner, steps = STEP_RUNNERS[step]
    job = manager.create(step, url=req.url, prompt=req.prompt, steps=steps)
    arg_map = {
        "metadata": (req.url,),
        "transcript": (req.url, req.prefer_whisper),
        "comments": (req.url,),
        "frames": (req.url, req.do_vision),
        "clips": (req.url, req.prompt),
        "output": (req.url, req.prompt),
    }
    _spawn(runner, job, *arg_map[step])
    return {"job_id": job.id}


# --- API: jobs -----------------------------------------------------------
@app.get("/api/job/{job_id}")
def get_job(job_id: str):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found.")
    return job.to_dict()


@app.get("/api/jobs")
def list_jobs():
    return manager.list()


# --- API: data -----------------------------------------------------------
@app.get("/api/video/{video_id}")
def get_video(video_id: str):
    record = database.get_full_record(video_id)
    if not record.get("metadata"):
        raise HTTPException(404, "Video not analyzed yet.")
    return record


@app.get("/api/videos")
def list_videos():
    return database.list_videos()


@app.delete("/api/video/{video_id}")
def delete_video(video_id: str):
    database.delete_video(video_id)
    return {"ok": True}


@app.get("/api/output/{output_id}")
def get_output(output_id: int):
    out = database.get_output(output_id)
    if not out:
        raise HTTPException(404, "Output not found.")
    return out


# --- API: export ---------------------------------------------------------
@app.get("/api/export/{video_id}")
def export(video_id: str, fmt: str = "json"):
    record = database.get_full_record(video_id)
    if not record.get("metadata"):
        raise HTTPException(404, "Video not analyzed yet.")
    if fmt not in exporters.FORMATS:
        raise HTTPException(400, f"Unsupported format. Use one of {exporters.FORMATS}.")
    res = exporters.export(record, fmt)
    return Response(
        content=res["content"],
        media_type=res["media_type"],
        headers={"Content-Disposition": f'attachment; filename="{res["filename"]}"'},
    )


# --- API: Topic-to-Clips workflow ----------------------------------------
@app.post("/api/refine")
def refine(req: RefineReq):
    topic = (req.topic or "").strip()
    if not topic:
        return {"suggestions": []}
    return {"suggestions": search.refine_topic(topic)}


@app.post("/api/search")
def do_search(req: SearchReq):
    cfg = presets.normalize_config(req.config)
    try:
        candidates = search.discover(cfg)
    except search.SearchError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Search failed: {e}")
    return {"config": cfg, "candidates": candidates}


@app.post("/api/autoclips")
def start_autoclips(req: AutoClipsReq):
    cfg = presets.normalize_config(req.config)
    st = cfg["source_type"]
    # validate the source up front for a clear, immediate error
    if st == "topic" and not cfg["topic"]:
        raise HTTPException(400, "Enter a topic to search for.")
    if st == "channel" and not search.is_youtube_url(cfg["channel_url"]):
        raise HTTPException(400, "Enter a valid YouTube channel URL.")
    if st == "video" and not util.extract_video_id(cfg["video_url"]):
        raise HTTPException(400, "Enter a valid YouTube video URL.")
    if st == "preset":
        raise HTTPException(400, "Load a saved preset (it sets the real source), then run it.")

    run_id = uuid.uuid4().hex[:12]
    query = cfg["topic"] or cfg["channel_url"] or cfg["video_url"] or st
    job = manager.create("autoclips", url=query, prompt="", steps=autoclips.STEPS)
    database.create_run(run_id, st, query, cfg, job.id)
    _spawn(autoclips.run, job, run_id, cfg, req.selected)
    return {"run_id": run_id, "job_id": job.id}


@app.get("/api/run/{run_id}")
def get_run(run_id: str):
    rec = database.get_run_record(run_id)
    if not rec:
        raise HTTPException(404, "Run not found.")
    if rec.get("job_id"):
        job = manager.get(rec["job_id"])
        if job:
            rec["job"] = job.to_dict()
    return rec


@app.get("/api/runs")
def list_runs():
    return database.list_runs()


@app.delete("/api/run/{run_id}")
def delete_run(run_id: str):
    database.delete_run(run_id)
    return {"ok": True}


def _clip_or_404(clip_id: int) -> dict:
    clip = database.get_run_clip(clip_id)
    if not clip:
        raise HTTPException(404, "Clip not found.")
    return clip


@app.post("/api/clip/{clip_id}/approve")
def approve_clip(clip_id: int):
    _clip_or_404(clip_id)
    database.update_run_clip(clip_id, status="approved")
    return database.get_run_clip(clip_id)


@app.post("/api/clip/{clip_id}/reject")
def reject_clip(clip_id: int):
    _clip_or_404(clip_id)
    database.update_run_clip(clip_id, status="rejected")
    return database.get_run_clip(clip_id)


@app.post("/api/clip/{clip_id}/title")
def edit_clip_title(clip_id: int, req: ClipActionReq):
    """Edit title/description metadata only — no re-render (these aren't burned in)."""
    clip = _clip_or_404(clip_id)
    if req.title is not None:
        clip["title"] = req.title.strip()[:120]
    if req.description is not None:
        clip["description"] = req.description.strip()[:500]
    database.update_run_clip(clip_id, clip=clip)
    return database.get_run_clip(clip_id)


def _rerender_async(clip: dict, **kwargs):
    """Re-render a clip in a background job so the UI can poll progress."""
    job = manager.create("clip", url=clip.get("source_url", ""),
                         steps=[("render", "Re-render clip")])

    def work(j):
        manager.start(j)
        manager.step(j, "render", "running")
        try:
            autoclips.rerender_clip(clip, log=lambda m: manager.log(j, m), **kwargs)
            manager.step(j, "render", "done")
            manager.finish(j, {"clip_id": clip["id"]})
        except Exception as e:  # noqa: BLE001
            manager.step(j, "render", "error", str(e))
            database.update_run_clip(clip["id"], status="failed", error=str(e))
            manager.fail(j, str(e))

    _spawn(work, job)
    return job.id


@app.post("/api/clip/{clip_id}/regenerate")
def regenerate_clip(clip_id: int):
    clip = _clip_or_404(clip_id)
    database.update_run_clip(clip_id, status="rendering")
    job_id = _rerender_async(clip)
    return {"job_id": job_id, "clip_id": clip_id}


@app.post("/api/clip/{clip_id}/trim")
def trim_clip(clip_id: int, req: ClipActionReq):
    clip = _clip_or_404(clip_id)
    if req.start is None and req.end is None:
        raise HTTPException(400, "Provide a new start and/or end.")
    database.update_run_clip(clip_id, status="rendering")
    job_id = _rerender_async(clip, start=req.start, end=req.end)
    return {"job_id": job_id, "clip_id": clip_id}


@app.post("/api/clip/{clip_id}/reframe")
def reframe_clip(clip_id: int, req: ClipActionReq):
    clip = _clip_or_404(clip_id)
    if req.framing not in presets.FRAMING_MODES:
        raise HTTPException(400, f"framing must be one of {presets.FRAMING_MODES}.")
    database.update_run_clip(clip_id, status="rendering")
    job_id = _rerender_async(clip, framing_mode=req.framing)
    return {"job_id": job_id, "clip_id": clip_id}


@app.post("/api/clip/{clip_id}/captions")
def caption_clip(clip_id: int, req: ClipActionReq):
    clip = _clip_or_404(clip_id)
    if req.caption_style not in presets.CAPTION_STYLES:
        raise HTTPException(400, f"caption_style must be one of {presets.CAPTION_STYLES}.")
    database.update_run_clip(clip_id, status="rendering")
    job_id = _rerender_async(clip, caption_style=req.caption_style)
    return {"job_id": job_id, "clip_id": clip_id}


@app.post("/api/clip/{clip_id}/replace")
def replace_clip(clip_id: int):
    """Swap this clip for the next-best unused moment from the same source video."""
    clip = _clip_or_404(clip_id)
    vid = clip["video_id"]
    used = {round(c["start"]) for c in database.list_run_clips(clip["run_id"])
            if c["video_id"] == vid and c["id"] != clip_id}
    pool = sorted(database.get_clips(vid), key=lambda c: c.get("viral_score", 0), reverse=True)
    nxt = next((c for c in pool if round(c.get("start", -1)) not in used
                and round(c.get("start", -1)) != round(clip["start"])), None)
    if not nxt:
        raise HTTPException(404, "No alternative moment available for this video.")
    nxt.update({"video_id": vid, "source_url": clip["source_url"],
                "video_title": clip.get("video_title"), "rank": clip.get("rank")})
    database.update_run_clip(clip_id, status="rendering", clip=nxt)
    fresh = database.get_run_clip(clip_id)
    job_id = _rerender_async(fresh)
    return {"job_id": job_id, "clip_id": clip_id}


# --- API: presets --------------------------------------------------------
@app.get("/api/presets")
def get_presets():
    return presets.list_all()


@app.post("/api/presets")
def create_preset(req: PresetReq):
    return presets.create(req.name, req.config)


@app.put("/api/presets/{preset_id}")
def update_preset(preset_id: int, req: PresetReq):
    out = presets.update(preset_id, req.name, req.config)
    if not out:
        raise HTTPException(404, "Preset not found.")
    return out


@app.post("/api/presets/{preset_id}/duplicate")
def duplicate_preset(preset_id: int):
    out = presets.duplicate(preset_id)
    if not out:
        raise HTTPException(404, "Preset not found.")
    return out


@app.delete("/api/presets/{preset_id}")
def delete_preset(preset_id: int):
    presets.delete(preset_id)
    return {"ok": True}


@app.post("/api/presets/{preset_id}/run")
def run_preset(preset_id: int, req: AutoClipsReq):
    preset = presets.get(preset_id)
    if not preset:
        raise HTTPException(404, "Preset not found.")
    return start_autoclips(AutoClipsReq(config=preset["config"], selected=req.selected))


# --- API: Smart Video Searcher -------------------------------------------
def _job_view(job_id: str) -> dict | None:
    """Unified search-job status from the live JobManager, falling back to the
    persisted DB row when the worker is gone (backend restarted)."""
    job = manager.get(job_id)
    row = database.get_search(job_id, with_results=False)
    if not job and not row:
        return None
    if job:
        d = job.to_dict()
        stats = d.get("stats") or {}
        running = next((s for s in d.get("steps", []) if s["status"] == "running"), None)
        step = (running or {}).get("name") or (row or {}).get("step") or stats.get("currentStep") or "discover"
        elapsed = round(time.time() - d.get("created_at", time.time()), 1)
        progress = stats.get("pct", d.get("progress", 0))
        base = {"status": d.get("status"), "progress": progress,
                "steps": d.get("steps", []), "logs": (d.get("logs") or [])[-200:],
                "cancel_requested": d.get("cancel_requested", False), "error": d.get("error")}
    else:
        stats = row.get("stats") or {}
        step = row.get("step") or stats.get("currentStep") or "complete"
        elapsed = 0.0
        base = {"status": row.get("status"), "progress": stats.get("pct", row.get("progress", 0)),
                "steps": [], "logs": [], "cancel_requested": False,
                "error": ("This search was interrupted (the server restarted). "
                          "Retry to run it again." if row.get("status") == "error" else None)}
    return {"id": job_id, "currentStep": step, "phase": step, "elapsed": elapsed,
            "resultsFound": stats.get("resultsFound", 0),
            "resultsAnalyzed": stats.get("resultsAnalyzed", 0),
            "duplicatesRemoved": stats.get("duplicatesRemoved", 0),
            "errors": stats.get("errors", 0),
            "searchesCompleted": stats.get("searchesCompleted", 0),
            "searchesPlanned": stats.get("searchesPlanned", 0),
            "stats": stats, "run_id": (row or {}).get("run_id"), **base}


@app.post("/api/video-search/start")
def vs_start(req: VSStartReq):
    cfg = presets.normalize_config(req.config)
    scope = cfg["search_scope"]
    if scope == "channel" and not (cfg["channel_url"] or cfg["topic"]):
        raise HTTPException(400, "Enter a YouTube channel (URL, @handle, ID or name).")
    if scope == "video" and not util.extract_video_id(cfg["video_url"]):
        raise HTTPException(400, "Enter a valid YouTube video URL.")
    if scope in ("youtube", "youtube_web") and not cfg["topic"]:
        raise HTTPException(400, "Enter a topic to search for.")
    return {"jobId": video_search.start_search(cfg)}


@app.get("/api/video-search/job/{job_id}")
def vs_job(job_id: str):
    view = _job_view(job_id)
    if not view:
        raise HTTPException(404, "Search job not found.")
    return view


@app.post("/api/video-search/job/{job_id}/cancel")
@app.post("/api/video-search/cancel/{job_id}")
def vs_cancel(job_id: str):
    job = manager.get(job_id)
    if not job and not database.get_search(job_id, with_results=False):
        raise HTTPException(404, "Search job not found.")
    if job:
        manager.request_cancel(job)
    else:
        database.update_search(job_id, status="cancelled")
    return {"ok": True}


@app.post("/api/video-search/job/{job_id}/retry")
@app.post("/api/video-search/retry/{job_id}")
def vs_retry(job_id: str):
    try:
        return {"jobId": video_search.retry_search(job_id)}
    except KeyError:
        raise HTTPException(404, "Search job not found.")


@app.get("/api/video-search/job/{job_id}/results")
@app.get("/api/video-search/results/{job_id}")
def vs_results(job_id: str):
    row = database.get_search(job_id, with_results=True)
    if not row:
        raise HTTPException(404, "Search job not found.")
    results = row.get("results") or []
    return {"jobId": job_id, "status": row["status"], "step": row.get("step"),
            "stats": row.get("stats", {}), "candidates": results, "results": results,
            "run_id": row.get("run_id")}


@app.post("/api/video-search/analyze-selected")
def vs_analyze(req: VSAnalyzeReq):
    if not database.get_search(req.jobId, with_results=False):
        raise HTTPException(404, "Search job not found.")
    if not req.videoIds:
        raise HTTPException(400, "Select at least one video to analyze.")
    return {"jobId": video_search.analyze_selected(req.jobId, req.videoIds)}


@app.post("/api/video-search/create-clips")
def vs_create(req: VSCreateReq):
    if not req.selected:
        raise HTTPException(400, "Select at least one video.")
    return video_search.create_clips(req.jobId, req.selected, req.config)


@app.get("/api/video-search/latest")
def vs_latest():
    return database.latest_unfinished_search()


@app.delete("/api/video-search/job/{job_id}")
def vs_delete(job_id: str):
    database.delete_search(job_id)
    return {"ok": True}


@app.post("/api/video-search/refresh-meta")
def vs_refresh(req: VSRefreshReq):
    if not req.video_ids:
        raise HTTPException(400, "No videos to refresh.")
    cands = video_search.refresh_meta(req.video_ids, req.config)
    if not cands:
        raise HTTPException(502, "Could not refresh metadata for the selected video(s).")
    return {"candidates": cands}


# --- static hosting ------------------------------------------------------
app.mount("/media", StaticFiles(directory=str(config.VIDEO_DATA_DIR)), name="media")
app.mount("/clips", StaticFiles(directory=str(config.CLIPS_DIR)), name="clips")
app.mount("/static", StaticFiles(directory=str(config.WEB_DIR)), name="static")


@app.get("/")
def index():
    idx = config.WEB_DIR / "index.html"
    if not idx.exists():
        return JSONResponse({"error": "UI not found"}, status_code=500)
    return FileResponse(str(idx))


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)
