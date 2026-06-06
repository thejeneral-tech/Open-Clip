"""Orchestrates the analysis workflow:

  URL -> Metadata -> Transcript -> Comments -> Frames -> Understand request
      -> Rank moments / find clips -> Generate output

Exposes a full-run orchestrator and individual step runners (for the manual
buttons). Every step is wrapped so one failure degrades gracefully instead of
aborting the whole run (spec section 14). Progress is reported via JobManager.
"""
from __future__ import annotations

from . import database, util
from .jobs import Job, manager
from .services import clips, comments, frames, metadata, outputs, transcript
from .services.intent import parse_intent

FULL_STEPS = [
    ("metadata", "Fetch metadata"),
    ("transcript", "Fetch transcript"),
    ("comments", "Analyze comments"),
    ("frames", "Analyze video frames"),
    ("intent", "Understand request"),
    ("clips", "Rank moments & find clips"),
    ("output", "Generate output"),
]


def _logger(job: Job, step: str):
    def log(msg: str) -> None:
        manager.log(job, msg)
        manager.step(job, step, "running", msg)
    return log


# --- atomic units (do the work + persist) -------------------------------
def _do_metadata(url: str) -> dict:
    meta = metadata.fetch_metadata(url)
    if not meta.get("video_id"):
        raise metadata.MetadataError("Could not determine the video id.")
    database.upsert_video(meta)
    return meta


def _ensure_meta(url: str, log=lambda m: None) -> dict:
    vid = util.extract_video_id(url)
    if vid:
        existing = database.get_video(vid)
        if existing and existing.get("title") is not None:
            return existing
    log("Fetching metadata...")
    return _do_metadata(url)


def _do_transcript(vid, url, log, prefer_whisper=False) -> dict:
    t = transcript.get_transcript(vid, url, prefer_whisper=prefer_whisper, log=log)
    database.save_transcript(vid, t)
    return t


def _do_comments(vid, url, meta, log) -> dict:
    fetched = comments.fetch_comments(vid, url, log=log)
    insights = comments.analyze_comments(fetched["comments"], meta.get("heatmap", []), meta, log)
    database.save_comments(vid, fetched["comments"], meta.get("heatmap", []), insights)
    return {"fetched": fetched, "insights": insights}


def _do_frames(vid, url, meta, log, do_vision=True) -> list:
    fr = frames.extract_frames(vid, url, meta, do_vision=do_vision, log=log)
    database.save_frames(vid, fr)
    return fr


def _do_clips(vid, intent, log) -> list:
    record = database.get_full_record(vid)
    cl = clips.find_clips(record, intent, log)
    database.save_clips(vid, cl)
    return cl


def _do_output(vid, intent, prompt, log) -> dict:
    record = database.get_full_record(vid)
    out = outputs.generate_output(record, intent, log)
    oid = database.save_output(
        vid, prompt, out["mode"], out["content"],
        {"label": out["label"], "data": out.get("data", {})},
    )
    out["output_id"] = oid
    return out


# --- full pipeline -------------------------------------------------------
def run_full(job: Job, url: str, prompt: str, do_frames: bool = True,
             prefer_whisper: bool = False) -> None:
    manager.start(job)
    result: dict = {}

    # 1. metadata (fatal if it fails)
    manager.step(job, "metadata", "running")
    try:
        meta = _do_metadata(url)
        manager.set_video(job, meta["video_id"])
        manager.step(job, "metadata", "done",
                     f"{meta.get('title') or meta['video_id']} "
                     f"({'Short' if meta.get('is_short') else 'Long-form'})")
    except Exception as e:  # noqa: BLE001
        manager.step(job, "metadata", "error", str(e))
        manager.fail(job, f"Metadata fetch failed: {e}")
        return
    vid = meta["video_id"]
    result["video_id"] = vid

    # 2. transcript
    manager.step(job, "transcript", "running")
    try:
        t = _do_transcript(vid, url, _logger(job, "transcript"), prefer_whisper)
        manager.step(job, "transcript", "done",
                     f"{len(t['segments'])} segments via {t['source']}")
    except Exception as e:  # noqa: BLE001
        manager.step(job, "transcript", "error", f"No transcript ({e})")

    # 3. comments
    manager.step(job, "comments", "running")
    try:
        c = _do_comments(vid, url, meta, _logger(job, "comments"))
        n = len(c["fetched"]["comments"])
        manager.step(job, "comments", "done",
                     f"{n} comments analyzed" if n else "No comments available")
    except Exception as e:  # noqa: BLE001
        manager.step(job, "comments", "error", str(e))

    # 4. frames
    if do_frames:
        manager.step(job, "frames", "running")
        try:
            fr = _do_frames(vid, url, meta, _logger(job, "frames"))
            manager.step(job, "frames", "done", f"{len(fr)} frames extracted")
        except Exception as e:  # noqa: BLE001
            manager.step(job, "frames", "error", str(e))
    else:
        manager.step(job, "frames", "skipped", "Frame analysis turned off")

    # 5. understand request
    manager.step(job, "intent", "running")
    intent = parse_intent(prompt, meta)
    manager.step(job, "intent", "done", f"{intent['label']} — \"{intent['focus'][:60]}\"")
    result["mode"] = intent["mode"]

    # 6. rank moments / clips
    manager.step(job, "clips", "running")
    try:
        cl = _do_clips(vid, intent, _logger(job, "clips"))
        manager.step(job, "clips", "done", f"{len(cl)} clip candidates")
    except Exception as e:  # noqa: BLE001
        manager.step(job, "clips", "error", str(e))

    # 7. generate output
    manager.step(job, "output", "running")
    try:
        out = _do_output(vid, intent, prompt, _logger(job, "output"))
        manager.step(job, "output", "done", out["label"])
        result.update({"output_id": out.get("output_id"), "label": out["label"]})
    except Exception as e:  # noqa: BLE001
        manager.step(job, "output", "error", str(e))
        result["output_error"] = str(e)

    manager.finish(job, result)


