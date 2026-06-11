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

import os

from app.core.database import session_scope
from app.core.logging import get_logger
from app.models.enums import JobStatus, PublishStatus, SvStoryStatus, SvVideoStatus
from app.models.publishing import PublishingConnector
from app.models.storyvault import (
    SvBackground,
    SvExport,
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
    sv_narration_key,
    sv_preview_key,
)
from app.services.storyvault import composer, scripts as scripts_svc, tts
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
            "speed": video.speed,
            "caption_style": video.caption_style,
            "background_category": video.background_category,
            "background_id": video.background_id,
            "script_engine": video.script_engine,
            "script_id": video.script_id,
        }

    try:
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

        # ------------------------------------------------------- 2. narration
        tracker.set(stage="narration", progress=_NARRATE[0], message="Synthesizing narration")
        narration_key = sv_narration_key(sv_video_id)
        result = tts.synthesize(
            script_text,
            storage.abspath(narration_key),
            voice=opts["voice"],
            speed=opts["speed"],
        )
        storage.commit(narration_key)
        if result.duration <= 0.5:
            raise RuntimeError("Narration came back empty — is a SAPI voice installed?")
        with session_scope() as db:
            video = db.get(SvVideo, sv_video_id)
            video.narration_path = narration_key
            video.narration_duration = result.duration
            video.word_timings = result.words
        tracker.set(stage="narration", progress=_NARRATE[1], message=f"Narration: {result.duration:.1f}s")

        # -------------------------------------------------------- 3. captions
        tracker.set(stage="captions", progress=_CAPTIONS[0], message="Building captions")
        tokens = captions_svc.build_tokens(result.words)
        tokens = captions_svc.heuristic_emphasis(tokens)
        ass_key = sv_captions_key(sv_video_id, "ass")
        srt_key = sv_captions_key(sv_video_id, "srt")
        captions_svc.write_ass(
            storage.abspath(ass_key), tokens, opts["caption_style"], composer.RENDER_W, composer.RENDER_H
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
        plan = composer.plan_segments(candidates, result.duration, seed=sv_video_id)
        with session_scope() as db:
            video = db.get(SvVideo, sv_video_id)
            video.segment_plan = plan
            used_ids = [p["segment_id"] for p in plan if p.get("segment_id")]
            if used_ids:
                for seg in db.query(SvSegment).filter(SvSegment.id.in_(used_ids)).all():
                    seg.times_used += 1
        msg = f"{len(plan)} segments" if plan else "No footage library — using gradient background"
        tracker.set(stage="footage", progress=_FOOTAGE[1], message=msg)

        # ---------------------------------------------------------- 5. preview
        preview_key = sv_preview_key(sv_video_id)
        spec = composer.RenderSpec(
            narration_path=storage.abspath(narration_key, ensure_parent=False),
            total_duration=result.duration,
            ass_path=storage.abspath(ass_key, ensure_parent=False),
            plan=plan,
            output_path=storage.abspath(preview_key),
            width=composer.PREVIEW_W,
            height=composer.PREVIEW_H,
        )
        composer.render_video(
            spec,
            on_progress=lambda f: tracker.throttled(
                "preview", _lerp(_PREVIEW, f), message="Rendering preview"
            ),
        )
        storage.commit(preview_key)
        with session_scope() as db:
            video = db.get(SvVideo, sv_video_id)
            video.preview_path = preview_key
        tracker.set(
            stage="ready", progress=1.0,
            status=SvVideoStatus.READY_FOR_REVIEW.value,
            message="Ready for review",
        )
    except Exception as exc:
        logger.exception("Story video %s pipeline failed", sv_video_id)
        tracker.fail("pipeline", str(exc)[:1000])


# =====================================================================
# Caption-style preset previews
# =====================================================================
# One sample sentence narrated once, then rendered with each caption style so
# the Presets page shows the real thing (same ASS renderer the pipeline uses).
PREVIEW_SAMPLE_TEXT = (
    "This is exactly how your captions will look. Bold words pop, numbers like "
    "47 stand out, and every single word stays in sync."
)


@celery_app.task(name="app.workers.sv_tasks.sv_caption_previews_task")
def sv_caption_previews_task(styles: list[str], force: bool = False) -> None:
    import tempfile

    missing = [s for s in styles if force or not storage.exists(sv_caption_preview_key(s))]
    if not missing:
        return

    with tempfile.TemporaryDirectory(prefix="sv_prev_") as tmp:
        wav = os.path.join(tmp, "sample.wav")
        result = tts.synthesize(PREVIEW_SAMPLE_TEXT, wav)
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
        video.status = SvVideoStatus.RENDERING.value
        video.stage = "render"
        video.progress = 0.0

    try:
        out_key = sv_export_key(sv_video_id, export_id)
        spec = composer.RenderSpec(
            narration_path=storage.abspath(narration_key, ensure_parent=False),
            total_duration=duration,
            ass_path=storage.abspath(ass_key, ensure_parent=False) if ass_key else None,
            plan=plan,
            output_path=storage.abspath(out_key),
            width=composer.RENDER_W,
            height=composer.RENDER_H,
        )
        result = composer.render_video(
            spec,
            on_progress=lambda f: tracker.throttled(
                "render", f, message="Rendering final video"
            ),
        )
        storage.commit(out_key)

        with session_scope() as db:
            video = db.get(SvVideo, sv_video_id)
            video.render_path = out_key
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
    except Exception as exc:
        logger.exception("Story video %s final render failed", sv_video_id)
        with session_scope() as db:
            export = db.get(SvExport, export_id)
            if export and not export.storage_path:
                db.delete(export)
        tracker.fail("render", str(exc)[:1000])
        raise


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

    try:
        # The upload needs the final 1080×1920 file — render it on demand.
        if not render_key:
            sv_render_video_task(sv_video_id, platform)
            with session_scope() as db:
                video = db.get(SvVideo, sv_video_id)
                render_key = video.render_path if video else None
        if not render_key:
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
