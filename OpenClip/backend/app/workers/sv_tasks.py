"""Story Vault Celery tasks.

* ``sv_ingest_background_task`` — probe + thumbnail + auto-segment uploaded
  footage.
* ``sv_generate_video_task`` — the story-to-preview pipeline:
  script → SAPI narration → word-timed captions → footage plan → preview render,
  parking the video in the review queue.
* ``sv_render_video_task`` — final 1080×1920 render after approval, producing an
  export row.
"""
from __future__ import annotations

import contextlib
import os
import sys
import threading
import time

from celery.signals import worker_ready

from app.core.database import session_scope
from app.core.events import publish_progress
from app.core.logging import get_logger
from app.models.enums import JobStatus, PublishStatus, SvStoryStatus, SvVideoStatus
from app.models.publishing import PublishingConnector
from app.models.storyvault import (
    SvBackground,
    SvExport,
    SvMusic,
    SvProject,
    SvPublishJob,
    SvScript,
    SvSegment,
    SvStory,
    SvVideo,
)
from app.services import captions as captions_svc
from app.services.ffmpeg import ffmpeg
from app.services.storage import (
    storage,
    sv_background_key,
    sv_background_thumb_key,
    sv_caption_preview_key,
    sv_captions_key,
    sv_export_key,
    sv_music_key,
    sv_music_mp3_key,
    sv_narration_key,
    sv_preview_key,
)
from app.services.storyvault import (
    composer,
    fish_clone,
    overlays as overlays_svc,
    piper_tts,
    scripts as scripts_svc,
    tts,
)
from app.workers.celery_app import celery_app
from app.workers.progress import ProgressTracker

logger = get_logger(__name__)

# Pipeline progress bands.
_SCRIPT = (0.03, 0.30)
_NARRATE = (0.30, 0.50)
_CAPTIONS = (0.50, 0.56)
_FOOTAGE = (0.56, 0.62)
_PREVIEW = (0.62, 1.0)


def _lerp(band: tuple[float, float], frac: float) -> float:
    return band[0] + (band[1] - band[0]) * max(0.0, min(1.0, frac))


# =====================================================================
# Cooperative cancellation (studio Stop / Clear-queue)
# =====================================================================
class _VideoCancelled(Exception):
    """Raised inside the pipeline when the user requested a stop. Caught at the
    task boundary, which parks the video in CANCELLED rather than FAILED."""


def _cancel_requested(sv_video_id: int) -> bool:
    with session_scope() as db:
        video = db.get(SvVideo, sv_video_id)
        return bool(video and video.cancel_requested)


def _abort_if_cancelled(sv_video_id: int) -> None:
    """Raise ``_VideoCancelled`` if the user asked to stop this video. Called at
    each pipeline checkpoint, so a long job bails out between stages."""
    if _cancel_requested(sv_video_id):
        raise _VideoCancelled


def _mark_cancelled(sv_video_id: int) -> None:
    """Park a stopped video in CANCELLED and clear the request flag. The partial
    render (if any) is left uncommitted and gets cleaned up on delete."""
    progress = 0.0
    with session_scope() as db:
        video = db.get(SvVideo, sv_video_id)
        if not video:
            return
        video.status = SvVideoStatus.CANCELLED.value
        video.stage = "cancelled"
        video.error = None
        video.cancel_requested = False
        progress = video.progress
    publish_progress(
        "sv_video", sv_video_id,
        stage="cancelled", progress=progress,
        status=SvVideoStatus.CANCELLED.value, message="Cancelled",
    )


def _clear_cancel_flag(sv_video_id: int) -> None:
    """Reconcile the cancel flag on a non-cancel terminal transition (a genuine
    failure). Without this a Stop that raced past the last checkpoint would leave
    the flag raised on a FAILED row, self-cancelling any later retry."""
    with session_scope() as db:
        video = db.get(SvVideo, sv_video_id)
        if video and video.cancel_requested:
            video.cancel_requested = False


def _render_progress(sv_video_id: int, tracker: ProgressTracker, stage: str, message: str,
                     band: tuple[float, float] | None = None):
    """An ffmpeg progress callback that reports into the pipeline (optionally
    mapped into ``band``) and, every few ticks, checks the cancel flag — raising
    ``_VideoCancelled`` to abort the render (``ffmpeg.run`` kills the subprocess
    when its progress callback raises). The DB check is sampled rather than run on
    every tick so a long render doesn't hammer the database."""
    ticks = 0

    def cb(frac: float) -> None:
        nonlocal ticks
        ticks += 1
        if ticks % 10 == 0 and _cancel_requested(sv_video_id):
            raise _VideoCancelled
        tracker.throttled(stage, _lerp(band, frac) if band else frac, message=message)

    return cb


@contextlib.contextmanager
def _narration_heartbeat(sv_video_id: int, tracker: ProgressTracker, est_seconds: float, message: str):
    """Keep a long, opaque narration call visibly alive.

    TTS (especially a cloned Fish voice on a slow GPU) is one blocking call with no
    intermediate progress — the pipeline would otherwise sit frozen at the start of
    the narration band for minutes, indistinguishable from a hang. A daemon thread
    crawls progress across the narration band against ``est_seconds`` and refreshes
    the row every ~15s, so the UI shows movement and ``updated_at`` stays fresh (a
    genuinely dead task then has a stale timestamp). Purely cosmetic: the real band
    end is set by the caller when narration actually returns."""
    stop = threading.Event()
    lo, hi = _NARRATE
    start = time.monotonic()

    def _tick() -> None:
        while not stop.wait(15.0):
            frac = min(0.95, (time.monotonic() - start) / max(1.0, est_seconds))
            try:
                if _cancel_requested(sv_video_id):
                    return  # a checkpoint in the main thread will park it
                tracker.set(stage="narration", progress=lo + (hi - lo) * frac, message=message)
            except Exception:  # noqa: BLE001 — a heartbeat must never break the render
                return

    th = threading.Thread(target=_tick, name=f"sv-narr-hb-{sv_video_id}", daemon=True)
    th.start()
    try:
        yield
    finally:
        stop.set()
        th.join(timeout=2.0)


