"""Story Vault API — discovery, story library, footage, video pipeline, exports."""
from __future__ import annotations

import asyncio
import os
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_current_user_flexible, get_session
from app.core.config import settings
from app.core.logging import get_logger
from app.models.enums import (
    SV_BACKGROUND_CATEGORIES,
    SV_CATEGORIES,
    SV_DURATIONS,
    SV_HOOK_STYLES,
    SV_NARRATION_STYLES,
    SV_PLATFORMS,
    CaptionStyle,
    JobStatus,
    SvStoryStatus,
    SvVideoStatus,
)
from app.models.publishing import PublishingConnector
from app.models.storyvault import (
    SvBackground,
    SvExport,
    SvProject,
    SvPublishJob,
    SvScript,
    SvSegment,
    SvStory,
    SvTemplate,
    SvVideo,
    SvVoicePreset,
)
from app.models.user import User
from app.schemas.common import Message
from app.schemas.storyvault import (
    SvBackgroundImport,
    SvBackgroundOut,
    SvBackgroundUpdate,
    SvCaptionPreviewOut,
    SvCloneGenerateOut,
    SvCloneGenerateRequest,
    SvCloneModelsOut,
    SvCloneQuantRequest,
    SvCloneStatusOut,
    SvCloneTranscribeOut,
    SvCloneTranscribeRequest,
    SvCloneUploadOut,
    SvDashboardOut,
    SvDiscoveryResult,
    SvDiscoverySearch,
    SvExportOut,
    SvMetaOut,
    SvProjectCreate,
    SvProjectOut,
    SvProjectRunResult,
    SvProjectSettings,
    SvProjectUpdate,
    SvPublishJobOut,
    SvPublishRequest,
    SvScriptOut,
    SvStoryImport,
    SvStoryOut,
    SvStoryUpdate,
    SvTemplateCreate,
    SvTemplateOut,
    SvTemplateUpdate,
    SvVideoApprove,
    SvVideoCreate,
    SvVideoOut,
    SvVideoReject,
    SvVoiceOut,
    SvVoicePresetCreate,
    SvVoicePresetOut,
    SvVoicePresetUpdate,
    SvVoiceSampleOut,
    SvVoiceSampleRequest,
)
from app.services.storage import (
    storage,
    sv_background_key,
    sv_caption_preview_key,
    sv_voice_clone_key,
    sv_voice_ref_key,
    sv_voice_sample_key,
)
from app.services.ffmpeg import ffmpeg
from app.services.storyvault import fish_clone, reddit, scoring
from app.services.storyvault import tts as tts_svc
from app.services.storyvault.templates_data import BUILTIN_TEMPLATES
from app.services.storyvault.voice_presets import ensure_voice_presets
from app.workers.celery_app import celery_app
from app.workers.sv_tasks import (
    sv_caption_previews_task,
    sv_generate_video_task,
    sv_import_background_task,
    sv_ingest_background_task,
    sv_publish_job_task,
    sv_render_video_task,
)

logger = get_logger(__name__)
router = APIRouter()

_ALLOWED_UPLOAD_EXT = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}
_voices_cache: list[dict] | None = None


# ----------------------------------------------------------------- enrichers
def _video_out(video: SvVideo, *, story_title: str | None = None, script_text: str | None = None) -> SvVideoOut:
    out = SvVideoOut.model_validate(video)
    out.preview_url = storage.url(video.preview_path)
    out.render_url = storage.url(video.render_path)
    out.story_title = story_title
    out.script_text = script_text
    return out


def _background_out(bg: SvBackground, segment_count: int = 0) -> SvBackgroundOut:
    out = SvBackgroundOut.model_validate(bg)
    out.thumbnail_url = storage.url(bg.thumbnail_path)
    out.segment_count = segment_count
    return out


async def _owned_story(db: AsyncSession, story_id: int, user: User) -> SvStory:
    story = await db.get(SvStory, story_id)
    if not story or story.owner_id != user.id or story.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Story not found")
    return story


async def _owned_video(db: AsyncSession, video_id: int, user: User) -> SvVideo:
    video = await db.get(SvVideo, video_id)
    if not video or video.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Video not found")
    return video


async def _owned_project(db: AsyncSession, project_id: int, user: User) -> SvProject:
    project = await db.get(SvProject, project_id)
    if not project or project.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


# Story statuses that are still "ready to turn into a video" (not yet used).
_READY_STORY_STATUSES = (
    SvStoryStatus.NEW.value,
    SvStoryStatus.SAVED.value,
    SvStoryStatus.APPROVED.value,
)
_PIPELINE_VIDEO_STATUSES = (
    SvVideoStatus.QUEUED.value,
    SvVideoStatus.PROCESSING.value,
    SvVideoStatus.RENDERING.value,
)


async def _project_out(db: AsyncSession, project: SvProject) -> SvProjectOut:
    """Enrich a project with its pipeline counts (one place to see the flow)."""

    async def _count(stmt) -> int:
        return int((await db.execute(stmt)).scalar() or 0)

    pid = project.id
    stories_q = select(func.count(SvStory.id)).where(
        SvStory.project_id == pid, SvStory.deleted_at.is_(None)
    )
    videos_q = select(func.count(SvVideo.id)).where(SvVideo.project_id == pid)

    out = SvProjectOut.model_validate(project)
    out.settings = SvProjectSettings(**(project.settings or {}))
    out.stories_total = await _count(stories_q)
    out.stories_ready = await _count(stories_q.where(SvStory.status.in_(_READY_STORY_STATUSES)))
    out.videos_total = await _count(videos_q)
    out.videos_in_pipeline = await _count(videos_q.where(SvVideo.status.in_(_PIPELINE_VIDEO_STATUSES)))
    out.videos_in_review = await _count(
        videos_q.where(SvVideo.status == SvVideoStatus.READY_FOR_REVIEW.value)
    )
    out.videos_completed = await _count(videos_q.where(SvVideo.status == SvVideoStatus.COMPLETED.value))
    out.videos_published = await _count(
        select(func.count(func.distinct(SvPublishJob.sv_video_id)))
        .join(SvVideo, SvPublishJob.sv_video_id == SvVideo.id)
        .where(SvVideo.project_id == pid, SvPublishJob.status == "published")
    )
    return out


@dataclass
class ResolvedVoice:
    """A stored voice choice resolved into what the render needs.

    ``voice``/``speed`` drive the default Windows SAPI path. ``voice_config`` is
    set only for a cloned (Fish Speech) voice — it's snapshotted onto the video so
    the worker narrates with the cloned voice instead of SAPI. See
    :attr:`SvVideo.voice_config`.
    """

    voice: str | None
    speed: float
    voice_config: dict | None = None


def _voice_config_for(preset: SvVoicePreset) -> dict | None:
    """The render-time voice_config for a preset, or ``None`` for plain SAPI."""
    if (preset.engine or "sapi") == "sapi":
        return None
    return {
        "engine": preset.engine,
        "ref_key": preset.ref_key,
        "prompt_text": preset.prompt_text or "",
        "name": preset.name,
    }


async def _resolve_voice(
    db: AsyncSession, user: User, voice: str | None, speed: float
) -> ResolvedVoice:
    """Turn a stored voice choice into what the render needs.

    ``None`` → the user's default Voice Lab preset (if any); ``"preset:<id>"`` →
    that saved preset; anything else → a SAPI voice name used verbatim. A cloned
    (Fish Speech) preset additionally carries a ``voice_config`` so the worker
    routes narration to the clone engine rather than SAPI.
    """
    if voice is None:
        default_preset = (
            await db.execute(
                select(SvVoicePreset).where(
                    SvVoicePreset.owner_id == user.id,
                    SvVoicePreset.deleted_at.is_(None),
                    SvVoicePreset.is_default.is_(True),
                )
            )
        ).scalars().first()
        if default_preset:
            return ResolvedVoice(default_preset.voice, speed, _voice_config_for(default_preset))
        return ResolvedVoice(None, speed, None)
    if voice.startswith("preset:"):
        try:
            preset_id = int(voice.split(":", 1)[1])
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid voice preset")
        preset = await db.get(SvVoicePreset, preset_id)
        if not preset or preset.owner_id != user.id or preset.deleted_at is not None:
            raise HTTPException(status_code=404, detail="Voice preset not found")
        return ResolvedVoice(preset.voice, preset.speed, _voice_config_for(preset))
    return ResolvedVoice(voice, speed, None)


