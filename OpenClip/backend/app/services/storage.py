"""Storage abstraction.

A single :data:`storage` object exposes a filesystem-like API. The default
``local`` backend writes under ``STORAGE_ROOT``; the ``s3`` backend mirrors the
same key layout into an S3-compatible bucket (MinIO, R2, AWS).

All higher layers reference media by **relative key** (e.g.
``projects/1/videos/3/source.mp4``). :meth:`Storage.abspath` resolves a key to a
local working path (downloading from S3 first when needed), and :meth:`url`
builds the browser-facing URL (``/media/<key>``) the API serves (proxied through
the Next.js dev server in local development).
"""
from __future__ import annotations

import contextlib
import os
import shutil
from pathlib import Path

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)


# ----------------------------------------------------------------- key layout
def video_dir(project_id: int, video_id: int) -> str:
    return f"projects/{project_id}/videos/{video_id}"


def video_source_key(project_id: int, video_id: int, ext: str = "mp4") -> str:
    return f"{video_dir(project_id, video_id)}/source.{ext.lstrip('.')}"


def video_audio_key(project_id: int, video_id: int) -> str:
    return f"{video_dir(project_id, video_id)}/audio.wav"


def video_thumb_key(project_id: int, video_id: int) -> str:
    return f"{video_dir(project_id, video_id)}/thumbnail.jpg"


def clip_dir(project_id: int, video_id: int, clip_id: int) -> str:
    return f"{video_dir(project_id, video_id)}/clips/{clip_id}"


def clip_preview_key(project_id: int, video_id: int, clip_id: int) -> str:
    return f"{clip_dir(project_id, video_id, clip_id)}/preview.mp4"


def clip_thumb_key(project_id: int, video_id: int, clip_id: int) -> str:
    return f"{clip_dir(project_id, video_id, clip_id)}/thumbnail.jpg"


def export_key(project_id: int, video_id: int, clip_id: int, export_id: int, fmt: str) -> str:
    return f"{clip_dir(project_id, video_id, clip_id)}/export_{export_id}.{fmt}"


# ------------------------------------------------------------ story vault keys
def sv_background_key(background_id: int, ext: str = "mp4") -> str:
    return f"storyvault/backgrounds/{background_id}/source.{ext.lstrip('.')}"


def sv_background_thumb_key(background_id: int) -> str:
    return f"storyvault/backgrounds/{background_id}/thumbnail.jpg"


def sv_music_key(music_id: int, ext: str = "mp4") -> str:
    """The original uploaded music/video file, pre-conversion."""
    return f"storyvault/music/{music_id}/source.{ext.lstrip('.')}"


def sv_music_mp3_key(music_id: int) -> str:
    """The extracted MP3 the render mixes under the narration."""
    return f"storyvault/music/{music_id}/audio.mp3"


def sv_music_preview_key(music_id: int, volume_pct: int) -> str:
    """A cached audition clip of a track mixed under sample narration at a level."""
    return f"storyvault/music/{music_id}/preview_v{int(volume_pct)}.mp3"


def sv_music_sample_narration_key() -> str:
    """The shared sample narration the music-preview mixes a track under."""
    return "storyvault/music/_sample/narration.wav"


def sv_video_dir(sv_video_id: int) -> str:
    return f"storyvault/videos/{sv_video_id}"


def sv_narration_key(sv_video_id: int) -> str:
    return f"{sv_video_dir(sv_video_id)}/narration.wav"


def sv_captions_key(sv_video_id: int, ext: str = "ass") -> str:
    return f"{sv_video_dir(sv_video_id)}/captions.{ext}"


def sv_preview_key(sv_video_id: int) -> str:
    return f"{sv_video_dir(sv_video_id)}/preview.mp4"


def sv_overlay_key(sv_video_id: int, name: str, width: int) -> str:
    """Burned-in intro overlay PNG (Reddit topic card / author intro).

    Keyed by ``width`` because the preview (540px) and final (1080px) renders
    need the card rasterized at their own canvas scale.
    """
    return f"{sv_video_dir(sv_video_id)}/overlay_{name}_{int(width)}.png"


def sv_export_key(sv_video_id: int, export_id: int) -> str:
    return f"{sv_video_dir(sv_video_id)}/export_{export_id}.mp4"


