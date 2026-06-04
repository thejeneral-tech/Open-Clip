"""
Trend Vault Launcher
────────────────────
Single-file GUI launcher for the Trend Vault stack.
Replaces all .bat files with a dark-theme control panel.

Build to .exe (run bats/build-launcher.bat):
    pip install pyinstaller
    pyinstaller --onefile --windowed --name TrendVaultLauncher launcher.py
"""

import os, sys, time, socket, subprocess, threading, webbrowser, shutil, platform, tkinter as tk
from tkinter import font as tkfont, messagebox
from datetime import datetime

# ── Project root (works as .py or frozen .exe) ───────────────────────────────
ROOT = os.path.dirname(sys.executable if getattr(sys, 'frozen', False) else os.path.abspath(__file__))

# ── Service definitions ───────────────────────────────────────────────────────
# Kokoro uses the venv Python written by bats/setup-kokoro.bat. If the venv
# isn't present we fall back to calling bats/start-kokoro.bat which will print
# the right "run bats/setup-kokoro.bat first" error.
_KOKORO_VENV_PY = os.path.join(ROOT, 'kokoro-tts', '.venv', 'Scripts', 'python.exe')
_KOKORO_SCRIPT  = os.path.join(ROOT, 'kokoro-tts', 'kokoro_server.py')
if os.path.isfile(_KOKORO_VENV_PY):
    _KOKORO_CMD = [_KOKORO_VENV_PY, _KOKORO_SCRIPT]
else:
    _KOKORO_CMD = [os.path.join(ROOT, 'bats', 'start-kokoro.bat')]

# ── Fish Speech S2 Pro ───────────────────────────────────────────────────────
# Second local TTS engine alongside Kokoro.
# PRIMARY backend: compiled GGUF/s2.cpp binary at FISH_GGUF_ROOT (default C:\fish-speech).
# FALLBACK: fish_speech_server.py Python launcher (slower, requires venv).
_HOME = os.environ.get('USERPROFILE') or os.path.expanduser('~')
_LOCAL = os.environ.get('LOCALAPPDATA', os.path.join(_HOME, 'AppData', 'Local'))

# ── GGUF backend (s2.exe) ─────────────────────────────────────────────────────
_FISH_GGUF_ROOT = os.environ.get('FISH_GGUF_ROOT') or (
    'C:\\fish-speech' if sys.platform == 'win32' else '/shared/fish-speech'
)
_FISH_GGUF_BINDIR   = os.path.join(_FISH_GGUF_ROOT, 'build', 's2.cpp', 'cmake-build')
_FISH_GGUF_BINARY   = os.path.join(_FISH_GGUF_BINDIR, 's2.exe' if sys.platform == 'win32' else 's2')
_FISH_GGUF_MODELDIR = os.path.join(_FISH_GGUF_ROOT, 'models', 's2-pro-gguf')
_FISH_GGUF_TOKENIZER = os.path.join(_FISH_GGUF_ROOT, 'tokenizer.json')

def _resolve_gguf_codec() -> str:
    """Return path to codec GGUF: prefer q4_k_m, fall back to f16."""
    q4  = os.path.join(_FISH_GGUF_MODELDIR, 's2-pro-q4_k_m-codec-only.gguf')
    f16 = os.path.join(_FISH_GGUF_MODELDIR, 's2-pro-f16-codec-only.gguf')
    return q4 if os.path.isfile(q4) else f16

def _gguf_backend_ok() -> bool:
    """True when all GGUF files needed by s2.exe are present."""
    transformer = os.path.join(_FISH_GGUF_MODELDIR, 's2-pro-q4_k_m-transformer-only.gguf')
    return (os.path.isfile(_FISH_GGUF_BINARY)
            and os.path.isfile(transformer)
            and os.path.isfile(_FISH_GGUF_TOKENIZER)
            and (os.path.isfile(_resolve_gguf_codec())))

# ── Python fallback backend ───────────────────────────────────────────────────
# Runtime path (where the fish-speech git repo lives)
_FISH_RUNTIME_PATH = os.environ.get('FISH_SPEECH_RUNTIME_PATH') or os.path.join(
    _LOCAL, 'trendvault', 'runtimes', 'fish-speech'
)
# Venv inside the runtime
_FISH_VENV_PATH = os.environ.get('FISH_SPEECH_VENV_PATH') or os.path.join(_FISH_RUNTIME_PATH, '.venv')
_FISH_VENV_PY   = os.path.join(_FISH_VENV_PATH, 'Scripts', 'python.exe')

# The self-contained launcher script (Python fallback)
_FISH_SERVER_PY  = os.path.join(ROOT, 'fish_speech_server.py')
_FISH_START_BAT  = os.path.join(ROOT, 'bats', 'start-fish-speech.bat')

# ── Fish Speech S2 Pro model detection ───────────────────────────────────────
# Lenient check: any one of these + sufficient directory size counts as "installed".
# Mirrors the logic in fishSpeechS2Pro.ts checkFishModel().
FISH_S2_PRO_REQUIRED_FILES = [
    'config.json',
    'model.pth',
    'firefly-gan-vq-fsq-8x1024-21hz-generator.pth',
    'special_tokens.json',
    'tokenizer.tiktoken',
    # Also accept safetensors layout
    'codec.pth',
    'model-00001-of-00002.safetensors',
    'model.safetensors',
]
FISH_S2_PRO_REPO_URL = 'https://huggingface.co/fishaudio/s2-pro'
_FISH_S2_PRO_DEFAULT_CACHE = os.path.join(_HOME, 's2-pro')
_FISH_S2_PRO_CONFIG_FILE = os.path.join(
    os.environ.get('APPDATA', os.path.join(_HOME, 'AppData', 'Roaming')),
    'trendvault', 'fish_s2_config.json',
)

