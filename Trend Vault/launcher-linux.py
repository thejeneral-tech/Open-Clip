"""
Trend Vault Launcher — Linux build
──────────────────────────────────
Linux-only fork of launcher.py. Same UI, same services, but every
Windows-ism (paths, taskkill/netstat, OllamaSetup.exe, .bat fallbacks,
CREATE_NO_WINDOW, Consolas) has been swapped for the Linux equivalent.

Run directly with Tk installed (most distros ship it):
    sudo apt install python3-tk         # Debian/Ubuntu
    sudo dnf install python3-tkinter    # Fedora
    sudo pacman -S tk                    # Arch

Build a single-file binary:
    pip install pyinstaller
    pyinstaller --onefile --name TrendVaultLauncher launcher-linux.py
"""

import os, sys, time, socket, subprocess, threading, webbrowser, shutil, signal, re, platform, tkinter as tk
from tkinter import font as tkfont, messagebox
from datetime import datetime

if sys.platform == 'win32':
    sys.stderr.write("launcher-linux.py is for Linux. Use launcher.py on Windows.\n")
    sys.exit(2)

# ── Project root (works as .py or frozen binary) ────────────────────────────
ROOT = os.path.dirname(sys.executable if getattr(sys, 'frozen', False) else os.path.abspath(__file__))

# ── Fish Speech S2 Pro — model location ──────────────────────────────────────
# The model is stored OUTSIDE the Git repo so it is never accidentally committed.
#
# Required files — ALL must be present (and non-stub) for the model to be ready.
FISH_S2_PRO_REQUIRED_FILES = [
    'config.json',
    'codec.pth',
    'model-00001-of-00002.safetensors',
    'model-00002-of-00002.safetensors',
    'tokenizer.json',
]

FISH_S2_PRO_REPO_URL = 'https://huggingface.co/fishaudio/s2-pro'

# Resolve $HOME once so all path helpers below share the same value.
_HOME = os.environ.get('HOME') or os.path.expanduser('~')

# Default download destination: ~/.cache/trendvault/models/s2-pro
# (respects XDG_CACHE_HOME if the user has set it).
_FISH_S2_PRO_DEFAULT_CACHE = os.path.join(
    os.environ.get('XDG_CACHE_HOME', os.path.join(_HOME, '.cache')),
    'trendvault', 'models', 's2-pro',
)

# Persisted settings file — remembers the model path across restarts.
# Linux standard: ~/.config/trendvault/fish_s2_config.json
_FISH_S2_PRO_CONFIG_FILE = os.path.join(
    os.environ.get('XDG_CONFIG_HOME', os.path.join(_HOME, '.config')),
    'trendvault', 'fish_s2_config.json',
)


def _fish_s2_pro_config_load() -> str | None:
    """Read the saved model path from the config file. Returns None on any error."""
    try:
        import json
        with open(_FISH_S2_PRO_CONFIG_FILE, 'r') as _f:
            _data = json.load(_f)
        _p = _data.get('model_path', '')
        return _p if _p else None
    except Exception:
        return None


def _fish_s2_pro_config_save(path: str) -> bool:
    """Write `path` to the config file so the app remembers it on restart."""
    try:
        import json
        os.makedirs(os.path.dirname(_FISH_S2_PRO_CONFIG_FILE), exist_ok=True)
        with open(_FISH_S2_PRO_CONFIG_FILE, 'w') as _f:
            json.dump({'model_path': path}, _f, indent=2)
        return True
    except Exception:
        return False


def _fish_s2_pro_candidate_paths() -> list[str]:
    """Return an ordered, deduplicated list of directories to search for the model.

    Search order:
      1. Path saved in the config file (from a previous "Choose" or auto-detect).
      2. ~/s2-pro — common user-level location.
      3. Default XDG cache: ~/.cache/trendvault/models/s2-pro.
      4. FISH_S2_PRO_MODEL_PATH env var (in case the user exported it manually).
    """
    _seen: set[str] = set()
    _cands: list[str] = []
    for _p in [
        _fish_s2_pro_config_load(),
        os.path.join(_HOME, 's2-pro'),
        _FISH_S2_PRO_DEFAULT_CACHE,
        os.environ.get('FISH_S2_PRO_MODEL_PATH', ''),
    ]:
        if _p and _p not in _seen:
            _seen.add(_p)
            _cands.append(_p)
    return _cands


def _fish_s2_pro_missing_files(path: str) -> list[str]:
    """Return the list of required files that are absent or are git-lfs pointer stubs at `path`.

    git-lfs pointer files are only ~134 bytes. Real .safetensors weights
    are several GB — we use 4 KB as a safe minimum to detect stubs.
    """
    missing: list[str] = []
    for fname in FISH_S2_PRO_REQUIRED_FILES:
        full = os.path.join(path, fname)
        if not os.path.isfile(full):
            missing.append(fname)
            continue
        if fname.endswith('.safetensors'):
            try:
                if os.path.getsize(full) <= 4096:
                    missing.append(fname + '  (git-lfs pointer — not fetched yet)')
            except OSError:
                missing.append(fname + '  (unreadable)')
    return missing


def resolve_fish_s2_pro_path() -> str | None:
    """Search all candidate locations and return the first complete model path, or None."""
    for _p in _fish_s2_pro_candidate_paths():
        if os.path.isdir(_p) and not _fish_s2_pro_missing_files(_p):
            return _p
    return None


# Resolve the active model path once at import time.
# FISH_S2_PRO_MODEL_PATH is the canonical variable used throughout the file.
# It is updated at runtime whenever the user picks a different folder.
FISH_S2_PRO_MODEL_PATH = resolve_fish_s2_pro_path() or _FISH_S2_PRO_DEFAULT_CACHE
os.environ['FISH_S2_PRO_MODEL_PATH'] = FISH_S2_PRO_MODEL_PATH

# ── Service definitions ─────────────────────────────────────────────────────
# Kokoro uses the venv Python written by the Linux setup script. If the venv
# isn't present we fall back to scripts/start-kokoro.sh (which should print
# the right "run scripts/setup-kokoro.sh first" error if it can't run).
_KOKORO_VENV_PY = os.path.join(ROOT, 'kokoro-tts', '.venv', 'bin', 'python')
_KOKORO_SCRIPT  = os.path.join(ROOT, 'kokoro-tts', 'kokoro_server.py')
_KOKORO_FALLBACK_SH = os.path.join(ROOT, 'scripts', 'start-kokoro.sh')
if os.path.isfile(_KOKORO_VENV_PY):
    _KOKORO_CMD = [_KOKORO_VENV_PY, _KOKORO_SCRIPT]
elif os.path.isfile(_KOKORO_FALLBACK_SH):
    _KOKORO_CMD = ['bash', _KOKORO_FALLBACK_SH]
else:
    # Last-resort: a system python that has kokoro installed.
    _KOKORO_CMD = ['python3', _KOKORO_SCRIPT]

# ── Fish Speech S2 Pro ───────────────────────────────────────────────────────
# Second local TTS engine alongside Kokoro. Linux/macOS path layout:
#
#   Runtime: ~/.local/share/trendvault/runtimes/fish-speech  (FISH_SPEECH_RUNTIME_PATH)
#   Venv:    <runtime>/.venv                                  (FISH_SPEECH_VENV_PATH)
#   Model:   FISH_S2_PRO_MODEL_PATH  (whatever the user already has)
#   URL:     FISH_TTS_URL            (default http://127.0.0.1:8080)
#
# Startup strategy (mirrors what start-fish-speech.bat does on Windows):
#   1. PREFERRED — invoke fish_speech_server.py (cross-platform Python
#      launcher that handles git clone + Python 3.10/3.11 selection +
#      venv creation + pip install + api_server start in one shot).
#   2. FALLBACK 1 — if a runtime venv exists, run tools.api_server directly.
#   3. FALLBACK 2 — scripts/start-fish-speech.sh shell helper if present.
#   4. LAST RESORT — bare python3 -m tools.api_server (fails fast with a
#      clear "Run setup first" message if the venv doesn't exist).
#
# The /api/fish-s2pro/start endpoint exposed by the Node server does the same
# pipeline programmatically — this launcher card is essentially the GUI
# button equivalent for users who want to run Fish Speech standalone.

_FISH_SERVER_PY     = os.path.join(ROOT, 'fish_speech_server.py')

# Runtime path mirrors fishSpeechS2Pro.ts:_defaultRuntimePath() on Linux:
#   XDG_DATA_HOME or ~/.local/share, then trendvault/runtimes/fish-speech.
_XDG_DATA = os.environ.get('XDG_DATA_HOME') or os.path.join(os.path.expanduser('~'), '.local', 'share')
_FISH_RUNTIME_DEFAULT = os.environ.get('FISH_SPEECH_RUNTIME_PATH') or os.path.join(_XDG_DATA, 'trendvault', 'runtimes', 'fish-speech')
_FISH_VENV_DEFAULT    = os.environ.get('FISH_SPEECH_VENV_PATH')    or os.path.join(_FISH_RUNTIME_DEFAULT, '.venv')
_FISH_VENV_PY         = os.path.join(_FISH_VENV_DEFAULT, 'bin', 'python')
_FISH_FALLBACK_SH     = os.path.join(ROOT, 'scripts', 'start-fish-speech.sh')
_FISH_MODEL_DIR_DEFAULT = resolve_fish_s2_pro_path() or _FISH_S2_PRO_DEFAULT_CACHE