# --- single-step runners (manual buttons) -------------------------------
def _ensure_meta_or_fail(job: Job, url: str, step: str):
    try:
        return _ensure_meta(url, _logger(job, step))
    except Exception as e:  # noqa: BLE001
        manager.step(job, step, "error", f"Metadata required but failed: {e}")
        manager.fail(job, str(e))
        return None


def run_metadata(job: Job, url: str) -> None:
    manager.start(job)
    manager.step(job, "metadata", "running")
    try:
        meta = _do_metadata(url)
        manager.set_video(job, meta["video_id"])
        manager.step(job, "metadata", "done", meta.get("title") or meta["video_id"])
        manager.finish(job, {"video_id": meta["video_id"]})
    except Exception as e:  # noqa: BLE001
        manager.step(job, "metadata", "error", str(e))
        manager.fail(job, str(e))


def run_transcript(job: Job, url: str, prefer_whisper: bool = False) -> None:
    manager.start(job)
    meta = _ensure_meta_or_fail(job, url, "transcript")
    if not meta:
        return
    vid = meta["video_id"]
    manager.set_video(job, vid)
    manager.step(job, "transcript", "running")
    try:
        t = _do_transcript(vid, url, _logger(job, "transcript"), prefer_whisper)
        manager.step(job, "transcript", "done", f"{len(t['segments'])} segments via {t['source']}")
        manager.finish(job, {"video_id": vid, "source": t["source"], "segments": len(t["segments"])})
    except Exception as e:  # noqa: BLE001
        manager.step(job, "transcript", "error", str(e))
        manager.fail(job, str(e))


def run_comments(job: Job, url: str) -> None:
    manager.start(job)
    meta = _ensure_meta_or_fail(job, url, "comments")
    if not meta:
        return
    vid = meta["video_id"]
    manager.set_video(job, vid)
    manager.step(job, "comments", "running")
    try:
        c = _do_comments(vid, url, meta, _logger(job, "comments"))
        n = len(c["fetched"]["comments"])
        manager.step(job, "comments", "done", f"{n} comments analyzed" if n else "No comments available")
        manager.finish(job, {"video_id": vid, "comments": n})
    except Exception as e:  # noqa: BLE001
        manager.step(job, "comments", "error", str(e))
        manager.fail(job, str(e))


def run_frames(job: Job, url: str, do_vision: bool = True) -> None:
    manager.start(job)
    meta = _ensure_meta_or_fail(job, url, "frames")
    if not meta:
        return
    vid = meta["video_id"]
    manager.set_video(job, vid)
    manager.step(job, "frames", "running")
    try:
        fr = _do_frames(vid, url, meta, _logger(job, "frames"), do_vision=do_vision)
        manager.step(job, "frames", "done", f"{len(fr)} frames extracted")
        manager.finish(job, {"video_id": vid, "frames": len(fr)})
    except Exception as e:  # noqa: BLE001
        manager.step(job, "frames", "error", str(e))
        manager.fail(job, str(e))


def run_clips(job: Job, url: str, prompt: str) -> None:
    manager.start(job)
    meta = _ensure_meta_or_fail(job, url, "clips")
    if not meta:
        return
    vid = meta["video_id"]
    manager.set_video(job, vid)
    manager.step(job, "clips", "running")
    try:
        intent = parse_intent(prompt or "find the best clips", meta)
        cl = _do_clips(vid, intent, _logger(job, "clips"))
        manager.step(job, "clips", "done", f"{len(cl)} clip candidates")
        manager.finish(job, {"video_id": vid, "clips": len(cl)})
    except Exception as e:  # noqa: BLE001
        manager.step(job, "clips", "error", str(e))
        manager.fail(job, str(e))


def run_output(job: Job, url: str, prompt: str) -> None:
    manager.start(job)
    meta = _ensure_meta_or_fail(job, url, "output")
    if not meta:
        return
    vid = meta["video_id"]
    manager.set_video(job, vid)
    manager.step(job, "output", "running")
    try:
        intent = parse_intent(prompt, meta)
        manager.step(job, "output", "running", f"Mode: {intent['label']}")
        out = _do_output(vid, intent, prompt, _logger(job, "output"))
        manager.step(job, "output", "done", out["label"])
        manager.finish(job, {"video_id": vid, "mode": out["mode"],
                             "output_id": out.get("output_id"), "label": out["label"]})
    except Exception as e:  # noqa: BLE001
        manager.step(job, "output", "error", str(e))
        manager.fail(job, str(e))