def _reconcile_orphaned_videos(**_) -> None:
    """Heal videos left mid-flight by a previous crash/restart, on worker boot.

    The Windows worker is ``--pool=solo`` (one job at a time) and the filesystem
    broker does not reliably redeliver an interrupted task, so a video that was
    PROCESSING/RENDERING when the worker died would otherwise sit frozen forever.
    At startup nothing can legitimately be in-flight, so reset the strays: a
    stopped one (``cancel_requested``) → CANCELLED; the rest → FAILED, which the
    user can simply retry.
    """
    try:
        with session_scope() as db:
            stuck = (
                db.query(SvVideo)
                .filter(
                    SvVideo.status.in_(
                        [SvVideoStatus.PROCESSING.value, SvVideoStatus.RENDERING.value]
                    )
                )
                .all()
            )
            for video in stuck:
                if video.cancel_requested:
                    video.status = SvVideoStatus.CANCELLED.value
                    video.stage = "cancelled"
                    # Keep cancel_requested set: if the filesystem broker *does*
                    # redeliver the task, its first checkpoint must still abort.
                else:
                    video.status = SvVideoStatus.FAILED.value
                    video.stage = "interrupted"
                    video.error = "Generation was interrupted (the worker restarted). Retry to run it again."
            if stuck:
                logger.warning("Reconciled %d orphaned story video(s) on worker startup", len(stuck))
    except Exception:  # noqa: BLE001 — startup best-effort; never block the worker from coming up
        logger.exception("Failed to reconcile orphaned story videos on startup")


# weak=False keeps a strong reference so the receiver can't be garbage-collected
# out from under the signal — it must survive for the worker's whole life.
worker_ready.connect(_reconcile_orphaned_videos, weak=False)


def _story_meta(story: SvStory) -> dict:
    """The fields the intro Reddit card / author intro overlays draw from."""
    return {
        "title": story.title,
        "body": story.body,
        "author": story.author,
        "community": story.community,
        "source": story.source,
        "upvotes": story.upvotes,
        "num_comments": story.num_comments,
    }


# =====================================================================
# Auto-workflow chaining (projects with auto_publish on)
# =====================================================================
def _project_settings(db, project_id: int | None) -> dict | None:
    """Return the project's auto-workflow settings, or None when not auto."""
    if not project_id:
        return None
    project = db.get(SvProject, project_id)
    if not project:
        return None
    settings = project.settings or {}
    return settings if settings.get("auto_publish") else None


def _maybe_auto_advance(sv_video_id: int) -> None:
    """After a preview is ready, auto-approve + final-render if the project says so."""
    try:
        with session_scope() as db:
            video = db.get(SvVideo, sv_video_id)
            if not video or video.status != SvVideoStatus.READY_FOR_REVIEW.value:
                return
            if _project_settings(db, video.project_id) is None:
                return
            video.status = SvVideoStatus.APPROVED.value
            video.reject_reason = None
        sv_render_video_task.delay(sv_video_id, "tiktok")
    except Exception:  # noqa: BLE001 — chaining is best-effort; the preview is safe in review
        logger.exception("Auto-advance failed for story video %s", sv_video_id)


def _maybe_auto_publish(sv_video_id: int) -> None:
    """After a final render, queue uploads to the project's saved channels."""
    try:
        job_ids: list[int] = []
        with session_scope() as db:
            video = db.get(SvVideo, sv_video_id)
            if not video:
                return
            settings = _project_settings(db, video.project_id)
            if settings is None:
                return
            connector_ids = settings.get("publish_connector_ids") or []
            if not connector_ids:
                return
            # Never double-publish — skip if this video already has jobs.
            if db.query(SvPublishJob).filter(SvPublishJob.sv_video_id == sv_video_id).count():
                return
            connectors = (
                db.query(PublishingConnector)
                .filter(
                    PublishingConnector.id.in_(connector_ids),
                    PublishingConnector.owner_id == video.owner_id,
                )
                .all()
            )
            privacy = settings.get("privacy", "public")
            title = (video.title or "Story video")[:100]
            for connector in connectors:
                job = SvPublishJob(
                    owner_id=video.owner_id,
                    sv_video_id=sv_video_id,
                    connector_id=connector.id,
                    platform=connector.platform,
                    title=title,
                    payload={"privacy": privacy},
                )
                db.add(job)
                db.flush()
                job_ids.append(job.id)
        for job_id in job_ids:
            sv_publish_job_task.delay(job_id)
    except Exception:  # noqa: BLE001 — best-effort; the finished export stays available
        logger.exception("Auto-publish failed for story video %s", sv_video_id)


