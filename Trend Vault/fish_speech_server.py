#!/usr/bin/env python3
"""
fish_speech_server.py — Trend Vault Fish Speech S2 Pro Server
=============================================================
Self-contained launcher for the Fish Speech S2 Pro TTS engine.

Usage:
  python fish_speech_server.py
  python fish_speech_server.py --model-path "C:\\Users\\YourName\\s2-pro"
  python fish_speech_server.py --listen 127.0.0.1:8080 --skip-setup

What this script does (in order):
  1. Verifies the s2-pro model exists (lenient: 50 MB+ with any expected file)
  2. Clones the fish-speech runtime repo if not present
  3. Creates a Python venv for fish-speech if not present
  4. Installs fish-speech + dependencies into the venv
  5. Starts tools.api_server at the configured listen address
  6. Streams server stdout/stderr back to this terminal

All paths follow the same logic as fishSpeechS2Pro.ts so the Node server and
this script share a consistent environment.

Environment variables (all optional — sensible defaults built-in):
  FISH_S2_PRO_MODEL_PATH       Your existing model dir  (default: ~/s2-pro on Windows)
  FISH_SPEECH_RUNTIME_PATH     Where to clone fish-speech (default: %LOCALAPPDATA%\\trendvault\\runtimes\\fish-speech)
  FISH_SPEECH_VENV_PATH        Python venv path          (default: <runtime>\\.venv)
  FISH_TTS_URL                 Listen URL                (default: http://127.0.0.1:8080)
  PYTHON_BIN                   Override python binary    (default: python on Windows, python3 elsewhere)
"""

import os, sys, subprocess, shutil, platform, time, argparse, signal, json, socket
from pathlib import Path

# -----------------------------------------------------------------------------
# Windows-safe console output. The Windows default "charmap" codec cannot
# encode many Unicode characters and crashes with UnicodeEncodeError when we
# try to print them (e.g. the old log lines that used U+2713 CHECK MARK).
# We reconfigure stdout/stderr to UTF-8 with "replace" fallback, and force the
# code page to UTF-8 (65001) on Windows so emojis/box-drawing/etc never crash.
# All visible log markers in this file use plain ASCII like [OK] / [FAIL].
# -----------------------------------------------------------------------------
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

if platform.system() == 'Windows':
    # Force UTF-8 in the console. Best-effort: silently ignore if it fails.
    try:
        os.system('chcp 65001 >NUL 2>&1')
    except Exception:
        pass
    os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
    os.environ.setdefault('PYTHONUTF8', '1')

# -----------------------------------------------------------------------------
# Config resolution -- mirrors fishSpeechS2Pro.ts resolveFishConfig()
# -----------------------------------------------------------------------------

HOME = Path.home()
IS_WIN = platform.system() == 'Windows'


def _default_runtime_path() -> str:
    if IS_WIN:
        local = os.environ.get('LOCALAPPDATA') or str(HOME / 'AppData' / 'Local')
        return str(Path(local) / 'trendvault' / 'runtimes' / 'fish-speech')
    xdg = os.environ.get('XDG_DATA_HOME') or str(HOME / '.local' / 'share')
    return str(Path(xdg) / 'trendvault' / 'runtimes' / 'fish-speech')


def _default_model_path() -> str:
    if IS_WIN:
        return str(HOME / 's2-pro')
    return str(HOME / '.cache' / 'trendvault' / 'models' / 's2-pro')


