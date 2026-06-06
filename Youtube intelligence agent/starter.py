"""App starter / preflight launcher for the YouTube Video Intelligence Agent.

Runs a series of startup checks and fixes what it can automatically, then
launches the web server. Wired to server.bat.

Checks (in order):
  1. Python version
  2. Python dependencies        (auto-installs from requirements.txt if missing)
  3. Ollama server              (auto-starts `ollama serve` if installed but down)
  4. Reasoning model            (auto-pulls if missing)
  5. ffmpeg                      (system or bundled)
  6. Port availability          (detects an already-running instance)
  7. Launch server + open browser

Everything before step 2 uses only the Python standard library, so it works
even before dependencies are installed.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

# --- config (env-overridable, server.bat sets YIA_PORT=6113) --------------
HOST = os.environ.get("YIA_HOST", "127.0.0.1")
PORT = int(os.environ.get("YIA_PORT", "6113"))
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
MODEL = os.environ.get("YIA_REASONING_MODEL", "deepseek-r1:8b")
URL = f"http://{HOST}:{PORT}"
REQUIRED = ["fastapi", "uvicorn", "httpx", "yt_dlp", "youtube_transcript_api",
            "faster_whisper", "imageio_ffmpeg", "PIL"]

# --- pretty console output -----------------------------------------------
# Make output robust whether stdout is a real console or a redirected file
# (Windows uses cp1252 for redirected stdout, which can't encode some glyphs).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if os.name == "nt":
    os.system("")  # enable ANSI escape sequences on Windows terminals


def _c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m"


def ok(s):   print("   " + _c("92", "[ OK ]") + " " + s)
def info(s): print("   " + _c("96", "[ .. ]") + " " + s)
def warn(s): print("   " + _c("93", "[WARN]") + " " + s)
def fail(s): print("   " + _c("91", "[FAIL]") + " " + s)
def step(n, total, title): print("\n" + _c("1;97", f" [{n}/{total}] {title}"))


def banner():
    line = "=" * 60
    print(_c("91", line))
    print(_c("1;97", "   YouTube Video Intelligence Agent  -  app starter"))
    print(_c("91", line))


# --- tiny stdlib HTTP ----------------------------------------------------
def http_json(url: str, timeout: float = 3.0):
    with urllib.request.urlopen(urllib.request.Request(url), timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1.0)
        return s.connect_ex((host, port)) == 0


# --- checks --------------------------------------------------------------
def check_python(total) -> None:
    step(1, total, "Python runtime")
    if sys.version_info < (3, 10):
        fail(f"Python {sys.version.split()[0]} is too old. Install Python 3.10+.")
        _abort()
    ok(f"Python {sys.version.split()[0]}")


def check_dependencies(total) -> None:
    step(2, total, "Python dependencies")
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from app import bootstrap
    if bootstrap.missing_core():
        info("Installing core dependencies from requirements.txt...")
    if not bootstrap.ensure_core_deps(lambda m: info(m)):
        fail("Dependency install failed. Run:  pip install -r requirements.txt")
        _abort()
    ok("Core dependencies installed")
    # Speech-to-text engine: CPU PyTorch (pinned known-good) + openai-whisper.
    if bootstrap.whisper_stack_ok():
        ok(f"Speech-to-text engine present (torch {bootstrap.torch_version()})")
    else:
        info("Installing speech-to-text engine (CPU PyTorch + openai-whisper, one-time)...")
        if bootstrap.ensure_whisper_stack(lambda m: info(m)):
            ok("Speech-to-text engine ready")
        else:
            warn("Whisper engine setup failed - videos with captions still work fine.")


def check_whisper_model(total) -> None:
    step(5, total, f"Whisper model ({os.environ.get('YIA_WHISPER_MODEL', 'base')})")
    try:
        from app.services import transcript
    except Exception as e:  # noqa: BLE001
        warn(f"Transcript module unavailable: {e}")
        return
    if transcript.is_whisper_cached():
        ok("Whisper model already downloaded")
        return
    info("Downloading Whisper model (one-time)...")
    if transcript.ensure_whisper_model(lambda m: info(m)):
        ok("Whisper model ready")
    else:
        warn("Whisper model not downloaded; it will retry on the first no-caption video.")


def _ollama_up() -> bool:
    try:
        http_json(f"{OLLAMA_URL}/api/tags", timeout=3)
        return True
    except Exception:
        return False


def check_ollama(total) -> bool:
    step(3, total, "Ollama server")
    if _ollama_up():
        ok(f"Ollama is running at {OLLAMA_URL}")
        return True
    if not shutil.which("ollama"):
        warn("Ollama is not installed. AI features (summaries, clips, scripts) "
             "will be unavailable. Get it at https://ollama.com")
        return False
    info("Ollama is installed but not running — starting 'ollama serve'...")
    try:
        flags = 0x00000008 if os.name == "nt" else 0  # DETACHED_PROCESS
        subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, creationflags=flags)
    except Exception as e:  # noqa: BLE001
        warn(f"Could not start Ollama automatically: {e}")
        return False
    for _ in range(30):
        if _ollama_up():
            ok("Ollama server started")
            return True
        time.sleep(1)
    warn("Ollama did not respond in time. AI features may be unavailable.")
    return False


def _models() -> list[str]:
    try:
        return [m.get("name", "") for m in http_json(f"{OLLAMA_URL}/api/tags").get("models", [])]
    except Exception:
        return []


def _has_model(models: list[str], want: str) -> bool:
    base = want.split(":")[0]
    return any(m == want or m.split(":")[0] == base for m in models)


def check_model(total, ollama_ok: bool) -> None:
    step(4, total, f"Reasoning model ({MODEL})")
    if not ollama_ok:
        warn("Skipped — Ollama is not available.")
        return
    if _has_model(_models(), MODEL):
        ok(f"Model '{MODEL}' is available")
        return
    warn(f"Model '{MODEL}' not found locally.")
    info(f"Pulling '{MODEL}' now (this is a multi-GB download; Ctrl+C to skip)...")
    try:
        subprocess.call(["ollama", "pull", MODEL])
    except KeyboardInterrupt:
        warn("Skipped model download. Pull it later with:  ollama pull " + MODEL)
        return
    except Exception as e:  # noqa: BLE001
        warn(f"Auto-pull failed: {e}. Run:  ollama pull {MODEL}")
        return
    if _has_model(_models(), MODEL):
        ok(f"Model '{MODEL}' is ready")
    else:
        warn("Model still not detected; AI features may not work.")


def check_ffmpeg(total) -> None:
    step(6, total, "ffmpeg (frame extraction)")
    exe = shutil.which("ffmpeg")
    if exe:
        ok(f"Using system ffmpeg: {exe}")
        return
    try:
        import imageio_ffmpeg
        ok(f"Using bundled ffmpeg: {imageio_ffmpeg.get_ffmpeg_exe()}")
    except Exception:
        warn("ffmpeg not found. Frame extraction will be unavailable.")


def check_port(total) -> None:
    step(7, total, f"Port {PORT}")
    if not port_in_use(HOST, PORT):
        ok(f"Port {PORT} is free")
        return
    # Something is already on the port — is it us?
    try:
        h = http_json(f"{URL}/api/health", timeout=2)
        if h.get("config", {}).get("version"):
            ok(f"The agent is already running on {PORT} — opening it in your browser.")
            webbrowser.open(URL)
            print()
            sys.exit(0)
    except Exception:
        pass
    fail(f"Port {PORT} is in use by another program. "
         f"Close it or pick another port:  set YIA_PORT=<port>  before launching.")
    _abort()


def launch(total) -> None:
    step(total, total, "Launch web server")
    os.environ["YIA_PORT"] = str(PORT)
    os.environ["YIA_HOST"] = HOST
    from app import database
    database.init_db()
    ok("Database ready")
    print()
    print(_c("92", "   All systems go.") + "  Open  " + _c("1;96", URL))
    print(_c("90", "   (a browser tab will open automatically - press Ctrl+C here to stop)"))
    print(_c("91", "=" * 60))

    import threading
    import uvicorn
    threading.Timer(1.6, lambda: _safe_open(URL)).start()
    uvicorn.run("app.server:app", host=HOST, port=PORT, log_level="info")


def _safe_open(url: str) -> None:
    try:
        webbrowser.open(url)
    except Exception:
        pass


def _abort() -> None:
    print()
    fail("Startup aborted.")
    try:
        input("Press Enter to close...")
    except (EOFError, KeyboardInterrupt):
        pass
    sys.exit(1)


def main() -> None:
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    banner()
    total = 8
    check_python(total)
    check_dependencies(total)
    ollama_ok = check_ollama(total)
    check_model(total, ollama_ok)
    check_whisper_model(total)
    check_ffmpeg(total)
    check_port(total)
    launch(total)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n" + _c("93", "Stopped."))
