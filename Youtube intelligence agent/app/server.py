"""FastAPI server: REST API for every pipeline step + full run, job polling,
history, exports, and static hosting of the dashboard and extracted frames."""
from __future__ import annotations

import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, database, ffmpeg_utils, llm, pipeline, util
from .jobs import manager
from .services import exporters
from .services.intent import MODES


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
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


# --- static hosting ------------------------------------------------------
app.mount("/media", StaticFiles(directory=str(config.VIDEO_DATA_DIR)), name="media")
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