def _resolve_host_python_for_fish() -> str | None:
    """Find the best host Python to bootstrap Fish Speech.

    Mirrors fishSpeechS2Pro.ts::findCompatiblePython() priority order:
      1. python3.11 / python3.10  (canonical names)
      2. uv-managed Python 3.11
      3. python3 / python  (only if its version is 3.10 or 3.11)

    Returns the path to a usable interpreter, or None if no compatible
    Python could be found.
    """
    for name in ('python3.11', 'python3.10', 'python3', 'python'):
        path = shutil.which(name)
        if not path:
            continue
        try:
            r = subprocess.run(
                [path, '-c', 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")'],
                capture_output=True, text=True, timeout=4,
            )
            ver = (r.stdout or '').strip()
            if ver in ('3.10', '3.11'):
                return path
        except Exception:
            continue
    return None


# ── GGUF backend (s2 binary) ─────────────────────────────────────────────────
# Fast compiled s2.cpp backend, preferred when present (mirrors launcher.py).
# A native `s2` binary plus GGUF model files live under FISH_GGUF_ROOT
# (default /shared/fish-speech; override with the FISH_GGUF_ROOT env var).
_FISH_GGUF_ROOT      = os.environ.get('FISH_GGUF_ROOT') or '/shared/fish-speech'
_FISH_GGUF_BINDIR    = os.path.join(_FISH_GGUF_ROOT, 'build', 's2.cpp', 'cmake-build')
_FISH_GGUF_BINARY    = os.path.join(_FISH_GGUF_BINDIR, 's2')
_FISH_GGUF_MODELDIR  = os.path.join(_FISH_GGUF_ROOT, 'models', 's2-pro-gguf')
_FISH_GGUF_TOKENIZER = os.path.join(_FISH_GGUF_ROOT, 'tokenizer.json')


def _resolve_gguf_codec() -> str:
    """Return the path to the codec GGUF: prefer q4_k_m, fall back to f16."""
    q4  = os.path.join(_FISH_GGUF_MODELDIR, 's2-pro-q4_k_m-codec-only.gguf')
    f16 = os.path.join(_FISH_GGUF_MODELDIR, 's2-pro-f16-codec-only.gguf')
    return q4 if os.path.isfile(q4) else f16


def _gguf_backend_ok() -> bool:
    """True when every GGUF file the s2 binary needs is present on disk."""
    transformer = os.path.join(_FISH_GGUF_MODELDIR, 's2-pro-q4_k_m-transformer-only.gguf')
    return (os.path.isfile(_FISH_GGUF_BINARY)
            and os.path.isfile(transformer)
            and os.path.isfile(_FISH_GGUF_TOKENIZER)
            and os.path.isfile(_resolve_gguf_codec()))


def _gguf_fish_cmd() -> list[str]:
    """Build the argv that launches the s2.cpp GGUF server on port 8080."""
    transformer = os.path.join(_FISH_GGUF_MODELDIR, 's2-pro-q4_k_m-transformer-only.gguf')
    return [_FISH_GGUF_BINARY,
            '--model',        transformer,
            '--model-codec',  _resolve_gguf_codec(),
            '--tokenizer',    _FISH_GGUF_TOKENIZER,
            '--port',         '8080',
            '--host',         '127.0.0.1',
            '--threads',      '4',
            '--vulkan',       '-1',
            '--codec-vulkan', '-1']


# Export FISH_GGUF_ROOT so child services (and the Node server) resolve the
# same backend location we do.
os.environ.setdefault('FISH_GGUF_ROOT', _FISH_GGUF_ROOT)

# Build the launcher card's start command.
# Priority: fast GGUF s2 binary > fish_speech_server.py > venv api_server >
#           shell helper > bare python3.
if _gguf_backend_ok():
    # Strategy 0 — the compiled s2.cpp GGUF backend (no venv required).
    _FISH_CMD = _gguf_fish_cmd()
elif os.path.isfile(_FISH_SERVER_PY):
    # Strategy 1 — the cross-platform fish_speech_server.py launcher.
    # Prefer the venv python if it exists (faster — skips host Python probe).
    # Otherwise pick the best host Python (3.10/3.11) we can find.
    if os.path.isfile(_FISH_VENV_PY):
        _FISH_CMD = [_FISH_VENV_PY, _FISH_SERVER_PY]
    else:
        _host_py = _resolve_host_python_for_fish() or 'python3'
        _FISH_CMD = [_host_py, _FISH_SERVER_PY]
elif os.path.isfile(_FISH_VENV_PY):
    # Strategy 2 — venv built but no fish_speech_server.py; run api_server directly.
    _FISH_CMD = [_FISH_VENV_PY, '-m', 'tools.api_server',
                 '--listen', '127.0.0.1:8080',
                 '--llama-checkpoint-path', _FISH_MODEL_DIR_DEFAULT]
elif os.path.isfile(_FISH_FALLBACK_SH):
    # Strategy 3 — shell helper (scripts/start-fish-speech.sh).
    _FISH_CMD = ['bash', _FISH_FALLBACK_SH]
else:
    # Strategy 4 — bare python3; will print a useful error if nothing's set up.
    _FISH_CMD = ['python3', '-m', 'tools.api_server',
                 '--listen', '127.0.0.1:8080',
                 '--llama-checkpoint-path', _FISH_MODEL_DIR_DEFAULT]


def fish_speech_http_ok(timeout: float = 2.0) -> tuple[bool, str]:
    """Probe the Fish Speech HTTP server defined by FISH_TTS_URL (default 8080).

    Returns (ok, base_url). Used by both the per-card dot indicator and the
    HEALTH button so the user knows whether port 8080 is *really* Fish Speech.
    """
    import urllib.request
    base = (os.environ.get('FISH_TTS_URL') or 'http://127.0.0.1:8080').rstrip('/')
    for path in ('/v1/health', '/health', '/'):
        try:
            with urllib.request.urlopen(base + path, timeout=timeout) as r:
                if 200 <= r.status < 500:
                    return True, base
        except Exception:
            continue
    return False, base

_OLLAMA_UI_SERVER = os.path.join(ROOT, 'Ollama web ui', 'server.js')

# Ollama on Linux ships an install.sh that needs sudo. We don't try to run it
# unattended — we just open the official install page in the browser and
# print the curl one-liner so the user can paste it into their own terminal.
_OLLAMA_INSTALL_PAGE   = 'https://ollama.com/download/linux'
_OLLAMA_INSTALL_ONELINE = 'curl -fsSL https://ollama.com/install.sh | sh'

def resolve_ollama() -> str | None:
    """Return the path to the ollama binary, or None if it isn't on PATH."""
    return shutil.which('ollama')


# ── Fish Audio S2 Pro helpers ─────────────────────────────────────────────────

def _check_git_lfs() -> bool:
    """Return True if git-lfs is installed and functional on this system."""
    if not shutil.which('git'):
        return False
    try:
        r = subprocess.run(
            ['git', 'lfs', 'version'],
            capture_output=True, timeout=6,
        )
        return r.returncode == 0
    except Exception:
        return False

def _fish_s2_pro_is_installed() -> bool:
    """Return True if any candidate location contains a complete Fish S2 Pro model."""
    return resolve_fish_s2_pro_path() is not None


def _fish_s2_pro_clone_exists() -> bool:
    """Return True if the default cache directory contains an interrupted git clone.

    We check the default cache dir (not the resolved active path) because a
    partial clone is only ever started there — it won't be 'complete' yet,
    so resolve_fish_s2_pro_path() would return None for it.
    """
    return os.path.isdir(os.path.join(_FISH_S2_PRO_DEFAULT_CACHE, '.git'))


def _missing_fish_s2_pro_deps() -> list[tuple[str, str]]:
    """Return a list of (dep_name, install_hint) tuples for any missing deps.

    The launcher needs four binaries to install / use Fish Audio S2 Pro:
      • git       — to clone the Hugging Face repo
      • git-lfs   — to fetch the real .safetensors weights (not LFS pointers)
      • python3   — required by the rest of the Trend Vault toolchain that
                    consumes the model
      • pip       — for any post-install Python package the model needs
    Returning a list rather than printing lets the caller decide how to
    surface the message (UI log, terminal, dialog).
    """
    missing: list[tuple[str, str]] = []
    if not shutil.which('git'):
        missing.append((
            'git',
            'Ubuntu/Debian: sudo apt install git   |   '
            'Fedora: sudo dnf install git   |   '
            'Arch: sudo pacman -S git',
        ))
    if not _check_git_lfs():
        missing.append((
            'git-lfs',
            'Ubuntu/Debian: sudo apt install git-lfs   |   '
            'Fedora: sudo dnf install git-lfs   |   '
            'Arch: sudo pacman -S git-lfs',
        ))
    if not (shutil.which('python3') or shutil.which('python')):
        missing.append((
            'python3',
            'Ubuntu/Debian: sudo apt install python3   |   '
            'Fedora: sudo dnf install python3   |   '
            'Arch: sudo pacman -S python',
        ))
    # We accept either a `pip` binary on PATH or `python3 -m pip` working.
    if not (shutil.which('pip3') or shutil.which('pip')):
        try:
            r = subprocess.run(
                [shutil.which('python3') or shutil.which('python') or 'python3',
                 '-m', 'pip', '--version'],
                capture_output=True, timeout=5,
            )
            pip_ok = (r.returncode == 0)
        except Exception:
            pip_ok = False
        if not pip_ok:
            missing.append((
                'pip',
                'Ubuntu/Debian: sudo apt install python3-pip   |   '
                'Fedora: sudo dnf install python3-pip   |   '
                'Arch: sudo pacman -S python-pip',
            ))
    return missing


def _git_lfs_install_user() -> bool:
    """Run `git lfs install --skip-repo` to enable LFS filters for this user.

    Safe to call repeatedly — git-lfs treats this as idempotent. Returns
    True on success. Failure is non-fatal; the clone may still succeed if
    LFS was installed globally on a previous run.
    """
    try:
        r = subprocess.run(
            ['git', 'lfs', 'install', '--skip-repo'],
            capture_output=True, timeout=15,
        )
        return r.returncode == 0
    except Exception:
        return False


# Aider: required for the Ollama Chat UI's Code section. We default to a
# project-local venv at <ROOT>/.venv-aider/ to sidestep distro-Python
# sandboxing + PEP 668 ("externally managed environment") errors.
_AIDER_VENV_DIR = os.path.join(ROOT, '.venv-aider')

def _aider_venv_python() -> str | None:
    """Return path to the venv's python binary, or None if not built."""
    p = os.path.join(_AIDER_VENV_DIR, 'bin', 'python')
    return p if os.path.isfile(p) else None

def _aider_venv_bin() -> str | None:
    """Return path to aider inside the venv, or None."""
    p = os.path.join(_AIDER_VENV_DIR, 'bin', 'aider')
    return p if os.path.isfile(p) else None

def resolve_aider() -> str | None:
    """Return the path to the aider binary, or None if not installed.
    Search order: PATH → ~/.local/bin (uv default, where aider-install
    puts it) → project venv."""
    p = shutil.which('aider')
    if p:
        return p
    home = os.environ.get('HOME')
    if home:
        guess = os.path.join(home, '.local', 'bin', 'aider')
        if os.path.isfile(guess):
            return guess
    venv = _aider_venv_bin()
    if venv:
        return venv
    return None


def _find_pip_cmd() -> list[str] | None:
    """Return a command list that can run pip. Prefers `python3 -m pip`."""
    for py in ('python3', 'python'):
        path = shutil.which(py)
        if path:
            return [path, '-m', 'pip']
    for pip in ('pip3', 'pip'):
        path = shutil.which(pip)
        if path:
            return [path]
    return None


def _find_pipx_cmd() -> list[str] | None:
    """Return a command list that can run pipx, or None if it isn't on PATH."""
    p = shutil.which('pipx')
    if p:
        return [p]
    # pipx is sometimes installed as a Python module but not exported to PATH.
    for py in ('python3', 'python'):
        path = shutil.which(py)
        if path:
            try:
                r = subprocess.run(
                    [path, '-m', 'pipx', '--version'],
                    capture_output=True, timeout=4,
                )
                if r.returncode == 0:
                    return [path, '-m', 'pipx']
            except Exception:
                pass
    return None


# ── uv: Rust-based Python installer. We use it because it doesn't go through
#       pip's broken build-isolation path (which downloads stale setuptools
#       and crashes on Python 3.12+ when numpy needs to build).
_USER_LOCAL_BIN = os.path.join(os.environ.get('HOME', ''), '.local', 'bin')

def _resolve_uv() -> str | None:
    """Return the path to the `uv` binary, or None if not installed."""
    p = shutil.which('uv')
    if p:
        return p
    for guess in (
        os.path.join(_USER_LOCAL_BIN, 'uv'),
        os.path.join(os.environ.get('HOME', ''), '.cargo', 'bin', 'uv'),
    ):
        if guess and os.path.isfile(guess):
            return guess
    return None

def _uv_release_url() -> str | None:
    """Build the GitHub release URL for the current OS / arch."""
    sys_name = platform.system()
    mach = (platform.machine() or '').lower()
    arch = {
        'amd64': 'x86_64', 'x86_64': 'x86_64', 'x64': 'x86_64',
        'arm64': 'aarch64', 'aarch64': 'aarch64',
    }.get(mach)
    if not arch:
        return None
    base = 'https://github.com/astral-sh/uv/releases/latest/download'
    if sys_name == 'Linux':
        return f'{base}/uv-{arch}-unknown-linux-gnu.tar.gz'
    if sys_name == 'Darwin':
        return f'{base}/uv-{arch}-apple-darwin.tar.gz'
    return None

def _download_uv(log) -> str | None:
    """Download the uv binary from GitHub releases into ~/.local/bin/."""
    import urllib.request, tempfile, tarfile
    url = _uv_release_url()
    if not url:
        log('No uv release for this OS/arch: ' + platform.system() + '/' + platform.machine(), RED)
        return None
    log('Downloading uv from ' + url, ACCENT)
    os.makedirs(_USER_LOCAL_BIN, exist_ok=True)
    archive = os.path.join(tempfile.gettempdir(), 'uv_dl.tar.gz')
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'TrendVaultLauncher/1.0'})
        with urllib.request.urlopen(req, timeout=60) as resp:
            with open(archive, 'wb') as f:
                shutil.copyfileobj(resp, f)
    except Exception as e:
        log('uv download failed: ' + str(e), RED)
        return None
    try:
        with tarfile.open(archive) as t:
            for member in t.getmembers():
                base_name = os.path.basename(member.name)
                if base_name in ('uv', 'uvx') and member.isfile():
                    member.name = base_name
                    t.extract(member, _USER_LOCAL_BIN)
                    os.chmod(os.path.join(_USER_LOCAL_BIN, base_name), 0o755)
    except Exception as e:
        log('uv extract failed: ' + str(e), RED)
        return None
    finally:
        try: os.remove(archive)
        except OSError: pass
    return _resolve_uv()