# =====================================================================
# Background ingestion
# =====================================================================
@celery_app.task(name="app.workers.sv_tasks.sv_ingest_background_task")
def sv_ingest_background_task(background_id: int) -> None:
    with session_scope() as db:
        bg = db.get(SvBackground, background_id)
        if not bg or not bg.storage_path:
            return
        bg.status = JobStatus.PROCESSING.value
        src_key = bg.storage_path

    src = storage.abspath(src_key, ensure_parent=False)
    try:
        info = ffmpeg.probe(src)
        thumb_key = sv_background_thumb_key(background_id)
        try:
            ffmpeg.extract_thumbnail(src, storage.abspath(thumb_key), at=min(2.0, max(0.5, info.duration / 10)))
            storage.commit(thumb_key)
        except Exception as exc:
            logger.warning("Background %s thumbnail failed: %s", background_id, exc)
            thumb_key = None

        windows = composer.auto_segments(info.duration)
        with session_scope() as db:
            bg = db.get(SvBackground, background_id)
            if not bg:
                return
            bg.duration_seconds = info.duration
            bg.width, bg.height, bg.fps = info.width, info.height, info.fps
            bg.size_bytes = info.size_bytes
            bg.thumbnail_path = thumb_key
            db.query(SvSegment).filter(SvSegment.background_id == background_id).delete()
            for start, end in windows:
                db.add(SvSegment(background_id=background_id, start_sec=start, end_sec=end))
            bg.status = JobStatus.COMPLETED.value
            bg.error = None
        logger.info("Background %s ingested: %.1fs, %d segments", background_id, info.duration, len(windows))
    except Exception as exc:
        logger.exception("Background %s ingest failed", background_id)
        with session_scope() as db:
            bg = db.get(SvBackground, background_id)
            if bg:
                bg.status = JobStatus.FAILED.value
                bg.error = str(exc)[:1000]


@celery_app.task(name="app.workers.sv_tasks.sv_import_background_task")
def sv_import_background_task(background_id: int, url: str) -> None:
    """Download footage from a YouTube (or other yt-dlp supported) URL, then run
    the standard probe + thumbnail + auto-segment ingest on it."""
    from app.services import youtube

    with session_scope() as db:
        bg = db.get(SvBackground, background_id)
        if not bg:
            return
        bg.status = JobStatus.PROCESSING.value
        bg.error = None

    key = sv_background_key(background_id, "mp4")
    try:
        dest = storage.open_write(key)
        meta = youtube.download(url, dest)
        storage.commit(key)
    except Exception as exc:
        logger.exception("Background %s URL import failed", background_id)
        with session_scope() as db:
            bg = db.get(SvBackground, background_id)
            if bg:
                bg.status = JobStatus.FAILED.value
                bg.error = str(exc)[:1000]
        return

    with session_scope() as db:
        bg = db.get(SvBackground, background_id)
        if not bg:
            return
        bg.storage_path = key
        bg.size_bytes = storage.size(key)
        if meta.get("title"):
            bg.original_filename = str(meta["title"])[:512]

    # Reuse the shared ingest path (probe, thumbnail, auto-segment).
    sv_ingest_background_task(background_id)


# =====================================================================
# Music ingestion (any audio/video upload → MP3 bed)
# =====================================================================
@celery_app.task(name="app.workers.sv_tasks.sv_ingest_music_task")
def sv_ingest_music_task(music_id: int) -> None:
    """Convert an uploaded audio/video file to an MP3 bed and probe its duration.

    Mirrors footage ingestion but far simpler: there's no segmenting or
    thumbnailing — the whole track is mixed in (and looped) under the narration.
    The original upload is dropped once the MP3 is produced.
    """
    with session_scope() as db:
        track = db.get(SvMusic, music_id)
        if not track or not track.storage_path:
            return
        track.status = JobStatus.PROCESSING.value
        track.error = None
        src_key = track.storage_path

    src = storage.abspath(src_key, ensure_parent=False)
    mp3_key = sv_music_mp3_key(music_id)
    mp3_path = storage.abspath(mp3_key)
    try:
        # Drop any video stream, encode a clean stereo MP3 (libmp3lame VBR ~q2).
        ffmpeg.run(["-i", src, "-vn", "-ac", "2", "-c:a", "libmp3lame", "-q:a", "2", mp3_path])
        storage.commit(mp3_key)
        info = ffmpeg.probe(mp3_path)
    except Exception as exc:
        logger.exception("Music %s ingest failed", music_id)
        with session_scope() as db:
            track = db.get(SvMusic, music_id)
            if track:
                track.status = JobStatus.FAILED.value
                track.error = str(exc)[:1000]
        return

    # The source upload was only needed for the conversion — drop it, keep the MP3.
    if src_key != mp3_key:
        with contextlib.suppress(Exception):
            storage.delete(src_key)

    with session_scope() as db:
        track = db.get(SvMusic, music_id)
        if not track:
            return
        track.storage_path = mp3_key
        track.duration_seconds = info.duration
        track.size_bytes = storage.size(mp3_key)
        track.status = JobStatus.COMPLETED.value
        track.error = None
    logger.info("Music %s ingested: %.1fs", music_id, info.duration)


