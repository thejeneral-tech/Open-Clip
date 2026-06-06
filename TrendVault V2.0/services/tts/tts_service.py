"""Kokoro TTS service — Python port of scripts/tts/ttsService.ts + ttsEngineManager.ts.

generate_voice(): preset → pause-shaped chunks → Kokoro engine ladder (with
voice fallback + 3-attempt sanitization) → concat-with-silence → FX chain →
mp3 bytes. Blocking; call via asyncio.to_thread from async routes.
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Callable, Dict, List, Optional

from core.atomic_io import read_json
from core.constants import (
    CUSTOM_PRESETS_FILE, HIDDEN_VOICES_FILE, TTS_VOICE_PRESETS_FILE, BASE_DIR,
)
from lib import ffmpeg_tools
from services.tts import audio_fx, kokoro_client
from services.tts.script_formatter import format_script, truncate_for_preview
from services.tts.text_preprocess import (
    CINEMATIC_PAUSES, DEFAULT_PAUSES, pause_config_from_royal_pace, prepare_string,
)

# ── Constants (mirror ttsEngineManager.ts) ──
MAX_CHUNK_CHARS = 160
MIN_CHUNK_DURATION_SEC = 0.2
MIN_CHUNK_BYTES = 2000
MIN_FINAL_DURATION_SEC = 1.0
RETRIES_PER_CHUNK_PER_ENGINE = 3

_CINEMATIC_RE = re.compile(
    r"cave_oracle|dungeon_wizard|cosmic_monk|dark_story|forbidden|shadow_prophet|"
    r"gravel_king|ancient_librarian|ethereal|mythic|raspy|ancient_king|medieval_oracle|"
    r"cave_prophet|dungeon_storyteller|old_warlock|cathedral_monk|gravel_knight|"
    r"shadow_bard|elder_dragon|royal_seer|night_watchman|stone_temple|wandering_sage|"
    r"dark_cosmos|flamekeeper|quiet_giant|old_kingdom",
    re.I,
)

Logger = Callable[[str], None]


def _load_builtin_presets() -> List[Dict[str, Any]]:
    return read_json(TTS_VOICE_PRESETS_FILE, []) or []


VOICE_PRESETS: List[Dict[str, Any]] = _load_builtin_presets()


def read_custom_presets() -> List[Dict[str, Any]]:
    return read_json(CUSTOM_PRESETS_FILE, []) or []


def find_preset(preset_id: str) -> Optional[Dict[str, Any]]:
    for p in VOICE_PRESETS:
        if p.get("id") == preset_id:
            return p
    for p in read_custom_presets():
        if p.get("id") == preset_id:
            return p
    return None


def list_voice_presets() -> List[Dict[str, Any]]:
    """Built-in presets followed by user customs (raw; route filters hidden)."""
    return list(VOICE_PRESETS) + read_custom_presets()


def read_hidden_voice_ids() -> set:
    data = read_json(HIDDEN_VOICES_FILE, [])
    if isinstance(data, dict):
        data = data.get("hidden") or data.get("ids") or []
    return {str(x) for x in (data or [])}


# ── Sanitization ladder (ttsEngineManager.ts) ──
def _ensure_terminal(s: str) -> str:
    if s and not re.search(r"[.!?]$", s):
        s += "."
    return s


def sanitize_attempt_1(text: str) -> str:
    s = text
    s = s.replace("…", ". ")
    s = re.sub(r"\.{2,}", ". ", s)
    s = re.sub(r"\s*[—–]\s*", ", ", s)
    s = re.sub(r"[‘’]", "'", s)
    s = re.sub(r"[“”]", '"', s)
    s = re.sub(r"[*_~`#]+", "", s)
    s = re.sub(r"\s{2,}", " ", s).strip()
    return _ensure_terminal(s) if s else s


_CONTRACTIONS = [
    (r"\bdon't\b", "do not"), (r"\bdoesn't\b", "does not"), (r"\bdidn't\b", "did not"),
    (r"\bwon't\b", "will not"), (r"\bwouldn't\b", "would not"), (r"\bshouldn't\b", "should not"),
    (r"\bcouldn't\b", "could not"), (r"\bcan't\b", "cannot"), (r"\bisn't\b", "is not"),
    (r"\bwasn't\b", "was not"), (r"\baren't\b", "are not"), (r"\bweren't\b", "were not"),
    (r"\bhasn't\b", "has not"), (r"\bhaven't\b", "have not"), (r"\bthat's\b", "that is"),
    (r"\bit's\b", "it is"), (r"\bthey're\b", "they are"), (r"\byou're\b", "you are"),
    (r"\bwe're\b", "we are"),
]
_CONTRACTIONS_CS = [(r"\bI'm\b", "I am"), (r"\bI've\b", "I have"),
                    (r"\bI'll\b", "I will"), (r"\bI'd\b", "I would")]


def sanitize_attempt_2(text: str) -> str:
    s = sanitize_attempt_1(text)
    for pat, rep in _CONTRACTIONS:
        s = re.sub(pat, rep, s, flags=re.I)
    for pat, rep in _CONTRACTIONS_CS:
        s = re.sub(pat, rep, s)
    s = re.sub(r"[^\x20-\x7E]", " ", s)
    s = re.sub(r"\s{2,}", " ", s).strip()
    return _ensure_terminal(s) if s else s


def sanitize_attempt_3(text: str) -> str:
    s = sanitize_attempt_2(text).lower()
    s = re.sub(r"[^a-z0-9 .,!?']", " ", s)
    s = re.sub(r"\s{2,}", " ", s).strip()
    return _ensure_terminal(s) if s else s


def split_for_kokoro(text: str) -> List[str]:
    if not text or not text.strip():
        return []
    if len(text) <= MAX_CHUNK_CHARS:
        return [text]
    sentences = [s.strip() for s in re.split(r"(?<=[.!?…])\s+|\.{2,}\s+", text) if s and s.strip()]
    out: List[str] = []
    for sentence in sentences:
        if len(sentence) <= MAX_CHUNK_CHARS:
            out.append(sentence)
            continue
        buf = ""
        for w in re.split(r"\s+", sentence):
            if not buf:
                buf = w
            elif len(buf) + 1 + len(w) > MAX_CHUNK_CHARS:
                out.append(buf)
                buf = w
            else:
                buf += " " + w
        if buf:
            out.append(buf)
    return out


# ── Kokoro engine (one voice id) ──
class KokoroEngine:
    def __init__(self, display_name: str, voice: str, speed: float):
        self.name = display_name
        self.voice = voice
        self.speed = speed

    def probe(self) -> Dict[str, Any]:
        out_path = ffmpeg_tools.tmp_audio_file(".wav")
        try:
            res = kokoro_client.synthesize("This is a render test.", self.voice, self.speed,
                                           out_path, timeout=30.0)
            if not res:
                return {"ok": False, "reason": "Kokoro server unreachable (connection refused)"}
            if res["bytes"] < MIN_CHUNK_BYTES:
                return {"ok": False, "reason": f"test audio too small ({res['bytes']} bytes)"}
            dur = ffmpeg_tools.probe_duration_sec(out_path)
            if dur < 0.5:
                return {"ok": False, "reason": f"test audio duration {dur:.2f}s (< 0.5s)"}
            return {"ok": True}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "reason": str(e)}
        finally:
            _silent_unlink(out_path)

    def synthesize_chunk(self, text: str, out_path: str) -> Dict[str, Any]:
        res = kokoro_client.synthesize(text, self.voice, self.speed, out_path)
        if not res:
            raise RuntimeError("Kokoro server unreachable")
        if res["bytes"] < MIN_CHUNK_BYTES:
            raise RuntimeError(f"audio too small ({res['bytes']} bytes)")
        dur = ffmpeg_tools.probe_duration_sec(out_path)
        if dur < MIN_CHUNK_DURATION_SEC:
            raise RuntimeError(f"audio too short ({dur:.2f}s)")
        return {"bytes": res["bytes"], "durationSec": dur}


def _silent_unlink(path: str) -> None:
    try:
        if path and os.path.exists(path):
            os.unlink(path)
    except Exception:
        pass


def build_voice_ladder(preset: Dict[str, Any], speed: float) -> List[KokoroEngine]:
    edge_id = preset.get("edgeId") or "af_bella"
    engines = [KokoroEngine(f"Selected ({preset.get('name')} -> {edge_id})", edge_id, speed)]
    fallbacks = [
        ("Default Kokoro male (am_adam)", "am_adam"),
        ("Default Kokoro female (af_bella)", "af_bella"),
        ("Alt Kokoro male (am_michael)", "am_michael"),
    ]
    sel = edge_id.lower()
    for label, voice in fallbacks:
        if sel == voice.lower():
            continue
        engines.append(KokoroEngine(label, voice, speed))
    return engines


def build_chunk_plan(tts_chunks: List[Dict[str, Any]],
                     formatter: Callable[[str], str]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for li, chunk in enumerate(tts_chunks):
        cleaned = formatter(chunk["text"])
        if not cleaned or not cleaned.strip():
            continue
        parts = split_for_kokoro(cleaned)
        for pi, part in enumerate(parts):
            is_last = pi == len(parts) - 1
            out.append({"originalLineIndex": li, "text": part,
                        "pauseAfterMs": chunk["pauseAfterMs"] if is_last else 60})
    return out


def orchestrate(chunks: List[Dict[str, Any]], engines: List[KokoroEngine],
                log: Logger) -> Dict[str, Any]:
    reasons: List[str] = []
    if not engines:
        return {"ok": False, "reasons": ["No TTS engines configured"]}
    for ei, engine in enumerate(engines):
        log(f"Trying engine {ei + 1}/{len(engines)}: {engine.name}")
        log(f"  Probing {engine.name} with real synthesis test...")
        probe = engine.probe()
        if not probe.get("ok"):
            why = f"{engine.name} failed real synthesis test: {probe.get('reason') or 'unknown'}"
            log("  " + why)
            reasons.append(why)
            continue
        log(f"  {engine.name} passed real synthesis test")
        chunk_paths: List[str] = []
        chunk_dur: List[float] = []
        chunk_pauses: List[int] = []
        engine_failed = False
        engine_fail_reason = ""
        for ci, chunk in enumerate(chunks):
            label = f"chunk {ci + 1}/{len(chunks)} (engine {engine.name})"
            chunk_ok = False
            last_err = ""
            for attempt in range(1, RETRIES_PER_CHUNK_PER_ENGINE + 1):
                sanitized = (sanitize_attempt_1 if attempt == 1
                             else sanitize_attempt_2 if attempt == 2
                             else sanitize_attempt_3)(chunk["text"])
                if not sanitized:
                    last_err = "empty text after sanitize"
                    continue
                out_path = ffmpeg_tools.tmp_audio_file(".wav")
                try:
                    r = engine.synthesize_chunk(sanitized, out_path)
                    log(f"  {label} attempt {attempt}: {r['durationSec']:.2f}s, "
                        f"{round(r['bytes'] / 1024)}KB")
                    chunk_paths.append(out_path)
                    chunk_dur.append(r["durationSec"])
                    chunk_pauses.append(chunk["pauseAfterMs"])
                    chunk_ok = True
                    break
                except Exception as err:  # noqa: BLE001
                    last_err = str(err)
                    log(f"  {label} attempt {attempt} FAILED: {last_err}")
                    _silent_unlink(out_path)
                    if re.search(r"server unreachable|connection refused", last_err, re.I):
                        break
            if not chunk_ok:
                engine_failed = True
                engine_fail_reason = (f"{engine.name} failed {label}: {last_err} | "
                                      f"text: \"{chunk['text'][:60]}\"")
                log("  " + engine_fail_reason)
                log(f"  Abandoning {engine.name} and trying next engine...")
                break
        if engine_failed:
            for p in chunk_paths:
                _silent_unlink(p)
            reasons.append(engine_fail_reason)
            continue
        log(f"  {engine.name} synthesized all {len(chunks)} chunks successfully")
        return {"ok": True, "engineUsed": engine.name, "chunkPaths": chunk_paths,
                "perChunkDurations": chunk_dur, "pauseAfterMs": chunk_pauses}
    return {"ok": False, "reasons": reasons}


def _concat_with_pauses(file_paths: List[str], pause_after_ms: List[int], out_path: str) -> None:
    if len(file_paths) != len(pause_after_ms):
        raise ValueError("pauseAfterMs length must equal filePaths length")
    if not file_paths:
        raise ValueError("no inputs")
    if len(file_paths) == 1:
        import shutil
        shutil.copyfile(file_paths[0], out_path)
        return
    silence_by_ms: Dict[int, str] = {}
    try:
        for i in range(len(file_paths) - 1):
            ms = pause_after_ms[i]
            if ms > 1 and ms not in silence_by_ms:
                sp = ffmpeg_tools.tmp_audio_file(".wav")
                ffmpeg_tools.generate_silence(ms / 1000, sp)
                silence_by_ms[ms] = sp
        interleaved: List[str] = []
        for i, p in enumerate(file_paths):
            interleaved.append(p)
            if i < len(file_paths) - 1:
                sp = silence_by_ms.get(pause_after_ms[i])
                if sp:
                    interleaved.append(sp)
        ffmpeg_tools.concat_wavs(interleaved, out_path)
    finally:
        for sp in silence_by_ms.values():
            _silent_unlink(sp)


def _write_debug_dump(name: str, payload: Any) -> None:
    try:
        d = os.path.join(BASE_DIR, "debug", "tts")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name + ".json"), "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except Exception:
        pass


def generate_voice(
    text: str,
    presetId: str,
    pitch: Optional[float] = None,
    rate: Optional[float] = None,
    speed: Optional[float] = None,
    volume: Optional[float] = None,
    intensity: Optional[float] = None,
    preview: bool = False,
    throatDepth: Optional[float] = None,
    ancientRasp: Optional[float] = None,
    royalPace: Optional[float] = None,
    chamberSpace: Optional[float] = None,
    logger: Optional[Logger] = None,
    safeMode: bool = False,
) -> Dict[str, Any]:
    log: Logger = logger or (lambda s: None)
    preset = find_preset(presetId)
    if not preset:
        raise RuntimeError(f"Unknown preset: {presetId}")
    defaults = preset.get("defaults") or {}

    is_cinematic = bool(_CINEMATIC_RE.search(preset.get("id") or ""))
    if royalPace and royalPace > 0:
        pause_cfg = pause_config_from_royal_pace(royalPace)
    else:
        pause_cfg = CINEMATIC_PAUSES if is_cinematic else DEFAULT_PAUSES
    prepared = prepare_string(text, pause_cfg)
    spd = speed if speed is not None else defaults.get("speed", 1.0)

    if preview:
        joined = " ".join(c["text"] for c in prepared["ttsChunks"])
        truncated = truncate_for_preview(joined, 12, spd)
        chunks = [{"originalLineIndex": 0, "text": format_script(truncated), "pauseAfterMs": 0}]
    else:
        chunks = build_chunk_plan(prepared["ttsChunks"], format_script)
    chunks = [c for c in chunks if c["text"] and c["text"].strip()]
    if not chunks:
        raise RuntimeError("No non-empty text to synthesize.")

    log(f"Splitting script into {len(chunks)} chunk(s)")
    engines = build_voice_ladder(preset, spd)
    log(f"Engine ladder ({len(engines)} engines):")
    for i, e in enumerate(engines):
        log(f"  {i + 1}. {e.name}")

    orch = orchestrate(chunks, engines, log)
    if not orch.get("ok"):
        debug_id = f"tts-fail-{int(time.time() * 1000)}"
        _write_debug_dump(debug_id, {
            "presetId": presetId, "presetName": preset.get("name"),
            "presetEdgeId": preset.get("edgeId"), "chunkCount": len(chunks),
            "engineLadder": [e.name for e in engines], "reasons": orch.get("reasons"),
        })
        raise RuntimeError(
            f"Every TTS engine failed. See debug/tts/{debug_id}.json. "
            f"Reasons: {' || '.join(orch.get('reasons') or [])}")
    log(f"TTS engine selected: {orch['engineUsed']}")

    cleanup = list(orch["chunkPaths"])
    try:
        concat_path = ffmpeg_tools.tmp_audio_file(".wav")
        cleanup.append(concat_path)
        _concat_with_pauses(orch["chunkPaths"], orch["pauseAfterMs"], concat_path)
        concat_dur = ffmpeg_tools.probe_duration_sec(concat_path)
        if concat_dur < MIN_FINAL_DURATION_SEC:
            raise RuntimeError(f"Concat produced {concat_dur:.2f}s of audio.")
        log(f"Merged audio duration: {concat_dur:.2f}s")

        preset_sliders = preset.get("sliders") or {}
        final_path = ffmpeg_tools.tmp_audio_file(".mp3")
        cleanup.append(final_path)

        if safeMode:
            log("Safe mode: skipping FX chain")
            fx = {"pitch": 0, "rate": 0, "speed": 1.0, "volume": 0, "intensity": 0,
                  "eq": "none", "reverb": False, "robot": False,
                  "throatDepth": 0, "ancientRasp": 0, "royalPace": 0, "chamberSpace": 0}
        else:
            fx = {
                "pitch": pitch if pitch is not None else defaults.get("pitch", 0),
                "rate": rate if rate is not None else defaults.get("rate", 0),
                "speed": speed if speed is not None else defaults.get("speed", 1.0),
                "volume": volume if volume is not None else defaults.get("volume", 0),
                "intensity": intensity if intensity is not None else defaults.get("intensity", 0),
                "eq": preset.get("eq", "none"), "reverb": preset.get("reverb", False),
                "robot": preset.get("robot", False),
                "throatDepth": throatDepth if throatDepth is not None else preset_sliders.get("throatDepth", 0),
                "ancientRasp": ancientRasp if ancientRasp is not None else preset_sliders.get("ancientRasp", 0),
                "royalPace": royalPace if royalPace is not None else preset_sliders.get("royalPace", 0),
                "chamberSpace": chamberSpace if chamberSpace is not None else preset_sliders.get("chamberSpace", 0),
            }
        ffmpeg_tools.apply_filter(concat_path, final_path, audio_fx.build_filter_chain(fx))

        final_dur = ffmpeg_tools.probe_duration_sec(final_path)
        if final_dur < MIN_FINAL_DURATION_SEC:
            raise RuntimeError(
                f"Final post-FX audio {final_dur:.2f}s - FX chain destroyed audio.")
        log(f"Final voice audio: {final_dur:.2f}s via {orch['engineUsed']}"
            + (" (safe mode)" if safeMode else ""))

        with open(final_path, "rb") as f:
            buffer = f.read()
        return {"buffer": buffer, "mimeType": "audio/mpeg", "engineUsed": orch["engineUsed"],
                "perChunkDurations": orch["perChunkDurations"], "finalDurationSec": final_dur}
    finally:
        for f in cleanup:
            _silent_unlink(f)


# ── Service wrapper (Coder pattern: class singleton + getter) ──
class KokoroTtsService:
    def generate_voice(self, **opts) -> Dict[str, Any]:
        return generate_voice(**opts)

    def list_voice_presets(self) -> List[Dict[str, Any]]:
        return list_voice_presets()

    def voice_cards(self) -> List[Dict[str, Any]]:
        """Built-in + custom presets with soft-hidden ids removed (for the picker)."""
        hidden = read_hidden_voice_ids()
        return [p for p in list_voice_presets() if str(p.get("id")) not in hidden]

    def find_preset(self, preset_id: str) -> Optional[Dict[str, Any]]:
        return find_preset(preset_id)

    def status(self) -> Dict[str, Any]:
        reachable = kokoro_client.probe_reachable()
        return {
            "local": reachable,
            "engine": "kokoro",
            "url": kokoro_client._base_url(),
            "kokoro": reachable,
        }

    def wait_ready(self, logger: Optional[Logger] = None) -> Dict[str, Any]:
        return kokoro_client.wait_ready(logger=logger)


_service: Optional[KokoroTtsService] = None


def get_tts_service() -> KokoroTtsService:
    global _service
    if _service is None:
        _service = KokoroTtsService()
    return _service
