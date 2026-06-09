"""Celery tasks: ingestion + the full clip-generation pipeline.

Pipeline (``process_video_task``):

    transcribe → detect viral moments → create clips →
    for each clip: rank · titles · description · b-roll · captions · reframe · render

Each stage emits progress via :class:`ProgressTracker`, so the dashboard updates
live over WebSocket.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from typing import Any

from app.core.config import settings
from app.core.database import session_scope
from app.core.logging import get_logger
from app.models.analysis import AIAnalysis
from app.models.clip import Clip
from app.models.enums import JobStatus, VideoSource
from app.models.export import Export
from app.models.settings import UserSettings
from app.models.transcript import Transcript
from app.models.video import Video
from app.schemas.video import ProcessOptions
from app.services import (
    broll as broll_svc,
    captions as captions_svc,
    descriptions as desc_svc,
    ranking as ranking_svc,
    reframing,
    titles as titles_svc,
    transcription,
    viral_detection,
    youtube_captions,
    youtube_detect,
    youtube_download,
    youtube_metadata,
)
from app.services.export import render_clip
from app.services.ffmpeg import ffmpeg
from app.services.storage import (
    clip_preview_key,
    clip_segment_key,
    clip_thumb_key,
    storage,
    video_audio_key,
    video_source_key,
    video_thumb_key,
)
from app.services.transcript_utils import clip_words_relative, text_in_range
from app.workers.celery_app import celery_app
from app.workers.progress import ProgressTracker

logger = get_logger(__name__)

# Overall-progress bands for the pipeline stages.
_TRANSCRIBE = (0.05, 0.40)
_DETECT = (0.40, 0.50)
_ENRICH = (0.50, 1.0)
# Segment-mode YouTube sub-bands (before _DETECT): caption fetch, or the
# audio-only Whisper fallback when no captions are available.
_YT_CAPTION = (0.05, 0.20)
_YT_AUDIO = (0.20, 0.40)


def _lerp(band: tuple[float, float], frac: float) -> float:
    return band[0] + (band[1] - band[0]) * max(0.0, min(1.0, frac))


def _owner_models(video: Video) -> dict[str, str]:
    """Resolve the model names to use, honoring the owner's settings."""
    out = {
        "default": settings.OLLAMA_DEFAULT_MODEL,
        "ranking": settings.OLLAMA_RANKING_MODEL,
        "whisper": settings.WHISPER_MODEL,
    }
    with session_scope() as db:
        v = db.get(Video, video.id)
        if not v:
            return out
        proj = v.project
        if proj and proj.owner_id:
            row = (
                db.query(UserSettings).filter(UserSettings.user_id == proj.owner_id).one_or_none()
            )
            if row:
                out["default"] = row.default_model
                out["ranking"] = row.ranking_model
                out["whisper"] = row.whisper_model
    return out


def _source_path(video: Video) -> str:
    return storage.abspath(video.storage_path, ensure_parent=False)


def _clip_render_source(clip: Clip, video: Video) -> tuple[str, float]:
    """Resolve the file + time offset to render/export a clip from.

    Segment-download clips render from their own partial source file (times are
    rebased by ``source_offset``); whole-video clips render from the full source
    at offset 0.
    """
    if clip.source_segment_path:
        return storage.abspath(clip.source_segment_path, ensure_parent=False), clip.source_offset or 0.0
    return _source_path(video), 0.0


# =====================================================================
# Ingestion
# =====================================================================
def _probe_and_thumbnail(video_id: int) -> None:
    with session_scope() as db:
        video = db.get(Video, video_id)
        src = storage.abspath(video.storage_path, ensure_parent=False)
        project_id, vid = video.project_id, video.id

    info = ffmpeg.probe(src)
    thumb_key = video_thumb_key(project_id, vid)
    thumb_path = storage.open_write(thumb_key)
    try:
        ffmpeg.extract_thumbnail(src, thumb_path, at=min(2.0, max(0.5, info.duration * 0.1)))
        storage.commit(thumb_key)
    except Exception as exc:  # pragma: no cover
        logger.warning("Thumbnail failed for video %s: %s", vid, exc)
        thumb_key = None

    with session_scope() as db:
        video = db.get(Video, video_id)
        video.duration_seconds = info.duration
        video.width = info.width
        video.height = info.height
        video.fps = info.fps
        video.codec = info.codec
        if info.size_bytes:
            video.size_bytes = info.size_bytes
        if thumb_key:
            video.thumbnail_path = thumb_key