@celery_app.task(name="app.workers.sv_tasks.sv_import_music_task")
def sv_import_music_task(music_id: int, url: str) -> None:
    """Download audio from a YouTube (or other yt-dlp supported) URL, then run the
    standard convert-to-MP3 ingest on it. Mirrors ``sv_import_background_task``."""
    from app.services import youtube

    with session_scope() as db:
        track = db.get(SvMusic, music_id)
        if not track:
            return
        track.status = JobStatus.PROCESSING.value
        track.error = None

    key = sv_music_key(music_id, "mp4")
    try:
        dest = storage.open_write(key)
        meta = youtube.download(url, dest)
        storage.commit(key)
    except Exception as exc:
        logger.exception("Music %s URL import failed", music_id)
        with session_scope() as db:
            track = db.get(SvMusic, music_id)
            if track:
                track.status = JobStatus.FAILED.value
                track.error = str(exc)[:1000]
        return

    with session_scope() as db:
        track = db.get(SvMusic, music_id)
        if not track:
            return
        track.storage_path = key
        if meta.get("title"):
            track.original_filename = str(meta["title"])[:512]

    # Reuse the shared ingest path (extract audio → MP3, drop the source).
    sv_ingest_music_task(music_id)


def _resolve_music_path(owner_id: int, music_id: int | None) -> str | None:
    """The absolute MP3 path for a video's chosen music bed, or None.

    Returns None when the track is missing, not owned, not finished converting,
    or its file has since been deleted — so a stale/broken choice simply renders
    with narration only (the composer also guards on the path existing).
    """
    if not music_id:
        return None
    with session_scope() as db:
        track = db.get(SvMusic, music_id)
        if (
            not track
            or track.owner_id != owner_id
            or track.status != JobStatus.COMPLETED.value
            or not track.storage_path
        ):
            return None
        key = track.storage_path
    path = storage.abspath(key, ensure_parent=False)
    return path if os.path.exists(path) else None


# =====================================================================
# Story → preview pipeline
# =====================================================================
def _segment_candidates(
    db, owner_id: int, category: str | None, background_id: int | None = None
) -> list[dict]:
    q = (
        db.query(SvSegment, SvBackground)
        .join(SvBackground, SvSegment.background_id == SvBackground.id)
        .filter(
            SvBackground.owner_id == owner_id,
            SvBackground.status == JobStatus.COMPLETED.value,
            SvBackground.storage_path.isnot(None),
        )
    )
    rows = q.all()
    if background_id is not None:
        # User pinned one footage source — draw only from it. If it has no usable
        # segments, fall through to the category/all behaviour below.
        pinned = [(s, b) for s, b in rows if b.id == background_id]
        if pinned:
            rows = pinned
            category = None  # pinned footage overrides the category filter
    if category:
        in_cat = [(s, b) for s, b in rows if (b.category or "").lower() == category.lower()]
        if in_cat:
            rows = in_cat
    return [
        {
            "segment_id": s.id,
            "background_id": b.id,
            "storage_path": b.storage_path,
            "start_sec": s.start_sec,
            "end_sec": s.end_sec,
            "times_used": s.times_used,
        }
        for s, b in rows
    ]


