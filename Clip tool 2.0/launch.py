#!/usr/bin/env python3
"""
OpenClip launcher 🎬

A themed, dependency-free control panel for the **local** OpenClip stack — no
Docker required. It manages four native processes:

    • api       FastAPI / Uvicorn        (http://localhost:8000)
    • worker    Celery (filesystem queue, SQLite results)
    • frontend  Next.js dev server       (http://localhost:3000)
    • ollama    local LLM runtime        (http://localhost:11434)

Run it with no arguments for an interactive menu, or use subcommands directly:

    python launch.py setup       # create venv, install deps, init the database
    python launch.py up          # start everything, wait, open the browser
    python launch.py down        # stop the stack
    python launch.py status      # service + health overview
    python launch.py logs [svc]  # tail logs
    python launch.py doctor      # check prerequisites
    python launch.py open        # open the app in your browser
    python launch.py nuke        # delete the local database + media (destructive)

The launcher itself is pure standard library — no pip install required. It builds
an isolated virtualenv under ``backend/.venv`` for the backend dependencies.
"""
from __future__ import annotations

import argparse
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
VENV = BACKEND / ".venv"
DATA = ROOT / "data"
RUN_DIR = DATA / "run"
LOG_DIR = DATA / "logs"

API_PORT = 8000
WEB_PORT = 3000
OLLAMA_PORT = 11434
# uvicorn binds IPv4 127.0.0.1; probe that directly so health checks don't first
# try IPv6 ::1 (which "localhost" resolves to on Windows) and stall ~2s per try.
LOOPBACK = "127.0.0.1"

IS_WIN = os.name == "nt"
PROD = False

# --------------------------------------------------------------------------- #
#  Theme
# --------------------------------------------------------------------------- #
PRIMARY = (139, 92, 246)     # violet  #8b5cf6  (matches the dashboard --primary)
PRIMARY_LT = (167, 139, 250)  # light violet
PINK = (236, 72, 153)        # gradient end
ACCENT = (34, 211, 238)      # cyan
C_OK = (16, 185, 129)        # emerald
C_WARN = (245, 158, 11)      # amber
C_ERR = (244, 63, 94)        # rose
C_DIM = (148, 163, 184)      # slate


def _setup_io() -> None:
    """Force UTF-8 output so emoji / box-drawing never crash on cp1252 consoles."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:
            pass


def _supports_color() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    if not sys.stdout.isatty():
        return False
    if IS_WIN:
        try:
            import ctypes

            kernel32 = ctypes.windll.kernel32
            # Enable ENABLE_VIRTUAL_TERMINAL_PROCESSING (0x4) on stdout.
            kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
        except Exception:
            return False
    return True


COLOR = _supports_color()


def paint(text: str, rgb: tuple[int, int, int], bold: bool = False) -> str:
    if not COLOR:
        return text
    r, g, b = rgb
    prefix = ("\x1b[1m" if bold else "") + f"\x1b[38;2;{r};{g};{b}m"
    return f"{prefix}{text}\x1b[0m"


def _lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def gradient(text: str, start: tuple[int, int, int], end: tuple[int, int, int], bold: bool = True) -> str:
    if not COLOR:
        return text
    n = max(1, len(text) - 1)
    out = []
    for i, ch in enumerate(text):
        if ch == " ":
            out.append(ch)
            continue
        t = i / n
        rgb = (_lerp(start[0], end[0], t), _lerp(start[1], end[1], t), _lerp(start[2], end[2], t))
        out.append(paint(ch, rgb, bold))
    return "".join(out)


BANNER = r"""
 ██████╗ ██████╗ ███████╗███╗   ██╗ ██████╗██╗     ██╗██████╗
██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔════╝██║     ██║██╔══██╗
██║   ██║██████╔╝█████╗  ██╔██╗ ██║██║     ██║     ██║██████╔╝
██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██║     ██║     ██║██╔═══╝
╚██████╔╝██║     ███████╗██║ ╚████║╚██████╗███████╗██║██║
 ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝ ╚═════╝╚══════╝╚═╝╚═╝