# ---------------------------------------------------------------------- meta
@router.get("/meta", response_model=SvMetaOut)
async def get_meta(current_user: User = Depends(get_current_user)) -> SvMetaOut:
    return SvMetaOut(
        hook_styles=SV_HOOK_STYLES,
        narration_styles=SV_NARRATION_STYLES,
        durations=SV_DURATIONS,
        categories=SV_CATEGORIES,
        background_categories=SV_BACKGROUND_CATEGORIES,
        caption_styles=[s.value for s in CaptionStyle],
        platforms=SV_PLATFORMS,
    )


@router.get("/voices", response_model=list[SvVoiceOut])
async def list_voices(current_user: User = Depends(get_current_user)) -> list[SvVoiceOut]:
    global _voices_cache
    if _voices_cache is None:
        _voices_cache = await run_in_threadpool(tts_svc.list_voices)
    return [SvVoiceOut(**v) for v in _voices_cache]


@router.post("/voices/sample", response_model=SvVoiceSampleOut)
async def voice_sample(
    payload: SvVoiceSampleRequest,
    current_user: User = Depends(get_current_user),
) -> SvVoiceSampleOut:
    """Synthesize a short test line so a voice can be auditioned in the browser.

    Samples are cached by (voice, speed, text) hash — repeat auditions are free.
    """
    import hashlib

    text = payload.text.strip() or SvVoiceSampleRequest.model_fields["text"].default
    digest = hashlib.sha256(f"{payload.voice}|{payload.speed:.2f}|{text}".encode()).hexdigest()[:16]
    key = sv_voice_sample_key(digest)

    if not storage.exists(key):
        try:
            result = await run_in_threadpool(
                tts_svc.synthesize,
                text,
                storage.abspath(key),
                voice=payload.voice,
                speed=payload.speed,
            )
            storage.commit(key)
            duration = result.duration
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Synthesis failed: {exc}") from exc
    else:
        try:
            from app.services.ffmpeg import ffmpeg as _ff

            duration = await run_in_threadpool(
                lambda: _ff.probe(storage.abspath(key, ensure_parent=False)).duration
            )
        except Exception:
            duration = 0.0
    return SvVoiceSampleOut(media_url=storage.url(key) or "", duration=duration)


