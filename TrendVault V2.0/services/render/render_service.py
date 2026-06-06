"""Render orchestration — Python port of the /api/trend-vault/render background pipeline.

Stages: TTS (Kokoro) → caption alignment (AssemblyAI/proportional) → update job
file → spawn Node Remotion subprocess (streaming progress to the SSE JobRegistry)
→ verify the MP4 has an audio stream. Runs as an asyncio task; blocking work is
offloaded with asyncio.to_thread so the event loop (and SSE) keeps flowing.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

from core.atomic_io import read_json
from core.config import config
from core.constants import (
    CAPTIONS_DIR, CUSTOM_AUDIO_DIR, PUBLIC_AUDIO_DIR, RENDER_AUDIO_FLOOR_SEC,
    RENDER_SCRIPT, ROOT, TREND_VAULT_OUT,
)
from core.sse import get_job_registry
from lib import ffmpeg_tools
from lib.hashing import is_fish_engine
from lib.timing import build_timed_captions, bundle_to_render_lines
from services.render import caption_align
from services.tts import kokoro_client
from services.tts.tts_service import generate_voice

_ANSI = re.compile(r"\x1b\[[0-9;]*m")


class RenderService:
    async def run(self, job_id: str, folder: str, script_lines: List[Dict[str, Any]],
                  settings: Dict[str, Any], job_file: str) -> None:
        reg = get_job_registry()

        def log(line: str, pct: Optional[int] = None, stage: Optional[str] = None) -> None:
            reg.push_log(job_id, line, pct=pct, stage=stage)

        try:
            # ── Stage 1: TTS voice ──────────────────────────────────────────
            reg.set_progress(job_id, 5, "🎙 Generating voice...")
            log("🎙 Generating TTS voice audio...")

            voice = settings.get("voice") or {}
            full_text = "\n\n".join(l.get("text", "") for l in script_lines)
            voice_file = f"trend_vault_voice_{job_id}.mp3"
            voice_path = os.path.join(CUSTOM_AUDIO_DIR, voice_file)
            preset_id = voice.get("presetId") or "tiktok_female"
            safe_mode = bool(settings.get("safeMode"))

            if is_fish_engine(preset_id, voice.get("engine")):
                raise RuntimeError(
                    "Fish Speech S2 Pro isn't available in V2.0 yet (coming in Phase 3). "
                    "Pick a Kokoro voice preset.")

            log("🔎 Checking Kokoro server...")
            probe = await asyncio.to_thread(kokoro_client.probe_alive)
            if not probe.get("ok"):
                log(f"⚠ Kokoro not ready on first try: {probe.get('reason') or 'unknown'} — "
                    f"retrying for up to 60s")
                waited = await asyncio.to_thread(kokoro_client.wait_ready, 60000, 2000, log)
                if not waited.get("ready"):
                    raise RuntimeError(
                        "Kokoro TTS server is not responding after 60s of retries. Last reason: "
                        f"{waited.get('lastReason') or 'unknown'}. Start Kokoro (launcher card / "
                        "bats/start-kokoro.bat) and make sure nothing else holds port 5070.")
            else:
                log(f"✓ Kokoro server ready (test audio {probe.get('bytes') or 0} bytes)")

            result = await asyncio.to_thread(
                generate_voice,
                text=full_text, presetId=preset_id,
                pitch=voice.get("pitch"), rate=voice.get("rate"), speed=voice.get("speed"),
                volume=voice.get("volume"), intensity=voice.get("intensity"),
                throatDepth=voice.get("throatDepth"), ancientRasp=voice.get("ancientRasp"),
                royalPace=voice.get("royalPace"), chamberSpace=voice.get("chamberSpace"),
                logger=log, safeMode=safe_mode,
            )
            voice_buffer = result["buffer"]
            if not voice_buffer or len(voice_buffer) < 1024:
                raise RuntimeError(
                    f"TTS returned suspiciously small audio ({len(voice_buffer or b'')} bytes). "
                    "Render aborted — final video would be silent.")

            os.makedirs(CUSTOM_AUDIO_DIR, exist_ok=True)
            with open(voice_path, "wb") as f:
                f.write(voice_buffer)
            log(f"[TTS] output size: {len(voice_buffer) / 1024:.0f} KB", pct=15)

            tts_dur = await asyncio.to_thread(ffmpeg_tools.probe_duration_sec, voice_path)
            log(f"[TTS] duration: {tts_dur:.2f}s")
            if tts_dur < RENDER_AUDIO_FLOOR_SEC:
                raise RuntimeError(
                    f"TTS file has duration {tts_dur:.2f}s — too short / likely silence. Render aborted.")

            os.makedirs(PUBLIC_AUDIO_DIR, exist_ok=True)
            public_audio_path = os.path.join(PUBLIC_AUDIO_DIR, voice_file)
            shutil.copyfile(voice_path, public_audio_path)
            log("───────── RENDER HANDOFF ─────────")
            log(f"[HANDOFF] tts engine used : {result.get('engineUsed')}")
            log(f"[HANDOFF] final audio dur : {tts_dur:.2f}s")
            log(f"[HANDOFF] duration mode   : {settings.get('durationMode') or 'autoVoice'} "
                f"(target={settings.get('durationSeconds', 'n/a')}s)")
            log(f"[HANDOFF] output folder   : {folder}")
            log("──────────────────────────────────")

            # ── Stage 1.5: caption alignment ────────────────────────────────
            per_line_words: Optional[List[List[Dict[str, Any]]]] = None
            timing_source = "word-proportional"
            if config.assemblyai_api_key:
                try:
                    log("🔤 Aligning captions to voice (AssemblyAI)...", pct=16)
                    words = await asyncio.to_thread(caption_align.transcribe, voice_path)
                    if words:
                        per_line_words = caption_align.match_words_to_lines(script_lines, words)
                        timing_source = "assemblyai-forced-alignment"
                        log(f"✓ Aligned {len(words)} words to {len(script_lines)} lines")
                    else:
                        log("⚠ AssemblyAI returned no words — using word-proportional timing")
                except Exception as e:  # noqa: BLE001
                    log(f"⚠ AssemblyAI alignment failed ({str(e)[:60]}) — using word-proportional timing")

            cap_input = [{"text": l.get("text", ""), "type": l.get("type") or "observation"}
                         for l in script_lines]
            bundle = build_timed_captions(cap_input, tts_dur,
                                          per_line_words=per_line_words, source=timing_source)

            # ── Fixed-duration rescale ──────────────────────────────────────
            force_target = bool(settings.get("forceTargetDuration"))
            dur_secs = settings.get("durationSeconds")
            target_valid = isinstance(dur_secs, (int, float)) and dur_secs > 0
            mode_fixed = (settings.get("durationMode") or "autoVoice") == "fixed"
            if (mode_fixed or force_target) and target_valid:
                target = dur_secs
                scale = target / bundle["audioDurationSec"]
                scaled = None
                if per_line_words:
                    scaled = [[{"word": w["word"], "startMs": w["startMs"] * scale,
                                "endMs": w["endMs"] * scale} for w in line] for line in per_line_words]
                bundle = build_timed_captions(cap_input, target,
                                              per_line_words=scaled, source=timing_source)
                log(f"[DURATION] rebuilt timeline to fit {target}s window ({scale:.3f}× scale)")

            # ── Text sync offset ────────────────────────────────────────────
            raw_off = settings.get("textSyncOffsetMs") or 0
            try:
                raw_off = float(raw_off)
            except (TypeError, ValueError):
                raw_off = 0
            offset_ms = max(-2000, min(2000, raw_off))
            if offset_ms != 0:
                off_sec = offset_ms / 1000
                max_sec = bundle["audioDurationSec"]
                max_ms = max_sec * 1000
                for c in bundle["captions"]:
                    ns = max(0, min(max_sec, c["start"] + off_sec))
                    ne = max(ns, min(max_sec, c["end"] + off_sec))
                    c["start"], c["end"], c["duration"] = ns, ne, ne - ns
                    c["startMs"], c["endMs"] = ns * 1000, ne * 1000
                    if c.get("words"):
                        for w in c["words"]:
                            ws = max(0, min(max_ms, w["startMs"] + offset_ms))
                            we = max(ws, min(max_ms, w["endMs"] + offset_ms))
                            w["startMs"], w["endMs"] = ws, we
                log(f"[TIMING] applied textSyncOffsetMs={offset_ms}")

            # Persist canonical captions JSON
            try:
                os.makedirs(CAPTIONS_DIR, exist_ok=True)
                with open(os.path.join(CAPTIONS_DIR, f"captions_{job_id}.json"), "w", encoding="utf-8") as f:
                    json.dump({"audioFile": voice_file, "audioDurationSec": bundle["audioDurationSec"],
                               "source": bundle["source"], "captions": bundle["captions"]}, f, indent=2)
            except Exception as e:  # noqa: BLE001
                log(f"[TIMING] could not persist caption JSON: {e}")

            aligned_lines = bundle_to_render_lines(bundle)

            # ── Stage 1.9: rewrite job file for the renderer ────────────────
            try:
                job = read_json(job_file, {}) or {}
                job.setdefault("settings", {})
                job["settings"]["audioFile"] = voice_file if os.path.exists(voice_path) else settings.get("audioFile", "")
                job["settings"]["durationMode"] = settings.get("durationMode") or "autoVoice"
                job["settings"]["durationSeconds"] = settings.get("durationSeconds") or job["settings"].get("durationSeconds")
                job["settings"]["voiceVolume"] = settings.get("voiceVolume", 1)
                job["scriptLines"] = aligned_lines
                job["timing"] = {"audioDurationSec": bundle["audioDurationSec"],
                                 "source": bundle["source"],
                                 "captionsPath": f"public/captions/captions_{job_id}.json"}
                with open(job_file, "w", encoding="utf-8") as f:
                    json.dump(job, f)
            except Exception as e:  # noqa: BLE001
                log(f"[JOB] could not update job file: {e}")

            # ── Stage 2: Remotion render (Node subprocess) ──────────────────
            reg.set_progress(job_id, 18, "🎬 Bundling & rendering...")
            log("🎬 Starting Remotion render pipeline...")
            await self._spawn_render(job_id, job_file, reg)

            # ── Stage 3: verify ─────────────────────────────────────────────
            out_file = os.path.join(TREND_VAULT_OUT, folder, "video.mp4")
            if not os.path.exists(out_file):
                raise RuntimeError("Render process finished but video.mp4 not found")
            has_audio = await asyncio.to_thread(ffmpeg_tools.has_audio_stream, out_file)
            audio_file_ok = os.path.exists(public_audio_path) and os.path.getsize(public_audio_path) > 1024
            log(f"[VERIFY] final mp4 has audio stream: {'yes' if has_audio else 'no'} "
                f"(voice file present: {'yes' if audio_file_ok else 'no'})")
            if not has_audio:
                raise RuntimeError(
                    "Render produced a video with NO audio stream. Marking job failed — "
                    "silent videos are not allowed.")

            reg.finish(job_id, True, output_file=f"{folder}/video.mp4")
            log(f"✅ Render complete! → trend-vault-output/{folder}/video.mp4", pct=100)
            self._record(job_id, folder, settings.get("trendVaultSign"), "done", f"{folder}/video.mp4", None)

        except Exception as err:  # noqa: BLE001
            msg = str(err)
            reg.finish(job_id, False, error=msg)
            log(f"❌ Render failed: {msg}")
            self._record(job_id, folder, settings.get("trendVaultSign"), "error", None, msg)
        finally:
            try:
                if os.path.exists(job_file):
                    os.unlink(job_file)
            except Exception:
                pass
            asyncio.get_event_loop().call_later(3600, reg.cleanup, job_id)

    async def _spawn_render(self, job_id: str, job_file: str, reg) -> None:
        """Spawn `npx tsx scripts/trend-vault-render.ts`, stream stdout→SSE."""
        env = {**os.environ, "TREND_VAULT_JOB_FILE": job_file}
        proc = await asyncio.create_subprocess_shell(
            f'npx tsx "{RENDER_SCRIPT}"',
            cwd=ROOT, env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )

        buffer = ""
        assert proc.stdout is not None
        while True:
            chunk = await proc.stdout.read(1024)
            if not chunk:
                break
            buffer += chunk.decode("utf-8", "replace")
            # Remotion writes progress with \r (no newline) — split on both.
            parts = re.split(r"[\r\n]", buffer)
            buffer = parts.pop()
            for line in parts:
                self._handle_render_line(job_id, line, reg)
        if buffer.strip():
            self._handle_render_line(job_id, buffer, reg)

        code = await proc.wait()
        if code != 0:
            raise RuntimeError(f"trend-vault-render.ts exited with code {code}")

    @staticmethod
    def _handle_render_line(job_id: str, line: str, reg) -> None:
        clean = _ANSI.sub("", line).strip()
        if not clean:
            return
        pct: Optional[int] = None
        stage: Optional[str] = None
        m = re.match(r"^(\d+)%", clean)
        if m:
            p = int(m.group(1))
            pct = round(18 + p * 0.82)
            stage = f"🎬 Rendering… {p}%"
        if re.search(r"using system browser", clean, re.I):
            stage, pct = "🌐 Browser ready", 20
        if re.search(r"bundling remotion", clean, re.I):
            stage, pct = "📦 Bundling...", 22
        if re.search(r"bundle ready", clean, re.I):
            stage, pct = "🎬 Launching renderer...", 28
        if re.search(r"rendering \d+ frames", clean, re.I):
            stage, pct = "🎬 Rendering frames...", 32
        if re.search(r"render complete|✓ render", clean, re.I):
            stage, pct = "💾 Encoding MP4...", 95
        fm = re.search(r"(\d+)%\s*\((\d+)/(\d+)\s*frames?\)", clean, re.I)
        if fm:
            pct = round(32 + int(fm.group(1)) * 0.6)
            stage = f"🎬 {fm.group(2)} / {fm.group(3)} frames"
        reg.push_log(job_id, clean, pct=pct, stage=stage)

    @staticmethod
    def _record(job_id: str, folder: str, sign: Optional[str], status: str,
                output_file: Optional[str], error: Optional[str]) -> None:
        try:
            from core.database import RenderRecord, SessionLocal
            db = SessionLocal()
            try:
                db.add(RenderRecord(job_id=job_id, folder=folder, sign=sign,
                                    status=status, output_file=output_file, error=error,
                                    created_at=datetime.utcnow(), updated_at=datetime.utcnow()))
                db.commit()
            finally:
                db.close()
        except Exception:
            pass

    def list_outputs(self) -> Dict[str, Any]:
        """Scan trend-vault-output/*/ for finished renders (newest first)."""
        folders: List[Dict[str, Any]] = []
        if os.path.isdir(TREND_VAULT_OUT):
            for name in sorted(os.listdir(TREND_VAULT_OUT)):
                d = os.path.join(TREND_VAULT_OUT, name)
                if not os.path.isdir(d):
                    continue
                if not os.path.exists(os.path.join(d, "video.mp4")):
                    continue  # only finished renders, matching server.ts
                meta = read_json(os.path.join(d, "meta.json"), {})
                folders.append({"folder": name, "hasVideo": True, "meta": meta})
        folders.reverse()
        return {"folders": folders}


_service: Optional[RenderService] = None


def get_render_service() -> RenderService:
    global _service
    if _service is None:
        _service = RenderService()
    return _service