@celery_app.task(bind=True, name="app.workers.tasks.ingest_upload_task", max_retries=2)
def ingest_upload_task(self, video_id: int) -> dict[str, Any]:
    tracker = ProgressTracker("video", video_id)
    try:
        tracker.set(stage="ingest", progress=0.3, message="Probing media")
        _probe_and_thumbnail(video_id)
        tracker.complete(stage="ready", message="Ready to process")
        return {"video_id": video_id, "status": "ready"}
    except Exception as exc:
        logger.exception("Ingest (upload) failed for %s", video_id)
        tracker.fail("ingest", str(exc))
        raise


@celery_app.task(bind=True, name="app.workers.tasks.ingest_youtube_task", max_retries=1)
def ingest_youtube_task(self, video_id: int, url: str) -> dict[str, Any]:
    """Fetch metadata + engagement signals only — no video download.

    Segment mode finds clips from this analytics bundle and downloads only the
    chosen segments later (during processing). Live streams can't be range-
    downloaded, so they're rejected here with a clear message.
    """
    tracker = ProgressTracker("video", video_id)
    try:
        tracker.set(stage="fetching", progress=0.2, message="Fetching video metadata")
        bundle = youtube_metadata.build_signal_bundle(url)

        if bundle.get("is_live"):
            raise RuntimeError(
                "This is a live stream. Wait until the broadcast ends, then import the VOD."
            )

        with session_scope() as db:
            video = db.get(Video, video_id)
            video.youtube_meta = bundle
            if bundle.get("title") and not video.title:
                video.title = bundle["title"]
            if bundle.get("duration"):
                video.duration_seconds = bundle["duration"]
            video.width = bundle.get("width") or video.width
            video.height = bundle.get("height") or video.height
            video.fps = bundle.get("fps") or video.fps
            if bundle.get("language") and not video.language:
                video.language = bundle["language"]

        tracker.complete(stage="ready", message="Ready to process")
        return {"video_id": video_id, "status": "ready"}
    except Exception as exc:
        logger.exception("Ingest (youtube) failed for %s", video_id)
        tracker.fail("fetching", str(exc))
        raise


# =====================================================================
# Transcription + detection + per-clip enrichment
# =====================================================================
def _transcribe(video_id: int, opts: ProcessOptions, models: dict[str, str],
                tracker: ProgressTracker) -> dict[str, Any]:
    with session_scope() as db:
        video = db.get(Video, video_id)
        src = _source_path(video)
        project_id = video.project_id

    audio_key = video_audio_key(project_id, video_id)
    audio_path = storage.open_write(audio_key)
    tracker.set(stage="transcribe", progress=_TRANSCRIBE[0], message="Extracting audio")
    ffmpeg.extract_audio(src, audio_path)

    # Audio is extracted; the long part is the actual transcription. Carry a
    # "Transcribing audio" message on every progress frame so the UI label
    # reflects the real stage instead of staying on "Extracting audio".
    tracker.set(stage="transcribe", progress=_TRANSCRIBE[0],
                message="Transcribing audio", persist=False)
    result = transcription.transcribe(
        audio_path,
        model_size=models["whisper"],
        language=opts.language,
        on_progress=lambda f: tracker.throttled(
            "transcribe", _lerp(_TRANSCRIBE, f), message="Transcribing audio"),
    )

    with session_scope() as db:
        db.query(Transcript).filter(Transcript.video_id == video_id).delete()
        db.add(
            Transcript(
                video_id=video_id,
                language=result.get("language"),
                engine=result.get("engine"),
                model=result.get("model"),
                full_text=result.get("full_text", ""),
                word_count=result.get("word_count", 0),
                num_speakers=result.get("num_speakers", 0),
                duration_seconds=result.get("duration"),
                segments=result.get("segments", []),
            )
        )
        video = db.get(Video, video_id)
        if result.get("language"):
            video.language = result["language"]
    return result


def _persist_candidates(video_id: int, candidates: list[Any], analyses: list[dict[str, Any]],
                        opts: ProcessOptions) -> list[int]:
    """Write detected CandidateClips + their AIAnalysis rows; return new clip ids."""
    clip_ids: list[int] = []
    aspect = opts.aspect_ratios[0].value if opts.aspect_ratios else "9:16"
    with session_scope() as db:
        for a in analyses:
            db.add(AIAnalysis(video_id=video_id, **a))
        for idx, cand in enumerate(candidates):
            clip = Clip(
                video_id=video_id,
                order_index=idx,
                start_time=cand.start,
                end_time=cand.end,
                duration=cand.duration,
                title=cand.title,
                reasoning=cand.reasoning,
                transcript_text=cand.transcript_text,
                viral_score=cand.viral_score,
                aspect_ratio=aspect,
                caption_style=opts.caption_style.value,
                status=JobStatus.PENDING.value,
            )
            db.add(clip)
            db.flush()
            clip_ids.append(clip.id)
    return clip_ids


