"""
Kokoro TTS HTTP server for Trend Vault.

Exposes POST /tts that accepts JSON {text, voice, speed} and returns audio/wav.
The frontend sends Edge-style voice IDs (e.g. "en-US-DavisNeural"); we translate
them to Kokoro voice ids via VOICE_MAP. Speed is the Kokoro speed multiplier.

Start with:
    start-kokoro.bat      (Windows)
    python kokoro_server.py  (manual)

Listens on http://127.0.0.1:5070 by default. Override with env:
    KOKORO_PORT=5070
    KOKORO_HOST=127.0.0.1
    KOKORO_MODEL=kokoro-v0_19.onnx
    KOKORO_VOICES=voices.bin

The Trend Vault Node server reaches this via LOCAL_TTS_URL=http://localhost:5070
(see .env.all).
"""
from __future__ import annotations

import io
import os
import sys
import logging
from pathlib import Path

from flask import Flask, jsonify, request, send_file

try:
    from kokoro_onnx import Kokoro
except ImportError:
    print("ERROR: kokoro-onnx is not installed. Run setup-kokoro.bat first.", file=sys.stderr)
    sys.exit(1)

try:
    import soundfile  # noqa: F401  (used indirectly via Kokoro internals)
except ImportError:
    print("ERROR: soundfile is not installed. Run setup-kokoro.bat first.", file=sys.stderr)
    sys.exit(1)

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
MODEL_PATH  = HERE / os.environ.get("KOKORO_MODEL",  "kokoro-v0_19.onnx")
VOICES_PATH = HERE / os.environ.get("KOKORO_VOICES", "voices.bin")
HOST = os.environ.get("KOKORO_HOST", "127.0.0.1")
PORT = int(os.environ.get("KOKORO_PORT", "5070"))

# Edge Neural voice id -> Kokoro voice id.
# Kokoro v0.19 ships ~10 American/British voices; we map every Edge preset
# used in voicePresets.json to its closest match. Add new entries as voices
# are introduced.
VOICE_MAP: dict[str, str] = {
    # American — female
    "en-US-AriaNeural":    "af_bella",
    "en-US-JennyNeural":   "af_sarah",
    "en-US-EmmaNeural":    "af_nicole",
    "en-US-MonicaNeural":  "af_sky",
    "en-US-JaneNeural":    "af_nicole",
    # American — male
    "en-US-GuyNeural":     "am_michael",
    "en-US-DavisNeural":   "am_adam",
    "en-US-EricNeural":    "am_adam",
    "en-US-ChristopherNeural": "am_michael",
    "en-US-JasonNeural":   "am_michael",
    "en-US-AndrewNeural":  "am_adam",
    "en-US-BrianNeural":   "am_michael",
    "en-US-RogerNeural":   "am_adam",
    "en-US-SteffanNeural": "am_michael",
    "en-US-TonyNeural":    "am_adam",
    # British
    "en-GB-RyanNeural":    "bm_george",
    "en-GB-ThomasNeural":  "bm_lewis",
}
DEFAULT_VOICE = "af_bella"

logging.basicConfig(level=logging.INFO, format="[kokoro] %(message)s")
log = logging.getLogger(__name__)

if not MODEL_PATH.exists() or not VOICES_PATH.exists():
    log.error("Model files not found. Expected:")
    log.error("  %s", MODEL_PATH)
    log.error("  %s", VOICES_PATH)
    log.error("Run setup-kokoro.bat to download them.")
    sys.exit(2)

log.info("Loading Kokoro model from %s", MODEL_PATH)
kokoro = Kokoro(str(MODEL_PATH), str(VOICES_PATH))
log.info("Model loaded. Voices available: %d", len(getattr(kokoro, "voices", []) or []))

app = Flask(__name__)


def resolve_voice(requested: str | None) -> str:
    if not requested:
        return DEFAULT_VOICE
    # Pass-through if it already looks like a Kokoro id (e.g. "af_bella")
    if "_" in requested and not requested.startswith("en-"):
        return requested
    return VOICE_MAP.get(requested, DEFAULT_VOICE)


@app.get("/")
def health():
    return jsonify({
        "ok": True,
        "engine": "kokoro",
        "model": MODEL_PATH.name,
        "voices_mapped": len(VOICE_MAP),
    })


@app.post("/tts")
def tts():
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400

    voice = resolve_voice(data.get("voice"))
    try:
        speed = float(data.get("speed", 1.0))
    except (TypeError, ValueError):
        speed = 1.0
    speed = max(0.5, min(2.0, speed))

    try:
        audio, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
    except Exception as e:
        log.exception("Kokoro synthesis failed")
        return jsonify({"error": f"synthesis failed: {e}"}), 500

    audio = np.asarray(audio, dtype="float32")
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return send_file(buf, mimetype="audio/wav", as_attachment=False, download_name="tts.wav")


@app.get("/voices")
def voices():
    return jsonify({"map": VOICE_MAP, "default": DEFAULT_VOICE})


if __name__ == "__main__":
    log.info("Running on http://%s:%s", HOST, PORT)
    app.run(host=HOST, port=PORT, threaded=True)