def _fish_s2_pro_config_load():
    """Return the saved model path from the JSON config, or None."""
    import json
    try:
        if os.path.isfile(_FISH_S2_PRO_CONFIG_FILE):
            with open(_FISH_S2_PRO_CONFIG_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return data.get('model_path') or None
    except Exception:
        pass
    return None

def _fish_s2_pro_config_save(path: str) -> bool:
    """Persist the model path to the JSON config. Returns True on success."""
    import json
    try:
        os.makedirs(os.path.dirname(_FISH_S2_PRO_CONFIG_FILE), exist_ok=True)
        with open(_FISH_S2_PRO_CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump({'model_path': path}, f, indent=2)
        return True
    except Exception:
        return False

def _fish_s2_pro_candidate_paths() -> list:
    """Return ordered list of directories to check for the S2 Pro model.
    Order: GGUF root → saved config → env var → %USERPROFILE%\\s2-pro → default cache."""
    candidates = []
    # GGUF root is always the primary candidate (it's where the web app looks too)
    if _FISH_GGUF_ROOT not in candidates:
        candidates.append(_FISH_GGUF_ROOT)
    saved = _fish_s2_pro_config_load()
    if saved and saved not in candidates:
        candidates.append(saved)
    env_path = os.environ.get('FISH_S2_PRO_MODEL_PATH', '')
    if env_path and env_path not in candidates:
        candidates.append(env_path)
    # Legacy locations as fallback
    home_s2 = os.path.join(_HOME, 's2-pro')
    if home_s2 not in candidates:
        candidates.append(home_s2)
    if _FISH_S2_PRO_DEFAULT_CACHE not in candidates:
        candidates.append(_FISH_S2_PRO_DEFAULT_CACHE)
    return candidates

def _fish_s2_pro_dir_size(path: str) -> int:
    """Return total byte size of directory tree."""
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total

def _fish_s2_pro_present_files(path: str) -> list:
    """Return which of the expected model files are actually present."""
    return [f for f in FISH_S2_PRO_REQUIRED_FILES if os.path.isfile(os.path.join(path, f))]

def _fish_s2_pro_missing_files(path: str) -> list:
    """Lenient check: return empty list if directory looks like a real model.
    Mirrors fishSpeechS2Pro.ts checkFishModel() — accepts any large dir with
    at least one expected file, or any dir >200 MB regardless of filenames."""
    if not os.path.isdir(path):
        return ['directory does not exist']
    present = _fish_s2_pro_present_files(path)
    total   = _fish_s2_pro_dir_size(path)
    # ≥50 MB with at least one recognised file  OR  ≥200 MB regardless = OK
    if (present and total > 50 * 1024 * 1024) or total > 200 * 1024 * 1024:
        return []   # nothing "missing" — lenient pass
    if not present:
        return ['no recognised model files found in directory']
    return [f'directory too small ({total // 1024 // 1024} MB) — may be partial download']

def resolve_fish_s2_pro_path():
    """Return the first candidate directory that passes the lenient model check, or None."""
    for path in _fish_s2_pro_candidate_paths():
        if not _fish_s2_pro_missing_files(path):
            return path
    return None

def _fish_s2_pro_is_installed() -> bool:
    return resolve_fish_s2_pro_path() is not None

def _fish_s2_pro_clone_exists() -> bool:
    return os.path.isdir(os.path.join(_FISH_RUNTIME_PATH, '.git'))

def _check_git_lfs() -> bool:
    try:
        r = subprocess.run(
            ['git', 'lfs', 'version'],
            capture_output=True, timeout=5,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        return r.returncode == 0
    except Exception:
        return False

# Resolve model path once at import time so _FISH_CMD picks it up.
FISH_S2_PRO_MODEL_PATH = resolve_fish_s2_pro_path() or _FISH_S2_PRO_DEFAULT_CACHE
os.environ['FISH_S2_PRO_MODEL_PATH'] = FISH_S2_PRO_MODEL_PATH
os.environ['FISH_GGUF_ROOT']         = _FISH_GGUF_ROOT
os.environ.setdefault('FISH_SPEECH_RUNTIME_PATH', _FISH_RUNTIME_PATH)
os.environ.setdefault('FISH_SPEECH_VENV_PATH',    _FISH_VENV_PATH)
# PUBLIC Fish Speech address = the TrendVault web server (3001), which proxies
# /health, /v1/tts and /v1/audio/speech to the real Fish process. The real
# s2.cpp process still listens on 8080 (FISH_UPSTREAM_URL).
os.environ.setdefault('FISH_TTS_URL',             'http://127.0.0.1:3001')
os.environ.setdefault('FISH_UPSTREAM_URL',        'http://127.0.0.1:8080')

# Build the command to start Fish Speech.
# Priority: s2.exe GGUF binary > fish_speech_server.py > venv python > bat fallback
if _gguf_backend_ok():
    # Fast GGUF backend — no Python/venv required.
    _gguf_codec = _resolve_gguf_codec()
    _gguf_transformer = os.path.join(_FISH_GGUF_MODELDIR, 's2-pro-q4_k_m-transformer-only.gguf')
    _gguf_env  = dict(os.environ, PATH=_FISH_GGUF_BINDIR + os.pathsep + os.environ.get('PATH', ''))
    _FISH_CMD = [_FISH_GGUF_BINARY,
                 '--model',        _gguf_transformer,
                 '--model-codec',  _gguf_codec,
                 '--tokenizer',    _FISH_GGUF_TOKENIZER,
                 '--port',         '8080',
                 '--host',         '127.0.0.1',
                 '--threads',      '4',
                 '--vulkan',       '-1',
                 '--codec-vulkan', '-1']
elif os.path.isfile(_FISH_SERVER_PY):
    # Python fallback — handles setup automatically but needs venv.
    _py = _FISH_VENV_PY if os.path.isfile(_FISH_VENV_PY) else 'python'
    _FISH_CMD = [_py, _FISH_SERVER_PY,
                 '--model-path', FISH_S2_PRO_MODEL_PATH,
                 '--runtime-path', _FISH_RUNTIME_PATH,
                 '--venv-path', _FISH_VENV_PATH,
                 '--listen', '127.0.0.1:8080']
elif os.path.isfile(_FISH_VENV_PY):
    _FISH_CMD = [_FISH_VENV_PY, '-m', 'tools.api_server',
                 '--listen', '127.0.0.1:8080',
                 '--llama-checkpoint-path', FISH_S2_PRO_MODEL_PATH]
else:
    _FISH_CMD = [_FISH_START_BAT]

# Health probe for Fish Speech — single source of truth used by the dot
# indicator and the HEALTH button. Returns (ok, reason).
def fish_speech_http_ok(timeout: float = 2.0) -> tuple[bool, str]:
    """Probe the REAL Fish Speech process (FISH_UPSTREAM_URL, default :8080).
    We probe the actual process — not the public 3001 proxy — so the dot/HEALTH
    button reflect whether Fish itself is up, independent of the web server."""
    import urllib.request, urllib.error
    base = (os.environ.get('FISH_UPSTREAM_URL') or 'http://127.0.0.1:8080').rstrip('/')
    for path in ('/v1/health', '/health', '/'):
        try:
            with urllib.request.urlopen(base + path, timeout=timeout) as r:
                if 200 <= r.status < 500:
                    return True, base
        except Exception:
            continue
    return False, base

_OLLAMA_UI_SERVER = os.path.join(ROOT, 'Ollama web ui', 'server.js')

# Ollama: required dependency for the Chat UI. Resolved at launch time so a
# fresh install (which extends PATH after we started) is still picked up.
_OLLAMA_INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe'
_OLLAMA_DEFAULT_EXE = os.path.expandvars(r'%LOCALAPPDATA%\Programs\Ollama\ollama.exe')

def resolve_ollama() -> str | None:
    """Return the path to ollama.exe, or None if it isn't installed."""
    p = shutil.which('ollama')
    if p:
        return p
    if os.path.isfile(_OLLAMA_DEFAULT_EXE):
        return _OLLAMA_DEFAULT_EXE
    return None


# Aider: required for the Ollama Chat UI's Code section. The Code agent
# spawns `aider --model ollama_chat/<model> --message ...` for every turn,
# so this binary must be resolvable (either on PATH, in a pipx-managed env,
# or in the project-local venv we maintain).
#
# We default to installing aider into a dedicated venv at <ROOT>/.venv-aider/
# because the WindowsApps PythonManager Python sandboxes `pip --user`
# installs and breaks numpy source-builds with stale setuptools.
_AIDER_VENV_DIR = os.path.join(ROOT, '.venv-aider')

def _aider_venv_python() -> str | None:
    """Return path to the venv's python.exe, or None if the venv isn't built."""
    p = os.path.join(_AIDER_VENV_DIR, 'Scripts', 'python.exe')
    return p if os.path.isfile(p) else None

def _aider_venv_bin() -> str | None:
    """Return path to aider.exe inside the venv, or None."""
    p = os.path.join(_AIDER_VENV_DIR, 'Scripts', 'aider.exe')
    return p if os.path.isfile(p) else None

def resolve_aider() -> str | None:
    """Return the path to aider.exe, or None if it isn't installed.
    Search order: PATH → uv tool bin dir (where aider-install puts it) →
    project venv → common pip --user locations."""
    p = shutil.which('aider')
    if p:
        return p
    home = os.environ.get('USERPROFILE')
    if home:
        # uv (via aider-install) installs tool launchers here by default.
        for guess in (
            os.path.join(home, '.local', 'bin', 'aider.exe'),
            os.path.join(home, '.local', 'bin', 'aider'),
        ):
            if os.path.isfile(guess):
                return guess
    venv = _aider_venv_bin()
    if venv:
        return venv
    if home:
        for guess in (
            os.path.join(home, 'AppData', 'Roaming', 'Python', 'Scripts', 'aider.exe'),
            os.path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Scripts', 'aider.exe'),
        ):
            if os.path.isfile(guess):
                return guess
    return None


# ── Node.js Bundling ────────────────────────────────────────────────────────
# On Windows, if npm is not available on PATH, the launcher can download and
# bundle a prebuilt Node.js runtime into %LOCALAPPDATA%\trendvault\runtimes\node.
# This allows offline/restricted environments to still use the Web App (npm start).
_NODE_VERSION = 'v22.11.0'
_NODE_DIR = os.path.join(
    os.environ.get('LOCALAPPDATA', os.path.join(_HOME, 'AppData', 'Local')),
    'trendvault', 'runtimes', 'node'
)

def _node_release_url() -> str | None:
    """Build the nodejs.org download URL for the current Windows / arch."""
    if platform.system() != 'Windows':
        return None
    mach = (platform.machine() or '').lower()
    arch = {
        'amd64': 'x64', 'x86_64': 'x64', 'x64': 'x64',
        'arm64': 'arm64', 'aarch64': 'arm64',
    }.get(mach)
    if not arch:
        return None
    return f'https://nodejs.org/dist/{_NODE_VERSION}/node-{_NODE_VERSION}-win-{arch}.zip'

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
        if os.path.isfile(os.path.join(full, 'npm.cmd')):
            return full
    return None

def _ensure_bundled_node_on_path() -> str | None:
    """If a bundled Node install exists, prepend its directory to PATH. Returns the bin dir or None."""
    bin_dir = _node_bin_dir()
    if not bin_dir:
        return None
    cur = os.environ.get('PATH', '')
    parts = cur.split(os.pathsep) if cur else []
    if bin_dir not in parts:
        os.environ['PATH'] = bin_dir + (os.pathsep + cur if cur else '')
    return bin_dir

def _download_node(log) -> str | None:
    """Download Node.js binary zip and extract into _NODE_DIR. Returns the bin dir on success."""
    import urllib.request, tempfile, zipfile
    url = _node_release_url()
    if not url:
        log('No Node.js release for this Windows arch: ' + platform.machine(), RED)
        return None
    log('Downloading Node.js ' + _NODE_VERSION + ' from nodejs.org', ACCENT)
    log('This may take 30-60 seconds (~25 MB)...', MUTED)
    os.makedirs(_NODE_DIR, exist_ok=True)
    archive = os.path.join(tempfile.gettempdir(), 'trend_vault_node_dl.zip')
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'TrendVaultLauncher/1.0'})
        with urllib.request.urlopen(req, timeout=180) as resp:
            with open(archive, 'wb') as f:
                shutil.copyfileobj(resp, f)
    except Exception as e:
        log('Node.js download failed: ' + str(e), RED)
        return None
    log('Download complete, extracting...', ACCENT)
    try:
        with zipfile.ZipFile(archive) as z:
            z.extractall(_NODE_DIR)
    except Exception as e:
        log('Node.js extract failed: ' + str(e), RED)
        return None
    finally:
        try:
            os.remove(archive)
        except OSError:
            pass
    bin_dir = _node_bin_dir()
    if not bin_dir:
        log('Node.js archive extracted but bin dir not found inside ' + _NODE_DIR, RED)
        return None
    _ensure_bundled_node_on_path()
    log('Node.js ' + _NODE_VERSION + ' installed to ' + _NODE_DIR, GREEN)
    return bin_dir

# Ensure bundled Node is on PATH if it exists (from previous auto-install)
_ensure_bundled_node_on_path()


def _resolve_host_python_for_fish() -> str | None:
    """Find a compatible Python interpreter (3.10 or 3.11) for Fish Speech bootstrap.

    Search order:
      1. python3.11 / python3.10 (canonical names, preferred)
      2. py.exe -3.11 / py.exe -3.10 (Windows Python launcher)
      3. python3 / python (if version is compatible)

    Returns the path/command to a usable interpreter, or None."""
    # Try canonical names first
    for pyname in ('python3.11', 'python3.10', 'python3', 'python'):
        path = shutil.which(pyname)
        if path:
            try:
                ver_out = subprocess.run(
                    [path, '-c', 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")'],
                    capture_output=True, text=True, timeout=4,
                )
                if ver_out.returncode == 0:
                    ver = ver_out.stdout.strip()
                    if ver in ('3.10', '3.11'):
                        return path
            except Exception:
                pass

    # Try Windows Python launcher (py.exe)
    if shutil.which('py'):
        for version in ('3.11', '3.10'):
            try:
                ver_out = subprocess.run(
                    ['py', f'-{version}', '-c', 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")'],
                    capture_output=True, text=True, timeout=4,
                )
                if ver_out.returncode == 0:
                    ver = ver_out.stdout.strip()
                    if ver == version:
                        return f'py -{version}'
            except Exception:
                pass

    return None


def _missing_fish_s2_pro_deps_windows() -> list[tuple[str, str]]:
    """Check for system dependencies needed by Fish Speech S2 Pro on Windows.

    Returns a list of (dep_name, install_hint) tuples for any missing deps.
    """
    missing = []
    if not shutil.which('git'):
        missing.append((
            'git',
            'Download from https://git-scm.com or run: winget install Git.Git',
        ))
    if not _check_git_lfs():
        missing.append((
            'git-lfs',
            'Download from https://git-lfs.github.com or run: winget install GitHub.GitLFS',
        ))
    if not (shutil.which('python') or shutil.which('python3')):
        missing.append((
            'python3',
            'Download from https://python.org or run: winget install Python.Python.3.11',
        ))
    # Check if pip is available via `python -m pip`
    py = shutil.which('python') or shutil.which('python3')
    if py:
        try:
            r = subprocess.run(
                [py, '-m', 'pip', '--version'],
                capture_output=True, timeout=5,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
            pip_ok = (r.returncode == 0)
        except Exception:
            pip_ok = False
    else:
        pip_ok = False

    if not pip_ok:
        missing.append((
            'pip',
            'Run: python -m ensurepip --upgrade',
        ))

    return missing


def _git_lfs_install_user() -> bool:
    """Run `git lfs install --skip-repo` to enable LFS filters for this user.

    Safe to call repeatedly — git-lfs treats this as idempotent. Returns
    True on success. Failure is non-fatal; the clone may still succeed if
    LFS was installed globally on a previous run."""
    try:
        r = subprocess.run(
            ['git', 'lfs', 'install', '--skip-repo'],
            capture_output=True, timeout=15,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        return r.returncode == 0
    except Exception:
        return False


def _find_pip_cmd() -> list[str] | None:
    """Return a command list that can run pip. Prefers `python -m pip`."""
    for py in ('python', 'python3', 'py'):
        path = shutil.which(py)
        if path:
            return [path, '-m', 'pip']
    for pip in ('pip', 'pip3'):
        path = shutil.which(pip)
        if path:
            return [path]
    return None


def _find_pipx_cmd() -> list[str] | None:
    """Return a command list that can run pipx, or None if it isn't on PATH."""
    p = shutil.which('pipx')
    if p:
        return [p]
    # pipx is sometimes available as a Python module but not on PATH.
    for py in ('python', 'python3', 'py'):
        path = shutil.which(py)
        if path:
            try:
                r = subprocess.run(
                    [path, '-m', 'pipx', '--version'],
                    capture_output=True, timeout=4,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                )
                if r.returncode == 0:
                    return [path, '-m', 'pipx']
            except Exception:
                pass
    return None


# ── uv: Rust-based Python installer. We use it because it doesn't go through
#       pip's broken build-isolation path (which downloads its own stale
#       setuptools and crashes on Python 3.12+ when numpy needs to build).
_USER_LOCAL_BIN = os.path.join(
    os.environ.get('USERPROFILE') or os.environ.get('HOME', ''),
    '.local', 'bin'
)

def _resolve_uv() -> str | None:
    """Return the path to the `uv` binary, or None if not installed."""
    p = shutil.which('uv')
    if p:
        return p
    for guess in (
        os.path.join(_USER_LOCAL_BIN, 'uv.exe'),
        os.path.join(_USER_LOCAL_BIN, 'uv'),
        os.path.join(os.environ.get('USERPROFILE', ''), '.cargo', 'bin', 'uv.exe'),
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
    if sys_name == 'Windows':
        return f'{base}/uv-{arch}-pc-windows-msvc.zip'
    if sys_name == 'Linux':
        return f'{base}/uv-{arch}-unknown-linux-gnu.tar.gz'
    if sys_name == 'Darwin':
        return f'{base}/uv-{arch}-apple-darwin.tar.gz'
    return None

def _download_uv(log) -> str | None:
    """Download the uv binary from GitHub releases into ~/.local/bin/.
    `log` is a callable(msg, color=None) used to stream progress.
    Returns the resolved path on success, None on failure."""
    import urllib.request, tempfile, zipfile, tarfile
    url = _uv_release_url()
    if not url:
        log('No uv release for this OS/arch: ' + platform.system() + '/' + platform.machine(), RED)
        return None
    log('Downloading uv from ' + url, ACCENT)
    os.makedirs(_USER_LOCAL_BIN, exist_ok=True)
    suffix = '.zip' if url.endswith('.zip') else '.tar.gz'
    archive = os.path.join(tempfile.gettempdir(), 'uv_dl' + suffix)
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'TrendVaultLauncher/1.0'})
        with urllib.request.urlopen(req, timeout=60) as resp:
            with open(archive, 'wb') as f:
                shutil.copyfileobj(resp, f)
    except Exception as e:
        log('uv download failed: ' + str(e), RED)
        return None
    # Extract the uv binary into ~/.local/bin/.
    try:
        if suffix == '.zip':
            with zipfile.ZipFile(archive) as z:
                for name in z.namelist():
                    base_name = os.path.basename(name)
                    if base_name in ('uv.exe', 'uv'):
                        with z.open(name) as src, open(os.path.join(_USER_LOCAL_BIN, base_name), 'wb') as dst:
                            shutil.copyfileobj(src, dst)
        else:
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
        # Fish Speech S2 Pro — local second TTS engine alongside Kokoro.
        # The dot lights green when port 8080 is occupied; the HEALTH button
        # additionally verifies it's actually a Fish Speech server (HTTP probe).
        'key':  'fish_speech',
        'name': 'Fish Speech',
        'desc': 'Local GGUF TTS server  •  port 8080',
        'port': 8080,
        'cmd':  _FISH_CMD,
        'url':  None,
        'needs_npm': False,
        # Inject the GGUF binary dir into PATH so the s2.exe can find ggml DLLs.
        'env':  {'PATH': _FISH_GGUF_BINDIR + os.pathsep + os.environ.get('PATH', '')},
        # Custom HTTP health probe — port 8080 is a common dev port so a
        # generic listener could light the dot green even if Fish isn't
        # really there. This probe asks the server to confirm it's alive.
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

# ── Palette ───────────────────────────────────────────────────────────────────
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

# ── Helpers ───────────────────────────────────────────────────────────────────
def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex(('127.0.0.1', port)) == 0

def kill_port(port: int):
    """Kill whatever process is listening on the given port (Windows)."""
    try:
        result = subprocess.run(
            ['netstat', '-aon'],
            capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.splitlines():
            if f':{port} ' in line and 'LISTENING' in line:
                parts = line.split()
                pid = parts[-1]
                if pid and pid != '0':
                    subprocess.run(['taskkill', '/F', '/PID', pid],
                                   capture_output=True, timeout=5)
    except Exception:
        pass

def _kill_proc_tree(proc: subprocess.Popen):
    """Terminate a process and its child tree gracefully, then force-kill if needed."""
    if proc.poll() is not None:  # already dead
        return
    try:
        proc.terminate()
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        # Force kill with tree flag (/T) to terminate all spawned children (npm spawns node, etc.)
        try:
            subprocess.run(
                ['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                capture_output=True, timeout=5,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

def ts() -> str:
    return datetime.now().strftime('%H:%M:%S')


# ── Main app ──────────────────────────────────────────────────────────────────
class TrendVaultLauncher(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('🏦 Trend Vault Launcher')
        self.configure(bg=BG)
        self.minsize(1080, 720)
        self.geometry('1180x780')

        # Process handles  { key: subprocess.Popen }
        self._procs: dict[str, subprocess.Popen] = {}
        self._lock  = threading.Lock()
        self._installing_ollama = False
        self._installing_aider  = False
        self._installing_node   = False
        self._installing_fish_s2 = False
        # CLI runner state
        self._cli_proc: subprocess.Popen | None = None
        self._cli_busy = False
        self._cli_history: list[str] = []
        self._cli_history_idx: int = -1   # index into _cli_history while browsing
        self._cli_draft: str = ''         # what was typed before browsing history

        self._build_ui()
        self._poll()                                 # start status polling loop
        self.after(400,  self._check_npm_on_start)      # Node.js availability
        self.after(800,  self._check_ollama_on_start)   # prompt to install if missing
        self.after(1200, self._check_aider_on_start)    # aider for the Code section
        self.after(1600, self._check_fish_s2_on_start)  # fish speech model check

    # ── UI construction ───────────────────────────────────────────────────────
    def _build_ui(self):
        mono = tkfont.Font(family='Consolas', size=9)

        # ── Top header (spans both columns) ──
        hdr = tk.Frame(self, bg=BG, pady=14)
        hdr.pack(fill='x', padx=28)
        tk.Label(hdr, text='🏦  TREND VAULT', bg=BG, fg=TEXT,
                 font=('Segoe UI', 18, 'bold')).pack(side='left')
        tk.Label(hdr, text='CONTROL', bg=BG, fg=ACCENT,
                 font=('Segoe UI', 18, 'bold')).pack(side='left', padx=(8, 0))
        self._status_var = tk.StringVar(value='Ready')
        tk.Label(hdr, textvariable=self._status_var, bg=BG, fg=MUTED,
                 font=('Segoe UI', 9)).pack(side='right')

        tk.Frame(self, bg=BORDER, height=1).pack(fill='x')

        # ── Two-column body ──
        body = tk.Frame(self, bg=BG)
        body.pack(fill='both', expand=True)

        # LEFT column: services + actions (fixed width)
        left = tk.Frame(body, bg=BG, width=560)
        left.pack(side='left', fill='y')
        left.pack_propagate(False)

        tk.Frame(body, bg=BORDER, width=1).pack(side='left', fill='y')

        # RIGHT column: console + prompt (flex)
        right = tk.Frame(body, bg=BG2)
        right.pack(side='left', fill='both', expand=True)

        # ── LEFT: section label + service cards ──
        tk.Label(left, text='SERVICES', bg=BG, fg=MUTED,
                 font=('Segoe UI', 8, 'bold')).pack(anchor='w', padx=28, pady=(18, 6))
        cards_frame = tk.Frame(left, bg=BG)
        cards_frame.pack(fill='x', padx=28)

        self._cards: dict[str, dict] = {}
        for svc in SERVICES:
            self._cards[svc['key']] = self._make_card(cards_frame, svc)

        # Action bar inside left column
        tk.Frame(left, bg=BORDER, height=1).pack(fill='x', pady=(14, 0))
        tk.Label(left, text='ACTIONS', bg=BG, fg=MUTED,
                 font=('Segoe UI', 8, 'bold')).pack(anchor='w', padx=28, pady=(12, 6))
        bar = tk.Frame(left, bg=BG)
        bar.pack(fill='x', padx=24, pady=(0, 16))
        # Two rows of action buttons so they fit cleanly in 560px
        row1 = tk.Frame(bar, bg=BG); row1.pack(fill='x', pady=(0, 6))
        row2 = tk.Frame(bar, bg=BG); row2.pack(fill='x')
        self._btn(row1, '▶  START ALL',       self._start_all,    BTN_GO,  GREEN ).pack(side='left', padx=3)
        self._btn(row1, '■  STOP ALL',        self._stop_all,     BTN_STP, RED   ).pack(side='left', padx=3)
        self._btn(row1, '\U0001f4e6 INSTALL', self._run_install,  BTN,     AMBER ).pack(side='left', padx=3)
        self._btn(row1, '⬡  HEALTH',          self._health,       BTN,     AMBER ).pack(side='left', padx=3)
        self._btn(row2, '\U0001f310 OPEN STUDIO', self._open_browser, BTN, ACCENT).pack(side='left', padx=3)
        self._btn(row2, '\U0001f916 OPEN CHAT UI', self._open_chat,   BTN, ACCENT).pack(side='left', padx=3)
        self._btn(row2, '\U0001f9f0 INSTALL AIDER', self._run_install_aider, BTN, AMBER).pack(side='left', padx=3)
        self._btn(row2, '\U0001f4c1 S2 PRO FOLDER', self._choose_fish_s2_folder, BTN, ACCENT).pack(side='left', padx=3)

        # ── RIGHT: console header ──
        rhdr = tk.Frame(right, bg=BG2)
        rhdr.pack(fill='x', padx=20, pady=(18, 6))
        tk.Label(rhdr, text='CONSOLE', bg=BG2, fg=ACCENT,
                 font=('Segoe UI', 9, 'bold')).pack(side='left')
        # Shows the cwd that CLI commands run in.
        self._cwd_var = tk.StringVar(value='cwd: ' + ROOT)
        tk.Label(rhdr, textvariable=self._cwd_var, bg=BG2, fg=MUTED,
                 font=('Consolas', 8)).pack(side='left', padx=(12, 0))
        self._btn(rhdr, 'clear', self._clear_log, BG2, MUTED,
                  font=('Segoe UI', 8)).pack(side='right')

        # Log pane (fills the right column)
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
                 bg=BG2, fg=MUTED, font=('Segoe UI', 8, 'bold')
                 ).pack(anchor='w', padx=20, pady=(2, 4))
        prompt_wrap = tk.Frame(right, bg=BORDER)
        prompt_wrap.pack(fill='x', padx=20, pady=(0, 18))
        prompt_row = tk.Frame(prompt_wrap, bg=BG)
        prompt_row.pack(fill='x', padx=1, pady=1)
        tk.Label(prompt_row, text='$', bg=BG, fg=ACCENT,
                 font=('Consolas', 13, 'bold')).pack(side='left', padx=(10, 6), pady=4)
        self._prompt_var = tk.StringVar()
        self._prompt_entry = tk.Entry(
            prompt_row, textvariable=self._prompt_var,
            bg=BG, fg=TEXT, insertbackground=TEXT,
            relief='flat', bd=0, highlightthickness=0,
            font=('Consolas', 10),
        )
        self._prompt_entry.pack(side='left', fill='x', expand=True, ipady=8)
        self._prompt_entry.bind('<Return>',   lambda e: self._run_cli())
        self._prompt_entry.bind('<Up>',       lambda e: self._history_prev())
        self._prompt_entry.bind('<Down>',     lambda e: self._history_next())
        # Stop the currently-running command (Ctrl+C is a no-op in tk Entry,
        # so we use Esc and a STOP button).
        self._prompt_entry.bind('<Escape>',   lambda e: self._stop_cli())
        self._run_btn = self._btn(prompt_row, 'RUN', self._run_cli, BTN_GO, GREEN,
                                  font=('Segoe UI', 9, 'bold'))
        self._run_btn.pack(side='left', padx=(6, 3), pady=4)
        self._stop_btn = self._btn(prompt_row, 'STOP', self._stop_cli, BTN_STP, RED,
                                   font=('Segoe UI', 9, 'bold'))
        self._stop_btn.pack(side='left', padx=(0, 6), pady=4)
        self._stop_btn.configure(state='disabled')

    def _make_card(self, parent: tk.Frame, svc: dict) -> dict:
        card = tk.Frame(parent, bg=CARD, bd=0, padx=16, pady=12,
                        highlightbackground=BORDER, highlightthickness=1)
        card.pack(fill='x', pady=6)

        left = tk.Frame(card, bg=CARD)
        left.pack(side='left', fill='y')

        dot = tk.Label(left, text='●', bg=CARD, fg=RED, font=('Segoe UI', 14))
        dot.pack(side='left', padx=(0, 10))

        info = tk.Frame(left, bg=CARD)
        info.pack(side='left')
        tk.Label(info, text=svc['name'], bg=CARD, fg=TEXT,
                 font=('Segoe UI', 11, 'bold'), anchor='w').pack(anchor='w')
        tk.Label(info, text=svc['desc'], bg=CARD, fg=MUTED,
                 font=('Segoe UI', 8), anchor='w').pack(anchor='w')

        right = tk.Frame(card, bg=CARD)
        right.pack(side='right')

        btn_start = self._btn(right, '▶ Start',
                              lambda k=svc['key']: self._start_one(k),
                              BTN_GO, GREEN, font=('Segoe UI', 9, 'bold'))
        btn_start.pack(side='left', padx=(0, 6))

        btn_stop = self._btn(right, '■ Stop',
                             lambda k=svc['key']: self._stop_one(k),
                             BTN_STP, RED, font=('Segoe UI', 9, 'bold'))
        btn_stop.pack(side='left')

        return {'dot': dot, 'btn_start': btn_start, 'btn_stop': btn_stop,
                'running': False}

    @staticmethod
    def _btn(parent, text, cmd, bg, fg, font=('Segoe UI', 9, 'bold')) -> tk.Button:
        b = tk.Button(parent, text=text, command=cmd,
                      bg=bg, fg=fg, activebackground=BTN_HOV, activeforeground=TEXT,
                      font=font, bd=0, relief='flat', padx=12, pady=6, cursor='hand2')
        b.bind('<Enter>', lambda e, w=b: w.configure(bg=BTN_HOV))
        b.bind('<Leave>', lambda e, w=b, c=bg: w.configure(bg=c))
        return b

    # ── Logging ───────────────────────────────────────────────────────────────
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

    # ── Status polling ────────────────────────────────────────────────────────
    def _poll(self):
        for svc in SERVICES:
            key  = svc['key']
            up   = port_in_use(svc['port'])
            # Services that opt in (via http_health) only show as healthy
            # when the HTTP probe also confirms they're alive. This stops
            # Fish Speech from showing green when some unrelated process
            # happens to be sitting on port 8080.
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

    # ── Dependency management ─────────────────────────────────────────────────
    def _ensure_deps(self) -> bool:
        """Check for node_modules; run npm install if missing. Returns True when ready."""
        nm = os.path.join(ROOT, 'node_modules')
        if os.path.isdir(nm):
            return True
        self._log_line('node_modules not found -- running npm install...', AMBER)
        self._set_status('Installing dependencies...')
        try:
            proc = subprocess.Popen(
                ['npm', 'install'],
                cwd=ROOT, env={**os.environ},
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                encoding='utf-8', errors='replace', bufsize=1,
                shell=(sys.platform == 'win32'),
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0,
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
            else:
                self._log_line('npm install failed (exit code ' + str(proc.returncode) + ')', RED)
                self._set_status('Install failed')
                return False
        except Exception as e:
            self._log_line('npm install error: ' + str(e), RED)
            self._set_status('Install error')
            return False

    def _run_install(self):
        """Manually trigger npm install."""
        def _do():
            self._log_line('--- npm install ---', ACCENT)
            self._set_status('Installing dependencies...')
            try:
                proc = subprocess.Popen(
                    ['npm', 'install'],
                    cwd=ROOT, env={**os.environ},
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    encoding='utf-8', errors='replace', bufsize=1,
                    shell=(sys.platform == 'win32'),
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0,
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
            except Exception as e:
                self._log_line('Error: ' + str(e), RED)
            finally:
                self._set_status('Ready')
                self._log_line('--- End ---', ACCENT)
        threading.Thread(target=_do, daemon=True).start()

    # ── Node.js dependency ────────────────────────────────────────────────────
    def _check_npm_on_start(self):
        """Runs ~400ms after the UI is built. Checks for npm on PATH."""
        if shutil.which('npm'):
            self._log_line('npm detected on PATH', GREEN)
            return
        if shutil.which('node'):
            self._log_line('node detected on PATH (npm should be available)', GREEN)
            return
        if _node_bin_dir():
            self._log_line('Bundled Node.js already installed at ' + _NODE_DIR, GREEN)
            return
        self._log_line('npm is not on PATH -- the Web App needs it to work', AMBER)
        self._prompt_install_node()

    def _prompt_install_node(self):
        if self._installing_node:
            self._log_line('Node.js install already in progress...', AMBER)
            return
        answer = messagebox.askyesno(
            'Install Node.js?',
            'npm is required for the Web App but was not found on this PC.\n\n'
            'Download and bundle Node.js ' + _NODE_VERSION + ' (~25 MB) into\n'
            '%LOCALAPPDATA%\\trendvault\\runtimes\\node?\n\n'
            'This is optional — you can install Node.js manually if you prefer.',
        )
        if not answer:
            self._log_line('Node.js install skipped by user', MUTED)
            return
        threading.Thread(target=self._install_node, daemon=True).start()

    def _install_node(self):
        """Download Node.js binary and extract to _NODE_DIR."""
        self._installing_node = True
        try:
            self._log_line('--- Node.js Install ---', ACCENT)
            self._set_status('Downloading Node.js...')
            bin_dir = _download_node(self._log_line)
            if bin_dir:
                self._log_line('Node.js bundle ready. Restart launcher to use it.', GREEN)
                self._log_line('(or manually run: SET PATH=' + bin_dir + ';%PATH%)', MUTED)
            else:
                self._log_line('Node.js download/extract failed. Retry with INSTALL button or install from nodejs.org', RED)
        finally:
            self._installing_node = False
            self._set_status('Ready')
            self._log_line('--- End ---', ACCENT)

    # ── Ollama dependency ─────────────────────────────────────────────────────
    def _check_ollama_on_start(self):
        """Runs ~1s after the UI is built. Logs status, prompts to install."""
        path = resolve_ollama()
        if path:
            self._log_line('Ollama detected: ' + path, GREEN)
            return
        self._log_line('Ollama is not installed -- the Chat UI needs it to work', AMBER)
        self._prompt_install_ollama()

    def _prompt_install_ollama(self):
        if self._installing_ollama:
            self._log_line('Ollama install already in progress...', AMBER)
            return
        answer = messagebox.askyesno(
            'Install Ollama?',
            'Ollama is required for the Chat UI but was not found on this PC.\n\n'
            'Download the official installer (~700 MB) from ollama.com and run it now?\n\n'
            'You will need to click through the Ollama setup window when it appears.',
        )
        if not answer:
            self._log_line('Ollama install skipped by user', MUTED)
            return
        threading.Thread(target=self._install_ollama, daemon=True).start()

    def _install_ollama(self):
        """Download OllamaSetup.exe and launch it. Installer is interactive."""
        import urllib.request, tempfile
        self._installing_ollama = True
        try:
            self._log_line('Downloading Ollama installer...', AMBER)
            self._set_status('Downloading Ollama...')
            installer_path = os.path.join(tempfile.gettempdir(), 'OllamaSetup.exe')
            req = urllib.request.Request(
                _OLLAMA_INSTALLER_URL,
                headers={'User-Agent': 'TrendVaultLauncher/1.0'},
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                total = int(resp.headers.get('Content-Length', 0) or 0)
                downloaded = 0
                last_pct = -1
                with open(installer_path, 'wb') as f:
                    while True:
                        chunk = resp.read(64 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total:
                            pct = int(downloaded * 100 / total)
                            if pct != last_pct and pct % 5 == 0:
                                self._set_status('Downloading Ollama... ' + str(pct) + '%')
                                last_pct = pct
            self._log_line('Download complete (' + str(downloaded // (1024 * 1024)) + ' MB)', GREEN)
            self._log_line('Launching installer -- complete the setup window to finish', TEXT)
            self._set_status('Running Ollama installer...')
            # Run installer; UAC prompt handled by Windows. Don't block.
            subprocess.Popen([installer_path], shell=False)
            self._log_line(
                'When the installer finishes, click START on the Ollama card to launch it.',
                ACCENT,
            )
        except Exception as e:
            self._log_line('Ollama install failed: ' + str(e), RED)
        finally:
            self._installing_ollama = False
            self._set_status('Ready')

    # ── Aider dependency ──────────────────────────────────────────────────────
    def _check_aider_on_start(self):
        """Runs shortly after Ollama check. Logs status, prompts to install."""
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
                'Python/pip not found on PATH -- install Python 3 first to use aider', RED
            )
            return
        answer = messagebox.askyesno(
            'Install Aider?',
            'Aider is required for the Code section of the Chat UI.\n\n'
            'Install with:\n'
            '    ' + ' '.join(pip) + ' install --user aider-chat\n\n'
            'Click Yes to install now (uses your system Python).',
        )
        if not answer:
            self._log_line('Aider install skipped by user', MUTED)
            return
        threading.Thread(target=self._install_aider, args=(pip,), daemon=True).start()

    def _run_install_aider(self):
        """Toolbar button: re-prompt or re-attempt install on demand."""
        if resolve_aider():
            self._log_line('Aider is already installed: ' + resolve_aider(), GREEN)
            return
        self._installing_aider = False  # clear any stale latch
        self._prompt_install_aider()

    def _install_aider(self, pip):
        """Install aider via uv (primary) or pipx (fallback).

        We removed the pip --user, aider-install, and project-local-venv
        strategies because they all eventually invoke pip's build-isolation
        path which downloads a stale setuptools (pkgutil.ImpImporter crash
        on Python 3.12+). The uv path is the only one that reliably works
        on a sandboxed WindowsApps PythonManager Python because uv:
          (a) is a standalone Rust binary (no Python needed to bootstrap)
          (b) can download its OWN managed Python via python-build-standalone
          (c) does its own dep resolution and never uses pip's broken
              build-isolation environment.
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
                        'It may have landed in %USERPROFILE%\\.local\\bin\\ — restart '
                        'the launcher to re-scan, or add that dir to PATH.', AMBER
                    )
            else:
                self._log_line('Aider install failed; see errors above', RED)
                self._log_line('Manual install — open a NEW PowerShell window and run:', AMBER)
                self._log_line('   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"', AMBER)
                self._log_line('   & "$env:USERPROFILE\\.local\\bin\\uv.exe" tool install --python 3.12 aider-chat', AMBER)
                self._log_line(
                    'Then restart the launcher. If GitHub is blocked, install '
                    'Python from python.org and pipx, then click INSTALL AIDER.', AMBER
                )
        finally:
            self._installing_aider = False
            self._set_status('Ready')

    def _install_aider_via_uv(self) -> bool:
        """Download uv (if needed), install a managed Python under uv, then
        install aider into it.

        Two important tricks:
        - Install uv as a standalone binary from GitHub releases, so we
          never need Python's pip to bootstrap it.
        - Tell uv to download its OWN Python (via uv's bundled
          python-build-standalone builds). This guarantees we install
          aider into a known-good Python 3.12, not the host's sandboxed
          WindowsApps PythonManager that triggers all the build failures.
        """
        # 1. Get uv on disk.
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

        # 2. Download a managed Python into uv's cache. This is the key
        #    step — it isolates aider from the broken host Python entirely.
        self._log_line('Ensuring uv has a managed Python 3.12 (may download ~30 MB on first run)...', ACCENT)
        py_ok = self._run_pip_subprocess(
            [uv, 'python', 'install', '3.12'],
            '[uv python]'
        )
        if not py_ok:
            self._log_line(
                'uv python install failed — falling back to system Python (may still work)',
                AMBER
            )

        # 3. Install aider into a uv-managed tool environment, pinned to
        #    the managed Python 3.12.
        self._log_line('Running uv tool install aider-chat (forcing managed Python 3.12)...', ACCENT)
        ok = self._run_pip_subprocess(
            [uv, 'tool', 'install', '--force', '--python', '3.12', 'aider-chat'],
            '[uv]'
        )
        if not ok:
            # Retry without --python in case 3.12 wasn't available for some
            # arch — uv will pick whatever it has.
            self._log_line('Retrying uv tool install without an explicit Python pin...', AMBER)
            ok = self._run_pip_subprocess(
                [uv, 'tool', 'install', '--force', 'aider-chat'],
                '[uv]'
            )
        return ok and resolve_aider() is not None

    def _install_aider_via_aider_install(self, pip) -> bool:
        """Use the official aider-install meta-package.

        The aider-install package is tiny (no native deps), so even sandboxed
        Pythons can `pip install --user` it. When run, it installs uv and
        then uses `uv tool install aider-chat`, which produces a stand-alone
        aider binary in %USERPROFILE%\\.local\\bin\\ on Windows.
        """
        ok = self._run_pip_subprocess(
            pip + ['install', '--user', '--upgrade', 'aider-install'],
            '[pip meta]'
        )
        if not ok:
            return False
        # Run it as a module so we don't have to know where the .exe ended up.
        py_for_module = pip[0] if pip[0].endswith(('.exe', 'python', 'python3', 'py')) else 'python'
        self._log_line('Running aider-install — this may take a minute on first run...', ACCENT)
        ok = self._run_pip_subprocess([py_for_module, '-m', 'aider_install'], '[aider-install]')
        # Either ok==True or resolve_aider() can already find the binary
        # (some aider-install versions exit 1 but still complete the install).
        return ok or resolve_aider() is not None

    def _install_aider_into_venv(self, pip) -> bool:
        """Bootstrap <ROOT>/.venv-aider/ and pip-install aider into it.

        Steps:
          1. Create the venv with `python -m venv <dir>` (using `pip[0]`
             which is the Python interpreter we resolved earlier).
          2. Upgrade pip + setuptools + wheel inside the venv.
          3. `pip install --upgrade --prefer-binary aider-chat` inside it.

        Returns True iff the final aider install exits 0 AND aider.exe is
        present at the expected venv path afterwards.
        """
        py_for_bootstrap = pip[0]   # _find_pip_cmd returns [python, '-m', 'pip']
        if not os.path.isfile(py_for_bootstrap):
            # User passed plain ['pip'] — find a python explicitly.
            for cand in ('python', 'python3', 'py'):
                p = shutil.which(cand)
                if p:
                    py_for_bootstrap = p
                    break
        # 1. Create the venv (skip if already there).
        if os.path.isdir(_AIDER_VENV_DIR) and _aider_venv_python():
            self._log_line('venv already exists at ' + _AIDER_VENV_DIR + ' — reusing', AMBER)
        else:
            ok = self._run_pip_subprocess(
                [py_for_bootstrap, '-m', 'venv', _AIDER_VENV_DIR],
                '[venv create]'
            )
            if not ok or not _aider_venv_python():
                self._log_line('Could not create venv at ' + _AIDER_VENV_DIR, RED)
                return False
        venv_py = _aider_venv_python()
        # 2. Upgrade pip / setuptools / wheel inside the venv.
        self._log_line('Upgrading pip / setuptools / wheel inside venv...', ACCENT)
        self._run_pip_subprocess(
            [venv_py, '-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'],
            '[venv prep]'
        )
        # 3. Install aider into the venv.
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
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
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

    # ── Service control ───────────────────────────────────────────────────────
    def _start_one(self, key: str):
        svc = next(s for s in SERVICES if s['key'] == key)
        if key == 'ollama' and not resolve_ollama():
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
        # If Ollama is missing, ask the user once before kicking off the batch.
        if not resolve_ollama():
            self._prompt_install_ollama()
            # Continue starting everything else regardless — the user can hit
            # START ALL again after the installer finishes.
        def _do():
            if not self._ensure_deps():
                return
            # Boot order: Ollama, Kokoro, and Fish Speech first (so dependents'
            # probes succeed), then the Ollama UI (which proxies to :11434),
            # then the rest. Fish Speech is treated as a peer of Kokoro since
            # the Voice Preset panel can use either.
            order = {'ollama': 0, 'kokoro': 0, 'fish_speech': 0, 'ollama_ui': 1}
            ordered = sorted(SERVICES, key=lambda s: order.get(s['key'], 2))
            for svc in ordered:
                # Skip ollama silently if it's still missing — _launch would
                # log a redundant error otherwise.
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
        if key == 'fish_speech':
            # Validate the GGUF/s2.cpp backend before spawning. Aborts with a
            # clear console error if the binary or model files are missing.
            if not self._fish_preflight():
                self._set_status('Ready')
                return
            cmd = _FISH_CMD  # always use the freshest resolved GGUF command
        self._log_line('Starting ' + svc['name'] + '...', TEXT)
        self._set_status('Starting ' + svc['name'] + '...')
        try:
            env = {**os.environ, 'NODE_OPTIONS': '--max-old-space-size=8192'}
            env.update(svc.get('env', {}))
            flags = 0
            if sys.platform == 'win32':
                flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
            proc = subprocess.Popen(
                cmd, cwd=ROOT, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                encoding='utf-8', errors='replace', bufsize=1,
                shell=(sys.platform == 'win32'),
                creationflags=flags,
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
        except Exception as e:
            self._log_line('Failed to start ' + svc['name'] + ': ' + str(e), RED)
        finally:
            with self._lock:
                self._procs.pop(key, None)
            self._set_status('Ready')

    def _fish_preflight(self) -> bool:
        """Validate the GGUF/s2.cpp backend before starting Fish Speech.
        Logs each check; returns True only when binary + model + codec exist."""
        # 1 — compiled s2.cpp binary
        if not os.path.isfile(_FISH_GGUF_BINARY):
            self._log_line('[Fish Speech] ERROR: binary not found at ' + _FISH_GGUF_BINARY, RED)
            self._log_line('[Fish Speech] Build s2.cpp or run install_fish_gguf_runtime.py, then retry.', RED)
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

        # 4 — tokenizer (required by s2.exe)
        if not os.path.isfile(_FISH_GGUF_TOKENIZER):
            self._log_line('[Fish Speech] ERROR: tokenizer.json not found at ' + _FISH_GGUF_TOKENIZER, RED)
            return False

        self._log_line('[Fish Speech] starting on port 8080', ACCENT)
        return True

    def _fish_wait_online(self):
        """Poll the GGUF server's /health until it answers, then log online.
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
        if svc['key'] == 'fish_speech':
            self._log_line('[Fish Speech] stopped', MUTED)
        else:
            self._log_line(svc['name'] + ' stopped', MUTED)

    # ── Health check ──────────────────────────────────────────────────────────
    def _health(self):
        def _check():
            self._log_line('--- Health Check ---', ACCENT)
            for svc in SERVICES:
                port_up = port_in_use(svc['port'])
                # If the service exposes a custom HTTP health probe (Fish Speech
                # does, since port 8080 is a common dev port and a generic
                # listener shouldn't be reported as healthy), run it too.
                http_probe = svc.get('http_health')
                if port_up and callable(http_probe):
                    ok, info = http_probe()
                    if ok:
                        status = 'RUNNING (HTTP OK @ ' + info + ')'
                        color  = GREEN
                    else:
                        status = 'PORT BUSY but no Fish Speech HTTP response from ' + info
                        color  = AMBER
                else:
                    status = 'RUNNING' if port_up else 'STOPPED'
                    color  = GREEN if port_up else RED
                self._log_line(
                    svc['name'].ljust(20) + '  :' + str(svc['port']) + '  ' + status,
                    color
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
                'Kokoro model'.ljust(15) + '  ' + ('OK' if kokoro_ready else 'MISSING -- run bats/setup-kokoro.bat'),
                TEXT if kokoro_ready else AMBER
            )
            # ── Fish Speech S2 Pro: model + runtime ──────────────────────────
            # Two distinct things can be missing: the cached HF weights, or
            # the project-local venv with the fish-speech package installed.
            # Report each separately so the user knows which fix to apply.
            fish_model_dir = resolve_fish_s2_pro_path()
            if fish_model_dir:
                self._log_line(
                    'Fish model'.ljust(15) + '  OK — ' + fish_model_dir,
                    TEXT
                )
            else:
                self._log_line('Fish model'.ljust(15) + '  checking candidate paths...', AMBER)
                for cpath in _fish_s2_pro_candidate_paths():
                    if not os.path.isdir(cpath):
                        self._log_line('  ' + cpath + '  — not found', MUTED)
                        continue
                    missing = _fish_s2_pro_missing_files(cpath)
                    if missing:
                        self._log_line('  ' + cpath + '  — incomplete', AMBER)
                        for mf in missing:
                            self._log_line('    missing: ' + mf, AMBER)
                    else:
                        self._log_line('  ' + cpath + '  — complete', GREEN)
                self._log_line(
                    'Fish model'.ljust(15) + '  MISSING — use 📁 S2 PRO FOLDER to point to your model',
                    RED
                )
            fish_venv_ok = os.path.isfile(_FISH_VENV_PY)
            self._log_line(
                'Fish runtime'.ljust(15) + '  ' + (
                    'OK (' + _FISH_VENV_PY + ')' if fish_venv_ok else
                    'MISSING -- run bats/setup-fish-speech.bat to build the venv (or set FISH_TTS_URL to an external server)'
                ),
                TEXT if fish_venv_ok else AMBER
            )
            ollama_path = resolve_ollama()
            self._log_line(
                'Ollama'.ljust(15) + '  ' + (ollama_path if ollama_path else 'MISSING -- click START on the Ollama card to install'),
                TEXT if ollama_path else AMBER
            )
            aider_path = resolve_aider()
            self._log_line(
                'Aider'.ljust(15) + '  ' + (aider_path if aider_path else 'MISSING -- click INSTALL AIDER to add it'),
                TEXT if aider_path else AMBER
            )
            self._log_line('--- End ---', ACCENT)
        threading.Thread(target=_check, daemon=True).start()

    # ── Browser ───────────────────────────────────────────────────────────────
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
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0,
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
            # Save whatever is currently typed so we can restore it on Down
            self._cli_draft = self._prompt_var.get()
            self._cli_history_idx = len(hist) - 1
        elif self._cli_history_idx > 0:
            self._cli_history_idx -= 1
        self._prompt_var.set(hist[self._cli_history_idx])
        # Move cursor to end of entry
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
            # Back past the end — restore whatever the user was typing
            self._cli_history_idx = -1
            self._prompt_var.set(getattr(self, '_cli_draft', ''))
        self._prompt_entry.icursor('end')

    # ── Fish Speech S2 Pro startup check ──────────────────────────────────────
    def _check_fish_s2_on_start(self):
        """Runs ~1.6 s after launch. Scans candidate paths, updates env, auto-starts server."""
        global FISH_S2_PRO_MODEL_PATH, _FISH_CMD
        self._log_line('─── Fish Speech S2 Pro ───────────────────────────', ACCENT)

        # Check for system dependencies
        missing_deps = _missing_fish_s2_pro_deps_windows()
        if missing_deps:
            self._log_line('⚠ System dependencies missing:', RED)
            for dep_name, install_hint in missing_deps:
                self._log_line(f'  ✗ {dep_name}: {install_hint}', AMBER)
            self._log_line('Fish Speech may not install correctly until these are resolved.', AMBER)

        self._log_line('Checking model paths...', ACCENT)
        found_path = None
        for cpath in _fish_s2_pro_candidate_paths():
            if not os.path.isdir(cpath):
                continue
            missing = _fish_s2_pro_missing_files(cpath)
            if not missing:
                found_path = cpath
                self._log_line('● Fish model: found at ' + cpath, GREEN)
                break
            else:
                self._log_line('Folder exists but check failed: ' + cpath, AMBER)
                for mf in missing:
                    self._log_line('  ' + mf, AMBER)

        if found_path:
            FISH_S2_PRO_MODEL_PATH = found_path
            os.environ['FISH_S2_PRO_MODEL_PATH'] = found_path
            os.environ['FISH_GGUF_ROOT']         = _FISH_GGUF_ROOT
            os.environ['FISH_SPEECH_RUNTIME_PATH'] = _FISH_RUNTIME_PATH
            os.environ['FISH_SPEECH_VENV_PATH']    = _FISH_VENV_PATH
            if _fish_s2_pro_config_load() != found_path:
                _fish_s2_pro_config_save(found_path)

            # Rebuild the command — prefer GGUF binary, fall back to Python.
            if _gguf_backend_ok():
                _gguf_codec = _resolve_gguf_codec()
                _gguf_transformer = os.path.join(_FISH_GGUF_MODELDIR, 's2-pro-q4_k_m-transformer-only.gguf')
                self._log_line('● Using GGUF backend: ' + _FISH_GGUF_BINARY, GREEN)
                _FISH_CMD[:] = [_FISH_GGUF_BINARY,
                                '--model',        _gguf_transformer,
                                '--model-codec',  _gguf_codec,
                                '--tokenizer',    _FISH_GGUF_TOKENIZER,
                                '--port',         '8080',
                                '--host',         '127.0.0.1',
                                '--threads',      '4',
                                '--vulkan',       '-1',
                                '--codec-vulkan', '-1']
            elif os.path.isfile(_FISH_SERVER_PY):
                _py = _FISH_VENV_PY if os.path.isfile(_FISH_VENV_PY) else 'python'
                _FISH_CMD[:] = [_py, _FISH_SERVER_PY,
                                '--model-path', found_path,
                                '--runtime-path', _FISH_RUNTIME_PATH,
                                '--venv-path', _FISH_VENV_PATH,
                                '--listen', '127.0.0.1:8080']

            # Update the service card command too
            for svc in SERVICES:
                if svc['key'] == 'fish_speech':
                    svc['cmd'] = _FISH_CMD[:]

            # Check if server is already running, if not auto-start it
            ok, _ = fish_speech_http_ok(timeout=1.5)
            if ok:
                self._log_line('● Fish server: already running at http://127.0.0.1:8080', GREEN)
            else:
                self._log_line('● Fish server: not running — auto-starting…', ACCENT)
                self.after(500, lambda: self._auto_start_fish())
        else:
            self._log_line(
                '● Fish model: not found. Click 📁 S2 PRO FOLDER to select your model directory.',
                AMBER
            )
            self._log_line(
                '  Checked paths: ' + ', '.join(_fish_s2_pro_candidate_paths()),
                MUTED
            )

    def _auto_start_fish(self):
        """Auto-start Fish Speech server if model is found and server is not running."""
        ok, _ = fish_speech_http_ok(timeout=1.0)
        if ok:
            self._log_line('● Fish server: already up — skipping auto-start', GREEN)
            return
        card = self._cards.get('fish_speech')
        if card:
            self._log_line('Auto-starting Fish Speech S2 Pro server…', ACCENT)
            self._start_service('fish_speech')

    def _choose_fish_s2_folder(self):
        """Open a folder picker so the user can point to an existing S2 Pro model."""
        from tkinter import filedialog
        global FISH_S2_PRO_MODEL_PATH
        start = _fish_s2_pro_config_load() or _HOME
        chosen = filedialog.askdirectory(
            title='Select Fish Speech S2 Pro model folder',
            initialdir=start,
        )
        if not chosen:
            return
        chosen = os.path.normpath(chosen)
        missing = _fish_s2_pro_missing_files(chosen)
        if missing:
            self._log_line('Selected folder check failed:', AMBER)
            for mf in missing:
                self._log_line('  ' + mf, AMBER)
            self._log_line(
                'The folder should contain the s2-pro model files. '
                'If the folder is large (>200 MB) it may still work — '
                'try clicking Start Fish Speech.',
                AMBER
            )
            # Still accept it if the user insists — let the server decide
            if not messagebox.askyesno(
                'Model Check Failed',
                f'The selected folder failed the model check:\n{chosen}\n\n'
                + '\n'.join(missing[:3])
                + '\n\nDo you want to use it anyway?'
            ):
                return
        FISH_S2_PRO_MODEL_PATH = chosen
        os.environ['FISH_S2_PRO_MODEL_PATH'] = chosen
        _fish_s2_pro_config_save(chosen)
        self._log_line('Fish Speech S2 Pro model path set to: ' + chosen, GREEN)
        self._log_line('Restart the launcher (or re-start Fish Speech) to apply.', ACCENT)

    def _stop_cli(self):
        proc = getattr(self, '_cli_proc', None)
        if proc and proc.poll() is None:
            try:
                if sys.platform == 'win32':
                    subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                                   capture_output=True, timeout=5)
                else:
                    proc.kill()
            except Exception:
                try: proc.kill()
                except Exception: pass
            self._log_line('CLI command stopped', AMBER)
        else:
            self._log_line('No CLI command running', MUTED)


if __name__ == '__main__':
    TrendVaultLauncher().mainloop()