def _detect(video_id: int, transcript: dict[str, Any], opts: ProcessOptions,
            models: dict[str, str], tracker: ProgressTracker) -> list[int]:
    tracker.set(stage="detect", progress=_DETECT[0], message="Finding viral moments")
    segments = transcript.get("segments", [])
    duration = transcript.get("duration") or (segments[-1]["end"] if segments else 0)

    candidates, analyses = viral_detection.detect_viral_clips(
        segments,
        duration=duration,
        target_count=opts.target_clip_count,
        min_seconds=opts.min_clip_seconds,
        max_seconds=opts.max_clip_seconds,
        model=opts.model or models["default"],
    )

    clip_ids = _persist_candidates(video_id, candidates, analyses, opts)
    tracker.set(stage="detect", progress=_DETECT[1], message=f"Found {len(clip_ids)} candidate clips",
                data={"clip_count": len(clip_ids)})
    return clip_ids


def _enrich_clip(clip_id: int, source_path: str, segments: list[dict[str, Any]],
                 opts: ProcessOptions, models: dict[str, str],
                 *, source_offset: float = 0.0) -> None:
    """Run all AI + media steps for a single clip.

    ``start``/``end`` (and the transcript ``segments``) are always absolute in the
    original video. ``source_path`` may be a partial segment file that begins at
    ``source_offset`` seconds — render/reframe seek into it at ``time - offset``.
    """
    clip_tracker = ProgressTracker("clip", clip_id)
    with session_scope() as db:
        clip = db.get(Clip, clip_id)
        start, end = clip.start_time, clip.end_time
        aspect, style = clip.aspect_ratio, clip.caption_style
        title, project_id, video_id = clip.title, None, clip.video_id
        existing_text = clip.transcript_text
        clip.status = JobStatus.PROCESSING.value
        video = db.get(Video, clip.video_id)
        project_id = video.project_id

    # Local (segment-file) times for the media tools; absolute times for the text.
    local_start = max(0.0, start - source_offset)
    local_end = max(local_start + 0.1, end - source_offset)

    text = text_in_range(segments, start, end)
    words = clip_words_relative(segments, start, end)
    analyses: list[dict[str, Any]] = []
    updates: dict[str, Any] = {}
    if text and not existing_text:
        updates["transcript_text"] = text

    # --- ranking ---
    try:
        clip_tracker.set(stage="rank", progress=0.1, message="Scoring")
        result, meta = ranking_svc.rank_clip(
            title=title or "", text=text, duration=end - start, model=models["ranking"]
        )
        updates["ranking_score"] = result["overall_score"]
        updates["confidence"] = result["confidence"]
        updates["score_breakdown"] = result
        analyses.append({"analysis_type": "ranking", "model": meta.get("model"),
                         "result": result, "duration_ms": meta.get("duration_ms")})
    except Exception as exc:
        logger.warning("Ranking failed for clip %s: %s", clip_id, exc)

    # --- titles ---
    if opts.generate_titles:
        try:
            clip_tracker.set(stage="titles", progress=0.25, message="Writing titles")
            result, meta = titles_svc.generate_titles(text=text, model=models["default"])
            updates["title_variations"] = result["all"]
            if result.get("best"):
                updates["title"] = result["best"]
            analyses.append({"analysis_type": "titles", "model": meta.get("model"), "result": result})
        except Exception as exc:
            logger.warning("Titles failed for clip %s: %s", clip_id, exc)

    # --- description ---
    if opts.generate_descriptions:
        try:
            clip_tracker.set(stage="description", progress=0.4, message="SEO description")
            result, meta = desc_svc.generate_description(
                title=updates.get("title", title) or "", text=text, model=models["default"]
            )
            updates["description"] = result["description"]
            updates["hashtags"] = result["hashtags"]
            updates["keywords"] = result["keywords"]
            analyses.append({"analysis_type": "description", "model": meta.get("model"), "result": result})
        except Exception as exc:
            logger.warning("Description failed for clip %s: %s", clip_id, exc)

    # --- b-roll ---
    if opts.generate_broll:
        try:
            clip_tracker.set(stage="broll", progress=0.5, message="B-roll suggestions")
            result, meta = broll_svc.suggest_broll(text=text, model=models["default"])
            updates["broll_suggestions"] = result
            analyses.append({"analysis_type": "broll", "model": meta.get("model"),
                             "result": {"suggestions": result}})
        except Exception as exc:
            logger.warning("B-roll failed for clip %s: %s", clip_id, exc)

    # --- captions ---
    tokens: list[dict[str, Any]] = []
    if opts.enable_captions:
        try:
            clip_tracker.set(stage="captions", progress=0.6, message="Generating captions")
            tokens = captions_svc.build_tokens(words)
            tokens, meta = captions_svc.apply_emphasis(tokens, model=models["default"])
            updates["captions"] = tokens
            analyses.append({"analysis_type": "caption_emphasis", "model": meta.get("model"),
                             "result": {"count": len(tokens)}})
        except Exception as exc:
            logger.warning("Captions failed for clip %s: %s", clip_id, exc)
            tokens = captions_svc.build_tokens(words)
            updates["captions"] = tokens

    # --- reframe trajectory ---
    reframe_data: dict[str, Any] = {}
    if opts.enable_reframe:
        try:
            clip_tracker.set(stage="reframe", progress=0.72, message="Tracking subject")
            reframe_data = reframing.compute_trajectory(
                source_path, start=local_start, end=local_end,
                on_progress=lambda f: clip_tracker.set(
                    stage="reframe", progress=0.72 + f * 0.1, persist=False),
            )
            updates["reframe_data"] = reframe_data
        except Exception as exc:
            logger.warning("Reframe failed for clip %s: %s", clip_id, exc)

    # Persist AI results before the (slow) render.
    with session_scope() as db:
        clip = db.get(Clip, clip_id)
        for key, value in updates.items():
            setattr(clip, key, value)
        for a in analyses:
            db.add(AIAnalysis(video_id=video_id, clip_id=clip_id, **a))

    # --- render preview ---
    try:
        clip_tracker.set(stage="render", progress=0.85, message="Rendering preview")
        preview_key = clip_preview_key(project_id, video_id, clip_id)
        preview_path = storage.open_write(preview_key)
        render_clip(
            source_path=source_path,
            output_path=preview_path,
            start=local_start, end=local_end,
            aspect_ratio=aspect,
            resolution="1080p",
            reframe_data=reframe_data,
            caption_tokens=tokens if opts.enable_captions else None,
            caption_style=style,
            burn_captions=opts.enable_captions,
            on_progress=lambda f: clip_tracker.set(
                stage="render", progress=0.85 + f * 0.13, persist=False),
        )
        storage.commit(preview_key)

        thumb_key = clip_thumb_key(project_id, video_id, clip_id)
        thumb_path = storage.open_write(thumb_key)
        ffmpeg.extract_thumbnail(preview_path, thumb_path, at=0.5)
        storage.commit(thumb_key)

        with session_scope() as db:
            clip = db.get(Clip, clip_id)
            clip.preview_path = preview_key
            clip.thumbnail_path = thumb_key
            clip.status = JobStatus.COMPLETED.value
            clip.progress = 1.0
        clip_tracker.complete(stage="done", message="Clip ready")
    except Exception as exc:
        logger.exception("Render failed for clip %s", clip_id)
        with session_scope() as db:
            clip = db.get(Clip, clip_id)
            clip.status = JobStatus.FAILED.value
            clip.error = str(exc)
        clip_tracker.fail("render", str(exc))