@celery_app.task(name="app.workers.sv_tasks.sv_generate_video_task")
def sv_generate_video_task(sv_video_id: int) -> None:
    tracker = ProgressTracker("sv_video", sv_video_id)

    with session_scope() as db:
        video = db.get(SvVideo, sv_video_id)
        if not video:
            return
        story = db.get(SvStory, video.story_id)
        if not story:
            tracker.fail("script", "Story no longer exists")
            return
        opts = {
            "owner_id": video.owner_id,
            "story_id": story.id,
            "title": story.title,
            "body": story.body,
            "duration_target": video.duration_target,
            "hook_style": video.hook_style,
            "narration_style": video.narration_style,
            "drama_level": video.drama_level,
            "voice": video.voice,
            "voice_config": video.voice_config,
            "speed": video.speed,
            "caption_style": video.caption_style,
            "caption_config": video.caption_config,
            "background_category": video.background_category,
            "background_id": video.background_id,
            "music_id": video.music_id,
            "music_volume": video.music_volume,
            "script_engine": video.script_engine,
            "script_id": video.script_id,
            "template_config": video.template_config,
            "story_meta": _story_meta(story),
        }

    try:
        _abort_if_cancelled(sv_video_id)
        # ---------------------------------------------------------- 1. script
        tracker.set(stage="script", progress=_SCRIPT[0], message="Writing the script")
        script_text: str | None = None
        if opts["script_id"]:
            with session_scope() as db:
                existing = db.get(SvScript, opts["script_id"])
                if existing:
                    script_text = existing.full_text
        if script_text is None:
            generated = scripts_svc.generate_script(
                opts["title"], opts["body"],
                engine=opts["script_engine"],
                duration_target=opts["duration_target"],
                hook_style=opts["hook_style"],
                narration_style=opts["narration_style"],
                drama_level=opts["drama_level"],
                speed=opts["speed"],
            )
            with session_scope() as db:
                script = SvScript(
                    story_id=opts["story_id"],
                    full_text=generated["full_text"],
                    hook=generated.get("hook"),
                    duration_target=opts["duration_target"],
                    hook_style=opts["hook_style"],
                    narration_style=opts["narration_style"],
                    drama_level=opts["drama_level"],
                    word_count=len(generated["full_text"].split()),
                    generator=generated.get("generator"),
                )
                db.add(script)
                db.flush()
                video = db.get(SvVideo, sv_video_id)
                video.script_id = script.id
                video.title = opts["title"][:512]
            script_text = generated["full_text"]
        tracker.set(stage="script", progress=_SCRIPT[1], message="Script ready")
        _abort_if_cancelled(sv_video_id)

        # ------------------------------------------------------- 2. narration
        # Read the title (shown on the topic card) and the author intro, then the
        # story body — all on one audio timeline. Each intro card is shown for
        # exactly as long as its line is spoken, and the body captions begin the
        # instant the body narration does. With no intro template the narration is
        # body-only. A cloned (Fish Speech) voice routes to the clone engine (which
        # produces the same NarrationResult/StoryNarration shape, with captions
        # recovered by aligning the synthesized speech); everything else uses SAPI.
        tracker.set(stage="narration", progress=_NARRATE[0], message="Synthesizing narration")
        narration_key = sv_narration_key(sv_video_id)
        narration_abspath = storage.abspath(narration_key)
        beats = overlays_svc.intro_beats(opts["story_meta"], opts.get("template_config"))
        story_parts = [*beats, {"kind": "body", "text": script_text}] if beats else None
        card_window = author_window = None

        voice_cfg = opts.get("voice_config") or {}
        use_clone = (voice_cfg.get("engine") or "sapi") != "sapi"
        # Engine routing for a "system" (non-cloned) voice is platform-specific:
        # Windows uses SAPI (System.Speech); Linux/macOS use Piper neural voices.
        # A cloned voice always routes to the Fish Speech engine.
        if use_clone:
            ref_key = voice_cfg.get("ref_key")
            ref_path = (
                storage.abspath(ref_key, ensure_parent=False)
                if ref_key and storage.exists(ref_key) else None
            )
            narr_kw = {"ref_path": ref_path, "prompt_text": voice_cfg.get("prompt_text") or "", "speed": opts["speed"]}
            story_fn, body_fn = fish_clone.narrate_story, fish_clone.narrate
        elif sys.platform == "win32":
            narr_kw = {"voice": opts["voice"], "speed": opts["speed"]}
            story_fn, body_fn = tts.synthesize_story, tts.synthesize
        else:
            narr_kw = {"voice": opts["voice"], "speed": opts["speed"]}
            story_fn, body_fn = piper_tts.synthesize_story, piper_tts.synthesize

        # Estimate narration time so the heartbeat can pace a progress crawl. A
        # cloned Fish voice on this GPU runs ~10x slower than a system voice, so a
        # long body can take many minutes; the estimate only needs to be
        # order-of-magnitude right to keep the bar honestly moving.
        word_est = max(1, len((script_text or "").split()))
        est_seconds = max(20.0, word_est * (6.0 if use_clone else 0.5))
        hb_msg = (
            "Synthesizing narration — a cloned voice can take several minutes"
            if use_clone else "Synthesizing narration"
        )
        with _narration_heartbeat(sv_video_id, tracker, est_seconds, hb_msg):
            if story_parts:
                narr = story_fn(story_parts, narration_abspath, **narr_kw)
                body_words, body_start = narr.body_words, narr.body_start
                card_window, author_window = narr.card_window, narr.author_window
                duration = narr.duration
            else:
                result = body_fn(script_text, narration_abspath, **narr_kw)
                body_words, body_start, duration = result.words, 0.0, result.duration
        storage.commit(narration_key)
        if duration <= 0.5:
            if use_clone:
                msg = "Cloned-voice narration came back empty — is the Fish Speech server running?"
            elif sys.platform == "win32":
                msg = "Narration came back empty — is a SAPI voice installed?"
            else:
                msg = ("Narration came back empty — is a Piper voice installed? "
                       "Run setup or `python launch.py voices --add en_US-amy-medium`.")
            raise RuntimeError(msg)
        intro_plan = {
            "card": list(card_window) if card_window else None,
            "author": list(author_window) if author_window else None,
            "body_start": body_start,
        }
        with session_scope() as db:
            video = db.get(SvVideo, sv_video_id)
            video.narration_path = narration_key
            video.narration_duration = duration
            video.word_timings = body_words
            video.intro_plan = intro_plan
        tracker.set(stage="narration", progress=_NARRATE[1], message=f"Narration: {duration:.1f}s")
        _abort_if_cancelled(sv_video_id)

        # -------------------------------------------------------- 3. captions
        # Captions cover the body only (the title/author are shown by the intro
        # cards). The body word timings already sit at their true place on the
        # combined timeline, so no offset is needed — caption N lights up exactly
        # as word N is spoken. Timing is resolution-independent, so this single
        # (RENDER-res) ASS drives the preview and final renders alike.
        tracker.set(stage="captions", progress=_CAPTIONS[0], message="Building captions")
        tokens = captions_svc.build_tokens(body_words)
        tokens = captions_svc.heuristic_emphasis(tokens)
        ass_key = sv_captions_key(sv_video_id, "ass")
        srt_key = sv_captions_key(sv_video_id, "srt")
        captions_svc.write_ass(
            storage.abspath(ass_key), tokens, opts["caption_style"],
            composer.RENDER_W, composer.RENDER_H, overrides=opts.get("caption_config"),
        )
        storage.commit(ass_key)
        with open(storage.abspath(srt_key), "w", encoding="utf-8") as fh:
            fh.write(captions_svc.render_srt(tokens))
        storage.commit(srt_key)
        with session_scope() as db:
            video = db.get(SvVideo, sv_video_id)
            video.captions_ass_path = ass_key
            video.captions_srt_path = srt_key

        # --------------------------------------------------------- 4. footage
        tracker.set(stage="footage", progress=_FOOTAGE[0], message="Selecting footage")
        with session_scope() as db:
            candidates = _segment_candidates(
                db, opts["owner_id"], opts["background_category"], opts["background_id"]
            )
        plan = composer.plan_segments(candidates, duration, seed=sv_video_id)
        with session_scope() as db:
            video = db.get(SvVideo, sv_video_id)
            video.segment_plan = plan
            used_ids = [p["segment_id"] for p in plan if p.get("segment_id")]
            if used_ids:
                for seg in db.query(SvSegment).filter(SvSegment.id.in_(used_ids)).all():
                    seg.times_used += 1
        msg = f"{len(plan)} segments" if plan else "No footage library — using gradient background"
        tracker.set(stage="footage", progress=_FOOTAGE[1], message=msg)
        _abort_if_cancelled(sv_video_id)

        # ------------------------------------------------------ 5. final render
        # Render the publish-ready 1080×1920 cut straight away, so a finished video
        # lands in review already exportable. The same file doubles as the
        # on-screen review preview, and an SvExport row is recorded — so hitting
        # Publish later just uploads this file and never re-renders. (See
        # sv_render_video_task, whose fast path reuses render_path.) Rendering once
        # at full resolution here also avoids the old preview-then-final double
        # encode.
        music_path = _resolve_music_path(opts["owner_id"], opts.get("music_id"))
        render_key = sv_preview_key(sv_video_id)
        render_intro = overlays_svc.prepare_intro_overlays(
            sv_video_id=sv_video_id,
            story_meta=opts["story_meta"],
            template_config=opts.get("template_config"),
            width=composer.RENDER_W,
            height=composer.RENDER_H,
            card_window=card_window,
            author_window=author_window,
        )
        spec = composer.RenderSpec(
            narration_path=storage.abspath(narration_key, ensure_parent=False),
            total_duration=duration,
            ass_path=storage.abspath(ass_key, ensure_parent=False),
            plan=plan,
            output_path=storage.abspath(render_key),
            width=composer.RENDER_W,
            height=composer.RENDER_H,
            overlays=render_intro["overlays"],
            music_path=music_path,
            music_volume=opts.get("music_volume") or 0.0,
        )
        result = composer.render_video(
            spec,
            on_progress=_render_progress(sv_video_id, tracker, "preview", "Rendering video", _PREVIEW),
        )
        storage.commit(render_key)
        # Final checkpoint: honour a Stop that landed during the render before we
        # mark the video ready — otherwise it would silently finish with the flag
        # still raised, which then self-cancels any later approve/retry.
        _abort_if_cancelled(sv_video_id)
        with session_scope() as db:
            video = db.get(SvVideo, sv_video_id)
            # One 1080×1920 file backs both the review preview and the upload, so a
            # later publish is a pure upload with no second render.
            video.preview_path = render_key
            video.render_path = render_key
            video.cancel_requested = False  # genuine success — reconcile the flag
            story = db.get(SvStory, video.story_id)
            db.add(
                SvExport(
                    owner_id=opts["owner_id"],
                    sv_video_id=sv_video_id,
                    platform="tiktok",
                    title=(
                        video.title
                        or (story.title if story else None)
                        or f"Story video {sv_video_id}"
                    )[:512],
                    storage_path=render_key,
                    size_bytes=result["size_bytes"],
                    duration_seconds=result["duration"],
                    width=result["width"],
                    height=result["height"],
                )
            )
        tracker.set(
            stage="ready", progress=1.0,
            status=SvVideoStatus.READY_FOR_REVIEW.value,
            message="Ready for review",
        )
    except _VideoCancelled:
        logger.info("Story video %s cancelled by user", sv_video_id)
        _mark_cancelled(sv_video_id)
        return
    except Exception as exc:
        logger.exception("Story video %s pipeline failed", sv_video_id)
        tracker.fail("pipeline", str(exc)[:1000])
        _clear_cancel_flag(sv_video_id)

    # Auto-workflow: if this video belongs to an auto-publish project, carry it
    # straight to the final render (the status guard no-ops on the failure path).
    _maybe_auto_advance(sv_video_id)


