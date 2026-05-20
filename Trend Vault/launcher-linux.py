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

import os, sys, time, socket, subprocess, threading, webbrowser, shutil, signal, re, tkinter as tk
from tkinter import font as tkfont, messagebox
from datetime import datetime

if sys.platform == 'win32':
    sys.stderr.write("launcher-linux.py is for Linux. Use launcher.py on Windows.\n")
    sys.exit(2)

# ── Project root (works as .py or frozen binary) ────────────────────────────
ROOT = os.path.dirname(sys.executable if getattr(sys, 'frozen', False) else os.path.abspath(__file__))

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

_OLLAMA_UI_SERVER = os.path.join(ROOT, 'Ollama web ui', 'server.js')

# Ollama on Linux ships an install.sh that needs sudo. We don't try to run it
# unattended — we just open the official install page in the browser and
# print the curl one-liner so the user can paste it into their own terminal.
_OLLAMA_INSTALL_PAGE   = 'https://ollama.com/download/linux'
_OLLAMA_INSTALL_ONELINE = 'curl -fsSL https://ollama.com/install.sh | sh'

def resolve_ollama() -> str | None:
    """Return the path to the ollama binary, or None if it isn't on PATH."""
    return shutil.which('ollama')


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
    Search order: project venv → PATH → ~/.local/bin/aider."""
    venv = _aider_venv_bin()
    if venv:
        return venv
    p = shutil.which('aider')
    if p:
        return p
    home = os.environ.get('HOME')
    if home:
        guess = os.path.join(home, '.local', 'bin', 'aider')
        if os.path.isfile(guess):
            return guess
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
        # CLI runner state
        self._cli_proc: subprocess.Popen | None = None
        self._cli_busy = False
        self._cli_history: list[str] = []
        self._cli_history_idx: int = -1
        self._cli_draft: str = ''

        self._build_ui()
        self._poll()
        self.after(800, self._check_ollama_on_start)
        self.after(1200, self._check_aider_on_start)

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
        """Install aider into <ROOT>/.venv-aider/ by default; pipx if present.

        Distro Pythons on modern Debian/Ubuntu/Fedora reject system-wide
        pip installs (PEP 668 'externally managed environment'), and even
        --user installs can break when numpy needs to be source-built
        against stale setuptools (the pkgutil.ImpImporter failure on
        Python 3.12+). A dedicated venv sidesteps both problems.
        """
        self._installing_aider = True
        self._set_status('Installing aider...')
        try:
            pipx = _find_pipx_cmd()
            if pipx:
                self._log_line('pipx detected — using isolated install', ACCENT)
                ok = self._run_pip_subprocess(pipx + ['install', 'aider-chat'], '[pipx]')
            else:
                self._log_line(
                    'Installing aider into project-local venv at ' + _AIDER_VENV_DIR + ' ...', ACCENT
                )
                ok = self._install_aider_into_venv(pip)
            if ok:
                self._log_line('Aider installed successfully', GREEN)
                path = resolve_aider()
                if path:
                    self._log_line('Aider resolved at: ' + path, GREEN)
                else:
                    self._log_line(
                        'Aider install reported success but resolve_aider() returned None. '
                        'Restart the launcher to re-scan.', AMBER
                    )
            else:
                self._log_line('Aider install failed; see [pip] / [venv] errors above', RED)
                self._log_line(
                    'Workaround: install pipx via your distro package manager, then re-click:', AMBER
                )
                self._log_line('   sudo apt install pipx      # or:  pip install --user pipx', AMBER)
                self._log_line('   then click INSTALL AIDER again', AMBER)
        finally:
            self._installing_aider = False
            self._set_status('Ready')

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
            order = {'ollama': 0, 'kokoro': 0, 'ollama_ui': 1}
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

    def _kill(self, svc: dict):
        self._log_line('Stopping ' + svc['name'] + '...', AMBER)
        with self._lock:
            proc = self._procs.get(svc['key'])
        if proc:
            _kill_proc_tree(proc)
        kill_port(svc['port'])
        self._log_line(svc['name'] + ' stopped', MUTED)

    # ── Health check ────────────────────────────────────────────────────────
    def _health(self):
        def _check():
            self._log_line('--- Health Check ---', ACCENT)
            for svc in SERVICES:
                up = port_in_use(svc['port'])
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
            for tool in ('node', 'npm', 'npx', 'lsof'):
                p = shutil.which(tool)
                self._log_line(
                    'Tool'.ljust(15) + '  ' + tool.ljust(25) + '  ' + (p if p else 'MISSING'),
                    TEXT if p else AMBER
                )
            self._log_line('--- End ---', ACCENT)
        threading.Thread(target=_check, daemon=True).start()

    # ── Browser ─────────────────────────────────────────────────────────────
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

    # ── CLI runner ──────────────────────────────────────────────────────────
    def _set_cli_busy(self, busy: bool):
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
        if self._cli_busy:
            self._log_line('A command is still running -- click STOP first or wait', AMBER)
            return
        if not self._cli_history or self._cli_history[-1] != cmd:
            self._cli_history.append(cmd)
            if len(self._cli_history) > 200:
                self._cli_history = self._cli_history[-200:]
        self._cli_history_idx = -1
        self._cli_draft = ''
        self._prompt_var.set('')
        self._log_line('$ ' + cmd, ACCENT)
        threading.Thread(target=self._spawn_cli, args=(cmd,), daemon=True).start()

    def _spawn_cli(self, cmd: str):
        self._set_cli_busy(True)
        try:
            # Run through /bin/sh (or $SHELL if set) so pipes / redirects work.
            shell_bin = os.environ.get('SHELL') or '/bin/sh'
            proc = subprocess.Popen(
                [shell_bin, '-c', cmd],
                cwd=ROOT,
                env={**os.environ},
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                encoding='utf-8',
                errors='replace',
                bufsize=1,
                start_new_session=True,
            )
            self._cli_proc = proc
            self._append_inline('', leading_ts=True)
            for raw in proc.stdout:
                line = raw.rstrip('\r\n')
                self._append_inline(line + '\n')
            proc.wait()
            code = proc.returncode
            self._log_line('(exit ' + str(code) + ')', GREEN if code == 0 else RED)
        except FileNotFoundError as e:
            self._log_line('command not found: ' + str(e), RED)
        except Exception as e:
            self._log_line('CLI error: ' + str(e), RED)
        finally:
            self._cli_proc = None
            self._set_cli_busy(False)

    def _stop_cli(self):
        proc = self._cli_proc
        if not proc:
            return
        self._log_line('^C -- stopping command...', AMBER)
        _kill_proc_tree(proc)

    # ── CLI history navigation ──────────────────────────────────────────────
    def _history_prev(self):
        if not self._cli_history:
            return 'break'
        if self._cli_history_idx == -1:
            self._cli_draft = self._prompt_var.get()
            self._cli_history_idx = len(self._cli_history) - 1
        elif self._cli_history_idx > 0:
            self._cli_history_idx -= 1
        self._prompt_var.set(self._cli_history[self._cli_history_idx])
        self.after(0, lambda: self._prompt_entry.icursor('end'))
        return 'break'

    def _history_next(self):
        if self._cli_history_idx == -1:
            return 'break'
        if self._cli_history_idx < len(self._cli_history) - 1:
            self._cli_history_idx += 1
            self._prompt_var.set(self._cli_history[self._cli_history_idx])
        else:
            self._cli_history_idx = -1
            self._prompt_var.set(self._cli_draft)
        self.after(0, lambda: self._prompt_entry.icursor('end'))
        return 'break'

    def _append_inline(self, text: str, leading_ts: bool = False):
        def _do():
            self._log.configure(state='normal')
            if leading_ts:
                self._log.insert('end', '[' + ts() + ']  ', 'cinline')
                self._log.tag_configure('cinline', foreground=MUTED)
            self._log.insert('end', text, 'inline')
            self._log.see('end')
            self._log.configure(state='disabled')
        self.after(0, _do)

    # ── Window close ────────────────────────────────────────────────────────
    def destroy(self):
        for svc in SERVICES:
            with self._lock:
                proc = self._procs.get(svc['key'])
            if proc:
                _kill_proc_tree(proc)
        if self._cli_proc:
            _kill_proc_tree(self._cli_proc)
        super().destroy()


if __name__ == '__main__':
    app = TrendVaultLauncher()
    app.mainloop()
