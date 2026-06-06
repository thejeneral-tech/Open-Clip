"""First-run installer for the YouTube Video Intelligence Agent.

Downloads and verifies EVERYTHING needed to run the full pipeline on this
machine, then you can start it with server.bat:

  1. Upgrade pip
  2. Core Python dependencies (web, yt-dlp, media)         -> requirements.txt
  3. Speech-to-text engine (CPU PyTorch + openai-whisper)  -> pinned known-good
  4. Verify imports
  5. ffmpeg (bundled binary)
  6. Whisper speech-to-text model                          -> ~150 MB
  7. Ollama reasoning model (deepseek-r1:8b)               -> ~5 GB

Run:  python install.py            (or double-click install.bat)
      python install.py --vision   (also pull a local vision model)
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
sys.path.insert(0, ROOT)

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
MODEL = os.environ.get("YIA_REASONING_MODEL", "deepseek-r1:8b")
WHISPER_MODEL = os.environ.get("YIA_WHISPER_MODEL", "base")
WANT_VISION = "--vision" in sys.argv
VISION_MODEL = os.environ.get("YIA_VISION_MODEL", "moondream")

# --- ascii-safe colored output ------------------------------------------
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if os.name == "nt":
    os.system("")


def _c(code, s): return f"\033[{code}m{s}\033[0m"
def ok(s):   print("   " + _c("92", "[ OK ]") + " " + s)
def info(s): print("   " + _c("96", "[ .. ]") + " " + s)
def warn(s): print("   " + _c("93", "[WARN]") + " " + s)
def fail(s): print("   " + _c("91", "[FAIL]") + " " + s)
def step(t): print("\n" + _c("1;97", " " + t))


def http_json(url, timeout=4):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _ollama_models():
    try:
        return [m.get("name", "") for m in http_json(f"{OLLAMA_URL}/api/tags").get("models", [])]
    except Exception:
        return None


def _has_model(models, want):
    base = want.split(":")[0]
    return any(m == want or m.split(":")[0] == base for m in models)


def main() -> int:
    print(_c("91", "=" * 64))
    print(_c("1;97", "   YouTube Video Intelligence Agent  -  first-run installer"))
    print(_c("91", "=" * 64))

    # 1) pip
    step("[1/7] Upgrade pip")
    subprocess.call([sys.executable, "-m", "pip", "install", "--upgrade", "pip"])
    ok("pip is up to date")

    # 2) core deps
    step("[2/7] Core dependencies (web, yt-dlp, media)")
    from app import bootstrap
    if bootstrap.ensure_core_deps(info):
        ok("Core dependencies installed")
    else:
        fail("Core dependency install failed. See errors above.")
        return _end(1)

    # 3) whisper engine
    step("[3/7] Speech-to-text engine (CPU PyTorch + openai-whisper)")
    info("Largest download (a few hundred MB) - please wait...")
    if bootstrap.ensure_whisper_stack(info):
        ok(f"Whisper engine ready (torch {bootstrap.torch_version()})")
    else:
        warn("Whisper engine setup failed. Captioned videos still work; videos "
             "without captions won't transcribe until this succeeds.")

    # 4) verify
    step("[4/7] Verify imports")
    missing = [m for m in ["fastapi", "uvicorn", "yt_dlp", "youtube_transcript_api",
                           "imageio_ffmpeg", "PIL"] if importlib.util.find_spec(m) is None]
    if missing:
        warn("Missing modules: " + ", ".join(missing))
    else:
        ok("All core modules import")
    if importlib.util.find_spec("whisper") is not None and bootstrap.torch_is_good():
        ok("Whisper modules import")

    # 5) ffmpeg
    step("[5/7] ffmpeg")
    from app.ffmpeg_utils import ensure_ffmpeg_on_path, ffmpeg_path
    p = ffmpeg_path()
    if p:
        ensure_ffmpeg_on_path()
        ok("ffmpeg available")
    else:
        warn("ffmpeg not found (frame extraction will be unavailable)")

    # 6) whisper model
    step(f"[6/7] Whisper model ({WHISPER_MODEL})")
    try:
        from app.services import transcript
        if transcript.ensure_whisper_model(info):
            ok(f"Whisper model '{WHISPER_MODEL}' downloaded")
        else:
            warn("Whisper model not downloaded; it will retry on first use.")
    except Exception as e:  # noqa: BLE001
        warn(f"Could not pre-download Whisper model: {e}")

    # 7) ollama model
    step(f"[7/7] Ollama reasoning model ({MODEL})")
    models = _ollama_models()
    if models is None:
        warn("Ollama server not reachable. Install & start Ollama "
             "(https://ollama.com), then run:  ollama pull " + MODEL)
    elif _has_model(models, MODEL):
        ok(f"Reasoning model '{MODEL}' is present")
    elif shutil.which("ollama"):
        info(f"Pulling '{MODEL}' (multi-GB, one-time)...")
        subprocess.call(["ollama", "pull", MODEL])
        ok(f"Reasoning model '{MODEL}' ready") if _has_model(_ollama_models() or [], MODEL) \
            else warn("Model pull may have failed; retry: ollama pull " + MODEL)
    else:
        warn("Ollama CLI not found. Install Ollama, then:  ollama pull " + MODEL)

    if WANT_VISION:
        step(f"[+] Optional vision model ({VISION_MODEL})")
        if shutil.which("ollama"):
            subprocess.call(["ollama", "pull", VISION_MODEL])
            ok(f"Vision model '{VISION_MODEL}' pulled")
        else:
            warn("Ollama CLI not found; cannot pull vision model.")

    print()
    print(_c("91", "=" * 64))
    print(_c("92", "   Install complete.") + "  Start the app with  " + _c("1;96", "server.bat"))
    print(_c("90", "   (or:  python starter.py)"))
    print(_c("91", "=" * 64))
    return _end(0)


def _end(code: int) -> int:
    try:
        input("\nPress Enter to close...")
    except (EOFError, KeyboardInterrupt):
        pass
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nInstall cancelled.")
        sys.exit(1)