# =====================================================================
# Caption-style preset previews
# =====================================================================
# One sample sentence narrated once, then rendered with each caption style so
# the Presets page shows the real thing (same ASS renderer the pipeline uses).
PREVIEW_SAMPLE_TEXT = (
    "This is exactly how your captions will look. Bold words pop, numbers like "
    "47 stand out, and every single word stays in sync."
)


def _preview_narration(wav: str):
    """Narrate the caption-preview sample with the platform's system-voice engine.

    Windows uses SAPI; Linux/macOS use Piper — the same system engine the real
    pipeline uses (see sv_generate_video_task) — so caption-style previews render
    everywhere without the heavyweight Fish server running. Falls back to a cloned
    (Fish) voice only if the system engine is unavailable. The voice is immaterial
    here: only the word timings drive the preview captions.
    """
    try:
        if sys.platform == "win32":
            return tts.synthesize(PREVIEW_SAMPLE_TEXT, wav)
        return piper_tts.synthesize(PREVIEW_SAMPLE_TEXT, wav)
    except (tts.TTSError, piper_tts.PiperError):
        return fish_clone.narrate(PREVIEW_SAMPLE_TEXT, wav)


@celery_app.task(name="app.workers.sv_tasks.sv_caption_previews_task")
def sv_caption_previews_task(styles: list[str], force: bool = False) -> None:
    import tempfile

    missing = [s for s in styles if force or not storage.exists(sv_caption_preview_key(s))]
    if not missing:
        return

    with tempfile.TemporaryDirectory(prefix="sv_prev_") as tmp:
        wav = os.path.join(tmp, "sample.wav")
        try:
            result = _preview_narration(wav)
        except Exception:
            # No narration engine available (e.g. Linux with the Fish server
            # down): skip preview generation rather than failing the task — the
            # Presets page falls back to its static placeholders.
            logger.exception("Caption previews skipped: no narration engine available")
            return
        tokens = captions_svc.build_tokens(result.words)
        tokens = captions_svc.heuristic_emphasis(tokens)

        for style in missing:
            try:
                ass = os.path.join(tmp, f"{style}.ass")
                captions_svc.write_ass(ass, tokens, style, composer.PREVIEW_W, composer.PREVIEW_H)
                key = sv_caption_preview_key(style)
                composer.render_video(
                    composer.RenderSpec(
                        narration_path=wav,
                        total_duration=result.duration,
                        ass_path=ass,
                        plan=[],
                        output_path=storage.abspath(key),
                        width=composer.PREVIEW_W,
                        height=composer.PREVIEW_H,
                    )
                )
                storage.commit(key)
                logger.info("Caption preview rendered: %s", style)
            except Exception:
                logger.exception("Caption preview failed for style %s", style)