def resolve_config(args=None) -> dict:
    model_path   = getattr(args, 'model_path', None) or os.environ.get('FISH_S2_PRO_MODEL_PATH') or _default_model_path()
    runtime_path = getattr(args, 'runtime_path', None) or os.environ.get('FISH_SPEECH_RUNTIME_PATH') or _default_runtime_path()
    venv_path    = getattr(args, 'venv_path', None) or os.environ.get('FISH_SPEECH_VENV_PATH') or str(Path(runtime_path) / '.venv')
    server_url   = getattr(args, 'listen', None) or os.environ.get('FISH_TTS_URL') or 'http://127.0.0.1:8080'
    python_bin   = os.environ.get('PYTHON_BIN') or ('python' if IS_WIN else 'python3')

    # Parse host:port from URL
    raw = server_url if '://' in server_url else f'http://{server_url}'
    try:
        import urllib.parse
        parsed    = urllib.parse.urlparse(raw)
        listen_addr = f"{parsed.hostname or '127.0.0.1'}:{parsed.port or 8080}"
    except Exception:
        listen_addr = '127.0.0.1:8080'

    return {
        'model_path':   str(model_path).strip(),
        'runtime_path': str(runtime_path).strip(),
        'venv_path':    str(venv_path).strip(),
        'server_url':   server_url,
        'listen_addr':  listen_addr,
        'python_bin':   python_bin,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Venv helpers
# ─────────────────────────────────────────────────────────────────────────────

def get_venv_python(cfg: dict) -> str:
    if IS_WIN:
        return str(Path(cfg['venv_path']) / 'Scripts' / 'python.exe')
    return str(Path(cfg['venv_path']) / 'bin' / 'python')


def venv_exists(cfg: dict) -> bool:
    return Path(get_venv_python(cfg)).is_file()


# ─────────────────────────────────────────────────────────────────────────────
# Step 1 — Model check
# ─────────────────────────────────────────────────────────────────────────────

# Lenient: any one of these files is enough if the directory is large enough
EXPECTED_MODEL_FILES = [
    'config.json',
    'model.pth',
    'firefly-gan-vq-fsq-8x1024-21hz-generator.pth',
    'special_tokens.json',
    'tokenizer.tiktoken',
    'codec.pth',
    'model-00001-of-00002.safetensors',
    'model.safetensors',
]


def _dir_size(path: str) -> int:
    """Total bytes in directory tree."""
    total = 0
    try:
        for root, _, files in os.walk(path):
            for f in files:
                try:
                    total += Path(root, f).stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def check_model(cfg: dict) -> tuple[bool, str]:
    path = cfg['model_path']
    if not Path(path).is_dir():
        return False, f"Model directory not found: {path}"
    total = _dir_size(path)
    present = [f for f in EXPECTED_MODEL_FILES if Path(path, f).is_file()]
    # Lenient: ≥50 MB with at least one expected file, OR ≥200 MB regardless
    ok = (len(present) > 0 and total > 50 * 1024 * 1024) or total > 200 * 1024 * 1024
    mb = total // 1024 // 1024
    if ok:
        return True, f"Model OK at {path} ({mb} MB, has: {', '.join(present) or 'large directory'})"
    reason = (
        f"No expected files found in {path}" if not present
        else f"Partial model at {path} ({mb} MB, found: {', '.join(present)})"
    )
    return False, reason


# ─────────────────────────────────────────────────────────────────────────────
# Step 2 — Runtime repo
# ─────────────────────────────────────────────────────────────────────────────

FISH_RUNTIME_GIT = 'https://github.com/fishaudio/fish-speech.git'


def check_runtime(cfg: dict) -> tuple[bool, str]:
    r = Path(cfg['runtime_path'])
    has_setup = (r / 'setup.py').is_file() or (r / 'pyproject.toml').is_file()
    has_api   = ((r / 'tools' / 'api_server.py').is_file()
                 or (r / 'tools' / 'api.py').is_file()
                 or (r / 'tools' / 'server.py').is_file())
    if has_setup and has_api:
        return True, str(r)
    return False, f"Runtime not found or incomplete at {r}"


def ensure_runtime(cfg: dict) -> tuple[bool, str]:
    ok, msg = check_runtime(cfg)
    if ok:
        return True, f"Runtime already present at {msg}"

    runtime_path = cfg['runtime_path']
    parent = str(Path(runtime_path).parent)
    Path(parent).mkdir(parents=True, exist_ok=True)

    log(f"Cloning fish-speech from GitHub -> {runtime_path}")
    log("This may take a minute on first run...")

    if Path(runtime_path).exists():
        tmp = f"{runtime_path}.tmp.{int(time.time())}"
        result = subprocess.run(
            ['git', 'clone', '--depth', '1', FISH_RUNTIME_GIT, tmp],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            shutil.rmtree(runtime_path, ignore_errors=True)
            shutil.move(tmp, runtime_path)
        else:
            shutil.rmtree(tmp, ignore_errors=True)
            return False, f"git clone failed (exit {result.returncode}): {result.stderr[-600:]}"
    else:
        result = subprocess.run(
            ['git', 'clone', '--depth', '1', FISH_RUNTIME_GIT, runtime_path],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            return False, (
                f"git clone failed (exit {result.returncode}): {result.stderr[-600:]}\n"
                "Ensure git is installed and you have internet access."
            )

    ok, msg = check_runtime(cfg)
    return ok, (f"Runtime cloned to {runtime_path}" if ok else
                f"Clone succeeded but runtime check failed: {msg}")


# -----------------------------------------------------------------------------
# Step 3 -- Python venv
#
# Fish Speech requires Python 3.10 or 3.11.  3.12, 3.13, and 3.14 are REJECTED
# because the upstream pyproject pins torch to a version that has no wheel for
# those Python releases (e.g. torch==2.8.0 has no cp314 wheel on PyPI). We
# detect available Python interpreters, prefer 3.11, and recreate the venv if
# the existing one was built with an incompatible interpreter (e.g. 3.14).
# -----------------------------------------------------------------------------

# Tuple of (major, minor) versions allowed for the Fish Speech venv.
ALLOWED_PYTHON_VERSIONS = ((3, 10), (3, 11))
# When multiple compatible versions are present, this one wins.
PREFERRED_PYTHON_VERSION = (3, 11)
# Exact error message required when no compatible interpreter is found.
PYTHON_MISSING_MSG = (
    "Fish Speech requires Python 3.10 or 3.11. "
    "Install Python 3.11 from python.org, then retry."
)


def _probe_python(exe_or_launcher: list) -> tuple[str, tuple[int, int]] | None:
    """
    Invoke a Python interpreter and return (executable_path, (major, minor))
    or None if invocation failed.
    """
    cmd = list(exe_or_launcher) + [
        '-c',
        'import sys; print(sys.executable); print(sys.version_info[0]); print(sys.version_info[1])',
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    lines = [l.strip() for l in r.stdout.strip().splitlines() if l.strip()]
    if len(lines) < 3:
        return None
    try:
        return lines[0], (int(lines[1]), int(lines[2]))
    except ValueError:
        return None


def detect_python_interpreters() -> list:
    """
    Enumerate Python interpreters likely usable for the Fish Speech venv.
    Returns a list of dicts:
        {'launcher': ['py','-3.11'], 'exe': 'C:\\\\...', 'version': (3, 11),
         'compatible': True}
    Ordered: compatible first, with preferred Python on top.
    """
    seen_exes = set()
    found = []

    def _add(launcher, exe, ver):
        if exe and exe not in seen_exes:
            seen_exes.add(exe)
            found.append({
                'launcher': launcher,
                'exe': exe,
                'version': ver,
                'compatible': ver in ALLOWED_PYTHON_VERSIONS,
            })

    if IS_WIN:
        # Probe the Windows 'py' launcher first for known minor versions.
        for major, minor in ((3, 10), (3, 11), (3, 12), (3, 13), (3, 14)):
            probe = _probe_python(['py', f'-{major}.{minor}'])
            if probe:
                _add(['py', f'-{major}.{minor}'], probe[0], probe[1])
        # Also probe whatever 'python' resolves to on PATH.
        probe = _probe_python(['python'])
        if probe:
            _add([probe[0]], probe[0], probe[1])
    else:
        # POSIX: try the common version-suffixed binaries.
        for name in ('python3.10', 'python3.11', 'python3.12', 'python3.13',
                     'python3.14', 'python3', 'python'):
            path = shutil.which(name)
            if not path:
                continue
            probe = _probe_python([path])
            if probe:
                _add([path], probe[0], probe[1])

    # Sort: compatible & preferred first, then other compatible, then others.
    def _rank(entry):
        if entry['compatible']:
            if entry['version'] == PREFERRED_PYTHON_VERSION:
                return (0, 0, 0)
            return (1, -entry['version'][1], 0)
        return (2, entry['version'][0], entry['version'][1])

    found.sort(key=_rank)
    return found


def select_python_for_venv():
    """
    Return (selected_executable, launcher_cmd, all_detected).
    selected_executable is the Python that will be used to create the venv.
    launcher_cmd is the argv prefix (e.g. ['py','-3.11']) used to invoke it.
    Returns (None, None, all_detected) if no compatible Python is on the host.
    """
    detected = detect_python_interpreters()
    for entry in detected:
        if entry['compatible']:
            return entry['exe'], entry['launcher'], detected
    return None, None, detected


def _venv_python_version(venv_py: str):
    """Return (major, minor) for the Python inside an existing venv, or None."""
    if not Path(venv_py).is_file():
        return None
    probe = _probe_python([venv_py])
    return probe[1] if probe else None


def ensure_venv(cfg: dict) -> tuple[bool, str]:
    venv_py_path = get_venv_python(cfg)
    venv_dir = cfg['venv_path']

    # ---- 1. If a venv already exists, check that its Python is compatible ---
    if venv_exists(cfg):
        existing_ver = _venv_python_version(venv_py_path)
        if existing_ver and existing_ver in ALLOWED_PYTHON_VERSIONS:
            log(f"  Existing venv uses Python {existing_ver[0]}.{existing_ver[1]} -- compatible")
            return True, f"Venv ready: {venv_py_path}"
        if existing_ver:
            log(f"  Existing venv uses Python {existing_ver[0]}.{existing_ver[1]} -- INCOMPATIBLE with Fish Speech")
            log(f"  Fish Speech needs Python 3.10 or 3.11 (NOT 3.12, 3.13, or 3.14).")
            log(f"  Deleting broken venv at {venv_dir} so it can be rebuilt...")
        else:
            log(f"  Could not determine venv Python version -- deleting and recreating...")
        try:
            shutil.rmtree(venv_dir, ignore_errors=True)
        except Exception as e:
            return False, f"Failed to remove broken venv at {venv_dir}: {e}"

    # ---- 2. Find a compatible Python on the host ---------------------------
    log("  Detecting installed Python interpreters...")
    selected_exe, launcher, detected = select_python_for_venv()

    if not detected:
        log("  (none found via 'py' launcher or PATH)")
    else:
        for entry in detected:
            tag = '[OK]  ' if entry['compatible'] else '[skip]'
            log(f"    {tag} Python {entry['version'][0]}.{entry['version'][1]}  "
                f"launcher={' '.join(entry['launcher'])}  exe={entry['exe']}")

    if not selected_exe:
        return False, PYTHON_MISSING_MSG

    log(f"  Selected Python: {selected_exe}")
    log(f"  Launcher command: {' '.join(launcher)}")

    # ---- 3. Create the venv using the selected interpreter -----------------
    runtime = cfg['runtime_path']
    Path(runtime).mkdir(parents=True, exist_ok=True)
    venv_cmd = list(launcher) + ['-m', 'venv', venv_dir]
    log(f"  Creating venv: {' '.join(venv_cmd)}")
    result = subprocess.run(venv_cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return False, (
            f"venv creation failed (exit {result.returncode}):\n"
            f"  command: {' '.join(venv_cmd)}\n"
            f"  stderr:  {result.stderr[-400:]}"
        )

    if not venv_exists(cfg):
        return False, f"venv create succeeded but python not found at {venv_py_path}"

    new_ver = _venv_python_version(venv_py_path)
    if new_ver:
        log(f"  Venv Python version: {new_ver[0]}.{new_ver[1]}")
        if new_ver not in ALLOWED_PYTHON_VERSIONS:
            return False, (
                f"venv was created with Python {new_ver[0]}.{new_ver[1]} which is "
                f"NOT supported by Fish Speech. " + PYTHON_MISSING_MSG
            )
    return True, f"Venv created at {venv_py_path}"


# ─────────────────────────────────────────────────────────────────────────────
# Step 4 — Dependencies
# ─────────────────────────────────────────────────────────────────────────────

REQUIRED_MODULES = ['torch', 'torchaudio', 'transformers', 'fish_speech']


def check_deps(cfg: dict) -> bool:
    """Quick import-check for the four required modules."""
    venv_py = get_venv_python(cfg)
    if not Path(venv_py).is_file():
        return False
    checks = '\n'.join(
        f"try:\n    import {m}; print('OK {m}')\nexcept Exception as e: print('FAIL {m}:',e)"
        for m in REQUIRED_MODULES
    )
    r = subprocess.run([venv_py, '-c', checks], capture_output=True, text=True, timeout=30)
    out = r.stdout
    return all(f'OK {m}' in out for m in REQUIRED_MODULES)


def _patch_pyproject(runtime: str) -> None:
    """
    Relax hard-pinned torch / torchaudio / numpy / Python version constraints
    in the cloned fish-speech pyproject.toml so that pip can resolve against
    whatever versions are actually available on PyPI.

    fish-speech often pins e.g. torch==2.8.0 which doesn't exist yet; this
    replaces exact pins with flexible lower-bounds while keeping the package
    itself installable.  The patch is idempotent and only touches the local
    clone — it does NOT affect any system-wide files.
    """
    import re

    pyproject = Path(runtime) / 'pyproject.toml'
    if not pyproject.is_file():
        return

    original = pyproject.read_text(encoding='utf-8', errors='replace')
    text = original

    # 1. Relax exact torch/torchaudio pins: torch==X.Y.Z → torch>=2.0.0,<4.0.0
    text = re.sub(r'"torch==[\d.]+"',      '"torch>=2.0.0,<4.0.0"',      text)
    text = re.sub(r'"torchaudio==[\d.]+"', '"torchaudio>=2.0.0,<4.0.0"', text)

    # 2. Relax numpy upper-bound if it excludes 3.13+
    #    e.g. numpy>=1.22,<2 → numpy>=1.22
    text = re.sub(r'"numpy([^"]*),<[\d.]+"', r'"numpy\1"', text)
    # Also handle older pin patterns like numpy==1.x
    text = re.sub(r'"numpy==[\d.]+"', '"numpy>=1.22.0"', text)

    # 3. Remove tight Python upper-bound if it excludes the running interpreter
    #    e.g. requires-python = ">=3.10,<3.13"  →  ">=3.10"
    import sys
    major, minor = sys.version_info[:2]
    def _relax_python_bound(m: re.Match) -> str:
        spec = m.group(1)
        # Strip any upper-bound clause that would exclude the current Python
        relaxed = re.sub(r',\s*<3\.\d+', '', spec)
        return f'requires-python = "{relaxed}"'
    text = re.sub(r'requires-python\s*=\s*"([^"]+)"', _relax_python_bound, text)

    if text != original:
        pyproject.write_text(text, encoding='utf-8')
        log("  [OK] Patched pyproject.toml -- relaxed torch/torchaudio/numpy/Python version constraints")
    else:
        log("  ... pyproject.toml already has flexible constraints -- no patch needed")


def _run_pip(venv_py: str, args: list, cwd: str = None, label: str = '') -> tuple[bool, str]:
    """Run pip with streaming output; return (success, last_stderr_chunk)."""
    cmd = [venv_py, '-m', 'pip'] + args + ['--disable-pip-version-check']
    proc = subprocess.Popen(
        cmd, cwd=cwd,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True,
    )
    last_lines = []
    for line in iter(proc.stdout.readline, ''):
        stripped = line.rstrip()
        if stripped:
            log(f"  [pip{' ' + label if label else ''}] {stripped}")
            last_lines.append(stripped)
            if len(last_lines) > 30:
                last_lines.pop(0)
    proc.wait()
    return proc.returncode == 0, '\n'.join(last_lines[-10:])


def install_deps(cfg: dict) -> tuple[bool, str]:
    venv_py = get_venv_python(cfg)
    runtime = cfg['runtime_path']

    # -- Upgrade pip first ----------------------------------------------------
    log("Upgrading pip...")
    subprocess.run(
        [venv_py, '-m', 'pip', 'install', '--upgrade', 'pip', '--quiet'],
        capture_output=True,
    )

    # -- Patch pyproject.toml to remove impossible version pins ---------------
    log("Checking pyproject.toml constraints...")
    _patch_pyproject(runtime)

    # -- Pre-install torch + torchaudio without version pins ------------------
    # We install these first so that when pip processes pyproject.toml it finds
    # them already satisfied and skips the (now-relaxed) constraint entirely.
    torch_cmd = [venv_py, '-m', 'pip', 'install', 'torch', 'torchaudio', '--quiet', '--disable-pip-version-check']
    log("Installing PyTorch (latest available -- this may take several minutes)...")
    log(f"  Install command: {' '.join(torch_cmd)}")
    torch_ok, torch_err = _run_pip(
        venv_py,
        ['install', 'torch', 'torchaudio', '--quiet'],
        label='torch',
    )
    if not torch_ok:
        # Non-fatal: pyproject.toml patch should still let the editable install work.
        log(f"  ! torch pre-install had warnings/errors -- continuing anyway: {torch_err[-200:]}")

    # -- Main editable install ------------------------------------------------
    fish_cmd = [venv_py, '-m', 'pip', 'install', '-e', '.', '--disable-pip-version-check']
    log("Installing fish-speech (pip install -e .)  <-  this can take several minutes...")
    log(f"  Install command: {' '.join(fish_cmd)} (cwd={runtime})")
    ok, err = _run_pip(
        venv_py,
        ['install', '-e', '.'],
        cwd=runtime,
        label='fish',
    )

    if not ok:
        # If it still failed, try with --no-build-isolation as a fallback
        log("  ! Standard install failed -- retrying with --no-build-isolation...")
        ok, err = _run_pip(
            venv_py,
            ['install', '-e', '.', '--no-build-isolation'],
            cwd=runtime,
            label='fish-nbi',
        )

    if not ok:
        return False, (
            f"pip install -e . failed.\n"
            f"Last output:\n{err}\n\n"
            "Troubleshooting tips:\n"
            "  * Fish Speech requires Python 3.10 or 3.11 (NOT 3.12, 3.13, or 3.14).\n"
            "    If you do not have Python 3.11 installed, get it from python.org\n"
            "    then delete the .venv folder and re-run.\n"
            "  * Try running bats\\setup-fish-speech.bat manually for the full log\n"
            "  * Check internet connectivity (PyPI + GitHub must be reachable)"
        )

    return True, "Dependencies installed successfully"


# ─────────────────────────────────────────────────────────────────────────────
# Step 5 — Start server
# ─────────────────────────────────────────────────────────────────────────────

def _is_port_busy(host: str, port: int, timeout: float = 1.0) -> bool:
    """Return True if something is already listening on host:port."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (ConnectionRefusedError, OSError):
        return False


def run_server(cfg: dict) -> int:
    venv_py = get_venv_python(cfg)
    runtime = cfg['runtime_path']
    model   = cfg['model_path']
    listen  = cfg['listen_addr']

    # Parse host/port for busy check
    host, _, port_str = listen.partition(':')
    port = int(port_str) if port_str.isdigit() else 8080

    if _is_port_busy(host or '127.0.0.1', port):
        log(f"WARNING: Port {port} already in use. Another server may be running.")
        log("If you intended to restart Fish Speech, stop the existing process first.")

    cmd = [
        venv_py, '-m', 'tools.api_server',
        '--listen', listen,
        '--llama-checkpoint-path', model,
    ]

    log(f"Starting: {' '.join(cmd)}")
    log(f"Working directory: {runtime}")
    log(f"Server -> http://{listen}")
    log("-" * 60)

    env = {**os.environ,
           'PYTHONUNBUFFERED': '1',
           'FISH_S2_PRO_MODEL_PATH': model,
           'FISH_SPEECH_RUNTIME_PATH': runtime,
           'FISH_SPEECH_VENV_PATH': cfg['venv_path'],
           'FISH_TTS_URL': cfg['server_url']}

    _proc = [None]

    def _shutdown(sig, frame):
        log(f"\nReceived signal {sig} -- shutting down...")
        p = _proc[0]
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        sys.exit(0)

    signal.signal(signal.SIGINT,  _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    _proc[0] = subprocess.Popen(cmd, cwd=runtime, env=env)
    exit_code = _proc[0].wait()
    log(f"Server process exited with code {exit_code}")
    return exit_code


# ─────────────────────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────────────────────

def log(msg: str):
    ts = time.strftime('%H:%M:%S')
    print(f"[fish {ts}] {msg}", flush=True)


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Fish Speech S2 Pro Server -- Trend Vault',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('--model-path',   dest='model_path',   help='Path to the s2-pro model directory')
    parser.add_argument('--runtime-path', dest='runtime_path', help='Path to the fish-speech clone')
    parser.add_argument('--venv-path',    dest='venv_path',    help='Path to the Python venv')
    parser.add_argument('--listen',       help='Listen address, e.g. 127.0.0.1:8080')
    parser.add_argument('--skip-setup',   action='store_true', help='Skip setup and start immediately')
    args = parser.parse_args()

    cfg = resolve_config(args)

    log("=" * 60)
    log("  Fish Speech S2 Pro Server -- Trend Vault")
    log("=" * 60)
    log(f"  Model path:   {cfg['model_path']}")
    log(f"  Runtime path: {cfg['runtime_path']}")
    log(f"  Venv path:    {cfg['venv_path']}")
    log(f"  Listen:       {cfg['listen_addr']}")
    log("=" * 60)

    if args.skip_setup:
        log("--skip-setup set: jumping straight to server launch")
        sys.exit(run_server(cfg))

    # -- Step 1: Verify model -------------------------------------------------
    log("Step 1/5 -- Checking model...")
    ok, msg = check_model(cfg)
    log(f"  {'[OK]' if ok else '[FAIL]'} {msg}")
    if not ok:
        log("")
        log("FATAL: Cannot start Fish Speech without the model.")
        log(f"  Expected model at: {cfg['model_path']}")
        log("  Set FISH_S2_PRO_MODEL_PATH or use --model-path to point at your model.")
        log("  You can also use the 'Choose Model Folder' button in the app UI.")
        sys.exit(1)

    # -- Step 2: Ensure runtime repo ------------------------------------------
    log("Step 2/5 -- Checking fish-speech runtime...")
    ok, msg = check_runtime(cfg)
    if not ok:
        log("  Runtime not found -- cloning from GitHub...")
        ok, msg = ensure_runtime(cfg)
        if not ok:
            log(f"FATAL: {msg}")
            log("  Ensure git is on PATH: https://git-scm.com/downloads")
            sys.exit(2)
    log(f"  [OK] {msg}")

    # -- Step 3: Create venv --------------------------------------------------
    log("Step 3/5 -- Checking Python venv...")
    ok, msg = ensure_venv(cfg)
    if not ok:
        log(f"FATAL: {msg}")
        sys.exit(3)
    log(f"  [OK] {msg}")

    # -- Step 4: Check / install deps -----------------------------------------
    log("Step 4/5 -- Checking dependencies...")
    if check_deps(cfg):
        log("  [OK] All required packages present")
    else:
        log("  Dependencies missing -- installing...  (first-time: may take 5-10 min)")
        ok, msg = install_deps(cfg)
        if not ok:
            log(f"FATAL: {msg}")
            sys.exit(4)
        if not check_deps(cfg):
            log("FATAL: Dependencies still missing after install. Check pip output above.")
            sys.exit(4)
        log("  [OK] Dependencies installed")

    # -- Step 5: Start server -------------------------------------------------
    log("Step 5/5 -- Starting Fish Speech server...")
    sys.exit(run_server(cfg))


if __name__ == '__main__':
    main()