# ── Node.js: distro Node packages on Linux are often stale or missing, and
#       PEP-668 sandboxes mean `npm` may simply not be on PATH. When we can't
#       find it we download the official binary tarball into a private dir
#       and prepend its bin/ to PATH so subprocesses can find npm/npx/node.
_NODE_VERSION = 'v22.11.0'
_NODE_DIR = os.path.join(os.environ.get('HOME', '') or os.getcwd(),
                         '.local', 'share', 'trend-vault-node')

def _node_release_url() -> str | None:
    """Build the nodejs.org tarball URL for the current OS / arch."""
    if platform.system() != 'Linux':
        return None
    mach = (platform.machine() or '').lower()
    arch = {
        'amd64':   'x64',
        'x86_64':  'x64',
        'x64':     'x64',
        'arm64':   'arm64',
        'aarch64': 'arm64',
        'armv7l':  'armv7l',
    }.get(mach)
    if not arch:
        return None
    return ('https://nodejs.org/dist/' + _NODE_VERSION +
            '/node-' + _NODE_VERSION + '-linux-' + arch + '.tar.xz')

def _node_bin_dir() -> str | None:
    """Return the bin/ dir of the bundled Node install, or None."""
    if not os.path.isdir(_NODE_DIR):
        return None
    try:
        entries = sorted(os.listdir(_NODE_DIR), reverse=True)
    except OSError:
        return None
    for name in entries:
        full = os.path.join(_NODE_DIR, name)
        if not (os.path.isdir(full) and name.startswith('node-')):
            continue
        bin_dir = os.path.join(full, 'bin')
        if os.path.isfile(os.path.join(bin_dir, 'npm')):
            return bin_dir
    return None

def _ensure_bundled_node_on_path() -> str | None:
    """If a bundled Node install exists, prepend its bin to PATH. Returns the bin dir or None."""
    bin_dir = _node_bin_dir()
    if not bin_dir:
        return None
    cur = os.environ.get('PATH', '')
    parts = cur.split(os.pathsep) if cur else []
    if bin_dir not in parts:
        os.environ['PATH'] = bin_dir + (os.pathsep + cur if cur else '')
    return bin_dir

def _download_node(log) -> str | None:
    """Download Node.js binary tarball and extract into _NODE_DIR. Returns the bin dir on success."""
    import urllib.request, tempfile, tarfile
    url = _node_release_url()
    if not url:
        log('No Node.js release for this OS/arch: ' +
            platform.system() + '/' + platform.machine(), RED)
        return None
    log('Downloading Node.js ' + _NODE_VERSION + ' from ' + url, ACCENT)
    log('This may take 30-60 seconds (~25 MB)...', MUTED)
    os.makedirs(_NODE_DIR, exist_ok=True)
    archive = os.path.join(tempfile.gettempdir(), 'trend_vault_node_dl.tar.xz')
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'TrendVaultLauncher/1.0'})
        with urllib.request.urlopen(req, timeout=180) as resp:
            with open(archive, 'wb') as f:
                shutil.copyfileobj(resp, f)
    except Exception as e:
        log('Node.js download failed: ' + str(e), RED)
        return None
    try:
        with tarfile.open(archive, mode='r:xz') as t:
            try:
                t.extractall(_NODE_DIR, filter='data')
            except TypeError:
                # Python < 3.12 doesn't accept the filter kwarg.
                t.extractall(_NODE_DIR)
    except Exception as e:
        log('Node.js extract failed: ' + str(e), RED)
        return None
    finally:
        try: os.remove(archive)
        except OSError: pass
    bin_dir = _node_bin_dir()
    if not bin_dir:
        log('Node.js archive extracted but bin/ not found inside ' + _NODE_DIR, RED)
        return None
    _ensure_bundled_node_on_path()
    return bin_dir

# If a prior auto-install left a Node.js bundle in place, wire it onto PATH
# now so npm/npx are resolvable for service launches and child processes.
_ensure_bundled_node_on_path()


SERVICES = [
    {
        'key':  'webapp',
        'name': 'Web App',
        'desc': 'Express server  •  port 3001',
        'port': 3001,
        'cmd':  ['npm', 'start'],
        'url':  'http://localhost:3001/trend-vault',
        'needs_npm': True,
    },
    {
        'key':  'worker',
        'name': 'Render Worker',
        'desc': 'Remotion worker  •  port 4000',
        'port': 4000,
        'cmd':  ['npx', 'tsx', 'server/render-worker.ts'],
        'url':  None,
        'needs_npm': True,
    },
    {
        'key':  'kokoro',
        'name': 'Kokoro TTS',
        'desc': 'Local TTS server  •  port 5070',
        'port': 5070,
        'cmd':  _KOKORO_CMD,
        'url':  None,
        'needs_npm': False,
    },
    {
        # Fish Speech S2 Pro — second local TTS engine. The dot lights green
        # only when port 8080 is occupied AND the http_health probe confirms
        # it's really a Fish Speech server (8080 is a common dev port and a
        # generic listener shouldn't be reported as healthy).
        'key':  'fish_speech',
        'name': 'Fish Speech S2 Pro',
        'desc': 'Local TTS engine  •  port 8080',
        'port': 8080,
        'cmd':  _FISH_CMD,
        'url':  None,
        'needs_npm': False,
        # Inject the GGUF binary dir into the loader path so the s2 binary can
        # find its shared libraries when the GGUF backend is in use (harmless
        # for the Python launcher path — a missing dir is simply ignored).
        'env':  {'LD_LIBRARY_PATH': _FISH_GGUF_BINDIR + os.pathsep + os.environ.get('LD_LIBRARY_PATH', '')},
        'http_health': fish_speech_http_ok,
    },
    {
        'key':  'ollama',
        'name': 'Ollama',
        'desc': 'Local LLM server  •  port 11434',
        'port': 11434,
        'cmd':  ['ollama', 'serve'],
        'url':  None,
        'needs_npm': False,
    },
    {
        'key':  'ollama_ui',
        'name': 'Ollama Chat UI',
        'desc': 'Web chat for Ollama  •  port 3002',
        'port': 3002,
        'cmd':  ['node', _OLLAMA_UI_SERVER],
        'url':  'http://localhost:3002',
        'env':  {'PORT': '3002', 'OLLAMA_HOST': 'http://127.0.0.1:11434'},
        'needs_npm': False,
    },
]

# ── Palette ─────────────────────────────────────────────────────────────────
BG      = '#0d0d14'
BG2     = '#13131e'
CARD    = '#1a1a2a'
BORDER  = '#2a2a40'
ACCENT  = '#7c6ff7'
GREEN   = '#00e676'
RED     = '#ff4d4d'
AMBER   = '#ffb300'
TEXT    = '#e8e8f0'
MUTED   = '#5a5a78'
BTN     = '#252538'
BTN_HOV = '#30304a'
BTN_GO  = '#1e3a2f'
BTN_STP = '#3a1e1e'

# Linux monospace stack — Consolas does not exist on most Linux desktops.
MONO_FAMILY = 'DejaVu Sans Mono'

# ── Helpers ─────────────────────────────────────────────────────────────────
def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex(('127.0.0.1', port)) == 0

def _pids_on_port(port: int) -> list[int]:
    """Return a list of PIDs listening on the given TCP port. Tries lsof, then ss."""
    # lsof -ti :PORT
    if shutil.which('lsof'):
        try:
            out = subprocess.run(
                ['lsof', '-ti', f'tcp:{port}', '-sTCP:LISTEN'],
                capture_output=True, text=True, timeout=4,
            ).stdout
            return [int(x) for x in out.split() if x.strip().isdigit()]
        except Exception:
            pass
    # fallback: ss -tlnpH 'sport = :PORT' → "users:((\"node\",pid=12345,fd=3))"
    if shutil.which('ss'):
        try:
            out = subprocess.run(
                ['ss', '-tlnpH', f'sport = :{port}'],
                capture_output=True, text=True, timeout=4,
            ).stdout
            return [int(m.group(1)) for m in re.finditer(r'pid=(\d+)', out)]
        except Exception:
            pass
    # fallback: fuser -n tcp PORT
    if shutil.which('fuser'):
        try:
            out = subprocess.run(
                ['fuser', '-n', 'tcp', str(port)],
                capture_output=True, text=True, timeout=4,
            ).stdout
            return [int(x) for x in out.split() if x.strip().isdigit()]
        except Exception:
            pass
    return []

def kill_port(port: int):
    """Send SIGTERM (then SIGKILL) to every process listening on the given port."""
    pids = _pids_on_port(port)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    # Give them a moment to clean up, then escalate.
    if pids:
        time.sleep(0.4)
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

def _kill_proc_tree(proc: subprocess.Popen):
    """Best-effort terminate of `proc` and any children it spawned."""
    if proc.poll() is not None:
        return
    pgid = None
    try:
        pgid = os.getpgid(proc.pid)
    except (ProcessLookupError, OSError):
        pgid = None
    try:
        if pgid is not None and pgid != os.getpgid(0):
            os.killpg(pgid, signal.SIGTERM)
        else:
            proc.terminate()
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            if pgid is not None and pgid != os.getpgid(0):
                os.killpg(pgid, signal.SIGKILL)
            else:
                proc.kill()
        except Exception:
            pass

def ts() -> str:
    return datetime.now().strftime('%H:%M:%S')