def sv_voice_sample_key(digest: str) -> str:
    return f"storyvault/voices/sample_{digest}.wav"


def sv_voice_ref_key(token: str) -> str:
    """Uploaded voice-clone reference clip (converted to WAV)."""
    return f"storyvault/voices/refs/{token}.wav"


def sv_voice_clone_key(token: str) -> str:
    """Generated voice-clone output audio."""
    return f"storyvault/voices/clones/{token}.wav"


def sv_voice_preset_preview_key(token: str) -> str:
    """Saved audition clip for a voice preset (played by the Preview button)."""
    return f"storyvault/voices/presets/{token}.wav"


def sv_caption_preview_key(style: str) -> str:
    return f"storyvault/presets/caption_{style}.mp4"


class Storage:
    def __init__(self) -> None:
        self.backend = settings.STORAGE_BACKEND
        self.root = Path(settings.STORAGE_ROOT)
        self.root.mkdir(parents=True, exist_ok=True)
        self._s3 = None
        if self.backend == "s3":
            self._init_s3()

    def _init_s3(self) -> None:
        import boto3  # imported lazily so local installs don't need boto3

        self._s3 = boto3.client(
            "s3",
            endpoint_url=settings.S3_ENDPOINT_URL,
            region_name=settings.S3_REGION,
            aws_access_key_id=settings.S3_ACCESS_KEY,
            aws_secret_access_key=settings.S3_SECRET_KEY,
            use_ssl=settings.S3_USE_SSL,
        )
        try:
            self._s3.head_bucket(Bucket=settings.S3_BUCKET)
        except Exception:
            logger.info("Creating S3 bucket %s", settings.S3_BUCKET)
            self._s3.create_bucket(Bucket=settings.S3_BUCKET)

    # --------------------------------------------------------------- local fs
    def abspath(self, key: str, *, ensure_parent: bool = True) -> str:
        """Resolve a key to a local path, materializing it from S3 if needed."""
        local = self.root / key
        if ensure_parent:
            local.parent.mkdir(parents=True, exist_ok=True)
        if self.backend == "s3" and not local.exists():
            # may not exist yet (we're about to create it)
            with contextlib.suppress(Exception):
                self._s3.download_file(settings.S3_BUCKET, key, str(local))
        return str(local)

    def exists(self, key: str) -> bool:
        if (self.root / key).exists():
            return True
        if self.backend == "s3":
            try:
                self._s3.head_object(Bucket=settings.S3_BUCKET, Key=key)
                return True
            except Exception:
                return False
        return False

    def save_bytes(self, key: str, data: bytes) -> str:
        path = self.abspath(key)
        with open(path, "wb") as fh:
            fh.write(data)
        self._maybe_upload(key, path)
        return key

    def save_file(self, src_path: str, key: str, *, move: bool = False) -> str:
        dest = self.abspath(key)
        if move:
            shutil.move(src_path, dest)
        else:
            shutil.copy2(src_path, dest)
        self._maybe_upload(key, dest)
        return key

    def open_write(self, key: str) -> str:
        """Return a local path the caller can write to; upload happens via
        :meth:`commit` once writing is finished."""
        return self.abspath(key)

    def commit(self, key: str) -> str:
        """Persist a locally-written key to the backend (no-op for local)."""
        self._maybe_upload(key, str(self.root / key))
        return key

    def delete(self, key: str) -> None:
        local = self.root / key
        if local.exists():
            if local.is_dir():
                shutil.rmtree(local, ignore_errors=True)
            else:
                local.unlink(missing_ok=True)
        if self.backend == "s3":
            with contextlib.suppress(Exception):
                self._s3.delete_object(Bucket=settings.S3_BUCKET, Key=key)

    def size(self, key: str) -> int | None:
        local = self.root / key
        if local.exists():
            return local.stat().st_size
        return None

    def url(self, key: str | None) -> str | None:
        if not key:
            return None
        return f"{settings.PUBLIC_MEDIA_URL.rstrip('/')}/{key.lstrip('/')}"

    def _maybe_upload(self, key: str, local_path: str) -> None:
        if self.backend == "s3" and os.path.exists(local_path):
            try:
                self._s3.upload_file(local_path, settings.S3_BUCKET, key)
            except Exception as exc:  # pragma: no cover
                logger.error("S3 upload failed for %s: %s", key, exc)


storage = Storage()