"""


def banner() -> None:
    print()
    for line in BANNER.strip("\n").splitlines():
        print(gradient(line, PRIMARY_LT, PINK))
    tagline = "  self-hosted AI short-form studio"
    sub = "  🎬  local Python stack · Ollama + Whisper · no Docker"
    print(paint(tagline, PRIMARY_LT, bold=True))
    print(paint(sub, C_DIM))
    print(paint("  " + "─" * 56, PRIMARY))
    print()


# --------------------------------------------------------------------------- #
#  Status line helpers
# --------------------------------------------------------------------------- #
def ok(msg: str) -> None:
    print(f"  {paint('✓', C_OK, bold=True)} {msg}")


def warn(msg: str) -> None:
    print(f"  {paint('⚠', C_WARN, bold=True)} {msg}")


def err(msg: str) -> None:
    print(f"  {paint('✗', C_ERR, bold=True)} {msg}")


def step(msg: str) -> None:
    print(f"  {paint('▸', PRIMARY_LT, bold=True)} {msg}")


def info(msg: str) -> None:
    print(f"  {paint('•', C_DIM)} {paint(msg, C_DIM)}")


class Spinner:
    """A small violet spinner for quiet waits."""

    FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

    def __init__(self, text: str) -> None:
        self.text = text
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self) -> "Spinner":
        if COLOR:
            self._thread = threading.Thread(target=self._spin, daemon=True)
            self._thread.start()
        else:
            print(f"  … {self.text}")
        return self

    def _spin(self) -> None:
        i = 0
        while not self._stop.is_set():
            frame = self.FRAMES[i % len(self.FRAMES)]
            sys.stdout.write(f"\r  {paint(frame, PRIMARY_LT, bold=True)} {self.text}   ")
            sys.stdout.flush()
            i += 1
            time.sleep(0.08)

    def __exit__(self, *exc) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join()
            sys.stdout.write("\r" + " " * (len(self.text) + 8) + "\r")
            sys.stdout.flush()


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _vis(s: str) -> int:
    """Visible length of a string, ignoring ANSI colour codes."""
    return len(_ANSI_RE.sub("", s))


def panel(title: str, rows: list[tuple[str, str]], color: tuple[int, int, int] = PRIMARY) -> None:
    label_w = max((_vis(r[0]) for r in rows), default=0)
    head = " " + paint(title, color, bold=True)
    body = [f" {label}{' ' * (label_w - _vis(label))}  {value}" for label, value in rows]
    width = max([_vis(head)] + [_vis(b) for b in body]) + 1
    bar = paint("│", color)
    print("  " + paint("╭" + "─" * width + "╮", color))
    print("  " + bar + head + " " * (width - _vis(head)) + bar)
    print("  " + paint("├" + "─" * width + "┤", color))
    for b in body:
        print("  " + bar + b + " " * (width - _vis(b)) + bar)
    print("  " + paint("╰" + "─" * width + "╯", color))


# --------------------------------------------------------------------------- #
#  Shell helpers
# --------------------------------------------------------------------------- #
def which(name: str) -> str | None:
    return shutil.which(name)


def _node_bin_dir() -> str | None:
    """Find the directory containing the ``node``/``npm`` executables.

    Version managers (nvm, fnm, Volta, ``n``) install Node under the user's home
    and only add their bin dir to PATH from an interactive shell's init files.
    The launcher is frequently started from a context that never sourced those
    (an IDE, a ``.desktop`` entry, a login shell, ``sudo``), so PATH alone isn't
    enough — fall back to scanning the usual version-manager locations.
    """
    found = shutil.which("npm") or shutil.which("node")
    if found:
        return os.path.dirname(found)

    home = Path.home()
    search: list[Path] = []
    search += sorted(home.glob(".nvm/versions/node/*/bin"), reverse=True)
    search += sorted(home.glob(".fnm/node-versions/*/installation/bin"), reverse=True)
    search += sorted(home.glob(".local/share/fnm/node-versions/*/installation/bin"), reverse=True)
    search += [home / ".volta" / "bin", home / "n" / "bin",
               Path("/usr/local/bin"), Path("/opt/homebrew/bin")]
    npm_name = "npm.cmd" if IS_WIN else "npm"
    for d in search:
        if (d / npm_name).exists():
            return str(d)
    return None


def ensure_node_on_path() -> None:
    """Make node/npm discoverable even when launched outside an nvm/fnm shell.

    Prepends the resolved node bin dir to ``PATH`` so both ``which()`` checks and
    every spawned service (which inherit this process's environment) can find
    ``npm`` — fixing the common "npm not found" failure on Linux/macOS where Node
    came from a version manager.
    """
    if shutil.which("npm"):
        return
    bin_dir = _node_bin_dir()
    if bin_dir:
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")


def run(cmd: list[str], capture: bool = False, cwd: Path | None = None,
        env: dict | None = None) -> tuple[int, str]:
    """Run a command. When capture=False the output streams to the terminal.

    Missing executables return code 127 instead of raising, so callers can probe
    for tools without try/except everywhere.
    """
    try:
        if capture:
            p = subprocess.run(cmd, cwd=cwd or ROOT, env=env, capture_output=True, text=True)
            return p.returncode, (p.stdout or "") + (p.stderr or "")
        return subprocess.call(cmd, cwd=cwd or ROOT, env=env), ""
    except FileNotFoundError:
        return 127, ""
    except OSError as exc:
        return 1, str(exc)


def http_ok(url: str, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return 200 <= resp.status < 500
    except Exception:
        return False


def wait_for(url: str, timeout: int = 180) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if http_ok(url):
            return True
        time.sleep(2)
    return False


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


# --------------------------------------------------------------------------- #
#  Interpreter / venv discovery
# --------------------------------------------------------------------------- #
COMPAT_MIN = (3, 10)
COMPAT_MAX = (3, 12)  # inclusive — the ML wheels lag newer Pythons


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if IS_WIN else "bin/python")


def _py_version(python: str) -> tuple[int, int] | None:
    code, out = run([python, "-c", "import sys;print('%d.%d' % sys.version_info[:2])"], capture=True)
    if code != 0:
        return None
    m = re.search(r"(\d+)\.(\d+)", out)
    return (int(m.group(1)), int(m.group(2))) if m else None


def _compatible(ver: tuple[int, int] | None) -> bool:
    return bool(ver) and COMPAT_MIN <= ver <= COMPAT_MAX


def find_base_python() -> tuple[str | None, tuple[int, int] | None]:
    """Find a Python 3.10–3.12 interpreter to build the backend venv from."""
    override = os.environ.get("OPENCLIP_PYTHON")
    if override:
        return override, _py_version(override)

    # Windows `py` launcher: enumerate every installed interpreter.
    if which("py"):
        code, out = run(["py", "-0p"], capture=True)
        if code == 0:
            found: list[tuple[tuple[int, int], str]] = []
            for line in out.splitlines():
                vm = re.search(r"(\d+)\.(\d+)", line)
                pm = re.search(r"[A-Za-z]:\\[^\r\n]*?python\.exe", line)
                if vm and pm:
                    ver = (int(vm.group(1)), int(vm.group(2)))
                    if _compatible(ver):
                        found.append((ver, pm.group(0)))
            if found:
                found.sort(reverse=True)  # newest compatible
                return found[0][1], found[0][0]

    # POSIX / generic command names.
    for name in ("python3.12", "python3.11", "python3.10", "python3", "python"):
        p = which(name)
        if p:
            ver = _py_version(p)
            if _compatible(ver):
                return p, ver

    # Fall back to the interpreter running this script.
    return sys.executable, _py_version(sys.executable)


# --------------------------------------------------------------------------- #
#  Environment / .env handling
# --------------------------------------------------------------------------- #
def read_env() -> dict[str, str]:
    env_path = ROOT / ".env"
    data: dict[str, str] = {}
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if line and "=" in line:
                k, v = line.split("=", 1)
                data[k.strip()] = v.strip()
    return data


def ensure_env() -> None:
    env_path = ROOT / ".env"
    example = ROOT / ".env.example"
    if env_path.exists():
        ok(".env present")
        return
    if not example.exists():
        err(".env.example missing — cannot bootstrap configuration")
        return
    text = example.read_text(encoding="utf-8")
    text = re.sub(r"^SECRET_KEY=.*$", f"SECRET_KEY={secrets.token_urlsafe(64)}", text, flags=re.M)
    env_path.write_text(text, encoding="utf-8")
    ok("Created .env from template with a fresh SECRET_KEY")


def child_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Environment for child processes: OS env + .env file + per-service extras."""
    env = {**os.environ, **read_env(), **(extra or {})}
    env.setdefault("PYTHONUNBUFFERED", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return env


def public_ws_url() -> str:
    """Browser-facing WebSocket URL for live progress.

    Defaults to the direct local backend (works for a plain ``localhost`` run).
    Set ``PUBLIC_WS_URL`` in ``.env`` — e.g. a ``wss://`` tailnet address fronted
    by ``tailscale serve`` — when the app is reached over a domain instead, since
    a page served over HTTPS can't open an insecure ``ws://localhost`` socket.
    """
    return read_env().get("PUBLIC_WS_URL") or f"ws://localhost:{API_PORT}/api/v1/ws"


def write_frontend_env() -> None:
    """Point the Next.js dev server at the local backend (API proxied, WS direct)."""
    local = FRONTEND / ".env.local"
    content = (
        "# Auto-generated by launch.py — local dev settings.\n"
        "# API + media are proxied through Next (see next.config.js rewrites);\n"
        "# the WebSocket connects straight to the backend (or PUBLIC_WS_URL).\n"
        f"BACKEND_INTERNAL_URL=http://localhost:{API_PORT}\n"
        f"NEXT_PUBLIC_WS_URL={public_ws_url()}\n"
    )
    if not local.exists() or local.read_text(encoding="utf-8") != content:
        local.write_text(content, encoding="utf-8")


def app_url() -> str:
    return f"http://localhost:{WEB_PORT}"


# --------------------------------------------------------------------------- #
#  Process supervisor (detached, pid-file based)
# --------------------------------------------------------------------------- #
def _pid_file(name: str) -> Path:
    return RUN_DIR / f"{name}.pid"


def _read_pid(name: str) -> int | None:
    f = _pid_file(name)
    if f.exists():
        try:
            return int(f.read_text().strip())
        except ValueError:
            return None
    return None


def pid_alive(pid: int) -> bool:
    if IS_WIN:
        code, out = run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture=True)
        return code == 0 and str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def is_running(name: str) -> bool:
    pid = _read_pid(name)
    return bool(pid and pid_alive(pid))


def start_service(name: str, cmd: list[str], cwd: Path, env: dict) -> bool:
    if is_running(name):
        info(f"{name} already running")
        return True
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    log = open(LOG_DIR / f"{name}.log", "ab")
    kwargs: dict = dict(cwd=str(cwd), env=env, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    if IS_WIN:
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    else:
        kwargs["start_new_session"] = True
    try:
        p = subprocess.Popen(cmd, **kwargs)
    except FileNotFoundError:
        err(f"Cannot start {name}: {cmd[0]} not found")
        return False
    _pid_file(name).write_text(str(p.pid))
    # Surface an immediate crash (bad command, missing dep) instead of pretending success.
    time.sleep(0.6)
    if p.poll() is not None:
        err(f"{name} exited immediately (see `logs {name}`)")
        _pid_file(name).unlink(missing_ok=True)
        return False
    ok(f"{name} started (pid {p.pid})")
    return True


def stop_service(name: str) -> None:
    pid = _read_pid(name)
    if not pid:
        return
    if pid_alive(pid):
        if IS_WIN:
            run(["taskkill", "/F", "/T", "/PID", str(pid)], capture=True)
        else:
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
                time.sleep(1.0)
                if pid_alive(pid):
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
            except OSError:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
    _pid_file(name).unlink(missing_ok=True)


# --------------------------------------------------------------------------- #
#  Service definitions
# --------------------------------------------------------------------------- #
def npm_argv(*args: str) -> list[str]:
    """npm is a .cmd on Windows, which needs to run through the shell.

    On POSIX, resolve npm to an absolute path (``ensure_node_on_path`` has
    already augmented PATH) so spawning works even when npm lives in a
    version-manager bin dir rather than a system one.
    """
    if IS_WIN:
        return [os.environ.get("COMSPEC", "cmd.exe"), "/c", "npm", *args]
    return [shutil.which("npm") or "npm", *args]


def api_cmd() -> list[str]:
    return [
        str(venv_python()), "-m", "uvicorn", "app.main:app",
        "--host", "127.0.0.1", "--port", str(API_PORT),
    ]


def worker_cmd() -> list[str]:
    cmd = [
        str(venv_python()), "-m", "celery", "-A", "app.workers.celery_app", "worker",
        "--loglevel=info", "-Q", "default,media,ai,bots",
    ]
    if IS_WIN:
        # Prefork (the default) doesn't work on Windows; solo runs one job at a time.
        cmd.append("--pool=solo")
    else:
        conc = read_env().get("WORKER_CONCURRENCY", "2")
        cmd.append(f"--concurrency={conc}")
    return cmd


def frontend_cmd() -> list[str]:
    return npm_argv("run", "start" if PROD else "dev")


# --------------------------------------------------------------------------- #
#  Setup
# --------------------------------------------------------------------------- #
def _setup_done() -> bool:
    return venv_python().exists() and (FRONTEND / "node_modules").exists()


def cmd_setup(_=None) -> bool:
    step("Setting up the local stack")
    healthy = True

    # 1. Backend virtualenv -------------------------------------------------
    base_py, ver = find_base_python()
    if not base_py:
        err("No Python interpreter found. Install Python 3.10–3.12.")
        return False
    vlabel = f"{ver[0]}.{ver[1]}" if ver else "?"
    if not _compatible(ver):
        warn(f"Using Python {vlabel}; 3.10–3.12 is recommended (some ML wheels lack "
             f"newer builds). Set OPENCLIP_PYTHON to override.")

    # A venv whose `python` merely *exists* isn't enough: a pip-less venv (common
    # on Debian when python3-venv/ensurepip isn't installed) or one built from an
    # incompatible interpreter would wedge the dependency install below. Validate
    # and repair/rebuild before trusting it.
    def _venv_has_pip() -> bool:
        if not venv_python().exists():
            return False
        rc, _ = run([str(venv_python()), "-m", "pip", "--version"], capture=True)
        return rc == 0

    needs_create = not venv_python().exists()
    if not needs_create and not _venv_has_pip():
        with Spinner("Repairing venv (bootstrapping pip via ensurepip)"):
            run([str(venv_python()), "-m", "ensurepip", "--upgrade"], capture=True)
        if not _venv_has_pip():
            warn("Existing venv has no pip and ensurepip failed — rebuilding it")
            needs_create = True
    if not needs_create:
        venv_ver = _py_version(str(venv_python()))
        if not _compatible(venv_ver) and _compatible(ver):
            vv = f"{venv_ver[0]}.{venv_ver[1]}" if venv_ver else "?"
            warn(f"Existing venv is Python {vv}; rebuilding on the compatible {vlabel}")
            needs_create = True

    if needs_create:
        if VENV.exists():
            shutil.rmtree(VENV, ignore_errors=True)
        with Spinner(f"Creating virtualenv (Python {vlabel})"):
            code, out = run([base_py, "-m", "venv", str(VENV)], capture=True)
        if code != 0 or not venv_python().exists():
            err("Failed to create virtualenv")
            print(out)
            return False
        if not _venv_has_pip():
            run([str(venv_python()), "-m", "ensurepip", "--upgrade"], capture=True)
        if not _venv_has_pip():
            err("Created the venv but it has no pip. Install your distro's Python "
                "venv support (e.g. `sudo apt install python3-venv`) and retry.")
            return False
        ok(f"Created backend/.venv (Python {vlabel})")
    else:
        ok("Backend virtualenv present")

    step("Installing backend dependencies (this can take several minutes)…")
    run([str(venv_python()), "-m", "pip", "install", "--upgrade", "pip"], capture=True)
    code, _ = run([str(venv_python()), "-m", "pip", "install", "-r", "requirements.txt"], cwd=BACKEND)
    if code != 0:
        err("Backend dependency install failed — see the output above")
        healthy = False
    else:
        ok("Backend dependencies installed")

    # 2. Frontend deps ------------------------------------------------------
    if which("npm"):
        step("Installing frontend dependencies (npm install)…")
        code, _ = run(npm_argv("install"), cwd=FRONTEND)
        (ok if code == 0 else err)(
            "Frontend dependencies installed" if code == 0 else "npm install failed")
        healthy = healthy and code == 0
    else:
        err("npm not found — install Node.js 18+ from https://nodejs.org/")
        healthy = False
    write_frontend_env()

    # 3. Database -----------------------------------------------------------
    if venv_python().exists():
        step("Initializing the database")
        code, out = run([str(venv_python()), "-m", "app.db_init"], cwd=BACKEND, capture=True, env=child_env())
        (ok if code == 0 else err)("Database ready" if code == 0 else "Database init failed")
        if code != 0:
            print(out)
            healthy = False

    print()
    (ok if healthy else err)(
        "Setup complete — run `python launch.py up`" if healthy else "Setup hit errors (see above)")
    return healthy


# --------------------------------------------------------------------------- #
#  Ollama
# --------------------------------------------------------------------------- #
def ollama_reachable() -> bool:
    return http_ok(f"http://localhost:{OLLAMA_PORT}/api/version")


def ensure_ollama() -> None:
    if ollama_reachable():
        ok("Ollama is running")
        return
    if which("ollama"):
        step("Starting Ollama")
        start_service("ollama", ["ollama", "serve"], ROOT, child_env())
        with Spinner("Waiting for Ollama"):
            wait_for(f"http://localhost:{OLLAMA_PORT}/api/version", timeout=60)
        (ok if ollama_reachable() else warn)(
            "Ollama is running" if ollama_reachable() else "Ollama didn't come online yet")
    else:
        warn("Ollama not found — install it from https://ollama.com/download (AI steps need it)")


# --------------------------------------------------------------------------- #
#  Commands
# --------------------------------------------------------------------------- #
def cmd_doctor(_=None) -> bool:
    step("Checking prerequisites")
    healthy = True

    base_py, ver = find_base_python()
    if base_py and ver:
        vlabel = f"{ver[0]}.{ver[1]}"
        if _compatible(ver):
            ok(f"Python {vlabel} ({base_py})")
        else:
            warn(f"Python {vlabel} found; 3.10–3.12 recommended for the ML wheels")
    else:
        err("No usable Python found — install Python 3.10–3.12")
        healthy = False

    if which("node"):
        _, nver = run(["node", "--version"], capture=True)
        ok(f"Node.js {nver.strip()}")
    else:
        err("Node.js not found — install 18+ from https://nodejs.org/")
        healthy = False
    if not which("npm"):
        err("npm not found (comes with Node.js)")
        healthy = False

    if which("ffmpeg"):
        ok("ffmpeg is installed")
    else:
        err("ffmpeg not found — required for all media processing "
            "(https://ffmpeg.org/download.html)")
        healthy = False

    if which("ollama"):
        ok("ollama is installed" + ("  (running)" if ollama_reachable() else "  (not started)"))
    else:
        warn("ollama not found — install from https://ollama.com/download for AI features")

    if which("nvidia-smi"):
        code, out = run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture=True)
        gpus = [g.strip() for g in out.splitlines() if g.strip()] if code == 0 else []
        if gpus:
            ok(f"NVIDIA GPU detected: {', '.join(gpus)} (set WHISPER_DEVICE=cuda for speed)")
        else:
            info("nvidia-smi present but no GPU reported (CPU mode will be used)")
    else:
        info("No NVIDIA GPU detected — everything still works on CPU, just slower")

    try:
        free_gb = shutil.disk_usage(ROOT).free / 1024 ** 3
        (ok if free_gb >= 30 else warn)(f"{free_gb:.0f} GB free disk (≥30 GB recommended for models)")
    except Exception:
        pass

    busy = [p for p in (API_PORT, WEB_PORT) if port_in_use(p)]
    running = any(is_running(s) for s in ("api", "worker", "frontend"))
    if busy and not running:
        warn(f"Ports already in use: {', '.join(map(str, busy))} (free them or expect conflicts)")
    else:
        ok("App ports look free")

    if _setup_done():
        ok("Dependencies installed (run `up` to start)")
    else:
        info("Run `python launch.py setup` to install dependencies")

    print()
    (ok if healthy else err)("All good — ready to launch!" if healthy else "Fix the issues above, then retry.")
    return healthy


def cmd_up(args=None) -> bool:
    no_open = getattr(args, "no_open", False)

    ensure_env()
    write_frontend_env()

    if not _setup_done():
        warn("Dependencies aren't installed yet — running setup first.")
        if not cmd_setup():
            return False
        print()

    # Database (idempotent; also guarantees data dirs exist before the worker starts).
    code, out = run([str(venv_python()), "-m", "app.db_init"], cwd=BACKEND, capture=True, env=child_env())
    if code != 0:
        err("Database initialization failed")
        print(out)
        return False

    ensure_ollama()

    if not which("ffmpeg") or not which("ffprobe"):
        if IS_WIN:
            hint = "winget install Gyan.FFmpeg"
        elif sys.platform == "darwin":
            hint = "brew install ffmpeg"
        else:
            hint = "sudo apt install ffmpeg (or a static build dropped into ~/.local/bin if you lack root)"
        warn("ffmpeg/ffprobe not found on PATH — REQUIRED for video import, "
             "transcription, rendering, and export. The app will start but jobs will "
             f"fail until you install it: {hint}")

    if PROD:
        step("Building the frontend (next build)…")
        code, _ = run(npm_argv("run", "build"), cwd=FRONTEND, env=child_env())
        if code != 0:
            err("Frontend build failed")
            return False

    step("Starting services")
    started = True
    started &= start_service("api", api_cmd(), BACKEND, child_env())
    started &= start_service("worker", worker_cmd(), BACKEND, child_env())
    started &= start_service(
        "frontend", frontend_cmd(), FRONTEND,
        child_env({"BACKEND_INTERNAL_URL": f"http://localhost:{API_PORT}",
                   "NEXT_PUBLIC_WS_URL": public_ws_url(),
                   "PORT": str(WEB_PORT)}),
    )
    if not started:
        warn("One or more services failed to start — check `python launch.py logs`")

    with Spinner("Waiting for the API to come online"):
        api_ready = wait_for(f"http://{LOOPBACK}:{API_PORT}/health", timeout=180)
    (ok if api_ready else warn)("API is healthy" if api_ready else "API didn't report healthy yet (check `logs api`)")

    with Spinner("Waiting for the web app"):
        web_ready = wait_for(f"http://{LOOPBACK}:{WEB_PORT}", timeout=180)
    (ok if web_ready else warn)("Web app is serving" if web_ready else "Web app still starting (check `logs frontend`)")

    print()
    panel(
        "OpenClip is ready",
        [
            (paint("App", PRIMARY_LT), paint(app_url(), ACCENT)),
            (paint("API docs", PRIMARY_LT), paint(f"http://localhost:{API_PORT}/api/docs", ACCENT)),
            (paint("Login", PRIMARY_LT), paint("admin@openclip.local / changeme", C_DIM)),
        ],
    )
    print()
    info("Services run in the background. Stop them with `python launch.py down`.")
    info("No AI models are installed yet — choose and install them in the web app under Settings → AI models.")
    warn("Change the default admin password in Settings after first login.")

    if not no_open and web_ready:
        webbrowser.open(app_url())
    return True


def cmd_down(_=None) -> bool:
    step("Stopping the stack")
    for name in ("frontend", "worker", "api", "ollama"):
        if is_running(name):
            stop_service(name)
            ok(f"Stopped {name}")
        else:
            stop_service(name)  # clean up any stale pid file
    ok("Stopped")
    return True


def cmd_restart(_=None) -> bool:
    cmd_down()
    print()
    return cmd_up()


def cmd_status(_=None) -> bool:
    step("Services")
    rows = []
    for name in ("api", "worker", "frontend", "ollama"):
        state = paint("● running", C_OK, bold=True) if is_running(name) else paint("○ stopped", C_DIM)
        pid = _read_pid(name)
        rows.append((paint(name, PRIMARY_LT), f"{state}{paint(f'  pid {pid}', C_DIM) if pid and is_running(name) else ''}"))
    panel("Process state", rows)
    print()
    step("Health")
    checks = [
        ("Web app", f"http://{LOOPBACK}:{WEB_PORT}"),
        ("API", f"http://{LOOPBACK}:{API_PORT}/health"),
        ("Ollama", f"http://localhost:{OLLAMA_PORT}/api/version"),
    ]
    for name, url in checks:
        (ok if http_ok(url) else err)(f"{name:<8} {paint(url, C_DIM)}")
    return True


def _tail(paths: list[Path]) -> None:
    handles = []
    for p in paths:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.touch(exist_ok=True)
        fh = open(p, "r", encoding="utf-8", errors="replace")
        fh.seek(0, os.SEEK_END)
        handles.append((p.stem, fh))
    label_w = max((len(name) for name, _ in handles), default=0)
    try:
        while True:
            idle = True
            for name, fh in handles:
                line = fh.readline()
                while line:
                    idle = False
                    prefix = paint(f"{name:<{label_w}}", PRIMARY_LT, bold=True)
                    sys.stdout.write(f"  {prefix} │ {line.rstrip()}\n")
                    line = fh.readline()
            if idle:
                time.sleep(0.4)
    except KeyboardInterrupt:
        print()
    finally:
        for _, fh in handles:
            fh.close()


def cmd_logs(args=None) -> bool:
    service = getattr(args, "service", None)
    names = [service] if service else ["api", "worker", "frontend", "ollama"]
    paths = [LOG_DIR / f"{n}.log" for n in names if (LOG_DIR / f"{n}.log").exists() or not service]
    if not paths:
        warn(f"No log file for '{service}' yet")
        return False
    step(f"Tailing logs{' for ' + service if service else ''} (Ctrl+C to stop)")
    _tail(paths)
    return True


def cmd_open(_=None) -> bool:
    step(f"Opening {app_url()}")
    webbrowser.open(app_url())
    return True


def cmd_nuke(_=None) -> bool:
    warn("This stops the stack and DELETES the local database, media, and queue.")
    warn(f"Target: {DATA}")
    try:
        confirm = input(paint("  Type 'nuke' to confirm: ", C_ERR)).strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    if confirm != "nuke":
        info("Cancelled")
        return False
    cmd_down()
    if DATA.exists():
        shutil.rmtree(DATA, ignore_errors=True)
    ok("Local data removed")
    return True


# --------------------------------------------------------------------------- #
#  Interactive menu
# --------------------------------------------------------------------------- #
MENU = [
    ("Start the stack", cmd_up),
    ("Stop the stack", cmd_down),
    ("Restart", cmd_restart),
    ("Status & health", cmd_status),
    ("View logs", cmd_logs),
    ("Setup / install dependencies", cmd_setup),
    ("Open in browser", cmd_open),
    ("Doctor (check prerequisites)", cmd_doctor),
    ("Reset everything (nuke)", cmd_nuke),
]


def menu() -> None:
    while True:
        running = any(is_running(s) for s in ("api", "worker", "frontend"))
        state = paint("● running", C_OK, bold=True) if running else paint("○ stopped", C_DIM, bold=True)
        print(f"  Stack: {state}")
        print()
        for i, (label, _) in enumerate(MENU, 1):
            print(f"   {paint(f'{i:>2}', PRIMARY_LT, bold=True)}  {label}")
        print(f"    {paint('q', C_DIM, bold=True)}  Quit")
        print()
        try:
            choice = input(paint("  ▸ choose: ", PRIMARY_LT, bold=True)).strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if choice in ("q", "quit", "exit"):
            print(paint("  👋  see you!", PRIMARY_LT))
            return
        if not choice.isdigit() or not (1 <= int(choice) <= len(MENU)):
            err("Invalid choice")
            continue
        print()
        try:
            MENU[int(choice) - 1][1](None)
        except KeyboardInterrupt:
            print()
        print()
        try:
            input(paint("  press Enter to return to the menu…", C_DIM))
        except (EOFError, KeyboardInterrupt):
            return
        print("\n")


# --------------------------------------------------------------------------- #
#  CLI
# --------------------------------------------------------------------------- #
def main() -> int:
    global PROD
    _setup_io()
    ensure_node_on_path()
    parser = argparse.ArgumentParser(
        prog="launch.py", description="OpenClip launcher 🎬 (local, no Docker)", add_help=True
    )
    parser.add_argument("--prod", action="store_true", help="build & serve the frontend in production mode")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("setup", help="create venv, install deps, init the database", aliases=["install"])

    up = sub.add_parser("up", help="start the stack", aliases=["start"])
    up.add_argument("--no-open", action="store_true", help="don't open the browser")

    sub.add_parser("down", help="stop the stack", aliases=["stop"])
    sub.add_parser("restart", help="restart the stack")
    sub.add_parser("status", help="service & health overview", aliases=["ps"])
    logs = sub.add_parser("logs", help="tail logs")
    logs.add_argument("service", nargs="?", help="service name (api, worker, frontend, ollama)")
    sub.add_parser("open", help="open the app in your browser")
    sub.add_parser("doctor", help="check prerequisites")
    sub.add_parser("nuke", help="delete the local database + media (destructive)")

    args = parser.parse_args()
    PROD = args.prod

    dispatch = {
        "setup": cmd_setup, "install": cmd_setup,
        "up": cmd_up, "start": cmd_up,
        "down": cmd_down, "stop": cmd_down,
        "restart": cmd_restart,
        "status": cmd_status, "ps": cmd_status,
        "logs": cmd_logs,
        "open": cmd_open,
        "doctor": cmd_doctor,
        "nuke": cmd_nuke,
    }

    banner()
    try:
        if args.command:
            handler = dispatch[args.command]
            return 0 if handler(args) else 1
        menu()
        return 0
    except KeyboardInterrupt:
        print("\n" + paint("  interrupted", C_DIM))
        return 130


if __name__ == "__main__":
    sys.exit(main())
