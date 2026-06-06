"""Media listing service — backgrounds, music, custom audio, prompts.

Mirrors the Express dir-scan endpoints (server.ts:1467/1635/1655/4537). Upload /
stock-media land in Phase 2.
"""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from core.atomic_io import read_json
from core.constants import BACKGROUNDS_DIR, CUSTOM_AUDIO_DIR, MUSIC_DIR, PROMPTS_FILE

_VIDEO_EXT = (".mp4", ".webm", ".mov")
_AUDIO_EXT = (".mp3", ".wav", ".ogg", ".m4a")


def _scan(directory: str, exts: tuple) -> List[str]:
    if not os.path.isdir(directory):
        return []
    return sorted(f for f in os.listdir(directory) if f.lower().endswith(exts))


class MediaService:
    def list_backgrounds(self) -> Dict[str, List[str]]:
        return {"files": _scan(BACKGROUNDS_DIR, _VIDEO_EXT)}

    def list_music(self) -> Dict[str, List[str]]:
        return {"files": _scan(MUSIC_DIR, _AUDIO_EXT)}

    def list_audio(self) -> Dict[str, List[str]]:
        return {"files": _scan(CUSTOM_AUDIO_DIR, _AUDIO_EXT)}

    def get_prompts(self) -> Any:
        return read_json(PROMPTS_FILE, {"prompts": [], "categories": []})


_service: Optional[MediaService] = None


def get_media_service() -> MediaService:
    global _service
    if _service is None:
        _service = MediaService()
    return _service