# ------------------------------------------------------------- voice presets
@router.get("/voices/presets", response_model=list[SvVoicePresetOut])
async def list_voice_presets(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[SvVoicePresetOut]:
    # Safety net for users created after startup: the built-ins are seeded for
    # everyone in the app lifespan, but seed lazily here too (idempotent).
    await run_in_threadpool(ensure_voice_presets, current_user.id)
    rows = (
        await db.execute(
            select(SvVoicePreset)
            .where(
                SvVoicePreset.owner_id == current_user.id,
                SvVoicePreset.deleted_at.is_(None),
            )
            .order_by(SvVoicePreset.is_default.desc(), SvVoicePreset.created_at.desc())
        )
    ).scalars().all()
    return [SvVoicePresetOut.model_validate(p) for p in rows]


@router.post("/voices/presets", response_model=SvVoicePresetOut, status_code=201)
async def create_voice_preset(
    payload: SvVoicePresetCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvVoicePresetOut:
    count = int(
        (
            await db.execute(
                select(func.count(SvVoicePreset.id)).where(SvVoicePreset.owner_id == current_user.id)
            )
        ).scalar() or 0
    )
    preset = SvVoicePreset(
        owner_id=current_user.id,
        name=payload.name.strip(),
        voice=payload.voice,
        speed=payload.speed,
        is_default=count == 0,  # first preset becomes the default
    )
    db.add(preset)
    await db.commit()
    await db.refresh(preset)
    return SvVoicePresetOut.model_validate(preset)


async def _owned_preset(db: AsyncSession, preset_id: int, user: User) -> SvVoicePreset:
    preset = await db.get(SvVoicePreset, preset_id)
    if not preset or preset.owner_id != user.id or preset.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Voice preset not found")
    return preset


@router.patch("/voices/presets/{preset_id}", response_model=SvVoicePresetOut)
async def update_voice_preset(
    preset_id: int,
    payload: SvVoicePresetUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvVoicePresetOut:
    preset = await _owned_preset(db, preset_id, current_user)
    if payload.name is not None:
        preset.name = payload.name.strip()
    if payload.voice is not None:
        preset.voice = payload.voice
    if payload.speed is not None:
        preset.speed = payload.speed
    await db.commit()
    await db.refresh(preset)
    return SvVoicePresetOut.model_validate(preset)


@router.post("/voices/presets/{preset_id}/default", response_model=SvVoicePresetOut)
async def set_default_voice_preset(
    preset_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvVoicePresetOut:
    preset = await _owned_preset(db, preset_id, current_user)
    others = (
        await db.execute(select(SvVoicePreset).where(SvVoicePreset.owner_id == current_user.id))
    ).scalars().all()
    for p in others:
        p.is_default = p.id == preset.id
    await db.commit()
    await db.refresh(preset)
    return SvVoicePresetOut.model_validate(preset)


@router.delete("/voices/presets/{preset_id}", response_model=Message)
async def delete_voice_preset(
    preset_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    preset = await _owned_preset(db, preset_id, current_user)
    was_default = preset.is_default
    if preset.builtin:
        # Soft-delete built-ins so re-seeding never resurrects them.
        preset.deleted_at = func.now()
        preset.is_default = False
    else:
        await db.delete(preset)
    # If we removed the default, promote a surviving preset to keep one active.
    if was_default:
        survivor = (
            await db.execute(
                select(SvVoicePreset)
                .where(
                    SvVoicePreset.owner_id == current_user.id,
                    SvVoicePreset.deleted_at.is_(None),
                    SvVoicePreset.id != preset.id,
                )
                .order_by(SvVoicePreset.created_at.desc())
            )
        ).scalars().first()
        if survivor:
            survivor.is_default = True
    await db.commit()
    return Message(detail="Voice preset deleted")


# ----------------------------------------------- voice cloning (Fish Speech S2)
_CLONE_UPLOAD_EXT = {".wav", ".mp3", ".mp4", ".flac", ".m4a", ".ogg"}
_REF_TOKEN_RE = re.compile(r"^[a-f0-9]{8,64}$")


def _ref_key(reference_id: str) -> str:
    """Validate a reference token and resolve it to its storage key.

    The token IS the filename, so reject anything but lowercase hex to keep a
    crafted ``reference_id`` from escaping the refs directory.
    """
    if not _REF_TOKEN_RE.match(reference_id or ""):
        raise HTTPException(status_code=422, detail="Invalid reference_id")
    return sv_voice_ref_key(reference_id)


@router.get("/voices/clone/status", response_model=SvCloneStatusOut)
async def clone_status(current_user: User = Depends(get_current_user)) -> SvCloneStatusOut:
    """Whether the Fish Speech s2.cpp server is up and ready to synthesize."""
    ok = await run_in_threadpool(fish_clone.reachable)
    return SvCloneStatusOut(reachable=ok, url=fish_clone.server_url())


@router.post("/voices/clone/upload", response_model=SvCloneUploadOut, status_code=201)
async def clone_upload(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
) -> SvCloneUploadOut:
    """Store an uploaded reference clip, converting it to a clean mono 24 kHz
    WAV the s2 engine can use as the voice prompt."""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in _CLONE_UPLOAD_EXT:
        raise HTTPException(status_code=422, detail=f"Unsupported audio type {ext!r}")

    token = uuid.uuid4().hex
    raw_key = sv_voice_ref_key(token) + ext  # temp path next to the final WAV
    raw_path = storage.abspath(raw_key)
    try:
        with open(raw_path, "wb") as fh:
            while chunk := await file.read(8 * 1024 * 1024):
                fh.write(chunk)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to store the upload") from exc

    wav_path = storage.abspath(sv_voice_ref_key(token))
    try:
        await run_in_threadpool(
            ffmpeg.run,
            ["-i", raw_path, "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", wav_path],
        )
        storage.commit(sv_voice_ref_key(token))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not decode the audio: {exc}") from exc
    finally:
        try:
            os.remove(raw_path)
        except OSError:
            pass

    return SvCloneUploadOut(reference_id=token, filename=(file.filename or "reference")[:256])


@router.post("/voices/clone/transcribe", response_model=SvCloneTranscribeOut)
async def clone_transcribe(
    payload: SvCloneTranscribeRequest,
    current_user: User = Depends(get_current_user),
) -> SvCloneTranscribeOut:
    """Auto-transcribe a reference clip (faster-whisper) into the transcript box."""
    key = _ref_key(payload.reference_id)
    if not storage.exists(key):
        raise HTTPException(status_code=404, detail="Reference audio not found — upload a clip first")
    from app.services.transcription import transcribe as _transcribe

    try:
        result = await run_in_threadpool(_transcribe, storage.abspath(key, ensure_parent=False))
    except Exception as exc:
        logger.warning("Reference transcription failed: %s", exc)
        return SvCloneTranscribeOut(
            ok=False,
            note="Auto-transcription unavailable — type the words spoken in the sample by hand.",
        )
    text = (result.get("full_text") or "").strip()
    if not text:
        return SvCloneTranscribeOut(ok=False, note="No speech detected — type the transcript by hand.")
    return SvCloneTranscribeOut(ok=True, transcript=text)


@router.post("/voices/clone/generate", response_model=SvCloneGenerateOut)
async def clone_generate(
    payload: SvCloneGenerateRequest,
    current_user: User = Depends(get_current_user),
) -> SvCloneGenerateOut:
    """Synthesize ``text`` in the uploaded reference voice via Fish Speech S2."""
    ref_path: str | None = None
    if payload.reference_id:
        key = _ref_key(payload.reference_id)
        if not storage.exists(key):
            raise HTTPException(status_code=404, detail="Reference audio not found — upload a clip first")
        if not payload.prompt_text.strip():
            raise HTTPException(
                status_code=422,
                detail="Add the transcript of your sample (or click Auto-transcribe) — the engine needs the words spoken in the clip to clone it.",
            )
        ref_path = storage.abspath(key, ensure_parent=False)

    token = uuid.uuid4().hex
    out_key = sv_voice_clone_key(token)
    out_path = storage.abspath(out_key)
    try:
        duration = await run_in_threadpool(
            fish_clone.synthesize,
            payload.text,
            out_path,
            ref_path=ref_path,
            prompt_text=payload.prompt_text,
            temperature=payload.temperature,
        )
        storage.commit(out_key)
    except fish_clone.FishCloneError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail=f"Voice generation failed: {exc}") from exc

    return SvCloneGenerateOut(
        media_url=storage.url(out_key) or "",
        duration=duration,
        bytes=storage.size(out_key) or 0,
    )


def _clone_models_out() -> SvCloneModelsOut:
    return SvCloneModelsOut(
        quants=fish_clone.QUANTS,
        quant=fish_clone.get_quant(),
        default_quant=fish_clone.DEFAULT_QUANT,
        model_dir=fish_clone.model_dir(),
        present=fish_clone.list_present_quants(),
        reachable=fish_clone.reachable(),
        url=fish_clone.server_url(),
    )


@router.get("/voices/clone/models", response_model=SvCloneModelsOut)
async def clone_models(current_user: User = Depends(get_current_user)) -> SvCloneModelsOut:
    """Fish Speech GGUF quants, which are downloaded, and the active selection."""
    return await run_in_threadpool(_clone_models_out)


@router.post("/voices/clone/models", response_model=SvCloneModelsOut)
async def set_clone_quant(
    payload: SvCloneQuantRequest,
    current_user: User = Depends(get_current_user),
) -> SvCloneModelsOut:
    """Set the preferred GGUF quant for voice cloning."""
    try:
        await run_in_threadpool(fish_clone.set_quant, payload.quant)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return await run_in_threadpool(_clone_models_out)


# --------------------------------------------------------- caption previews
@router.get("/presets/caption-previews", response_model=list[SvCaptionPreviewOut])
async def caption_previews(
    current_user: User = Depends(get_current_user),
) -> list[SvCaptionPreviewOut]:
    out: list[SvCaptionPreviewOut] = []
    for style in [s.value for s in CaptionStyle]:
        key = sv_caption_preview_key(style)
        exists = await run_in_threadpool(storage.exists, key)
        out.append(SvCaptionPreviewOut(style=style, media_url=storage.url(key) if exists else None))
    return out


@router.post("/presets/caption-previews/generate", response_model=Message)
async def generate_caption_previews(
    force: bool = Query(default=False),
    current_user: User = Depends(get_current_user),
) -> Message:
    styles = [s.value for s in CaptionStyle]
    sv_caption_previews_task.delay(styles, force)
    return Message(detail="Caption previews are rendering")


# ----------------------------------------------------------- templates (presets)
async def _seed_templates(db: AsyncSession, user: User) -> None:
    """Seed the built-in templates for a user, idempotently by ``template_key``.

    Built-ins already present (including soft-deleted ones) are left untouched,
    so a deleted built-in stays gone and the active default is never reset.
    """
    have = set(
        (
            await db.execute(
                select(SvTemplate.template_key).where(
                    SvTemplate.owner_id == user.id, SvTemplate.template_key.is_not(None)
                )
            )
        ).scalars().all()
    )
    new = False
    for spec in BUILTIN_TEMPLATES:
        if spec["key"] in have:
            continue
        db.add(
            SvTemplate(
                owner_id=user.id,
                template_key=spec["key"],
                name=spec["name"],
                data=spec,
                builtin=True,
                is_default=bool(spec.get("isDefault")),
            )
        )
        new = True
    if new:
        await db.commit()


async def _owned_template(db: AsyncSession, template_id: int, user: User) -> SvTemplate:
    tpl = await db.get(SvTemplate, template_id)
    if not tpl or tpl.owner_id != user.id or tpl.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Template not found")
    return tpl


async def _template_snapshot(
    db: AsyncSession, user: User, template_id: int | None
) -> tuple[dict | None, dict | None]:
    """Freeze a template's render config for a queued video.

    Returns ``(template_config, caption_config)`` snapshotted at queue time so a
    later edit/deletion of the template can't change an in-flight video. The full
    config drives the intro Reddit topic card + author intro overlays; the
    ``captions`` sub-blob keeps matching the burned-in caption preview as before.
    With no ``template_id`` both are ``None`` (the named ``caption_style`` is used
    alone and no intro overlays render) — the studio always sends the default
    template's id, so the default video still gets the full reference look.
    """
    if template_id is None:
        return None, None
    tpl = await _owned_template(db, template_id, user)
    if not isinstance(tpl.data, dict):
        return None, None
    caps = tpl.data.get("captions")
    return tpl.data, (caps if isinstance(caps, dict) else None)


async def _list_templates(db: AsyncSession, user: User) -> list[SvTemplate]:
    return list(
        (
            await db.execute(
                select(SvTemplate)
                .where(SvTemplate.owner_id == user.id, SvTemplate.deleted_at.is_(None))
                .order_by(
                    SvTemplate.is_default.desc(), SvTemplate.builtin.desc(), SvTemplate.name
                )
            )
        ).scalars().all()
    )


@router.get("/templates", response_model=list[SvTemplateOut])
async def list_templates(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[SvTemplateOut]:
    await _seed_templates(db, current_user)
    rows = await _list_templates(db, current_user)
    return [SvTemplateOut.model_validate(t) for t in rows]


@router.post("/templates", response_model=SvTemplateOut, status_code=201)
async def create_template(
    payload: SvTemplateCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvTemplateOut:
    await _seed_templates(db, current_user)
    # Clone the default template's config when no base blob is supplied.
    base = payload.data
    if base is None:
        default = (
            await db.execute(
                select(SvTemplate).where(
                    SvTemplate.owner_id == current_user.id,
                    SvTemplate.is_default.is_(True),
                    SvTemplate.deleted_at.is_(None),
                )
            )
        ).scalars().first()
        base = dict(default.data) if default else dict(BUILTIN_TEMPLATES[0])
    data = {**base, "name": payload.name.strip()}
    data.pop("key", None)
    tpl = SvTemplate(
        owner_id=current_user.id,
        name=payload.name.strip(),
        data=data,
        builtin=False,
        is_default=False,
    )
    db.add(tpl)
    await db.commit()
    await db.refresh(tpl)
    return SvTemplateOut.model_validate(tpl)


@router.patch("/templates/{template_id}", response_model=SvTemplateOut)
async def update_template(
    template_id: int,
    payload: SvTemplateUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvTemplateOut:
    tpl = await _owned_template(db, template_id, current_user)
    if payload.name is not None:
        tpl.name = payload.name.strip()
    if payload.data is not None:
        merged = {**tpl.data, **payload.data}
        if payload.name is not None:
            merged["name"] = payload.name.strip()
        tpl.data = merged
    await db.commit()
    await db.refresh(tpl)
    return SvTemplateOut.model_validate(tpl)


@router.post("/templates/{template_id}/default", response_model=SvTemplateOut)
async def set_default_template(
    template_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvTemplateOut:
    tpl = await _owned_template(db, template_id, current_user)
    others = (
        await db.execute(select(SvTemplate).where(SvTemplate.owner_id == current_user.id))
    ).scalars().all()
    for t in others:
        t.is_default = t.id == tpl.id
    await db.commit()
    await db.refresh(tpl)
    return SvTemplateOut.model_validate(tpl)


@router.post("/templates/{template_id}/duplicate", response_model=SvTemplateOut, status_code=201)
async def duplicate_template(
    template_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvTemplateOut:
    src = await _owned_template(db, template_id, current_user)
    name = f"{src.name} copy"
    data = {**src.data, "name": name}
    data.pop("key", None)
    tpl = SvTemplate(
        owner_id=current_user.id,
        name=name,
        data=data,
        builtin=False,
        is_default=False,
    )
    db.add(tpl)
    await db.commit()
    await db.refresh(tpl)
    return SvTemplateOut.model_validate(tpl)


@router.delete("/templates/{template_id}", response_model=Message)
async def delete_template(
    template_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    tpl = await _owned_template(db, template_id, current_user)
    # Soft-delete (built-ins stay gone — re-seeding skips existing keys). If the
    # default is removed, promote another surviving template to keep one active.
    tpl.deleted_at = datetime.now(timezone.utc)
    was_default = tpl.is_default
    tpl.is_default = False
    if was_default:
        survivor = (
            await db.execute(
                select(SvTemplate)
                .where(
                    SvTemplate.owner_id == current_user.id,
                    SvTemplate.deleted_at.is_(None),
                    SvTemplate.id != tpl.id,
                )
                .order_by(SvTemplate.builtin.desc(), SvTemplate.name)
            )
        ).scalars().first()
        if survivor:
            survivor.is_default = True
    await db.commit()
    return Message(detail="Template deleted")


# ------------------------------------------------------------------ projects
def _story_key(title: str) -> str:
    """Normalised content key for duplicate detection.

    Lower-cased, apostrophes dropped (so "sister's" == "sisters"), other
    punctuation collapsed to spaces — so a Reddit cross-post, a re-paste, or the
    same post collected twice all reduce to the same key. Drives a project's
    ``no_duplicates`` guard.
    """
    text = (title or "").lower().replace("'", "").replace("’", "")
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


async def _validate_project_settings(
    db: AsyncSession, user: User, s: SvProjectSettings
) -> None:
    """Reject settings that point at footage or channels the user doesn't own."""
    if s.background_id is not None:
        bg = await db.get(SvBackground, s.background_id)
        if not bg or bg.owner_id != user.id:
            raise HTTPException(status_code=404, detail="Footage not found")
    if s.template_id is not None:
        tpl = await db.get(SvTemplate, s.template_id)
        if not tpl or tpl.owner_id != user.id or tpl.deleted_at is not None:
            raise HTTPException(status_code=404, detail="Preset not found")
    if s.publish_connector_ids:
        owned = set(
            (
                await db.execute(
                    select(PublishingConnector.id).where(
                        PublishingConnector.id.in_(s.publish_connector_ids),
                        PublishingConnector.owner_id == user.id,
                    )
                )
            ).scalars()
        )
        missing = [c for c in s.publish_connector_ids if c not in owned]
        if missing:
            raise HTTPException(status_code=404, detail="One or more publish channels were not found")


async def _collect_reddit_into_project(
    db: AsyncSession, user: User, project: SvProject, s: SvProjectSettings
) -> int:
    """Fetch fresh stories from the project's communities and file them under it.

    Mirrors ``/discovery/search`` but tags every new story with ``project_id`` so
    a one-click run pulls straight into the right folder. Failures are swallowed
    (best-effort) so a flaky source never blocks the rest of the run.
    """
    fetched: list[dict] = []
    # Scan deeper when the project wants long stories — they're a small fraction
    # of any feed, so a shallow scan would rarely surface a 20–30 minute story.
    scan_limit = 100 if s.min_length >= 8000 else 25
    for i, community in enumerate(s.communities):
        if i:
            await asyncio.sleep(1.0)  # space out requests to dodge Reddit's rate limiter
        try:
            fetched.extend(
                await reddit.fetch_community(
                    community,
                    sort=s.discovery_sort,
                    time_window=s.discovery_time_window,
                    limit=scan_limit,
                    min_upvotes=s.min_upvotes,
                    min_length=s.min_length,
                )
            )
        except Exception as exc:  # noqa: BLE001 — one bad source shouldn't abort the run
            logger.warning("Project %s discovery failed for %s: %s", project.id, community, exc)

    existing_ids = set(
        (
            await db.execute(
                select(SvStory.external_id).where(
                    SvStory.owner_id == user.id, SvStory.external_id.isnot(None)
                )
            )
        ).scalars()
    )
    # With no-duplicates on, also reject cross-posts/re-pastes whose title matches
    # a story already in the vault — not just exact external-id repeats.
    existing_keys: set[str] = set()
    if s.no_duplicates:
        existing_keys = {
            _story_key(t)
            for t in (
                await db.execute(select(SvStory.title).where(SvStory.owner_id == user.id))
            ).scalars()
        }

    added = 0
    for item in fetched:
        if item["external_id"] in existing_ids:
            continue
        if s.no_duplicates:
            key = _story_key(item["title"])
            if key in existing_keys:
                continue
            existing_keys.add(key)
        existing_ids.add(item["external_id"])
        scored = scoring.score_story(
            item["title"], item["body"], item["upvotes"], item["num_comments"]
        )
        db.add(
            SvStory(
                owner_id=user.id,
                project_id=project.id,
                source=item["source"],
                source_url=item["source_url"],
                external_id=item["external_id"],
                community=item["community"],
                author=item.get("author"),
                title=item["title"],
                body=item["body"],
                category=scoring.guess_category(item["title"], item["body"], item["community"]),
                upvotes=item["upvotes"],
                num_comments=item["num_comments"],
                score=scored["overall"],
                score_breakdown=scored["breakdown"],
            )
        )
        added += 1
    if added:
        await db.commit()
    return added


async def _select_unique_stories(
    db: AsyncSession, user: User, base_q, limit: int
) -> list[SvStory]:
    """Pick up to ``limit`` ready stories whose content hasn't already become a
    video — the project's ``no_duplicates`` guard.

    A candidate is skipped when its normalised title matches one already turned
    into a video (any project of this user) or another story chosen in this same
    batch, so cross-posts and re-pastes never yield a second identical video.
    Normalisation isn't portable across SQLite/Postgres in SQL, so the de-dupe
    runs in Python over a widened candidate pool.
    """
    used_keys = {
        _story_key(t)
        for t in (
            await db.execute(
                select(SvStory.title)
                .join(SvVideo, SvVideo.story_id == SvStory.id)
                .where(SvStory.owner_id == user.id)
            )
        ).scalars()
    }
    pool = (await db.execute(base_q.limit(max(limit * 5, 25)))).scalars().all()
    chosen: list[SvStory] = []
    seen = set(used_keys)
    for story in pool:
        key = _story_key(story.title)
        if key in seen:
            continue
        seen.add(key)
        chosen.append(story)
        if len(chosen) >= limit:
            break
    return chosen


@router.get("/projects", response_model=list[SvProjectOut])
async def list_projects(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[SvProjectOut]:
    rows = (
        await db.execute(
            select(SvProject)
            .where(SvProject.owner_id == current_user.id)
            .order_by(SvProject.updated_at.desc())
        )
    ).scalars().all()
    return [await _project_out(db, p) for p in rows]


@router.post("/projects", response_model=SvProjectOut, status_code=201)
async def create_project(
    payload: SvProjectCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvProjectOut:
    await _validate_project_settings(db, current_user, payload.settings)
    project = SvProject(
        owner_id=current_user.id,
        name=payload.name.strip()[:255],
        description=(payload.description or None),
        settings=payload.settings.model_dump(),
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return await _project_out(db, project)


@router.get("/projects/{project_id}", response_model=SvProjectOut)
async def get_project(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvProjectOut:
    project = await _owned_project(db, project_id, current_user)
    return await _project_out(db, project)


@router.patch("/projects/{project_id}", response_model=SvProjectOut)
async def update_project(
    project_id: int,
    payload: SvProjectUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvProjectOut:
    project = await _owned_project(db, project_id, current_user)
    if payload.name is not None:
        project.name = payload.name.strip()[:255]
    if payload.description is not None:
        project.description = payload.description or None
    if payload.settings is not None:
        await _validate_project_settings(db, current_user, payload.settings)
        project.settings = payload.settings.model_dump()
    await db.commit()
    await db.refresh(project)
    return await _project_out(db, project)


@router.delete("/projects/{project_id}", response_model=Message)
async def delete_project(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    project = await _owned_project(db, project_id, current_user)
    # Don't delete the work — just unfile it (SQLite has no FK cascade here).
    await db.execute(
        SvStory.__table__.update().where(SvStory.project_id == project.id).values(project_id=None)
    )
    await db.execute(
        SvVideo.__table__.update().where(SvVideo.project_id == project.id).values(project_id=None)
    )
    await db.delete(project)
    await db.commit()
    return Message(detail="Project deleted")


@router.post("/projects/{project_id}/run", response_model=SvProjectRunResult)
async def run_project(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvProjectRunResult:
    """One click: collect fresh stories, then queue videos for the best ones.

    Each queued video runs the full pipeline (script → narration → captions →
    footage → preview). When the project has ``auto_publish`` on, the worker
    also renders the final cut and queues it to the saved channels — so a single
    click carries a story all the way to "ready to publish".
    """
    project = await _owned_project(db, project_id, current_user)
    s = SvProjectSettings(**(project.settings or {}))

    stories_added = 0
    if s.story_source == "reddit" and s.communities:
        stories_added = await _collect_reddit_into_project(db, current_user, project, s)

    # Best ready stories in this folder that don't have a video yet.
    used_subq = select(SvVideo.story_id).where(SvVideo.project_id == project.id)
    base_q = (
        select(SvStory)
        .where(
            SvStory.owner_id == current_user.id,
            SvStory.project_id == project.id,
            SvStory.deleted_at.is_(None),
            SvStory.status.in_(_READY_STORY_STATUSES),
            SvStory.id.notin_(used_subq),
        )
        .order_by(SvStory.score.desc())
    )
    if s.no_duplicates:
        # Skip any story whose content already became a video (any project).
        stories = await _select_unique_stories(db, current_user, base_q, s.videos_per_run)
    else:
        stories = (await db.execute(base_q.limit(s.videos_per_run))).scalars().all()

    rv = await _resolve_voice(db, current_user, s.voice, s.speed)
    template_config, caption_config = await _template_snapshot(db, current_user, s.template_id)
    queued: list[SvVideo] = []
    for story in stories:
        video = SvVideo(
            owner_id=current_user.id,
            story_id=story.id,
            project_id=project.id,
            title=story.title[:512],
            duration_target=s.duration_target,
            hook_style=s.hook_style,
            narration_style=s.narration_style,
            drama_level=s.drama_level,
            voice=rv.voice,
            speed=rv.speed,
            voice_config=rv.voice_config,
            caption_style=s.caption_style,
            caption_config=caption_config,
            template_config=template_config,
            background_category=s.background_category,
            background_id=s.background_id,
            script_engine=s.script_engine,
            status=SvVideoStatus.QUEUED.value,
        )
        db.add(video)
        queued.append(video)
    await db.commit()
    for video in queued:
        await db.refresh(video)
        task = sv_generate_video_task.delay(video.id)
        video.celery_task_id = task.id
    if queued:
        await db.commit()

    n = len(queued)
    if stories_added == 0 and n == 0:
        detail = (
            "No new stories to turn into videos. Add stories to this project, "
            "or set a story source and upvote thresholds it can reach."
        )
    else:
        bits = []
        if stories_added:
            bits.append(f"collected {stories_added} new {'story' if stories_added == 1 else 'stories'}")
        if n:
            bits.append(f"queued {n} {'video' if n == 1 else 'videos'}")
        detail = "Run started — " + " and ".join(bits) + "."
        if s.auto_publish and n:
            detail += " They'll render and queue for publishing automatically."
    return SvProjectRunResult(stories_added=stories_added, videos_queued=n, detail=detail)


@router.get("/dashboard", response_model=SvDashboardOut)
async def dashboard(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvDashboardOut:
    async def _count(stmt) -> int:
        return int((await db.execute(stmt)).scalar() or 0)

    uid = current_user.id
    stories_q = select(func.count(SvStory.id)).where(SvStory.owner_id == uid, SvStory.deleted_at.is_(None))
    in_pipeline = [SvVideoStatus.QUEUED.value, SvVideoStatus.PROCESSING.value, SvVideoStatus.RENDERING.value]

    recent = (
        await db.execute(
            select(SvVideo, SvStory.title)
            .join(SvStory, SvVideo.story_id == SvStory.id)
            .where(SvVideo.owner_id == uid)
            .order_by(SvVideo.updated_at.desc())
            .limit(8)
        )
    ).all()

    return SvDashboardOut(
        stories_total=await _count(stories_q),
        stories_new=await _count(stories_q.where(SvStory.status == SvStoryStatus.NEW.value)),
        stories_approved=await _count(stories_q.where(SvStory.status == SvStoryStatus.APPROVED.value)),
        backgrounds_ready=await _count(
            select(func.count(SvBackground.id)).where(
                SvBackground.owner_id == uid, SvBackground.status == JobStatus.COMPLETED.value
            )
        ),
        segments_total=await _count(
            select(func.count(SvSegment.id))
            .join(SvBackground, SvSegment.background_id == SvBackground.id)
            .where(SvBackground.owner_id == uid)
        ),
        videos_in_pipeline=await _count(
            select(func.count(SvVideo.id)).where(SvVideo.owner_id == uid, SvVideo.status.in_(in_pipeline))
        ),
        videos_in_review=await _count(
            select(func.count(SvVideo.id)).where(
                SvVideo.owner_id == uid, SvVideo.status == SvVideoStatus.READY_FOR_REVIEW.value
            )
        ),
        exports_total=await _count(
            select(func.count(SvExport.id)).where(SvExport.owner_id == uid, SvExport.deleted_at.is_(None))
        ),
        recent_videos=[_video_out(v, story_title=t) for v, t in recent],
    )


# ----------------------------------------------------------------- discovery
def _is_rate_limited(exc: Exception) -> bool:
    """True when a discovery failure is Reddit's HTTP 429 throttle."""
    resp = getattr(exc, "response", None)
    if resp is not None and getattr(resp, "status_code", None) == 429:
        return True
    return "429" in str(exc)


@router.post("/discovery/search", response_model=SvDiscoveryResult)
async def discovery_search(
    payload: SvDiscoverySearch,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvDiscoveryResult:
    fetched: list[dict] = []
    errors: list[str] = []
    throttled = False
    for i, community in enumerate(payload.communities):
        # Space out requests a little; Reddit throttles rapid unauthenticated reads.
        if i:
            await asyncio.sleep(2.0)
        try:
            fetched.extend(
                await reddit.fetch_community(
                    community,
                    sort=payload.sort,
                    time_window=payload.time_window,
                    limit=payload.limit,
                    min_upvotes=payload.min_upvotes,
                    min_length=payload.min_length,
                )
            )
        except Exception as exc:
            logger.warning("Discovery failed for %s: %s", community, exc)
            if _is_rate_limited(exc):
                # Reddit allows only ~one feed pull per ~30s per IP, with a long
                # cooldown. Hammering the remaining subreddits would just fail too,
                # so stop here and keep whatever earlier subreddits returned.
                errors.append(f"{community}: rate-limited by Reddit")
                throttled = True
                break
            errors.append(f"{community}: {exc}")

    note: str | None = None
    if throttled:
        note = (
            "Reddit rate-limited the request — it allows only about one subreddit "
            "pull every ~30 seconds. For long stories, pull one subreddit at a time "
            "and wait ~30s between them."
        )
    if not fetched and errors:
        raise HTTPException(status_code=502, detail=note or "; ".join(errors)[:500])

    existing_ids = set(
        (
            await db.execute(
                select(SvStory.external_id).where(
                    SvStory.owner_id == current_user.id, SvStory.external_id.isnot(None)
                )
            )
        ).scalars()
    )

    added: list[SvStory] = []
    duplicates = 0
    for item in fetched:
        if item["external_id"] in existing_ids:
            duplicates += 1
            continue
        existing_ids.add(item["external_id"])
        scored = scoring.score_story(item["title"], item["body"], item["upvotes"], item["num_comments"])
        story = SvStory(
            owner_id=current_user.id,
            source=item["source"],
            source_url=item["source_url"],
            external_id=item["external_id"],
            community=item["community"],
            author=item.get("author"),
            title=item["title"],
            body=item["body"],
            category=scoring.guess_category(item["title"], item["body"], item["community"]),
            upvotes=item["upvotes"],
            num_comments=item["num_comments"],
            score=scored["overall"],
            score_breakdown=scored["breakdown"],
        )
        db.add(story)
        added.append(story)
    await db.commit()
    for story in added:
        await db.refresh(story)

    return SvDiscoveryResult(
        fetched=len(fetched),
        added=len(added),
        duplicates=duplicates,
        stories=[SvStoryOut.model_validate(s) for s in added],
        note=note,
    )


@router.post("/stories/import", response_model=SvStoryOut, status_code=201)
async def import_story(
    payload: SvStoryImport,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvStoryOut:
    scored = scoring.score_story(payload.title, payload.body)
    story = SvStory(
        owner_id=current_user.id,
        source="paste",
        source_url=payload.source_url,
        title=payload.title.strip()[:512],
        body=payload.body.strip(),
        category=payload.category or scoring.guess_category(payload.title, payload.body),
        score=scored["overall"],
        score_breakdown=scored["breakdown"],
    )
    db.add(story)
    await db.commit()
    await db.refresh(story)
    return SvStoryOut.model_validate(story)


# ------------------------------------------------------------------- stories
@router.get("/stories", response_model=list[SvStoryOut])
async def list_stories(
    status: str | None = Query(default=None),
    category: str | None = Query(default=None),
    q: str | None = Query(default=None),
    sort: str = Query(default="score"),  # score|newest|upvotes
    project_id: int | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[SvStoryOut]:
    stmt = select(SvStory).where(SvStory.owner_id == current_user.id, SvStory.deleted_at.is_(None))
    if status:
        stmt = stmt.where(SvStory.status == status)
    if project_id is not None:
        stmt = stmt.where(SvStory.project_id == project_id)
    if category:
        stmt = stmt.where(SvStory.category == category)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(SvStory.title.ilike(like) | SvStory.body.ilike(like))
    order = {
        "score": SvStory.score.desc(),
        "newest": SvStory.created_at.desc(),
        "upvotes": SvStory.upvotes.desc(),
        # Longest body first — surfaces stories with enough material for the
        # long (10/20/30-minute) videos.
        "longest": func.length(SvStory.body).desc(),
    }.get(sort, SvStory.score.desc())
    rows = (await db.execute(stmt.order_by(order).limit(limit))).scalars().all()
    return [SvStoryOut.model_validate(s) for s in rows]


@router.get("/stories/{story_id}", response_model=SvStoryOut)
async def get_story(
    story_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvStoryOut:
    return SvStoryOut.model_validate(await _owned_story(db, story_id, current_user))


@router.patch("/stories/{story_id}", response_model=SvStoryOut)
async def update_story(
    story_id: int,
    payload: SvStoryUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvStoryOut:
    story = await _owned_story(db, story_id, current_user)
    if payload.status is not None:
        if payload.status not in {s.value for s in SvStoryStatus}:
            raise HTTPException(status_code=422, detail=f"Unknown status {payload.status!r}")
        story.status = payload.status
    if payload.category is not None:
        story.category = payload.category
    await db.commit()
    await db.refresh(story)
    return SvStoryOut.model_validate(story)


@router.delete("/stories/{story_id}", response_model=Message)
async def delete_story(
    story_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    story = await _owned_story(db, story_id, current_user)
    story.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return Message(detail="Story deleted")


@router.get("/stories/{story_id}/scripts", response_model=list[SvScriptOut])
async def list_scripts(
    story_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[SvScriptOut]:
    await _owned_story(db, story_id, current_user)
    rows = (
        await db.execute(
            select(SvScript).where(SvScript.story_id == story_id).order_by(SvScript.created_at.desc())
        )
    ).scalars().all()
    return [SvScriptOut.model_validate(s) for s in rows]


# --------------------------------------------------------------- backgrounds
@router.post("/backgrounds/upload", response_model=SvBackgroundOut, status_code=201)
async def upload_background(
    file: UploadFile = File(...),
    category: str | None = Form(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvBackgroundOut:
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in _ALLOWED_UPLOAD_EXT:
        raise HTTPException(status_code=422, detail=f"Unsupported file type {ext!r}")

    bg = SvBackground(
        owner_id=current_user.id,
        original_filename=(file.filename or "upload")[:512],
        category=category,
        status=JobStatus.PENDING.value,
    )
    db.add(bg)
    await db.commit()
    await db.refresh(bg)

    key = sv_background_key(bg.id, ext)
    dest = storage.abspath(key)
    try:
        with open(dest, "wb") as fh:
            while chunk := await file.read(8 * 1024 * 1024):
                fh.write(chunk)
        storage.commit(key)
    except Exception:
        await db.delete(bg)
        await db.commit()
        raise HTTPException(status_code=500, detail="Failed to store the upload")

    bg.storage_path = key
    bg.status = JobStatus.QUEUED.value
    await db.commit()
    await db.refresh(bg)
    sv_ingest_background_task.delay(bg.id)
    return _background_out(bg)


@router.post("/backgrounds/import", response_model=SvBackgroundOut, status_code=201)
async def import_background(
    payload: SvBackgroundImport,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvBackgroundOut:
    url = payload.url.strip()
    if not url:
        raise HTTPException(status_code=422, detail="A video URL is required")

    bg = SvBackground(
        owner_id=current_user.id,
        original_filename=url[:512],
        category=payload.category,
        status=JobStatus.QUEUED.value,
    )
    db.add(bg)
    await db.commit()
    await db.refresh(bg)
    sv_import_background_task.delay(bg.id, url)
    return _background_out(bg)


@router.get("/backgrounds", response_model=list[SvBackgroundOut])
async def list_backgrounds(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[SvBackgroundOut]:
    rows = (
        await db.execute(
            select(SvBackground, func.count(SvSegment.id))
            .outerjoin(SvSegment, SvSegment.background_id == SvBackground.id)
            .where(SvBackground.owner_id == current_user.id)
            .group_by(SvBackground.id)
            .order_by(SvBackground.created_at.desc())
        )
    ).all()
    return [_background_out(bg, count) for bg, count in rows]


@router.patch("/backgrounds/{background_id}", response_model=SvBackgroundOut)
async def update_background(
    background_id: int,
    payload: SvBackgroundUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvBackgroundOut:
    bg = await db.get(SvBackground, background_id)
    if not bg or bg.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Background not found")
    if payload.category is not None:
        bg.category = payload.category
    await db.commit()
    await db.refresh(bg)
    count = int(
        (
            await db.execute(
                select(func.count(SvSegment.id)).where(SvSegment.background_id == bg.id)
            )
        ).scalar() or 0
    )
    return _background_out(bg, count)


@router.delete("/backgrounds/{background_id}", response_model=Message)
async def delete_background(
    background_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    bg = await db.get(SvBackground, background_id)
    if not bg or bg.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Background not found")
    await db.delete(bg)
    await db.commit()
    storage.delete(f"storyvault/backgrounds/{background_id}")
    return Message(detail="Background deleted")


# -------------------------------------------------------------------- videos
@router.post("/videos", response_model=SvVideoOut, status_code=201)
async def create_video(
    payload: SvVideoCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvVideoOut:
    story = await _owned_story(db, payload.story_id, current_user)
    # Optional pinned footage must belong to the caller.
    if payload.background_id is not None:
        bg = await db.get(SvBackground, payload.background_id)
        if not bg or bg.owner_id != current_user.id:
            raise HTTPException(status_code=404, detail="Footage not found")
    # Optional project folder must belong to the caller.
    if payload.project_id is not None:
        await _owned_project(db, payload.project_id, current_user)
    # Voice resolution:
    #   "Auto" (None)        → the user's default Voice Lab preset, if one exists
    #   "preset:<id>"        → that saved preset, picked explicitly in the studio
    #   any other string     → a SAPI system voice name, used verbatim
    # A cloned (Fish Speech) preset also yields a voice_config so the worker
    # narrates with the clone engine instead of SAPI.
    rv = await _resolve_voice(db, current_user, payload.voice, payload.speed)
    # Snapshot the selected template's full render config (frozen at queue time
    # against later edits): the caption sub-blob keeps the burned-in captions
    # matching the preview, and the topicCard/authorIntro drive the intro
    # overlays. With no template selected we fall back to the user's default.
    template_config, caption_config = await _template_snapshot(db, current_user, payload.template_id)
    video = SvVideo(
        owner_id=current_user.id,
        story_id=story.id,
        project_id=payload.project_id,
        title=story.title[:512],
        duration_target=payload.duration_target,
        hook_style=payload.hook_style,
        narration_style=payload.narration_style,
        drama_level=payload.drama_level,
        voice=rv.voice,
        speed=rv.speed,
        voice_config=rv.voice_config,
        caption_style=payload.caption_style,
        caption_config=caption_config,
        template_config=template_config,
        background_category=payload.background_category,
        background_id=payload.background_id,
        script_engine=payload.script_engine,
        status=SvVideoStatus.QUEUED.value,
    )
    db.add(video)
    await db.commit()
    await db.refresh(video)

    task = sv_generate_video_task.delay(video.id)
    video.celery_task_id = task.id
    await db.commit()
    await db.refresh(video)
    return _video_out(video, story_title=story.title)


@router.get("/videos", response_model=list[SvVideoOut])
async def list_videos(
    status: str | None = Query(default=None),
    project_id: int | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[SvVideoOut]:
    stmt = (
        select(SvVideo, SvStory.title)
        .join(SvStory, SvVideo.story_id == SvStory.id)
        .where(SvVideo.owner_id == current_user.id)
    )
    if status:
        stmt = stmt.where(SvVideo.status == status)
    if project_id is not None:
        stmt = stmt.where(SvVideo.project_id == project_id)
    rows = (await db.execute(stmt.order_by(SvVideo.updated_at.desc()).limit(limit))).all()
    return [_video_out(v, story_title=t) for v, t in rows]


@router.get("/videos/{video_id}", response_model=SvVideoOut)
async def get_video(
    video_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvVideoOut:
    video = await _owned_video(db, video_id, current_user)
    story = await db.get(SvStory, video.story_id)
    script = await db.get(SvScript, video.script_id) if video.script_id else None
    return _video_out(
        video,
        story_title=story.title if story else None,
        script_text=script.full_text if script else None,
    )


@router.post("/videos/{video_id}/approve", response_model=SvVideoOut)
async def approve_video(
    video_id: int,
    payload: SvVideoApprove,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvVideoOut:
    video = await _owned_video(db, video_id, current_user)
    if video.status != SvVideoStatus.READY_FOR_REVIEW.value:
        raise HTTPException(status_code=409, detail=f"Video is {video.status}, not ready for review")
    if payload.platform not in SV_PLATFORMS:
        raise HTTPException(status_code=422, detail=f"Unknown platform {payload.platform!r}")
    video.status = SvVideoStatus.APPROVED.value
    video.reject_reason = None
    video.cancel_requested = False  # clear any stale stop flag before re-dispatch
    await db.commit()
    task = sv_render_video_task.delay(video.id, payload.platform)
    video.celery_task_id = task.id
    await db.commit()
    await db.refresh(video)
    return _video_out(video)


@router.post("/videos/{video_id}/reject", response_model=SvVideoOut)
async def reject_video(
    video_id: int,
    payload: SvVideoReject,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvVideoOut:
    video = await _owned_video(db, video_id, current_user)
    video.status = SvVideoStatus.REJECTED.value
    video.reject_reason = (payload.reason or "").strip() or None
    video.cancel_requested = False  # terminal state — drop any stale stop flag
    await db.commit()
    await db.refresh(video)
    return _video_out(video)


@router.post("/videos/{video_id}/retry", response_model=SvVideoOut)
async def retry_video(
    video_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvVideoOut:
    """Re-run the generation pipeline (failed or rejected videos)."""
    video = await _owned_video(db, video_id, current_user)
    if video.status in (SvVideoStatus.PROCESSING.value, SvVideoStatus.RENDERING.value):
        raise HTTPException(status_code=409, detail="Video is already processing")
    video.status = SvVideoStatus.QUEUED.value
    video.error = None
    video.reject_reason = None
    video.progress = 0.0
    video.stage = None
    video.script_id = None  # regenerate the script too
    video.cancel_requested = False  # clear any stale stop flag before re-dispatch
    await db.commit()
    task = sv_generate_video_task.delay(video.id)
    video.celery_task_id = task.id
    await db.commit()
    await db.refresh(video)
    return _video_out(video)


# Statuses for which a stop makes sense — the job is still in flight.
_CANCELLABLE_STATUSES = (
    SvVideoStatus.QUEUED.value,
    SvVideoStatus.PROCESSING.value,
    SvVideoStatus.RENDERING.value,
)


def _request_video_cancel(video: SvVideo) -> None:
    """Raise the cooperative-cancel flag and best-effort stop the Celery task.

    A running job (processing/rendering) self-aborts at its next checkpoint and
    the worker parks it in CANCELLED. A still-queued job may never reach a worker
    once revoked, so we mark it CANCELLED right here; the flag still guards the
    race where a worker had already picked it up.
    """
    video.cancel_requested = True
    if video.celery_task_id:
        # Best-effort: ask the worker to drop/terminate the task now (default
        # signal — SIGKILL isn't portable to the Windows worker). If acks_late
        # redelivers a terminated task, the cancel flag makes it self-abort at the
        # first checkpoint, so this never re-runs the whole pipeline.
        try:
            celery_app.control.revoke(video.celery_task_id, terminate=True)
        except Exception:  # noqa: BLE001 — best-effort; the flag is the source of truth
            logger.warning("Failed to revoke task %s for video %s", video.celery_task_id, video.id)
    if video.status == SvVideoStatus.QUEUED.value:
        video.status = SvVideoStatus.CANCELLED.value
        video.stage = "cancelled"
        video.progress = 0.0
    else:
        video.stage = "cancelling"


@router.post("/videos/{video_id}/cancel", response_model=SvVideoOut)
async def cancel_video(
    video_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvVideoOut:
    """Stop a queued or in-flight video. The worker discards the partial render
    and the video lands in CANCELLED (dropping out of the studio pipeline)."""
    video = await _owned_video(db, video_id, current_user)
    if video.status not in _CANCELLABLE_STATUSES:
        raise HTTPException(status_code=409, detail=f"Video is {video.status}, not running")
    _request_video_cancel(video)
    await db.commit()
    await db.refresh(video)
    return _video_out(video)


@router.post("/videos/clear-queue", response_model=Message)
async def clear_video_queue(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    """Empty the studio pipeline: stop every queued/in-flight video and delete the
    finished-but-listed (failed / cancelled) rows."""
    removable = (SvVideoStatus.FAILED.value, SvVideoStatus.CANCELLED.value)
    stmt = select(SvVideo).where(
        SvVideo.owner_id == current_user.id,
        SvVideo.status.in_((*_CANCELLABLE_STATUSES, *removable)),
    )
    videos = (await db.execute(stmt)).scalars().all()
    cancelled = 0
    deleted_ids: list[int] = []
    for video in videos:
        if video.status in removable:
            deleted_ids.append(video.id)
            await db.delete(video)
        else:
            _request_video_cancel(video)
            cancelled += 1
    await db.commit()
    for vid in deleted_ids:
        storage.delete(f"storyvault/videos/{vid}")
    total = cancelled + len(deleted_ids)
    return Message(detail=f"Cleared {total} video{'' if total == 1 else 's'} from the queue")


@router.delete("/videos/{video_id}", response_model=Message)
async def delete_video(
    video_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    video = await _owned_video(db, video_id, current_user)
    if video.status in (SvVideoStatus.PROCESSING.value, SvVideoStatus.RENDERING.value):
        raise HTTPException(status_code=409, detail="Video is processing — wait for it to finish")
    await db.delete(video)
    await db.commit()
    storage.delete(f"storyvault/videos/{video_id}")
    return Message(detail="Video deleted")


# ---------------------------------------------------------------- publishing
@router.post("/videos/{video_id}/publish", response_model=list[SvPublishJobOut], status_code=201)
async def publish_video(
    video_id: int,
    payload: SvPublishRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[SvPublishJobOut]:
    """Queue an upload of this video to each selected channel.

    The final 1080×1920 render happens automatically if it hasn't yet.
    """
    video = await _owned_video(db, video_id, current_user)
    publishable = {
        SvVideoStatus.READY_FOR_REVIEW.value,
        SvVideoStatus.APPROVED.value,
        SvVideoStatus.COMPLETED.value,
    }
    if video.status not in publishable:
        raise HTTPException(status_code=409, detail=f"Video is {video.status} — wait for the preview to finish")
    if payload.privacy not in ("public", "unlisted", "private"):
        raise HTTPException(status_code=422, detail=f"Unknown privacy {payload.privacy!r}")

    connectors = (
        await db.execute(
            select(PublishingConnector).where(
                PublishingConnector.id.in_(payload.connector_ids),
                PublishingConnector.owner_id == current_user.id,
            )
        )
    ).scalars().all()
    if len(connectors) != len(set(payload.connector_ids)):
        raise HTTPException(status_code=404, detail="One or more selected channels were not found")

    # Publishing implies approval — the review step is the publish click itself.
    if video.status == SvVideoStatus.READY_FOR_REVIEW.value:
        video.status = SvVideoStatus.APPROVED.value

    title = (payload.title or video.title or "Story video").strip()[:100]
    jobs: list[SvPublishJob] = []
    for connector in connectors:
        job = SvPublishJob(
            owner_id=current_user.id,
            sv_video_id=video.id,
            connector_id=connector.id,
            platform=connector.platform,
            title=title,
            description=payload.description,
            payload={"privacy": payload.privacy},
        )
        db.add(job)
        jobs.append(job)
    await db.commit()

    out: list[SvPublishJobOut] = []
    for job, connector in zip(jobs, connectors):
        await db.refresh(job)
        sv_publish_job_task.delay(job.id)
        item = SvPublishJobOut.model_validate(job)
        item.video_title = video.title
        item.channel_name = connector.name
        out.append(item)
    return out


@router.get("/publishing/jobs", response_model=list[SvPublishJobOut])
async def list_publish_jobs(
    limit: int = Query(default=100, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[SvPublishJobOut]:
    rows = (
        await db.execute(
            select(SvPublishJob, SvVideo.title, PublishingConnector.name)
            .join(SvVideo, SvPublishJob.sv_video_id == SvVideo.id)
            .outerjoin(PublishingConnector, SvPublishJob.connector_id == PublishingConnector.id)
            .where(SvPublishJob.owner_id == current_user.id)
            .order_by(SvPublishJob.created_at.desc())
            .limit(limit)
        )
    ).all()
    out: list[SvPublishJobOut] = []
    for job, video_title, channel_name in rows:
        item = SvPublishJobOut.model_validate(job)
        item.video_title = video_title
        item.channel_name = channel_name
        out.append(item)
    return out


@router.post("/publishing/jobs/{job_id}/retry", response_model=SvPublishJobOut)
async def retry_publish_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvPublishJobOut:
    job = await db.get(SvPublishJob, job_id)
    if not job or job.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Publish job not found")
    if job.status == "publishing":
        raise HTTPException(status_code=409, detail="Job is already uploading")
    if job.status == "published":
        raise HTTPException(status_code=409, detail="Job already published")
    job.status = "pending"
    job.error = None
    await db.commit()
    sv_publish_job_task.delay(job.id)
    await db.refresh(job)
    return SvPublishJobOut.model_validate(job)


@router.delete("/publishing/jobs/{job_id}", response_model=Message)
async def delete_publish_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    job = await db.get(SvPublishJob, job_id)
    if not job or job.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Publish job not found")
    if job.status == "publishing":
        raise HTTPException(status_code=409, detail="Job is uploading — wait for it to finish")
    await db.delete(job)
    await db.commit()
    return Message(detail="Publish job removed")


# ------------------------------------------------------------------- exports
@router.get("/exports", response_model=list[SvExportOut])
async def list_exports(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[SvExportOut]:
    rows = (
        await db.execute(
            select(SvExport)
            .where(
                SvExport.owner_id == current_user.id,
                SvExport.deleted_at.is_(None),
                SvExport.storage_path.isnot(None),
            )
            .order_by(SvExport.created_at.desc())
        )
    ).scalars().all()
    out: list[SvExportOut] = []
    for e in rows:
        item = SvExportOut.model_validate(e)
        item.media_url = storage.url(e.storage_path)
        out.append(item)
    return out


@router.get("/exports/{export_id}/download")
async def download_export(
    export_id: int,
    current_user: User = Depends(get_current_user_flexible),
    db: AsyncSession = Depends(get_session),
):
    export = await db.get(SvExport, export_id)
    if not export or export.owner_id != current_user.id or export.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Export not found")
    if not export.storage_path:
        raise HTTPException(status_code=409, detail="Export not ready")
    if settings.STORAGE_BACKEND == "s3":
        return RedirectResponse(url=storage.url(export.storage_path))
    path = storage.abspath(export.storage_path, ensure_parent=False)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Export file missing")
    safe_title = "".join(c for c in (export.title or f"story_{export.sv_video_id}") if c.isalnum() or c in " -_")[:80]
    return FileResponse(path, media_type="video/mp4", filename=f"{safe_title or 'story'}_{export.platform}.mp4")


@router.delete("/exports/{export_id}", response_model=Message)
async def delete_export(
    export_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    export = await db.get(SvExport, export_id)
    if not export or export.owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Export not found")
    export.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return Message(detail="Export deleted")