# =====================================================================
# Final render (after approval)
# =====================================================================
@celery_app.task(name="app.workers.sv_tasks.sv_render_video_task")
def sv_render_video_task(sv_video_id: int, platform: str = "tiktok") -> None:
    tracker = ProgressTracker("sv_video", sv_video_id)

    # Fast path: generation already produced the publish-ready 1080×1920 file
    # (render_path set). Don't re-render — just finalize: record an export row if
    # one is missing, mark the video complete, and continue to auto-publish. This
    # keeps "approve" (and the on-demand publish render) cheap and guarantees a
    # publish is a pure upload.
    with session_scope() as db:
        video = db.get(SvVideo, sv_video_id)
        if not video or not video.narration_path:
            return
        existing_render = video.render_path
        cancel_requested = video.cancel_requested
    if existing_render and os.path.exists(storage.abspath(existing_render, ensure_parent=False)):
        if cancel_requested:
            _mark_cancelled(sv_video_id)
            return
        with session_scope() as db:
            video = db.get(SvVideo, sv_video_id)
            story = db.get(SvStory, video.story_id)
            has_export = (
                db.query(SvExport)
                .filter(
                    SvExport.sv_video_id == sv_video_id,
                    SvExport.storage_path == existing_render,
                    SvExport.deleted_at.is_(None),
                )
                .first()
            )
            if not has_export:
                probe = None
                with contextlib.suppress(Exception):
                    probe = ffmpeg.probe(storage.abspath(existing_render, ensure_parent=False))
                db.add(
                    SvExport(
                        owner_id=video.owner_id,
                        sv_video_id=sv_video_id,
                        platform=platform,
                        title=(
                            video.title
                            or (story.title if story else None)
                            or f"Story video {sv_video_id}"
                        )[:512],
                        storage_path=existing_render,
                        size_bytes=storage.size(existing_render),
                        duration_seconds=(probe.duration if probe else video.narration_duration) or 0.0,
                        width=probe.width if probe else composer.RENDER_W,
                        height=probe.height if probe else composer.RENDER_H,
                    )
                )
            video.status = SvVideoStatus.COMPLETED.value
            video.stage = "done"
            video.progress = 1.0
            video.cancel_requested = False
            if story and story.status != SvStoryStatus.EXCLUDED.value:
                story.status = SvStoryStatus.USED.value
        tracker.set(
            stage="done", progress=1.0,
            status=SvVideoStatus.COMPLETED.value,
            message="Export ready",
        )
        _maybe_auto_publish(sv_video_id)
        return

    with session_scope() as db:
        video = db.get(SvVideo, sv_video_id)
        if not video or not video.narration_path:
            return
        story = db.get(SvStory, video.story_id)
        export = SvExport(
            owner_id=video.owner_id,
            sv_video_id=sv_video_id,
            platform=platform,
            title=(video.title or (story.title if story else None) or f"Story video {sv_video_id}")[:512],
        )
        db.add(export)
        db.flush()
        export_id = export.id
        narration_key = video.narration_path
        ass_key = video.captions_ass_path
        plan = video.segment_plan or []
        duration = video.narration_duration or 0.0
        template_config = video.template_config
        intro_plan = video.intro_plan or {}
        story_meta = _story_meta(story) if story else None
        owner_id = video.owner_id
        music_id = video.music_id
        music_volume = video.music_volume
        video.status = SvVideoStatus.RENDERING.value
        video.stage = "render"
        video.progress = 0.0

    try:
        _abort_if_cancelled(sv_video_id)
        # Rebuild the intro overlays at full render resolution, reusing the exact
        # on-screen windows the narration produced (and the captions were synced
        # to) during the preview pass — stored in intro_plan.
        card = intro_plan.get("card")
        author = intro_plan.get("author")
        intro = (
            overlays_svc.prepare_intro_overlays(
                sv_video_id=sv_video_id,
                story_meta=story_meta,
                template_config=template_config,
                width=composer.RENDER_W,
                height=composer.RENDER_H,
                card_window=tuple(card) if card else None,
                author_window=tuple(author) if author else None,
            )
            if story_meta is not None
            else {"overlays": []}
        )
        out_key = sv_export_key(sv_video_id, export_id)
        music_path = _resolve_music_path(owner_id, music_id)
        spec = composer.RenderSpec(
            narration_path=storage.abspath(narration_key, ensure_parent=False),
            total_duration=duration,
            ass_path=storage.abspath(ass_key, ensure_parent=False) if ass_key else None,
            plan=plan,
            output_path=storage.abspath(out_key),
            width=composer.RENDER_W,
            height=composer.RENDER_H,
            overlays=intro["overlays"],
            music_path=music_path,
            music_volume=music_volume or 0.0,
        )
        result = composer.render_video(
            spec,
            on_progress=_render_progress(sv_video_id, tracker, "render", "Rendering final video"),
        )
        storage.commit(out_key)
        # Final checkpoint: honour a Stop that landed during the render before we
        # mark it complete — this also keeps the auto-publish tail below from
        # uploading a video the user asked to stop.
        _abort_if_cancelled(sv_video_id)

        with session_scope() as db:
            video = db.get(SvVideo, sv_video_id)
            video.render_path = out_key
            video.cancel_requested = False  # genuine success — reconcile the flag
            export = db.get(SvExport, export_id)
            export.storage_path = out_key
            export.size_bytes = result["size_bytes"]
            export.duration_seconds = result["duration"]
            export.width = result["width"]
            export.height = result["height"]
            story = db.get(SvStory, video.story_id)
            if story and story.status != SvStoryStatus.EXCLUDED.value:
                story.status = SvStoryStatus.USED.value
        tracker.set(
            stage="done", progress=1.0,
            status=SvVideoStatus.COMPLETED.value,
            message="Export complete",
        )
    except _VideoCancelled:
        logger.info("Story video %s final render cancelled by user", sv_video_id)
        with session_scope() as db:
            export = db.get(SvExport, export_id)
            if export and not export.storage_path:
                db.delete(export)
        _mark_cancelled(sv_video_id)
        return
    except Exception as exc:
        logger.exception("Story video %s final render failed", sv_video_id)
        with session_scope() as db:
            export = db.get(SvExport, export_id)
            if export and not export.storage_path:
                db.delete(export)
        tracker.fail("render", str(exc)[:1000])
        _clear_cancel_flag(sv_video_id)
        raise

    # Auto-workflow: queue uploads to the project's saved channels (success path only).
    _maybe_auto_publish(sv_video_id)