# --------------------------------------------------------------------- transcript helpers
def _store_transcript(
    video_id: int, *, language: str | None, engine: str | None,
    segments: list[dict[str, Any]], full_text: str | None = None,
    duration: float | None = None, word_count: int | None = None,
    num_speakers: int = 0, model: str | None = None,
) -> None:
    """Replace the video's Transcript row (idempotent)."""
    if full_text is None:
        full_text = " ".join(s.get("text", "") for s in segments).strip()
    if word_count is None:
        word_count = len(full_text.split())
    with session_scope() as db:
        db.query(Transcript).filter(Transcript.video_id == video_id).delete()
        db.add(
            Transcript(
                video_id=video_id, language=language, engine=engine, model=model,
                full_text=full_text, word_count=word_count, num_speakers=num_speakers,
                duration_seconds=duration, segments=segments,
            )
        )
        video = db.get(Video, video_id)
        if language and not video.language:
            video.language = language


def _whisper_segment(seg_path: str, offset: float, models: dict[str, str],
                     language: str | None) -> list[dict[str, Any]]:
    """Transcribe a short downloaded segment for word-level caption timing.

    Returns segments with timestamps rebased to ABSOLUTE video time (+offset), so
    they slot straight into the shared transcript / ``clip_words_relative``.
    """
    tmpdir = tempfile.mkdtemp(prefix="seg_whisper_")
    try:
        wav = os.path.join(tmpdir, "seg.wav")
        ffmpeg.extract_audio(seg_path, wav)
        result = transcription.transcribe(
            wav, model_size=models["whisper"], language=language
        )
    except Exception as exc:  # noqa: BLE001 — captions degrade, don't fail the clip
        logger.warning("Per-segment transcription failed (%s); captions may be empty", exc)
        return []
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    out: list[dict[str, Any]] = []
    for seg in result.get("segments", []):
        ns = dict(seg)
        ns["start"] = float(seg.get("start", 0.0)) + offset
        ns["end"] = float(seg.get("end", 0.0)) + offset
        ns["words"] = [
            {**w, "start": float(w.get("start", 0.0)) + offset,
             "end": float(w.get("end", 0.0)) + offset}
            for w in (seg.get("words") or [])
        ]
        out.append(ns)
    return out