# ── Main app ────────────────────────────────────────────────────────────────
class TrendVaultLauncher(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('Trend Vault Launcher')
        self.configure(bg=BG)
        self.minsize(1080, 720)
        self.geometry('1180x780')

        # Process handles  { key: subprocess.Popen }
        self._procs: dict[str, subprocess.Popen] = {}
        self._lock  = threading.Lock()
        self._installing_ollama = False
        self._installing_aider = False
        self._installing_node = False
        self._installing_fish_s2 = False   # guards the Fish S2 Pro download thread
        self._node_install_lock = threading.Lock()
        # CLI runner state
        self._cli_proc: subprocess.Popen | None = None
        self._cli_busy = False
        self._cli_history: list[str] = []
        self._cli_history_idx: int = -1
        self._cli_draft: str = ''

        self._build_ui()
        self._poll()
        self.after(400,  self._check_node_on_start)
        self.after(800,  self._check_ollama_on_start)
        self.after(1200, self._check_aider_on_start)
        self.after(1600, self._check_fish_s2_on_start)  # Fish Audio S2 Pro model

    # ── UI construction ─────────────────────────────────────────────────────
    def _build_ui(self):
        mono = tkfont.Font(family=MONO_FAMILY, size=9)

        # ── Top header ──
        hdr = tk.Frame(self, bg=BG, pady=14)
        hdr.pack(fill='x', padx=28)
        tk.Label(hdr, text='🏦  TREND VAULT', bg=BG, fg=TEXT,
                 font=('DejaVu Sans', 18, 'bold')).pack(side='left')
        tk.Label(hdr, text='CONTROL', bg=BG, fg=ACCENT,
                 font=('DejaVu Sans', 18, 'bold')).pack(side='left', padx=(8, 0))
        self._status_var = tk.StringVar(value='Ready')
        tk.Label(hdr, textvariable=self._status_var, bg=BG, fg=MUTED,
                 font=('DejaVu Sans', 9)).pack(side='right')

        tk.Frame(self, bg=BORDER, height=1).pack(fill='x')

        # ── Two-column body ──
        body = tk.Frame(self, bg=BG)
        body.pack(fill='both', expand=True)

        left = tk.Frame(body, bg=BG, width=560)
        left.pack(side='left', fill='y')
        left.pack_propagate(False)

        tk.Frame(body, bg=BORDER, width=1).pack(side='left', fill='y')

        right = tk.Frame(body, bg=BG2)
        right.pack(side='left', fill='both', expand=True)

        # ── LEFT: section label + service cards ──
        tk.Label(left, text='SERVICES', bg=BG, fg=MUTED,
                 font=('DejaVu Sans', 8, 'bold')).pack(anchor='w', padx=28, pady=(18, 6))
        cards_frame = tk.Frame(left, bg=BG)
        cards_frame.pack(fill='x', padx=28)

        self._cards: dict[str, dict] = {}
        for svc in SERVICES:
            self._cards[svc['key']] = self._make_card(cards_frame, svc)

        tk.Frame(left, bg=BORDER, height=1).pack(fill='x', pady=(14, 0))
        tk.Label(left, text='ACTIONS', bg=BG, fg=MUTED,
                 font=('DejaVu Sans', 8, 'bold')).pack(anchor='w', padx=28, pady=(12, 6))
        bar = tk.Frame(left, bg=BG)
        bar.pack(fill='x', padx=24, pady=(0, 16))
        row1 = tk.Frame(bar, bg=BG); row1.pack(fill='x', pady=(0, 6))
        row2 = tk.Frame(bar, bg=BG); row2.pack(fill='x')
        self._btn(row1, '▶  START ALL',       self._start_all,    BTN_GO,  GREEN ).pack(side='left', padx=3)
        self._btn(row1, '■  STOP ALL',        self._stop_all,     BTN_STP, RED   ).pack(side='left', padx=3)
        self._btn(row1, '\U0001f4e6 INSTALL', self._run_install,  BTN,     AMBER ).pack(side='left', padx=3)
        self._btn(row1, '⬡  HEALTH',          self._health,       BTN,     AMBER ).pack(side='left', padx=3)
        self._btn(row2, '\U0001f310 OPEN STUDIO', self._open_browser, BTN, ACCENT).pack(side='left', padx=3)
        self._btn(row2, '\U0001f916 OPEN CHAT UI', self._open_chat,   BTN, ACCENT).pack(side='left', padx=3)
        self._btn(row2, '\U0001f9f0 INSTALL AIDER', self._run_install_aider, BTN, AMBER).pack(side='left', padx=3)
        # Fish Speech S2 Pro: lets the user point the app at an existing model folder.
        self._btn(row2, '\U0001f4c1 S2 PRO FOLDER', self._choose_fish_s2_folder, BTN, ACCENT).pack(side='left', padx=3)

        # ── RIGHT: console header ──
        rhdr = tk.Frame(right, bg=BG2)
        rhdr.pack(fill='x', padx=20, pady=(18, 6))
        tk.Label(rhdr, text='CONSOLE', bg=BG2, fg=ACCENT,
                 font=('DejaVu Sans', 9, 'bold')).pack(side='left')
        self._cwd_var = tk.StringVar(value='cwd: ' + ROOT)
        tk.Label(rhdr, textvariable=self._cwd_var, bg=BG2, fg=MUTED,
                 font=(MONO_FAMILY, 8)).pack(side='left', padx=(12, 0))
        self._btn(rhdr, 'clear', self._clear_log, BG2, MUTED,
                  font=('DejaVu Sans', 8)).pack(side='right')

        log_wrap = tk.Frame(right, bg=BORDER)
        log_wrap.pack(fill='both', expand=True, padx=20, pady=(0, 8))
        self._log = tk.Text(
            log_wrap, bg=BG, fg='#c0c0d8', font=mono,
            bd=0, relief='flat', wrap='word',
            state='disabled', padx=12, pady=10,
            insertbackground=TEXT, selectbackground=ACCENT,
        )
        self._log.pack(fill='both', expand=True, padx=1, pady=1)
        self._log.tag_configure('inline', foreground=TEXT)

        # ── CLI input row ──
        tk.Label(right, text='CLI  (Enter to run a shell command  ·  Up/Down for history)',
                 bg=BG2, fg=MUTED, font=('DejaVu Sans', 8, 'bold')
                 ).pack(anchor='w', padx=20, pady=(2, 4))
        prompt_wrap = tk.Frame(right, bg=BORDER)
        prompt_wrap.pack(fill='x', padx=20, pady=(0, 18))
        prompt_row = tk.Frame(prompt_wrap, bg=BG)
        prompt_row.pack(fill='x', padx=1, pady=1)
        tk.Label(prompt_row, text='$', bg=BG, fg=ACCENT,
                 font=(MONO_FAMILY, 13, 'bold')).pack(side='left', padx=(10, 6), pady=4)
        self._prompt_var = tk.StringVar()
        self._prompt_entry = tk.Entry(
            prompt_row, textvariable=self._prompt_var,
            bg=BG, fg=TEXT, insertbackground=TEXT,
            relief='flat', bd=0, highlightthickness=0,
            font=(MONO_FAMILY, 10),
        )
        self._prompt_entry.pack(side='left', fill='x', expand=True, ipady=8)
        self._prompt_entry.bind('<Return>',   lambda e: self._run_cli())
        self._prompt_entry.bind('<Up>',       lambda e: self._history_prev())
        self._prompt_entry.bind('<Down>',     lambda e: self._history_next())
        self._prompt_entry.bind('<Escape>',   lambda e: self._stop_cli())
        self._run_btn = self._btn(prompt_row, 'RUN', self._run_cli, BTN_GO, GREEN,
                                  font=('DejaVu Sans', 9, 'bold'))
        self._run_btn.pack(side='left', padx=(6, 3), pady=4)
        self._stop_btn = self._btn(prompt_row, 'STOP', self._stop_cli, BTN_STP, RED,
                                   font=('DejaVu Sans', 9, 'bold'))
        self._stop_btn.pack(side='left', padx=(0, 6), pady=4)
        self._stop_btn.configure(state='disabled')

    def _make_card(self, parent: tk.Frame, svc: dict) -> dict:
        card = tk.Frame(parent, bg=CARD, bd=0, padx=16, pady=12,
                        highlightbackground=BORDER, highlightthickness=1)
        card.pack(fill='x', pady=6)

        left = tk.Frame(card, bg=CARD)
        left.pack(side='left', fill='y')

        dot = tk.Label(left, text='●', bg=CARD, fg=RED, font=('DejaVu Sans', 14))
        dot.pack(side='left', padx=(0, 10))

        info = tk.Frame(left, bg=CARD)
        info.pack(side='left')
        tk.Label(info, text=svc['name'], bg=CARD, fg=TEXT,
                 font=('DejaVu Sans', 11, 'bold'), anchor='w').pack(anchor='w')
        tk.Label(info, text=svc['desc'], bg=CARD, fg=MUTED,
                 font=('DejaVu Sans', 8), anchor='w').pack(anchor='w')

        right = tk.Frame(card, bg=CARD)
        right.pack(side='right')

        btn_start = self._btn(right, '▶ Start',
                              lambda k=svc['key']: self._start_one(k),
                              BTN_GO, GREEN, font=('DejaVu Sans', 9, 'bold'))
        btn_start.pack(side='left', padx=(0, 6))

        btn_stop = self._btn(right, '■ Stop',
                             lambda k=svc['key']: self._stop_one(k),
                             BTN_STP, RED, font=('DejaVu Sans', 9, 'bold'))
        btn_stop.pack(side='left')

        return {'dot': dot, 'btn_start': btn_start, 'btn_stop': btn_stop, 'running': False}

    @staticmethod
    def _btn(parent, text, cmd, bg, fg, font=('DejaVu Sans', 9, 'bold')) -> tk.Button:
        b = tk.Button(parent, text=text, command=cmd,
                      bg=bg, fg=fg, activebackground=BTN_HOV, activeforeground=TEXT,
                      font=font, bd=0, relief='flat', padx=12, pady=6, cursor='hand2')
        b.bind('<Enter>', lambda e, w=b: w.configure(bg=BTN_HOV))
        b.bind('<Leave>', lambda e, w=b, c=bg: w.configure(bg=c))
        return b

    # ── Logging ─────────────────────────────────────────────────────────────
    def _log_line(self, msg: str, color: str = '#a0a0c0'):
        def _do():
            self._log.configure(state='normal')
            tag = 'c' + color.replace('#', '')
            self._log.tag_configure(tag, foreground=color)
            self._log.insert('end', '[' + ts() + ']  ' + msg + '\n', tag)
            self._log.see('end')
            self._log.configure(state='disabled')
        self.after(0, _do)

    def _clear_log(self):
        self._log.configure(state='normal')
        self._log.delete('1.0', 'end')
        self._log.configure(state='disabled')

    def _set_status(self, msg: str):
        self.after(0, lambda: self._status_var.set(msg))

    # ── Status polling ──────────────────────────────────────────────────────
    def _poll(self):
        for svc in SERVICES:
            key  = svc['key']
            up   = port_in_use(svc['port'])
            # Services that opt in (via http_health) only show as healthy
            # when the HTTP probe confirms they're alive — guards against
            # an unrelated process sitting on Fish Speech's port 8080.
            probe = svc.get('http_health')
            if up and callable(probe):
                try:
                    ok, _ = probe()
                    up = bool(ok)
                except Exception:
                    up = False
            card = self._cards[key]
            if up != card['running']:
                card['running'] = up
                color = GREEN if up else RED
                self.after(0, lambda d=card['dot'], c=color, u=up:
                           d.configure(fg=c, text='●' if u else '○'))
        self.after(2000, self._poll)

    # ── Dependency management (npm) ────────────────────────────────────────
    def _ensure_deps(self) -> bool:
        nm = os.path.join(ROOT, 'node_modules')
        if os.path.isdir(nm):
            return True
        if not self._ensure_node():
            return False
        self._log_line('node_modules not found -- running npm install...', AMBER)
        self._set_status('Installing dependencies...')
        try:
            proc = subprocess.Popen(
                ['npm', 'install'],
                cwd=ROOT, env={**os.environ},
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                encoding='utf-8', errors='replace', bufsize=1,
                start_new_session=True,
            )
            for raw in proc.stdout:
                line = raw.rstrip()
                if line:
                    lo = line.lower()
                    if any(w in lo for w in ('added', 'found', 'up to date')):
                        color = GREEN
                    elif 'error' in lo:
                        color = RED
                    else:
                        color = '#a0a0c0'
                    self._log_line('[npm install] ' + line, color)
            proc.wait()
            if proc.returncode == 0:
                self._log_line('Dependencies installed successfully', GREEN)
                self._set_status('Ready')
                return True
            self._log_line('npm install failed (exit code ' + str(proc.returncode) + ')', RED)
            self._set_status('Install failed')
            return False
        except FileNotFoundError:
            self._log_line('npm not found on PATH -- install Node.js first', RED)
            self._set_status('npm missing')
            return False
        except Exception as e:
            self._log_line('npm install error: ' + str(e), RED)
            self._set_status('Install error')
            return False

    def _run_install(self):
        def _do():
            self._log_line('--- npm install ---', ACCENT)
            self._set_status('Installing dependencies...')
            if not self._ensure_node():
                self._set_status('Ready')
                self._log_line('--- End ---', ACCENT)
                return
            try:
                proc = subprocess.Popen(
                    ['npm', 'install'],
                    cwd=ROOT, env={**os.environ},
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    encoding='utf-8', errors='replace', bufsize=1,
                    start_new_session=True,
                )
                for raw in proc.stdout:
                    line = raw.rstrip()
                    if line:
                        lo = line.lower()
                        if any(w in lo for w in ('added', 'found', 'up to date')):
                            color = GREEN
                        elif 'error' in lo:
                            color = RED
                        else:
                            color = '#a0a0c0'
                        self._log_line('[npm install] ' + line, color)
                proc.wait()
                if proc.returncode == 0:
                    self._log_line('Done', GREEN)
                else:
                    self._log_line('Failed (code ' + str(proc.returncode) + ')', RED)
            except FileNotFoundError:
                self._log_line('npm not found on PATH -- install Node.js first', RED)
            except Exception as e:
                self._log_line('Error: ' + str(e), RED)
            finally:
                self._set_status('Ready')
                self._log_line('--- End ---', ACCENT)
        threading.Thread(target=_do, daemon=True).start()

    # ── Node.js dependency ──────────────────────────────────────────────────
    def _check_node_on_start(self):
        npm = shutil.which('npm')
        if npm:
            self._log_line('Node.js detected: ' + npm, GREEN)
            return
        # Don't auto-download here -- the 25 MB pull would feel like a surprise
        # at app launch. The first START/INSTALL click triggers the install.
        self._log_line('Node.js not on PATH -- will auto-download on first install', AMBER)

    def _ensure_node(self) -> bool:
        """Make sure `npm` is available. Downloads Node.js LTS on demand if not."""
        with self._node_install_lock:
            if shutil.which('npm'):
                return True
            bundled = _ensure_bundled_node_on_path()
            if bundled and shutil.which('npm'):
                self._log_line('Using bundled Node.js at ' + bundled, GREEN)
                return True
            self._installing_node = True
            try:
                self._log_line('npm not found on PATH -- downloading Node.js '
                               + _NODE_VERSION + ' into ' + _NODE_DIR, AMBER)
                self._set_status('Downloading Node.js...')
                bin_dir = _download_node(self._log_line)
                if not bin_dir:
                    self._log_line('Could not auto-install Node.js. Manual options:', RED)
                    self._log_line('  Ubuntu/Debian:  sudo apt install nodejs npm', AMBER)
                    self._log_line('  Fedora:         sudo dnf install nodejs npm', AMBER)
                    self._log_line('  Arch:           sudo pacman -S nodejs npm', AMBER)
                    self._set_status('Node.js missing')
                    return False
                self._log_line('Node.js ready: ' + bin_dir, GREEN)
                return shutil.which('npm') is not None
            finally:
                self._installing_node = False

    # ── Ollama dependency ──────────────────────────────────────────────────
    def _check_ollama_on_start(self):
        path = resolve_ollama()
        if path:
            self._log_line('Ollama detected: ' + path, GREEN)
            return
        self._log_line('Ollama is not installed -- the Chat UI needs it to work', AMBER)
        self._prompt_install_ollama()

    def _prompt_install_ollama(self):
        if self._installing_ollama:
            self._log_line('Ollama install instructions already shown', AMBER)
            return
        answer = messagebox.askyesno(
            'Install Ollama?',
            'Ollama is required for the Chat UI but is not on PATH.\n\n'
            'The official Linux installer needs sudo, so this launcher will not\n'
            'run it for you.\n\n'
            'Open the install instructions in your browser?\n\n'
            'Or paste this into a terminal:\n'
            '    ' + _OLLAMA_INSTALL_ONELINE,
        )
        if not answer:
            self._log_line('Ollama install skipped by user', MUTED)
            return
        self._installing_ollama = True
        try:
            webbrowser.open(_OLLAMA_INSTALL_PAGE)
            self._log_line('Opened install page: ' + _OLLAMA_INSTALL_PAGE, ACCENT)
            self._log_line('Run in a terminal:  ' + _OLLAMA_INSTALL_ONELINE, TEXT)
            self._log_line(
                'When the installer finishes, click START on the Ollama card to launch it.',
                ACCENT,
            )
        finally:
            # Keep the flag latched so we don't spam the dialog; user can
            # always trigger it again via the Ollama Start button.
            pass

    # ── Aider dependency ────────────────────────────────────────────────────
    def _check_aider_on_start(self):
        path = resolve_aider()
        if path:
            self._log_line('Aider detected: ' + path, GREEN)
            return
        self._log_line('Aider is not installed -- the Chat UI Code section needs it', AMBER)
        self._prompt_install_aider()

    def _prompt_install_aider(self):
        if self._installing_aider:
            self._log_line('Aider install already in progress...', AMBER)
            return
        pip = _find_pip_cmd()
        if not pip:
            self._log_line(
                'python3 / pip not found on PATH -- install Python 3 first to use aider', RED
            )
            return
        answer = messagebox.askyesno(
            'Install Aider?',
            'Aider is required for the Code section of the Chat UI.\n\n'
            'Install with:\n'
            '    ' + ' '.join(pip) + ' install --user aider-chat\n\n'
            'Click Yes to install now (uses your system Python; no sudo needed).',
        )
        if not answer:
            self._log_line('Aider install skipped by user', MUTED)
            return
        threading.Thread(target=self._install_aider, args=(pip,), daemon=True).start()

    def _run_install_aider(self):
        if resolve_aider():
            self._log_line('Aider is already installed: ' + resolve_aider(), GREEN)
            return
        self._installing_aider = False
        self._prompt_install_aider()

    def _install_aider(self, pip):
        """Install aider via uv (primary) or pipx (fallback).

        Dropped strategies (pip --user, aider-install meta-package, project
        venv) all eventually invoke pip's build-isolation which downloads a
        stale setuptools that crashes on Python 3.12+ when numpy needs to
        be source-built. uv with a managed Python avoids this entirely.
        """
        self._installing_aider = True
        self._set_status('Installing aider...')
        try:
            self._log_line('Attempting install via uv (downloads its own Python)...', ACCENT)
            ok = self._install_aider_via_uv()
            if not ok:
                pipx = _find_pipx_cmd()
                if pipx:
                    self._log_line('uv path failed — trying pipx isolated install...', AMBER)
                    ok = self._run_pip_subprocess(pipx + ['install', 'aider-chat'], '[pipx]')
                    ok = ok and resolve_aider() is not None
            if ok:
                self._log_line('Aider installed successfully', GREEN)
                path = resolve_aider()
                if path:
                    self._log_line('Aider resolved at: ' + path, GREEN)
                else:
                    self._log_line(
                        'Aider install reported success but resolve_aider() returned None. '
                        'It may have landed in ~/.local/bin/ — add it to PATH:  '
                        'export PATH="$HOME/.local/bin:$PATH"', AMBER
                    )
            else:
                self._log_line('Aider install failed; see errors above', RED)
                self._log_line('Manual install — run in a terminal:', AMBER)
                self._log_line('   curl -LsSf https://astral.sh/uv/install.sh | sh', AMBER)
                self._log_line('   ~/.local/bin/uv python install 3.12', AMBER)
                self._log_line('   ~/.local/bin/uv tool install --python 3.12 aider-chat', AMBER)
                self._log_line('Then restart the launcher.', AMBER)
        finally:
            self._installing_aider = False
            self._set_status('Ready')

    def _install_aider_via_uv(self) -> bool:
        """Download uv (if needed), install a managed Python under uv, then
        install aider into it. Same trick as the Windows path: tell uv to
        download its own python-build-standalone CPython so we never touch
        the host distro Python (which may be PEP-668-locked or sandboxed)."""
        uv = _resolve_uv()
        if not uv:
            self._log_line('uv not found — downloading directly from astral.sh...', ACCENT)
            uv = _download_uv(self._log_line)
            if not uv:
                self._log_line('uv download failed; cannot proceed via uv path', RED)
                return False
            self._log_line('uv installed at ' + uv, GREEN)
        else:
            self._log_line('uv detected at ' + uv, GREEN)

        self._log_line('Ensuring uv has a managed Python 3.12 (may download ~30 MB on first run)...', ACCENT)
        py_ok = self._run_pip_subprocess(
            [uv, 'python', 'install', '3.12'],
            '[uv python]'
        )
        if not py_ok:
            self._log_line(
                'uv python install failed — falling back to system Python (may still work)', AMBER
            )

        self._log_line('Running uv tool install aider-chat (forcing managed Python 3.12)...', ACCENT)
        ok = self._run_pip_subprocess(
            [uv, 'tool', 'install', '--force', '--python', '3.12', 'aider-chat'],
            '[uv]'
        )
        if not ok:
            self._log_line('Retrying uv tool install without an explicit Python pin...', AMBER)
            ok = self._run_pip_subprocess(
                [uv, 'tool', 'install', '--force', 'aider-chat'],
                '[uv]'
            )
        return ok and resolve_aider() is not None

    def _install_aider_via_aider_install(self, pip) -> bool:
        """Use the official aider-install meta-package.

        aider-install is a tiny pure-Python package (no native deps), so even
        PEP-668-locked or sandboxed Pythons can pip-install it with --user.
        When run, it installs uv (a fast Rust-based installer) and uses
        `uv tool install aider-chat`, producing a stand-alone aider binary
        in ~/.local/bin/.
        """
        ok = self._run_pip_subprocess(
            pip + ['install', '--user', '--upgrade', 'aider-install'],
            '[pip meta]'
        )
        if not ok:
            # Some distros need --break-system-packages on PEP 668 systems.
            self._log_line('Retrying pip install with --break-system-packages...', AMBER)
            ok = self._run_pip_subprocess(
                pip + ['install', '--user', '--upgrade', '--break-system-packages',
                       'aider-install'],
                '[pip meta]'
            )
        if not ok:
            return False
        py_for_module = pip[0] if pip[0].endswith(('python', 'python3', 'py')) else 'python3'
        self._log_line('Running aider-install — this may take a minute on first run...', ACCENT)
        ok = self._run_pip_subprocess([py_for_module, '-m', 'aider_install'], '[aider-install]')
        return ok or resolve_aider() is not None

    def _install_aider_into_venv(self, pip) -> bool:
        """Bootstrap <ROOT>/.venv-aider/ and install aider into it."""
        py_for_bootstrap = pip[0]
        if not os.path.isfile(py_for_bootstrap):
            for cand in ('python3', 'python'):
                p = shutil.which(cand)
                if p:
                    py_for_bootstrap = p
                    break
        if os.path.isdir(_AIDER_VENV_DIR) and _aider_venv_python():
            self._log_line('venv already exists at ' + _AIDER_VENV_DIR + ' — reusing', AMBER)
        else:
            ok = self._run_pip_subprocess(
                [py_for_bootstrap, '-m', 'venv', _AIDER_VENV_DIR],
                '[venv create]'
            )
            if not ok or not _aider_venv_python():
                self._log_line(
                    'Could not create venv at ' + _AIDER_VENV_DIR + '. '
                    'On Debian/Ubuntu install python3-venv:  sudo apt install python3-venv',
                    RED
                )
                return False
        venv_py = _aider_venv_python()
        self._log_line('Upgrading pip / setuptools / wheel inside venv...', ACCENT)
        self._run_pip_subprocess(
            [venv_py, '-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'],
            '[venv prep]'
        )
        self._log_line('Installing aider-chat into venv (preferring wheels)...', ACCENT)
        ok = self._run_pip_subprocess(
            [venv_py, '-m', 'pip', 'install', '--upgrade', '--prefer-binary', 'aider-chat'],
            '[venv aider]'
        )
        return ok and _aider_venv_bin() is not None

    def _run_pip_subprocess(self, cmd, label='[pip]'):
        """Run a pip/pipx command, stream its output, return True on exit 0."""
        self._log_line('Running: ' + ' '.join(cmd), ACCENT)
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                encoding='utf-8', errors='replace', bufsize=1,
                start_new_session=True,
            )
            for raw in proc.stdout:
                line = raw.rstrip()
                if not line:
                    continue
                lo = line.lower()
                color = (
                    GREEN if 'successfully installed' in lo
                    else RED if 'error' in lo
                    else '#a0a0c0'
                )
                self._log_line(label + ' ' + line, color)
            proc.wait()
            return proc.returncode == 0
        except FileNotFoundError as e:
            self._log_line(label + ' command not runnable: ' + str(e), RED)
            return False
        except Exception as e:
            self._log_line(label + ' error: ' + str(e), RED)
            return False

    # ── Service control ─────────────────────────────────────────────────────
    def _start_one(self, key: str):
        svc = next(s for s in SERVICES if s['key'] == key)
        if key == 'ollama' and not resolve_ollama():
            self._installing_ollama = False
            self._prompt_install_ollama()
            return
        if port_in_use(svc['port']):
            self._log_line(svc['name'] + ' already running on :' + str(svc['port']), AMBER)
            return
        def _do():
            if svc.get('needs_npm', True) and not self._ensure_deps():
                return
            self._launch(svc)
        threading.Thread(target=_do, daemon=True).start()

    def _stop_one(self, key: str):
        svc = next(s for s in SERVICES if s['key'] == key)
        threading.Thread(target=self._kill, args=(svc,), daemon=True).start()

    def _start_all(self):
        if not resolve_ollama():
            self._installing_ollama = False
            self._prompt_install_ollama()
        def _do():
            if not self._ensure_deps():
                return
            # Fish Speech is a peer of Kokoro — both are local TTS engines
            # the Voice Preset panel can pick between, so they boot together.
            order = {'ollama': 0, 'kokoro': 0, 'fish_speech': 0, 'ollama_ui': 1}
            ordered = sorted(SERVICES, key=lambda s: order.get(s['key'], 2))
            for svc in ordered:
                if svc['key'] == 'ollama' and not resolve_ollama():
                    continue
                threading.Thread(target=self._launch, args=(svc,), daemon=True).start()
                time.sleep(0.3)
        threading.Thread(target=_do, daemon=True).start()

    def _stop_all(self):
        for svc in SERVICES:
            threading.Thread(target=self._kill, args=(svc,), daemon=True).start()

    def _launch(self, svc: dict):
        key = svc['key']
        if port_in_use(svc['port']):
            self._log_line(svc['name'] + ' already on :' + str(svc['port']), AMBER)
            return
        cmd = svc['cmd']
        if key == 'ollama':
            ollama_bin = resolve_ollama()
            if not ollama_bin:
                self._log_line('Ollama is not installed -- skipping', RED)
                return
            cmd = [ollama_bin, 'serve']
        if key == 'fish_speech' and _gguf_backend_ok():
            # Fast GGUF backend selected — validate the binary + model files,
            # then launch with the freshest resolved command. When the GGUF
            # backend is absent we fall through to the Python launcher path,
            # which bootstraps its own runtime, so it skips this hard preflight.
            if not self._fish_preflight():
                self._set_status('Ready')
                return
            cmd = _FISH_CMD
        self._log_line('Starting ' + svc['name'] + '...', TEXT)
        self._set_status('Starting ' + svc['name'] + '...')
        try:
            env = {**os.environ, 'NODE_OPTIONS': '--max-old-space-size=8192'}
            env.update(svc.get('env', {}))
            proc = subprocess.Popen(
                cmd, cwd=ROOT, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                encoding='utf-8', errors='replace', bufsize=1,
                # New session = new process group, so _kill_proc_tree can take
                # down anything the service spawns (npx → node, etc.).
                start_new_session=True,
            )
            with self._lock:
                self._procs[key] = proc
            if key == 'fish_speech':
                # Model load + bind takes time on CPU — announce when it's live.
                threading.Thread(target=self._fish_wait_online, daemon=True).start()
            for raw in proc.stdout:
                line = raw.rstrip()
                if line:
                    lo = line.lower()
                    if any(w in lo for w in ('ready', 'started', 'running', 'listening')):
                        color = GREEN
                    elif 'error' in lo:
                        color = RED
                    else:
                        color = '#a0a0c0'
                    self._log_line('[' + svc['name'] + '] ' + line, color)
            proc.wait()
            code = proc.returncode
            self._log_line(svc['name'] + ' exited (code ' + str(code) + ')',
                           AMBER if code else MUTED)
        except FileNotFoundError as e:
            self._log_line('Failed to start ' + svc['name'] + ': ' + str(e), RED)
        except Exception as e:
            self._log_line('Failed to start ' + svc['name'] + ': ' + str(e), RED)
        finally:
            with self._lock:
                self._procs.pop(key, None)
            self._set_status('Ready')

    def _fish_preflight(self) -> bool:
        """Validate the GGUF/s2.cpp backend before starting Fish Speech.

        Only meaningful when the GGUF backend is selected; the Python launcher
        path handles its own setup. Logs each check and returns True only when
        the binary, model, codec and tokenizer all exist."""
        # 1 — compiled s2.cpp binary
        if not os.path.isfile(_FISH_GGUF_BINARY):
            self._log_line('[Fish Speech] ERROR: binary not found at ' + _FISH_GGUF_BINARY, RED)
            self._log_line('[Fish Speech] Build s2.cpp or set FISH_GGUF_ROOT, then retry.', RED)
            return False
        self._log_line('[Fish Speech] binary found', GREEN)

        # 2 — transformer / model GGUF
        transformer = os.path.join(_FISH_GGUF_MODELDIR, 's2-pro-q4_k_m-transformer-only.gguf')
        if not os.path.isfile(transformer):
            self._log_line('[Fish Speech] ERROR: model GGUF not found at ' + transformer, RED)
            return False
        self._log_line('[Fish Speech] model found', GREEN)

        # 3 — codec GGUF (q4_k_m preferred, f16 fallback)
        codec = _resolve_gguf_codec()
        if not os.path.isfile(codec):
            self._log_line('[Fish Speech] ERROR: codec GGUF not found in ' + _FISH_GGUF_MODELDIR, RED)
            self._log_line('[Fish Speech] Expected s2-pro-q4_k_m-codec-only.gguf or s2-pro-f16-codec-only.gguf', RED)
            return False
        self._log_line('[Fish Speech] codec found', GREEN)

        # 4 — tokenizer (required by the s2 binary)
        if not os.path.isfile(_FISH_GGUF_TOKENIZER):
            self._log_line('[Fish Speech] ERROR: tokenizer.json not found at ' + _FISH_GGUF_TOKENIZER, RED)
            return False

        self._log_line('[Fish Speech] starting on port 8080', ACCENT)
        return True

    def _fish_wait_online(self):
        """Poll the Fish Speech /health endpoint until it answers, then log online.
        Model load + bind can take 10-60 s on CPU, so we wait up to ~120 s."""
        for _ in range(120):
            time.sleep(1)
            with self._lock:
                alive = self._procs.get('fish_speech') is not None
            if not alive:
                return  # process exited or was stopped before coming online
            ok, _info = fish_speech_http_ok(timeout=2.0)
            if ok:
                self._log_line('[Fish Speech] server online', GREEN)
                return

    def _kill(self, svc: dict):
        self._log_line('Stopping ' + svc['name'] + '...', AMBER)
        with self._lock:
            proc = self._procs.get(svc['key'])
        if proc:
            _kill_proc_tree(proc)
        kill_port(svc['port'])
        self._log_line(svc['name'] + ' stopped', MUTED)

    # ── Fish Speech S2 Pro model ────────────────────────────────────────────
    #
    # Startup flow (called ~1.6 s after the window appears):
    #   _check_fish_s2_on_start
    #     ├── found in any candidate path? → log ready, update global, exit
    #     ├── partial git clone in cache?  → resume non-destructively
    #     └── nothing found?              → prompt: download or choose folder
    #
    # _choose_fish_s2_folder  ← "📁 S2 PRO FOLDER" button in Actions bar.
    #   Opens a folder-picker; validates required files; saves path to config.
    #
    # _ensure_fish_s2_pro     ← actual git clone / resume logic (daemon thread).
    def _check_fish_s2_on_start(self):
        """Search all candidate paths for the model; update global if found."""
        global FISH_S2_PRO_MODEL_PATH, _FISH_CMD
        self._log_line('Checking Fish Speech S2 Pro model paths...', ACCENT)

        # Walk every candidate and report what we find.
        found_path: str | None = None
        for path in _fish_s2_pro_candidate_paths():
            if not os.path.isdir(path):
                continue  # doesn't exist — skip silently
            missing = _fish_s2_pro_missing_files(path)
            if not missing:
                found_path = path
                self._log_line('Found model at ' + path, GREEN)
                break
            else:
                self._log_line('Folder exists but incomplete at: ' + path, AMBER)
                self._log_line('Missing files: ' + ', '.join(missing), AMBER)

        if found_path:
            # Update the global so _ensure_fish_s2_pro and child services see it.
            FISH_S2_PRO_MODEL_PATH = found_path
            os.environ['FISH_S2_PRO_MODEL_PATH'] = found_path
            # Persist the discovered path so next launch finds it immediately.
            if _fish_s2_pro_config_load() != found_path:
                _fish_s2_pro_config_save(found_path)

            # Rebuild the start command now that the model is located —
            # prefer the fast GGUF binary, else the Python launcher.
            if _gguf_backend_ok():
                self._log_line('● Using GGUF backend: ' + _FISH_GGUF_BINARY, GREEN)
                _FISH_CMD[:] = _gguf_fish_cmd()
            elif os.path.isfile(_FISH_SERVER_PY):
                _py = _FISH_VENV_PY if os.path.isfile(_FISH_VENV_PY) else (
                    _resolve_host_python_for_fish() or 'python3')
                _FISH_CMD[:] = [_py, _FISH_SERVER_PY]
            # Keep the service card's command in sync with the rebuilt _FISH_CMD.
            for svc in SERVICES:
                if svc['key'] == 'fish_speech':
                    svc['cmd'] = _FISH_CMD[:]

            self._log_line('Fish Speech S2 Pro ready.', GREEN)
            self._log_line('Using existing model at ' + found_path, GREEN)

            # Auto-start the server if it isn't already up. We only auto-start
            # the fast GGUF backend; the Python launcher can trigger a lengthy
            # first-run clone + venv build, so we leave that to an explicit
            # Start click (mirrors the effective Windows behaviour, where the
            # GGUF preflight gates auto-start).
            ok, _ = fish_speech_http_ok(timeout=1.5)
            if ok:
                self._log_line(
                    '● Fish server: already running at '
                    + (os.environ.get('FISH_TTS_URL') or 'http://127.0.0.1:8080'),
                    GREEN,
                )
            elif _gguf_backend_ok():
                self._log_line('● Fish server: not running — auto-starting (GGUF backend)…', ACCENT)
                self.after(500, lambda: self._auto_start_fish())
            else:
                self._log_line(
                    'Press Start on the Fish Speech S2 Pro card to launch the server.', MUTED,
                )
            return

        # Path 2 — interrupted git clone sitting in the default cache dir.
        if _fish_s2_pro_clone_exists():
            self._log_line(
                'Partial Fish Speech S2 Pro download detected at: '
                + _FISH_S2_PRO_DEFAULT_CACHE, AMBER,
            )
            self._log_line('Resuming download (only missing assets will be fetched)…', ACCENT)
            threading.Thread(
                target=self._ensure_fish_s2_pro, kwargs={'resume': True}, daemon=True,
            ).start()
            return

        # Path 3 — nothing found anywhere.
        candidate_list = '\n'.join('  • ' + p for p in _fish_s2_pro_candidate_paths())
        self._log_line('Fish Speech S2 Pro model not found in any of these locations:', AMBER)
        for p in _fish_s2_pro_candidate_paths():
            self._log_line('  • ' + p, MUTED)
        self._log_line(
            'Tip: use the "📁 S2 PRO FOLDER" button to point to an existing download.', MUTED
        )

        answer = messagebox.askyesno(
            'Fish Speech S2 Pro Model',
            'The Fish Speech S2 Pro model was not found.\n\n'
            'Locations checked:\n' + candidate_list + '\n\n'
            'Options:\n'
            '  • YES  — download automatically (~several GB)\n'
            '  • NO   — use the "📁 S2 PRO FOLDER" button to select an existing folder\n\n'
            'Download now?',
        )
        if not answer:
            self._log_line(
                'Download skipped.  '
                'Use the "📁 S2 PRO FOLDER" button to point to an existing model folder.', MUTED,
            )
            return
        threading.Thread(target=self._ensure_fish_s2_pro, daemon=True).start()

    def _auto_start_fish(self):
        """Auto-start the Fish Speech server if the model is present and the
        server is not already responding. Triggered shortly after the model is
        discovered at launch (GGUF backend only)."""
        ok, _ = fish_speech_http_ok(timeout=1.0)
        if ok:
            self._log_line('● Fish server: already up — skipping auto-start', GREEN)
            return
        if self._cards.get('fish_speech'):
            self._log_line('Auto-starting Fish Speech S2 Pro server…', ACCENT)
            self._start_one('fish_speech')

    def _choose_fish_s2_folder(self):
        """Open a folder-picker so the user can select an existing S2 Pro model folder.

        Validates required files in the chosen folder, saves the path to the
        config file so the app remembers it after a restart, and updates the
        global FISH_S2_PRO_MODEL_PATH immediately so any service started in
        this session uses the correct weights.
        """
        global FISH_S2_PRO_MODEL_PATH
        from tkinter import filedialog

        # Start the picker in a sensible initial directory.
        _init = (
            os.path.join(_HOME, 's2-pro') if os.path.isdir(os.path.join(_HOME, 's2-pro'))
            else _HOME
        )
        folder = filedialog.askdirectory(
            title='Select Fish Speech S2 Pro model folder',
            initialdir=_init,
        )
        if not folder:
            return  # user cancelled

        self._log_line('Checking Fish Speech S2 Pro model paths...', ACCENT)
        missing = _fish_s2_pro_missing_files(folder)

        if missing:
            self._log_line('Selected folder is missing required files:', AMBER)
            for fname in missing:
                self._log_line('  Missing: ' + fname, RED)
            answer = messagebox.askyesno(
                'Incomplete Model Folder',
                'The selected folder is missing required files:\n\n'
                + '\n'.join('  • ' + f for f in missing)
                + '\n\nUse this folder anyway?  (you can run git lfs pull inside it later)',
            )
            if not answer:
                self._log_line('Folder selection cancelled.', MUTED)
                return

        # All checks passed (or user accepted an incomplete folder).
        FISH_S2_PRO_MODEL_PATH = folder
        os.environ['FISH_S2_PRO_MODEL_PATH'] = folder

        if _fish_s2_pro_config_save(folder):
            self._log_line('Model path saved to config — will be used on next restart too.', MUTED)
        else:
            self._log_line(
                'Warning: could not write config file ' + _FISH_S2_PRO_CONFIG_FILE
                + ' — path is active for this session but will not persist.', AMBER,
            )

        if not missing:
            self._log_line('Fish Speech S2 Pro ready.', GREEN)
            self._log_line('Using existing model at ' + folder, GREEN)
        else:
            self._log_line('Model path set (incomplete) — ' + folder, AMBER)

    def _ensure_fish_s2_pro(self, resume: bool = False):
        """Install or resume the Fish Audio S2 Pro model download.

        Steps (each logged with a clear "[step N/5]" prefix so failures are
        easy to attribute):
          1. Installing dependencies — verify git, git-lfs, python3, pip.
          2. Enable git-lfs filters for this user (idempotent).
          3. Create the parent cache directory (outside the Git repo).
          4. Either `git clone` (fresh) or `git fetch + git lfs pull`
             (resume) — resumable, idempotent, avoids re-downloading
             assets that are already on disk.
          5. Verify .safetensors weights are real (not LFS pointers).

        `resume=True` skips the destructive clone path and goes straight to
        the in-place fetch + lfs pull. Safe to retry — partial files are
        completed rather than re-downloaded.
        """
        # Guard against the user double-clicking the install button while a
        # previous attempt is still streaming.
        if self._installing_fish_s2:
            self._log_line('Fish Audio S2 Pro download already in progress…', AMBER)
            return
        self._installing_fish_s2 = True
        self._set_status('Downloading Fish Audio S2 Pro…')

        try:
            # ── Step 1/5: dependency check ────────────────────────────────────
            # Bundles git / git-lfs / python3 / pip into one report so the user
            # sees everything that's missing in a single message.
            self._log_line('[step 1/5] Installing dependencies…', ACCENT)
            missing = _missing_fish_s2_pro_deps()
            if missing:
                lines = ['Cannot install Fish Audio S2 Pro — missing dependencies:']
                for name, hint in missing:
                    lines.append('  • ' + name + '   →   ' + hint)
                lines.append('After installing the missing tool(s), relaunch and try again.')
                self._log_line('\n'.join(lines), RED)
                # Surface a dialog too so the user notices even if the log
                # has scrolled past.
                messagebox.showerror(
                    'Fish Audio S2 Pro — missing dependencies',
                    '\n'.join(['Cannot install Fish Audio S2 Pro.', ''] + [
                        '• ' + n for n, _ in missing
                    ] + ['', 'See the launcher log for install commands.']),
                )
                return
            self._log_line('Dependencies OK: git, git-lfs, python3, pip.', GREEN)

            # ── Step 2/5: enable git-lfs filters for this user ────────────────
            # `git lfs install` sets up filter.lfs.* config so the upcoming
            # clone actually fetches the real weights, not 134-byte pointers.
            self._log_line('[step 2/5] Enabling git-lfs filters…', ACCENT)
            if not _git_lfs_install_user():
                self._log_line(
                    'Warning: `git lfs install` did not return success. '
                    'Continuing anyway — LFS may already be enabled globally.',
                    AMBER,
                )

            # ── Step 3/5: create the cache directory OUTSIDE the Git repo ─────
            # FISH_S2_PRO_MODEL_PATH lives under ~/.cache/trendvault/models/
            # which is never inside the project folder, so no .safetensors
            # ever land in the Git working tree.
            self._log_line('[step 3/5] Preparing model directory…', ACCENT)
            parent_dir = os.path.dirname(FISH_S2_PRO_MODEL_PATH)
            try:
                os.makedirs(parent_dir, exist_ok=True)
            except OSError as exc:
                self._log_line(
                    '[step 3/5 FAILED] Could not create ' + parent_dir
                    + ': ' + str(exc), RED,
                )
                return
            self._log_line('Model directory: ' + FISH_S2_PRO_MODEL_PATH, MUTED)

            # ── Step 4/5: download (fresh clone OR resumable fetch) ───────────
            self._log_line('[step 4/5] Downloading model…', ACCENT)

            # Decide which path to take. We prefer resume whenever a .git
            # directory exists, even if `resume` wasn't explicitly requested —
            # it's always cheaper than re-cloning.
            do_resume = resume or _fish_s2_pro_clone_exists()
            if do_resume:
                # In-place: refresh refs, then ask LFS to fetch any missing
                # large objects. Both commands are no-ops if the working
                # tree is already up to date, so this is safe to retry.
                self._log_line(
                    'Resuming previous download — no files will be deleted.', ACCENT,
                )
                resume_steps = [
                    ['git', '-C', FISH_S2_PRO_MODEL_PATH, 'fetch', '--all'],
                    ['git', '-C', FISH_S2_PRO_MODEL_PATH, 'lfs', 'pull'],
                ]
                for step_cmd in resume_steps:
                    self._log_line('Running: ' + ' '.join(step_cmd), MUTED)
                    ok = self._stream_git_cmd(step_cmd, tag='s2-pro resume')
                    if not ok:
                        self._log_line(
                            '[step 4/5 FAILED] ' + ' '.join(step_cmd[:3])
                            + ' returned a non-zero exit code. '
                            'Check your internet connection and rerun the install.',
                            RED,
                        )
                        return
            else:
                # Fresh clone. We only reach this branch when the target dir
                # does NOT contain a .git folder, so it's safe to point git
                # at the path without rm -rf'ing user data.
                self._log_line(
                    'Cloning from ' + FISH_S2_PRO_REPO_URL + ' — this may take '
                    'several minutes (the .safetensors weights are several GB).',
                    ACCENT,
                )
                cmd = ['git', 'clone', FISH_S2_PRO_REPO_URL, FISH_S2_PRO_MODEL_PATH]
                self._log_line('Running: ' + ' '.join(cmd), MUTED)
                ok = self._stream_git_cmd(cmd, tag='s2-pro clone')
                if not ok:
                    self._log_line(
                        '[step 4/5 FAILED] git clone failed. '
                        'Check your internet connection and that git-lfs is working. '
                        'You can also clone manually:\n'
                        '    git clone ' + FISH_S2_PRO_REPO_URL + ' '
                        + FISH_S2_PRO_MODEL_PATH,
                        RED,
                    )
                    return

            # ── Step 5/5: verify ──────────────────────────────────────────────
            # Confirm at least one .safetensors > 4 KB exists — i.e. the LFS
            # pointer was resolved into real weights.
            self._log_line('[step 5/5] Verifying model assets…', ACCENT)
            if _fish_s2_pro_is_installed():
                # Re-export the env var so any service started after this
                # point sees the now-valid path.
                os.environ['FISH_S2_PRO_MODEL_PATH'] = FISH_S2_PRO_MODEL_PATH
                self._log_line('Fish Audio S2 Pro ready.', GREEN)
                self._log_line('Model path: ' + FISH_S2_PRO_MODEL_PATH, GREEN)
                self._log_line(
                    'FISH_S2_PRO_MODEL_PATH exported for child services.', MUTED,
                )
            else:
                # The clone finished but LFS didn't fetch the big files —
                # most likely the user's git-lfs hooks weren't wired up.
                # Tell them exactly which command to run by hand.
                self._log_line(
                    '[step 5/5 FAILED] Clone finished but no .safetensors weights '
                    'were found. git-lfs may not have fetched the large files. '
                    'Run this inside the model directory and try again:\n'
                    '    cd ' + FISH_S2_PRO_MODEL_PATH + ' && git lfs pull',
                    AMBER,
                )

        finally:
            self._installing_fish_s2 = False
            self._set_status('Ready')

    def _stream_git_cmd(self, cmd: list[str], tag: str = 's2-pro') -> bool:
        """Run a git/git-lfs command, stream stdout into the UI log, return True on success.

        Factored out so the fresh-clone and resume-pull paths both share the
        same colorized progress output. Returns False on any non-zero exit.
        """
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,   # git sends progress to stderr
                encoding='utf-8',
                errors='replace',
                bufsize=1,
                start_new_session=True,
            )
            for raw in proc.stdout:
                line = raw.rstrip()
                if not line:
                    continue
                lo = line.lower()
                if 'error' in lo or 'fatal' in lo:
                    color = RED
                elif any(w in lo for w in ('done', 'complete', 'resolving', 'receiving')):
                    color = GREEN
                else:
                    color = '#a0a0c0'
                self._log_line('[' + tag + '] ' + line, color)
            proc.wait()
            return proc.returncode == 0
        except FileNotFoundError:
            self._log_line('git not found on PATH while running: ' + ' '.join(cmd), RED)
            return False
        except Exception as exc:
            self._log_line('git command raised an unexpected error: ' + str(exc), RED)
            return False

    # ── Health check ───────────────────────────────────────────────────────────────────────
    def _health(self):
        def _check():
            self._log_line('--- Health Check ---', ACCENT)
            for svc in SERVICES:
                port_up = port_in_use(svc['port'])
                # If the service has a custom HTTP probe (Fish Speech does),
                # confirm it's actually that service responding before we
                # call it healthy. Port 8080 in particular is a common dev
                # port that another process can squat on.
                http_probe = svc.get('http_health')
                if port_up and callable(http_probe):
                    ok, info = http_probe()
                    if ok:
                        up = True
                        status = 'RUNNING (HTTP OK @ ' + info + ')'
                    else:
                        up = False
                        status = 'PORT BUSY but Fish Speech HTTP probe failed at ' + info
                else:
                    up = port_up
                    status = 'RUNNING' if up else 'STOPPED'
                self._log_line(
                    svc['name'].ljust(15) + '  :' + str(svc['port']) + '  ' + status,
                    GREEN if up else RED
                )
            folders = [
                'trend-vault-output', 'public/custom-audio',
                'backgrounds', 'music', 'custom-audio',
                'kokoro-tts', 'Ollama web ui',
            ]
            for folder in folders:
                exists = os.path.isdir(os.path.join(ROOT, folder))
                self._log_line(
                    'Folder'.ljust(15) + '  ' + folder.ljust(25) + '  ' + ('OK' if exists else 'MISSING'),
                    TEXT if exists else AMBER
                )
            env_ok = os.path.isfile(os.path.join(ROOT, '.env'))
            self._log_line(
                'Config'.ljust(15) + '  .env' + (' OK' if env_ok else '  MISSING -- API keys unavailable'),
                TEXT if env_ok else RED
            )
            kokoro_ready = os.path.isfile(os.path.join(ROOT, 'kokoro-tts', 'kokoro-v0_19.onnx'))
            self._log_line(
                'Kokoro model'.ljust(15) + '  ' + ('OK' if kokoro_ready else 'MISSING -- run scripts/setup-kokoro.sh'),
                TEXT if kokoro_ready else AMBER
            )
            ollama_path = resolve_ollama()
            self._log_line(
                'Ollama'.ljust(15) + '  ' + (ollama_path if ollama_path else 'MISSING -- install via ' + _OLLAMA_INSTALL_ONELINE),
                TEXT if ollama_path else AMBER
            )
            aider_path = resolve_aider()
            self._log_line(
                'Aider'.ljust(15) + '  ' + (aider_path if aider_path else 'MISSING -- click INSTALL AIDER to add it'),
                TEXT if aider_path else AMBER
            )
            # Fish Speech S2 Pro model — multi-path check
            self._log_line('Checking Fish Speech S2 Pro model paths...', ACCENT)
            _fish_found = resolve_fish_s2_pro_path()
            if _fish_found:
                self._log_line(
                    'Fish S2 Pro'.ljust(15) + '  OK — ' + _fish_found, TEXT
                )
            else:
                # Walk candidates so the user knows exactly what is wrong.
                _any_partial = False
                for _cp in _fish_s2_pro_candidate_paths():
                    if not os.path.isdir(_cp):
                        continue
                    _mf = _fish_s2_pro_missing_files(_cp)
                    if _mf:
                        _any_partial = True
                        self._log_line(
                            'Fish S2 Pro'.ljust(15) + '  INCOMPLETE at ' + _cp, AMBER
                        )
                        self._log_line(
                            '  Missing files: ' + ', '.join(_mf), AMBER
                        )
                if not _any_partial:
                    self._log_line(
                        'Fish S2 Pro'.ljust(15)
                        + '  MISSING — use "📁 S2 PRO FOLDER" or download',
                        AMBER
                    )
            # Fish Speech runtime (the inference server's Python venv).
            # Without this, the Fish Speech S2 Pro card's Start button has
            # no Python to execute even when the model weights are present.
            fish_runtime_ok = os.path.isfile(_FISH_VENV_PY)
            self._log_line(
                'Fish runtime'.ljust(15) + '  ' + (
                    'OK (' + _FISH_VENV_PY + ')' if fish_runtime_ok
                    else 'MISSING -- press Start on the Fish Speech S2 Pro card (fish_speech_server.py will clone + build the venv automatically), or set FISH_TTS_URL to an external server'
                ),
                TEXT if fish_runtime_ok else AMBER
            )
            # Host Python compatibility check — fish_speech_server.py needs
            # a Python 3.10 or 3.11 interpreter to BOOTSTRAP the venv when it
            # doesn't exist yet. We report the best available so the user
            # knows whether they need to apt install python3.11 first.
            fish_host_py = _resolve_host_python_for_fish()
            self._log_line(
                'Fish host py'.ljust(15) + '  ' + (
                    'OK (' + fish_host_py + ')' if fish_host_py
                    else 'MISSING -- no Python 3.10/3.11 found on PATH. Install python3.11: sudo apt install python3.11 python3.11-venv (Debian/Ubuntu)'
                ),
                TEXT if fish_host_py else AMBER
            )
            # fish_speech_server.py — the cross-platform launcher itself.
            fish_server_py_ok = os.path.isfile(_FISH_SERVER_PY)
            self._log_line(
                'Fish launcher'.ljust(15) + '  ' + (
                    'OK (' + _FISH_SERVER_PY + ')' if fish_server_py_ok
                    else 'MISSING -- fish_speech_server.py not found at project root (re-pull repo)'
                ),
                TEXT if fish_server_py_ok else AMBER
            )
            # Fish Speech HTTP probe — confirms the running server is real.
            fish_http_ok, fish_http_base = fish_speech_http_ok()
            self._log_line(
                'Fish HTTP'.ljust(15) + '  ' + (
                    'OK at ' + fish_http_base if fish_http_ok
                    else 'no response at ' + fish_http_base + ' (server not started — that is fine if you do not use Fish voices)'
                ),
                TEXT if fish_http_ok else MUTED
            )
            # git-lfs (needed by the Fish S2 Pro download)
            lfs_ok = _check_git_lfs()
            self._log_line(
                'git-lfs'.ljust(15) + '  ' + (
                    'OK' if lfs_ok
                    else 'MISSING -- sudo apt install git-lfs  (needed for S2 Pro weights)'
                ),
                TEXT if lfs_ok else AMBER
            )
            for tool in ('node', 'npm', 'npx', 'lsof'):
                p = shutil.which(tool)
                self._log_line(
                    'Tool'.ljust(15) + '  ' + tool.ljust(25) + '  ' + (p if p else 'MISSING'),
                    TEXT if p else AMBER
                )
            self._log_line('--- End ---', ACCENT)
        threading.Thread(target=_check, daemon=True).start()

    # ── Browser ──────────────────────────────────────────────────────────────────────────
    def _open_browser(self):
        url = 'http://localhost:3001/trend-vault'
        webbrowser.open(url)
        self._log_line('Opening ' + url, ACCENT)

    def _open_chat(self):
        url = 'http://localhost:3002'
        if not port_in_use(3002):
            self._log_line('Ollama Chat UI not running on :3002 -- start it first', AMBER)
            return
        webbrowser.open(url)
        self._log_line('Opening ' + url, ACCENT)

    # -- CLI runner (RUN/STOP buttons + Enter binding) ------------------------
    def _set_cli_busy(self, busy):
        self._cli_busy = busy
        def _do():
            try:
                self._run_btn.configure(state='disabled' if busy else 'normal')
                self._stop_btn.configure(state='normal' if busy else 'disabled')
            except Exception:
                pass
        self.after(0, _do)

    def _run_cli(self):
        cmd = self._prompt_var.get().strip()
        if not cmd:
            return
        if getattr(self, '_cli_busy', False):
            self._log_line('A command is still running -- click STOP first', AMBER)
            return
        if not getattr(self, '_cli_history', None):
            self._cli_history = []
        if not self._cli_history or self._cli_history[-1] != cmd:
            self._cli_history.append(cmd)
            if len(self._cli_history) > 200:
                self._cli_history = self._cli_history[-200:]
        self._cli_history_idx = -1
        self._prompt_var.set('')
        self._set_cli_busy(True)
        self._log_line('$ ' + cmd, ACCENT)
        def _run():
            try:
                proc = subprocess.Popen(
                    cmd, cwd=ROOT, shell=True,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    encoding='utf-8', errors='replace', bufsize=1,
                    start_new_session=True,
                )
                self._cli_proc = proc
                for raw in proc.stdout:
                    line = raw.rstrip()
                    if line:
                        self._log_line(line, TEXT)
                proc.wait()
                self._log_line('(exit ' + str(proc.returncode) + ')', MUTED)
            except Exception as e:
                self._log_line('cli error: ' + str(e), RED)
            finally:
                self._cli_proc = None
                self._set_cli_busy(False)
        threading.Thread(target=_run, daemon=True).start()

    # ── CLI history navigation (Up / Down arrows) ─────────────────────────────
    def _history_prev(self):
        """Step backward through CLI history (Up arrow)."""
        hist = getattr(self, '_cli_history', [])
        if not hist:
            return
        if self._cli_history_idx == -1:
            # Save whatever is currently typed so we can restore it on Down.
            self._cli_draft = self._prompt_var.get()
            self._cli_history_idx = len(hist) - 1
        elif self._cli_history_idx > 0:
            self._cli_history_idx -= 1
        self._prompt_var.set(hist[self._cli_history_idx])
        # Move cursor to end of entry.
        self._prompt_entry.icursor('end')

    def _history_next(self):
        """Step forward through CLI history (Down arrow)."""
        hist = getattr(self, '_cli_history', [])
        if self._cli_history_idx == -1:
            return
        if self._cli_history_idx < len(hist) - 1:
            self._cli_history_idx += 1
            self._prompt_var.set(hist[self._cli_history_idx])
        else:
            # Back past the end — restore whatever the user was typing.
            self._cli_history_idx = -1
            self._prompt_var.set(getattr(self, '_cli_draft', ''))
        self._prompt_entry.icursor('end')

    def _stop_cli(self):
        proc = getattr(self, '_cli_proc', None)
        if proc and proc.poll() is None:
            try: proc.kill()
            except Exception: pass
            self._log_line('CLI command stopped', AMBER)
        else:
            self._log_line('No CLI command running', MUTED)


if __name__ == '__main__':
    App().mainloop()