# =====================================================================
# Publishing (upload to connected channels)
# =====================================================================
@celery_app.task(name="app.workers.sv_tasks.sv_publish_job_task")
def sv_publish_job_task(job_id: int) -> None:
    from datetime import datetime, timezone

    from app.services.publishing.registry import get_connector

    with session_scope() as db:
        job = db.get(SvPublishJob, job_id)
        if not job:
            return
        job.status = PublishStatus.PUBLISHING.value
        job.error = None
        sv_video_id = job.sv_video_id
        connector_id = job.connector_id
        platform = job.platform
        video = db.get(SvVideo, sv_video_id)
        render_key = video.render_path if video else None

    def _fail(message: str) -> None:
        with session_scope() as db:
            j = db.get(SvPublishJob, job_id)
            if j:
                j.status = PublishStatus.FAILED.value
                j.error = message[:1000]

    def _render_ready(key: str | None) -> bool:
        return bool(key and os.path.exists(storage.abspath(key, ensure_parent=False)))

    try:
        # Publish uploads the already-rendered 1080×1920 file — it never
        # regenerates the story. Generation produces this file up front (render_path
        # set), so this is normally a pure upload. The render fallback only covers a
        # legacy video whose final file was never produced or has gone missing.
        if not _render_ready(render_key):
            sv_render_video_task(sv_video_id, platform)
            with session_scope() as db:
                video = db.get(SvVideo, sv_video_id)
                render_key = video.render_path if video else None
        if not _render_ready(render_key):
            _fail("Final render failed — see the video's error for details")
            return
        asset_path = storage.abspath(render_key, ensure_parent=False)

        with session_scope() as db:
            connector = db.get(PublishingConnector, connector_id) if connector_id else None
            if not connector:
                _fail("The selected channel no longer exists")
                return
            plugin = get_connector(connector.platform)
            if not plugin:
                _fail(f"No publisher for platform {connector.platform!r}")
                return
            ok, reason = plugin.validate(connector)
            if not ok:
                _fail(reason)
                return
            job = db.get(SvPublishJob, job_id)
            result = plugin.publish(job, asset_path, connector)
            if result.success:
                job.status = PublishStatus.PUBLISHED.value
                job.external_post_id = result.external_post_id
                job.external_url = result.external_url
                job.published_at = datetime.now(timezone.utc)
                story_video = db.get(SvVideo, job.sv_video_id)
                if story_video:
                    # A published video is finished — mark it complete so it no
                    # longer sits in the review queue (it was uploaded, not
                    # re-rendered).
                    if story_video.status in (
                        SvVideoStatus.READY_FOR_REVIEW.value,
                        SvVideoStatus.APPROVED.value,
                    ):
                        story_video.status = SvVideoStatus.COMPLETED.value
                        story_video.stage = "done"
                        story_video.progress = 1.0
                    story = db.get(SvStory, story_video.story_id)
                    if story and story.status != SvStoryStatus.EXCLUDED.value:
                        story.status = SvStoryStatus.USED.value
                logger.info("Story video %s published to %s: %s", sv_video_id, connector.name, result.external_url)
            else:
                job.status = PublishStatus.FAILED.value
                job.error = (result.detail or "Upload failed")[:1000]
    except Exception as exc:
        logger.exception("Story publish job %s failed", job_id)
        _fail(str(exc))