def _merge_segments(base: list[dict[str, Any]], extra: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge word-bearing whisper segments into caption segments (whisper wins on overlap)."""
    if not extra:
        return base
    extra_sorted = sorted(extra, key=lambda s: s.get("start", 0.0))
    covered = [(s.get("start", 0.0), s.get("end", 0.0)) for s in extra_sorted]

    def overlaps(s: dict[str, Any]) -> bool:
        a, b = s.get("start", 0.0), s.get("end", 0.0)
        return any(a < ce and b > cs for cs, ce in covered)

    merged = sorted(
        [s for s in base if not overlaps(s)] + extra_sorted,
        key=lambda s: s.get("start", 0.0),
    )
    for i, s in enumerate(merged):
        s["id"] = i
    return merged


def _transcribe_audio_only(video_id: int, url: str, opts: ProcessOptions,
                           models: dict[str, str], tracker: ProgressTracker) -> dict[str, Any]:
    """No-captions fallback: download the audio track (not the video) and Whisper it."""
    with session_scope() as db:
        video = db.get(Video, video_id)
        project_id = video.project_id

    tmpdir = tempfile.mkdtemp(prefix="yt_audio_")
    try:
        tracker.set(stage="transcribe", progress=_YT_AUDIO[0], message="Downloading audio")
        audio_src = youtube_download.download_audio(
            url, os.path.join(tmpdir, "audio_src.%(ext)s"),
            on_progress=lambda f: tracker.throttled(
                "transcribe", _lerp(_YT_AUDIO, f * 0.3), message="Downloading audio"),
        )
        audio_key = video_audio_key(project_id, video_id)
        wav = storage.open_write(audio_key)
        ffmpeg.extract_audio(audio_src, wav)
        storage.commit(audio_key)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    tracker.set(stage="transcribe", progress=_lerp(_YT_AUDIO, 0.35),
                message="Transcribing audio", persist=False)
    result = transcription.transcribe(
        wav, model_size=models["whisper"], language=opts.language,
        on_progress=lambda f: tracker.throttled(
            "transcribe", _lerp(_YT_AUDIO, 0.35 + f * 0.65), message="Transcribing audio"),
    )
    _store_transcript(
        video_id, language=result.get("language"), engine=result.get("engine"),
        segments=result.get("segments", []), full_text=result.get("full_text"),
        duration=result.get("duration"), word_count=result.get("word_count"),
        num_speakers=result.get("num_speakers", 0), model=result.get("model"),
    )
    return result


def _ensure_full_source(video_id: int, url: str, tracker: ProgressTracker) -> None:
    """Download the whole video (YouTube opt-out / legacy path) and probe it."""
    from app.services import youtube

    with session_scope() as db:
        video = db.get(Video, video_id)
        project_id = video.project_id
    key = video_source_key(project_id, video_id, "mp4")
    dest = storage.open_write(key)
    tracker.set(stage="downloading", progress=0.02, message="Downloading video")
    meta = youtube.download(
        url, dest, on_progress=lambda f: tracker.throttled("downloading", 0.02 + f * 0.03)
    )
    storage.commit(key)
    with session_scope() as db:
        video = db.get(Video, video_id)
        video.storage_path = key
        video.size_bytes = storage.size(key)
        if meta.get("title") and not video.title:
            video.title = meta["title"]
    _probe_and_thumbnail(video_id)


# --------------------------------------------------------------------- pipelines
def _process_full(video_id: int, opts: ProcessOptions, models: dict[str, str],
                  tracker: ProgressTracker) -> int:
    """Whole-video pipeline (uploads, and YouTube when segment mode is off)."""
    with session_scope() as db:
        video = db.get(Video, video_id)
        needs_download = video.source == VideoSource.YOUTUBE.value and not video.storage_path
        url = video.source_url
    if needs_download:
        _ensure_full_source(video_id, url, tracker)

    tracker.set(stage="transcribe", progress=_TRANSCRIBE[0], message="Transcribing audio")
    transcript = _transcribe(video_id, opts, models, tracker)
    if not transcript.get("segments"):
        raise RuntimeError("Transcription produced no segments (is there audio?)")

    clip_ids = _detect(video_id, transcript, opts, models, tracker)
    if not clip_ids:
        raise RuntimeError("No viral clips detected")

    with session_scope() as db:
        video = db.get(Video, video_id)
        source_path = _source_path(video)
    segments = transcript["segments"]

    total = len(clip_ids)
    for i, clip_id in enumerate(clip_ids):
        tracker.set(
            stage="enrich", progress=_lerp(_ENRICH, i / total),
            message=f"Producing clip {i + 1}/{total}", data={"current": i + 1, "total": total},
        )
        _enrich_clip(clip_id, source_path, segments, opts, models)
    return total


def _process_youtube_segmented(video_id: int, opts: ProcessOptions, models: dict[str, str],
                               tracker: ProgressTracker) -> int:
    """Metadata-first pipeline: detect from analytics, download only clip segments."""
    with session_scope() as db:
        video = db.get(Video, video_id)
        url = video.source_url
        project_id = video.project_id
        meta = dict(video.youtube_meta or {})
    duration = float(meta.get("duration") or 0.0)

    # ---- 1. transcript: YouTube captions first, else audio-only Whisper ----
    have_word_transcript = False
    word_segments: list[dict[str, Any]] = []
    caption_segments: list[dict[str, Any]] = []

    cap = None
    if opts.use_youtube_captions:
        tracker.set(stage="captions", progress=_YT_CAPTION[0], message="Fetching captions")
        cap = youtube_captions.fetch_captions(
            url, meta.get("video_id"), settings.YOUTUBE_CAPTION_LANGS
        )

    if cap and cap.get("segments"):
        caption_segments = cap["segments"]
        detect_segments = caption_segments
        _store_transcript(
            video_id, language=cap.get("language"), engine=cap.get("engine"),
            segments=caption_segments, full_text=cap.get("full_text"), duration=duration,
        )
        tracker.set(stage="captions", progress=_YT_CAPTION[1],
                    message=f"Captions ready ({len(caption_segments)} lines)")
    else:
        result = _transcribe_audio_only(video_id, url, opts, models, tracker)
        word_segments = result.get("segments") or []
        detect_segments = word_segments
        have_word_transcript = True
        duration = duration or float(result.get("duration") or 0.0)

    # ---- 2. detect (LLM over transcript + heatmap/comment signals) ----
    tracker.set(stage="detect", progress=_DETECT[0], message="Finding viral moments")
    candidates, analyses = youtube_detect.detect_from_youtube(
        caption_segments=detect_segments, duration=duration,
        youtube_meta=meta, opts=opts, models=models,
    )
    clip_ids = _persist_candidates(video_id, candidates, analyses, opts)
    if not clip_ids:
        raise RuntimeError("No clips detected from transcript or engagement signals")
    tracker.set(stage="detect", progress=_DETECT[1],
                message=f"Found {len(clip_ids)} candidate clips", data={"clip_count": len(clip_ids)})

    # ---- 3. per clip: download only its segment, then enrich + render ----
    pad = opts.segment_pad_seconds
    total = len(clip_ids)
    for i, clip_id in enumerate(clip_ids):
        tracker.set(
            stage="enrich", progress=_lerp(_ENRICH, i / total),
            message=f"Producing clip {i + 1}/{total}", data={"current": i + 1, "total": total},
        )
        with session_scope() as db:
            clip = db.get(Clip, clip_id)
            start, end = clip.start_time, clip.end_time

        seg_start = max(0.0, start - pad)
        seg_end = min(duration, end + pad) if duration else end + pad
        seg_key = clip_segment_key(project_id, video_id, clip_id)
        dest = storage.open_write(seg_key)
        try:
            youtube_download.download_section(
                url, seg_start, seg_end, dest,
                on_progress=lambda f, i=i: tracker.set(
                    stage="enrich", progress=_lerp(_ENRICH, (i + f * 0.4) / total),
                    message=f"Downloading clip {i + 1}/{total}", persist=False),
            )
            storage.commit(seg_key)
        except Exception as exc:
            logger.exception("Segment download failed for clip %s", clip_id)
            with session_scope() as db:
                c = db.get(Clip, clip_id)
                if c:
                    c.status = JobStatus.FAILED.value
                    c.error = f"Segment download failed: {exc}"
            continue

        seg_abspath = storage.abspath(seg_key, ensure_parent=False)
        with session_scope() as db:
            clip = db.get(Clip, clip_id)
            clip.source_segment_path = seg_key
            clip.source_offset = seg_start

        # Word-level segments for caption burn-in.
        if have_word_transcript:
            clip_segments = word_segments
        elif opts.enable_captions:
            clip_segments = _whisper_segment(seg_abspath, seg_start, models, opts.language)
            word_segments.extend(clip_segments)
        else:
            clip_segments = caption_segments

        _enrich_clip(clip_id, seg_abspath, clip_segments, opts, models, source_offset=seg_start)

    # Fold per-segment word timing back into the stored transcript so the UI and
    # clip regeneration get word-level data for the clipped regions.
    if word_segments and not have_word_transcript:
        _store_transcript(
            video_id, language="en", engine="youtube_captions+whisper",
            segments=_merge_segments(caption_segments, word_segments), duration=duration,
        )

    return total


@celery_app.task(bind=True, name="app.workers.tasks.process_video_task")
def process_video_task(self, video_id: int, options: dict[str, Any]) -> dict[str, Any]:
    opts = ProcessOptions(**(options or {}))
    tracker = ProgressTracker("video", video_id)
    try:
        with session_scope() as db:
            video = db.get(Video, video_id)
            if not video:
                return {"error": "video not found"}
            source = video.source
            has_signal_meta = bool(video.youtube_meta)
            video.status = JobStatus.PROCESSING.value
            # Clear any prior clips so reprocessing is idempotent.
            db.query(Clip).filter(Clip.video_id == video_id).delete()
        models = _owner_models(video)

        use_segments = (
            source == VideoSource.YOUTUBE.value
            and opts.segment_download
            and settings.YOUTUBE_SEGMENT_MODE
            and has_signal_meta
        )
        if use_segments:
            total = _process_youtube_segmented(video_id, opts, models, tracker)
        else:
            total = _process_full(video_id, opts, models, tracker)

        tracker.complete(stage="done", message=f"Generated {total} clips",
                         data={"clip_count": total})
        return {"video_id": video_id, "clips": total}
    except Exception as exc:
        logger.exception("Processing failed for video %s", video_id)
        tracker.fail("process", str(exc))
        raise


@celery_app.task(bind=True, name="app.workers.tasks.render_preview_task")
def render_preview_task(self, clip_id: int) -> dict[str, Any]:
    tracker = ProgressTracker("clip", clip_id)
    try:
        with session_scope() as db:
            clip = db.get(Clip, clip_id)
            video = db.get(Video, clip.video_id)
            source_path, offset = _clip_render_source(clip, video)
            project_id, video_id = video.project_id, video.id
            params = dict(
                start=clip.start_time - offset, end=clip.end_time - offset,
                aspect=clip.aspect_ratio, style=clip.caption_style,
                tokens=clip.captions or [], reframe=clip.reframe_data or {},
            )
            clip.status = JobStatus.PROCESSING.value

        tracker.set(stage="render", progress=0.1, message="Rendering preview")
        preview_key = clip_preview_key(project_id, video_id, clip_id)
        preview_path = storage.open_write(preview_key)
        render_clip(
            source_path=source_path, output_path=preview_path,
            start=params["start"], end=params["end"], aspect_ratio=params["aspect"],
            resolution="1080p", reframe_data=params["reframe"],
            caption_tokens=params["tokens"], caption_style=params["style"],
            burn_captions=bool(params["tokens"]),
            on_progress=lambda f: tracker.set(stage="render", progress=0.1 + f * 0.85, persist=False),
        )
        storage.commit(preview_key)

        thumb_key = clip_thumb_key(project_id, video_id, clip_id)
        thumb_path = storage.open_write(thumb_key)
        ffmpeg.extract_thumbnail(preview_path, thumb_path, at=0.5)
        storage.commit(thumb_key)

        with session_scope() as db:
            clip = db.get(Clip, clip_id)
            clip.preview_path = preview_key
            clip.thumbnail_path = thumb_key
            clip.status = JobStatus.COMPLETED.value
            clip.progress = 1.0
        tracker.complete(stage="done", message="Preview ready")
        return {"clip_id": clip_id}
    except Exception as exc:
        logger.exception("Preview render failed for clip %s", clip_id)
        with session_scope() as db:
            clip = db.get(Clip, clip_id)
            if clip:
                clip.status = JobStatus.FAILED.value
                clip.error = str(exc)
        tracker.fail("render", str(exc))
        raise


@celery_app.task(bind=True, name="app.workers.tasks.export_clip_task")
def export_clip_task(self, export_id: int) -> dict[str, Any]:
    tracker = ProgressTracker("export", export_id)
    try:
        with session_scope() as db:
            export = db.get(Export, export_id)
            clip = db.get(Clip, export.clip_id)
            video = db.get(Video, clip.video_id)
            source_path, offset = _clip_render_source(clip, video)
            project_id, video_id, clip_id = video.project_id, video.id, clip.id
            params = dict(
                start=clip.start_time - offset, end=clip.end_time - offset,
                style=clip.caption_style,
                tokens=clip.captions or [], reframe=clip.reframe_data or {},
                fmt=export.format, resolution=export.resolution,
                aspect=export.aspect_ratio, burn=export.burn_captions,
            )
            export.status = JobStatus.PROCESSING.value
            export.hwaccel = settings.HWACCEL

        tracker.set(stage="export", progress=0.05, message="Rendering export")
        from app.services.storage import export_key as export_key_fn

        out_key = export_key_fn(project_id, video_id, clip_id, export_id, params["fmt"])
        out_path = storage.open_write(out_key)
        result = render_clip(
            source_path=source_path, output_path=out_path,
            start=params["start"], end=params["end"], aspect_ratio=params["aspect"],
            resolution=params["resolution"], reframe_data=params["reframe"],
            caption_tokens=params["tokens"], caption_style=params["style"],
            burn_captions=params["burn"], hwaccel=settings.HWACCEL,
            on_progress=lambda f: tracker.set(stage="export", progress=0.05 + f * 0.9, persist=False),
        )
        storage.commit(out_key)

        with session_scope() as db:
            export = db.get(Export, export_id)
            export.storage_path = out_key
            export.size_bytes = result.size_bytes
            export.width = result.width
            export.height = result.height
            export.duration_seconds = result.duration
            export.status = JobStatus.COMPLETED.value
            export.progress = 1.0
        tracker.complete(stage="done", message="Export ready", data={"key": out_key})
        return {"export_id": export_id, "key": out_key}
    except Exception as exc:
        logger.exception("Export failed for %s", export_id)
        with session_scope() as db:
            export = db.get(Export, export_id)
            if export:
                export.status = JobStatus.FAILED.value
                export.error = str(exc)
        tracker.fail("export", str(exc))
        raise


@celery_app.task(bind=True, name="app.workers.tasks.regenerate_clip_task")
def regenerate_clip_task(self, clip_id: int, opts: dict[str, Any]) -> dict[str, Any]:
    """Re-run selected AI steps for a single clip (no full reprocess)."""
    tracker = ProgressTracker("clip", clip_id)
    try:
        with session_scope() as db:
            clip = db.get(Clip, clip_id)
            video = db.get(Video, clip.video_id)
            start, end, title, style = clip.start_time, clip.end_time, clip.title, clip.caption_style
            transcript = (
                db.query(Transcript).filter(Transcript.video_id == clip.video_id).one_or_none()
            )
            segments = transcript.segments if transcript else []
            clip.status = JobStatus.PROCESSING.value
        models = _owner_models(video)
        text = text_in_range(segments, start, end)
        words = clip_words_relative(segments, start, end)
        updates: dict[str, Any] = {}

        if opts.get("rerank"):
            tracker.set(stage="rank", progress=0.2, message="Re-scoring")
            res, _ = ranking_svc.rank_clip(title=title or "", text=text, duration=end - start,
                                           model=models["ranking"])
            updates.update(ranking_score=res["overall_score"], confidence=res["confidence"],
                           score_breakdown=res)
        if opts.get("regenerate_titles"):
            tracker.set(stage="titles", progress=0.4, message="New titles")
            res, _ = titles_svc.generate_titles(text=text, model=models["default"])
            updates["title_variations"] = res["all"]
        if opts.get("regenerate_description"):
            tracker.set(stage="description", progress=0.6, message="New description")
            res, _ = desc_svc.generate_description(title=title or "", text=text, model=models["default"])
            updates.update(description=res["description"], hashtags=res["hashtags"],
                           keywords=res["keywords"])
        if opts.get("regenerate_broll"):
            tracker.set(stage="broll", progress=0.75, message="New b-roll")
            res, _ = broll_svc.suggest_broll(text=text, model=models["default"])
            updates["broll_suggestions"] = res
        if opts.get("regenerate_captions"):
            tracker.set(stage="captions", progress=0.9, message="New captions")
            tokens = captions_svc.build_tokens(words)
            tokens, _ = captions_svc.apply_emphasis(tokens, model=models["default"])
            updates["captions"] = tokens

        with session_scope() as db:
            clip = db.get(Clip, clip_id)
            for key, value in updates.items():
                setattr(clip, key, value)
            clip.status = JobStatus.COMPLETED.value
        tracker.complete(stage="done", message="Regenerated")
        return {"clip_id": clip_id, "updated": list(updates.keys())}
    except Exception as exc:
        logger.exception("Regeneration failed for clip %s", clip_id)
        with session_scope() as db:
            clip = db.get(Clip, clip_id)
            if clip:
                clip.status = JobStatus.COMPLETED.value
        tracker.fail("regenerate", str(exc))
        raise
