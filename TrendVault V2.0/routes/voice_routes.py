"""Voice routes — voice-preview, generate-voice, voice-presets, tts-status."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from core.config import config
from core.constants import CAPTIONS_DIR, CUSTOM_AUDIO_DIR, PUBLIC_AUDIO_DIR, PUBLIC_DIR
from lib import ffmpeg_tools, hashing
from lib.timing import build_timed_captions
from services.tts.tts_service import KokoroTtsService, generate_voice


def setup_voice_routes(tts_service: KokoroTtsService) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["voice"])

    @router.post("/trend-vault/voice-preview")
    async def voice_preview(request: Request):
        body = await request.json()
        script_lines = body.get("scriptLines")
        voice = body.get("voice") or {}
        if not isinstance(script_lines, list) or not script_lines:
            return JSONResponse({"error": "scriptLines[] required"}, status_code=400)
        preset_id = voice.get("presetId") or "tiktok_female"
        full_text = "\n\n".join(l.get("text", "") for l in script_lines if l.get("text"))
        if not full_text.strip():
            return JSONResponse({"error": "scriptLines all empty"}, status_code=400)
        if hashing.is_fish_engine(preset_id, voice.get("engine")):
            return JSONResponse(
                {"ok": False, "error": "Fish Speech S2 Pro isn't available in V2.0 yet "
                 "(coming in Phase 3). Pick a Kokoro voice preset."}, status_code=503)

        preview_id = f"pv_{int(time.time() * 1000)}"
        audio_file = f"trend_vault_preview_{preview_id}.mp3"
        resolved_engine = "kokoro"

        def _synthesize():
            result = generate_voice(
                text=full_text, presetId=preset_id,
                pitch=voice.get("pitch"), rate=voice.get("rate"), speed=voice.get("speed"),
                volume=voice.get("volume"), intensity=voice.get("intensity"),
                throatDepth=voice.get("throatDepth"), ancientRasp=voice.get("ancientRasp"),
                royalPace=voice.get("royalPace"), chamberSpace=voice.get("chamberSpace"),
            )
            buf = result["buffer"]
            if not buf or len(buf) < 1024:
                raise RuntimeError(
                    f"TTS returned suspiciously small audio ({len(buf or b'')} bytes).")
            os.makedirs(CUSTOM_AUDIO_DIR, exist_ok=True)
            os.makedirs(PUBLIC_AUDIO_DIR, exist_ok=True)
            audio_path = os.path.join(CUSTOM_AUDIO_DIR, audio_file)
            with open(audio_path, "wb") as f:
                f.write(buf)
            public_audio_path = os.path.join(PUBLIC_AUDIO_DIR, audio_file)
            shutil.copyfile(audio_path, public_audio_path)
            dur = ffmpeg_tools.probe_duration_sec(audio_path)
            if dur < 0.4:
                raise RuntimeError(f"TTS produced {dur:.2f}s of audio — too short / silent.")
            return dur, public_audio_path

        try:
            audio_dur, public_audio_path = await asyncio.to_thread(_synthesize)
        except Exception as e:  # noqa: BLE001
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

        bundle = build_timed_captions(
            [{"text": l.get("text"), "type": l.get("type")} for l in script_lines],
            audio_dur, source="word-proportional")

        os.makedirs(CAPTIONS_DIR, exist_ok=True)
        captions_rel = f"captions/preview_{preview_id}.json"
        with open(os.path.join(PUBLIC_DIR, captions_rel), "w", encoding="utf-8") as f:
            json.dump({"audioFile": audio_file, "audioDurationSec": bundle["audioDurationSec"],
                       "source": bundle["source"], "captions": bundle["captions"]}, f, indent=2)

        script_text = "||".join((l.get("text") or "").strip() for l in script_lines)
        timing = {
            "mode": voice.get("durationMode") or "autoMatchVoice",
            "targetDurationSeconds": voice.get("targetDurationSec"),
            "actualAudioDurationSeconds": bundle["audioDurationSec"],
            "finalVideoDurationSeconds": bundle["audioDurationSec"],
            "scriptHash": hashing.stable_hash(script_text),
            "voiceHash": hashing.voice_hash(voice, resolved_engine),
            "provider": resolved_engine,
            "voiceId": voice.get("presetId"),
            "audioUrl": f"/custom-audio/{audio_file}",
            "audioFile": audio_file,
            "audioPath": public_audio_path,
            "lines": [{"id": f"line_{i}", "text": c["text"], "start": c["start"], "end": c["end"],
                       "duration": c["duration"], "wordCount": c["wordCount"]}
                      for i, c in enumerate(bundle["captions"])],
            "totalWords": bundle["totalWords"],
            "source": bundle["source"],
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        return {
            "ok": True, "previewId": preview_id,
            "audioUrl": f"/custom-audio/{audio_file}", "captionsUrl": f"/{captions_rel}",
            "audioDurationSec": bundle["audioDurationSec"], "totalWords": bundle["totalWords"],
            "source": bundle["source"], "resolvedEngine": resolved_engine,
            "captions": bundle["captions"], "timing": timing,
        }

    @router.post("/trend-vault/generate-voice")
    async def generate_voice_ep(request: Request):
        body = await request.json()
        text = body.get("text")
        preset_id = body.get("presetId")
        if not text or not preset_id:
            return JSONResponse({"error": "text and presetId required"}, status_code=400)
        if hashing.is_fish_engine(preset_id, body.get("engine")):
            return JSONResponse({"error": "Fish Speech S2 Pro isn't available in V2.0 yet "
                                 "(coming in Phase 3)."}, status_code=503)
        try:
            result = await asyncio.to_thread(
                generate_voice, text=text, presetId=preset_id,
                pitch=body.get("pitch"), rate=body.get("rate"), speed=body.get("speed"),
                volume=body.get("volume"), intensity=body.get("intensity"),
                preview=bool(body.get("preview")),
                throatDepth=body.get("throatDepth"), ancientRasp=body.get("ancientRasp"),
                royalPace=body.get("royalPace"), chamberSpace=body.get("chamberSpace"),
            )
            return Response(content=result["buffer"], media_type=result["mimeType"],
                            headers={"X-TTS-Engine": "kokoro"})
        except Exception as e:  # noqa: BLE001
            return JSONResponse({"error": str(e)}, status_code=500)

    @router.get("/trend-vault/voice-presets")
    async def voice_presets():
        return {"presets": tts_service.voice_cards()}

    @router.get("/trend-vault/tts-status")
    async def tts_status():
        s = await asyncio.to_thread(tts_service.status)
        s["fish"] = {
            "state": "missing", "message": "Fish Speech S2 Pro not available in V2.0 yet",
            "installed": False, "installing": False, "modelDir": None, "sizeBytes": 0,
            "serverUrl": config.fish_tts_url, "serverOk": False,
        }
        return s

    return router
