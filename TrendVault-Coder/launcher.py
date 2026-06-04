"""
TrendVault AI Launcher
──────────────────────
Single-file GUI launcher for the TrendVault AI workspace (the self-hosted
FastAPI app in this folder). A dark-theme control panel that creates the
virtualenv, installs dependencies, runs first-time setup, and starts/stops
the server — so you never have to touch a terminal.

Mirrors the Trend Vault stack launcher, adapted for this Python/uvicorn app.

Build to .exe (needs a GUI Python, not the Windows Store stub):
    pip install pyinstaller
    pyinstaller --onefile --windowed --name TrendVaultAILauncher launcher.py
"""

import os, sys, time, socket, subprocess, threading, webbrowser, shutil, platform
import tkinter as tk
from tkinter import font as tkfont, messagebox
from datetime import datetime

# ── Project root (works as .py or frozen .exe) ───────────────────────────────
ROOT = os.path.dirname(sys.executable if getattr(sys, 'frozen', False) else os.path.abspath(__file__))
IS_WIN = sys.platform == 'win32'

# ── App boot config ──────────────────────────────────────────────────────────
# The native PowerShell launcher boots with: venv -> pip install -r
# requirements.txt -> python setup.py -> uvicorn app:app --host H --port P.
# We replicate that flow here. Host/port follow .env (APP_BIND/APP_PORT) when
# present, otherwise the documented defaults.
_DEFAULT_HOST = '127.0.0.1'
_DEFAULT_PORT = 7000


def _read_env_setting(key: str, default: str) -> str:
    """Read a single KEY=value from .env (tolerating a UTF-8 BOM), else default."""
    env_path = os.path.join(ROOT, '.env')
    try:
        with open(env_path, 'r', encoding='utf-8-sig') as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, _, v = line.partition('=')
                if k.strip() == key:
                    return v.strip().strip('"').strip("'") or default
    except OSError:
        pass
    return default


APP_HOST = _read_env_setting('APP_BIND', _read_env_setting('TRENDVAULT_AI_HOST', _DEFAULT_HOST))
try:
    APP_PORT = int(_read_env_setting('APP_PORT', _read_env_setting('TRENDVAULT_AI_PORT', str(_DEFAULT_PORT))))
except ValueError:
    APP_PORT = _DEFAULT_PORT
# The bind host may be 0.0.0.0 (all interfaces); browse to loopback regardless.
_BROWSE_HOST = '127.0.0.1' if APP_HOST in ('0.0.0.0', '::', '') else APP_HOST
APP_URL = f'http://{_BROWSE_HOST}:{APP_PORT}'


def _venv_python() -> str | None:
    """Return the venv interpreter path if the venv exists, else None."""
    p = os.path.join(ROOT, 'venv', 'Scripts', 'python.exe') if IS_WIN \
        else os.path.join(ROOT, 'venv', 'bin', 'python')
    return p if os.path.isfile(p) else None


def _resolve_system_python() -> list[str] | None:
    """Find a Python 3.11+ interpreter for creating the venv.

    Search order mirrors launch-windows.ps1: the Windows 'py' launcher
    (newest first), then canonical python names. Returns a command prefix
    list (e.g. ['py', '-3.12'] or ['/usr/bin/python3']), or None."""
    def _ver_ok(cmd: list[str]) -> bool:
        try:
            r = subprocess.run(
                cmd + ['-c', 'import sys;print("%d.%d" % sys.version_info[:2])'],
                capture_output=True, text=True, timeout=5,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
            if r.returncode != 0:
                return False
            major, _, minor = r.stdout.strip().partition('.')
            return int(major) == 3 and int(minor) >= 11 or int(major) > 3
        except Exception:
            return False

    if shutil.which('py'):
        for v in ('-3.13', '-3.12', '-3.11'):
            if _ver_ok(['py', v]):
                return ['py', v]
    for name in ('python3.13', 'python3.12', 'python3.11', 'python3', 'python'):
        path = shutil.which(name)
        if path and _ver_ok([path]):
            return [path]
    return None


# ── Ollama (optional local LLM backend the app can connect to) ────────────────
_OLLAMA_INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe'
_OLLAMA_DEFAULT_EXE = os.path.expandvars(r'%LOCALAPPDATA%\Programs\Ollama\ollama.exe')


def resolve_ollama() -> str | None:
    """Return the path to the ollama binary, or None if it isn't installed."""
    p = shutil.which('ollama')
    if p:
        return p
    if IS_WIN and os.path.isfile(_OLLAMA_DEFAULT_EXE):
        return _OLLAMA_DEFAULT_EXE
    return None


def app_http_ok(timeout: float = 2.0) -> tuple[bool, str]:
    """Confirm the TrendVault AI server is actually answering on its port."""
    import urllib.request
    base = APP_URL
    for path in ('/login.html', '/', '/static/login.html'):
        try:
            with urllib.request.urlopen(base + path, timeout=timeout) as r:
                if 200 <= r.status < 500:
                    return True, base
        except Exception:
            continue
    return False, base


# ── Services ──────────────────────────────────────────────────────────────────
# The app's command is rebuilt at launch time from the (possibly just-created)
# venv interpreter, so 'cmd' here is only a placeholder.
SERVICES = [
    {
        'key':  'app',
        'name': 'TrendVault AI',
        'desc': f'FastAPI workspace  •  port {APP_PORT}',
        'port': APP_PORT,
        'cmd':  None,                # resolved in _launch() from the venv python
        'url':  APP_URL,
        'http_health': app_http_ok,
    },
    {
        'key':  'ollama',
        'name': 'Ollama',
        'desc': 'Local LLM server  •  port 11434',
        'port': 11434,
        'cmd':  ['ollama', 'serve'],
        'url':  None,
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
    """Kill whatever process is listening on the given port."""
    try:
        if IS_WIN:
            result = subprocess.run(['netstat', '-aon'], capture_output=True, text=True, timeout=5)
            for line in result.stdout.splitlines():
                if f':{port} ' in line and 'LISTENING' in line:
                    pid = line.split()[-1]
                    if pid and pid != '0':
                        subprocess.run(['taskkill', '/F', '/PID', pid], capture_output=True, timeout=5)
        else:
            r = subprocess.run(['lsof', '-ti', f'tcp:{port}'], capture_output=True, text=True, timeout=5)
            for pid in r.stdout.split():
                subprocess.run(['kill', '-9', pid], capture_output=True, timeout=5)
    except Exception:
        pass


def _kill_proc_tree(proc: subprocess.Popen):
    """Terminate a process and its child tree gracefully, then force-kill."""
    if proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            if IS_WIN:
                subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                               capture_output=True, timeout=5,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            else:
                proc.kill()
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def ts() -> str:
    return datetime.now().strftime('%H:%M:%S')


# ── Main app ──────────────────────────────────────────────────────────────────
class TrendVaultAILauncher(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('🏦 TrendVault AI Launcher')
        self.configure(bg=BG)
        self.minsize(1040, 680)
        self.geometry('1160x760')

        self._procs: dict[str, subprocess.Popen] = {}
        self._lock = threading.Lock()
        self._installing_ollama = False
        self._setting_up = False
        self._auto_opened = False
        # CLI runner state
        self._cli_proc: subprocess.Popen | None = None
        self._cli_busy = False
        self._cli_history: list[str] = []
        self._cli_history_idx: int = -1
        self._cli_draft: str = ''

        self._build_ui()
        self._poll()
        self.after(400, self._check_env_on_start)

    # ── UI construction ───────────────────────────────────────────────────────
    def _build_ui(self):
        mono = tkfont.Font(family='Consolas', size=9)

        hdr = tk.Frame(self, bg=BG, pady=14)
        hdr.pack(fill='x', padx=28)
        tk.Label(hdr, text='🏦  TRENDVAULT AI', bg=BG, fg=TEXT,
                 font=('Segoe UI', 18, 'bold')).pack(side='left')
        tk.Label(hdr, text='CONTROL', bg=BG, fg=ACCENT,
                 font=('Segoe UI', 18, 'bold')).pack(side='left', padx=(8, 0))
        self._status_var = tk.StringVar(value='Ready')
        tk.Label(hdr, textvariable=self._status_var, bg=BG, fg=MUTED,
                 font=('Segoe UI', 9)).pack(side='right')

        tk.Frame(self, bg=BORDER, height=1).pack(fill='x')

        body = tk.Frame(self, bg=BG)
        body.pack(fill='both', expand=True)

        left = tk.Frame(body, bg=BG, width=560)
        left.pack(side='left', fill='y')
        left.pack_propagate(False)

        tk.Frame(body, bg=BORDER, width=1).pack(side='left', fill='y')

        right = tk.Frame(body, bg=BG2)
        right.pack(side='left', fill='both', expand=True)

        # ── LEFT: services ──
        tk.Label(left, text='SERVICES', bg=BG, fg=MUTED,
                 font=('Segoe UI', 8, 'bold')).pack(anchor='w', padx=28, pady=(18, 6))
        cards_frame = tk.Frame(left, bg=BG)
        cards_frame.pack(fill='x', padx=28)

        self._cards: dict[str, dict] = {}
        for svc in SERVICES:
            self._cards[svc['key']] = self._make_card(cards_frame, svc)

        # ── LEFT: actions ──
        tk.Frame(left, bg=BORDER, height=1).pack(fill='x', pady=(14, 0))
        tk.Label(left, text='ACTIONS', bg=BG, fg=MUTED,
                 font=('Segoe UI', 8, 'bold')).pack(anchor='w', padx=28, pady=(12, 6))
        bar = tk.Frame(left, bg=BG)
        bar.pack(fill='x', padx=24, pady=(0, 16))
        row1 = tk.Frame(bar, bg=BG); row1.pack(fill='x', pady=(0, 6))
        row2 = tk.Frame(bar, bg=BG); row2.pack(fill='x')
        self._btn(row1, '▶  START ALL', self._start_all, BTN_GO, GREEN).pack(side='left', padx=3)
        self._btn(row1, '■  STOP ALL',  self._stop_all,  BTN_STP, RED).pack(side='left', padx=3)
        self._btn(row1, '\U0001f4e6 SETUP', self._run_setup_clicked, BTN, AMBER).pack(side='left', padx=3)
        self._btn(row1, '⬡  HEALTH',     self._health,    BTN, AMBER).pack(side='left', padx=3)
        self._btn(row2, '\U0001f310 OPEN APP', self._open_browser, BTN, ACCENT).pack(side='left', padx=3)
        self._btn(row2, '\U0001f916 INSTALL OLLAMA', self._run_install_ollama, BTN, AMBER).pack(side='left', padx=3)

        # ── RIGHT: console ──
        rhdr = tk.Frame(right, bg=BG2)
        rhdr.pack(fill='x', padx=20, pady=(18, 6))
        tk.Label(rhdr, text='CONSOLE', bg=BG2, fg=ACCENT,
                 font=('Segoe UI', 9, 'bold')).pack(side='left')
        self._cwd_var = tk.StringVar(value='cwd: ' + ROOT)
        tk.Label(rhdr, textvariable=self._cwd_var, bg=BG2, fg=MUTED,
                 font=('Consolas', 8)).pack(side='left', padx=(12, 0))
        self._btn(rhdr, 'clear', self._clear_log, BG2, MUTED,
                  font=('Segoe UI', 8)).pack(side='right')

        log_wrap = tk.Frame(right, bg=BORDER)
        log_wrap.pack(fill='both', expand=True, padx=20, pady=(0, 8))
        self._log = tk.Text(
            log_wrap, bg=BG, fg='#c0c0d8', font=mono,
            bd=0, relief='flat', wrap='word',
            state='disabled', padx=12, pady=10,
            insertbackground=TEXT, selectbackground=ACCENT,
        )
        self._log.pack(fill='both', expand=True, padx=1, pady=1)

        # ── RIGHT: CLI ──
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
            relief='flat', bd=0, highlightthickness=0, font=('Consolas', 10),
        )
        self._prompt_entry.pack(side='left', fill='x', expand=True, ipady=8)
        self._prompt_entry.bind('<Return>', lambda e: self._run_cli())
        self._prompt_entry.bind('<Up>',     lambda e: self._history_prev())
        self._prompt_entry.bind('<Down>',   lambda e: self._history_next())
        self._prompt_entry.bind('<Escape>', lambda e: self._stop_cli())
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
        dot = tk.Label(left, text='○', bg=CARD, fg=RED, font=('Segoe UI', 14))
        dot.pack(side='left', padx=(0, 10))
        info = tk.Frame(left, bg=CARD)
        info.pack(side='left')
        tk.Label(info, text=svc['name'], bg=CARD, fg=TEXT,
                 font=('Segoe UI', 11, 'bold'), anchor='w').pack(anchor='w')
        tk.Label(info, text=svc['desc'], bg=CARD, fg=MUTED,
                 font=('Segoe UI', 8), anchor='w').pack(anchor='w')

        right = tk.Frame(card, bg=CARD)
        right.pack(side='right')
        btn_start = self._btn(right, '▶ Start', lambda k=svc['key']: self._start_one(k),
                              BTN_GO, GREEN, font=('Segoe UI', 9, 'bold'))
        btn_start.pack(side='left', padx=(0, 6))
        btn_stop = self._btn(right, '■ Stop', lambda k=svc['key']: self._stop_one(k),
                             BTN_STP, RED, font=('Segoe UI', 9, 'bold'))
        btn_stop.pack(side='left')
        return {'dot': dot, 'btn_start': btn_start, 'btn_stop': btn_stop, 'running': False}

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
            up = port_in_use(svc['port'])
            card = self._cards[svc['key']]
            if up != card['running']:
                card['running'] = up
                color = GREEN if up else RED
                self.after(0, lambda d=card['dot'], c=color, u=up:
                           d.configure(fg=c, text='●' if u else '○'))
        self.after(2000, self._poll)

    # ── First-run environment check ───────────────────────────────────────────
    def _check_env_on_start(self):
        self._log_line('TrendVault AI launcher ready', ACCENT)
        self._log_line('App URL: ' + APP_URL, MUTED)
        syspy = _resolve_system_python()
        if syspy:
            self._log_line('Python detected: ' + ' '.join(syspy), GREEN)
        else:
            self._log_line('No Python 3.11+ found — install it from python.org before SETUP', RED)
        if _venv_python():
            self._log_line('venv ready: ' + _venv_python(), GREEN)
        else:
            self._log_line('venv not found — click 📦 SETUP (or START) to create it', AMBER)
        if resolve_ollama():
            self._log_line('Ollama detected: ' + resolve_ollama(), GREEN)
        else:
            self._log_line('Ollama not installed (optional — for local models)', MUTED)
        if not IS_WIN or shutil.which('bash'):
            return
        self._log_line('Note: Git Bash (bash.exe) not on PATH — the core app works '
                       'without it; install Git for Windows for full Cookbook/agent-shell.', MUTED)

    # ── Setup: venv + deps + setup.py ─────────────────────────────────────────
    def _run_setup_clicked(self):
        if self._setting_up:
            self._log_line('Setup already in progress...', AMBER)
            return
        threading.Thread(target=self._run_setup, daemon=True).start()

    def _ensure_setup(self) -> bool:
        """Quick gate before starting the app: returns True when the venv is
        ready, otherwise runs the full setup once."""
        if _venv_python() and os.path.isfile(os.path.join(ROOT, '.env')):
            return True
        return self._run_setup()

    def _run_setup(self) -> bool:
        """Create the venv, install requirements, run setup.py. Idempotent —
        safe to re-run; skips whatever already exists."""
        if self._setting_up:
            return False
        self._setting_up = True
        try:
            self._log_line('--- Setup ---', ACCENT)
            self._set_status('Setting up...')

            syspy = _resolve_system_python()
            if not syspy:
                self._log_line('Cannot set up: no Python 3.11+ on PATH. '
                               'Install from https://www.python.org/downloads/ and retry.', RED)
                return False

            venv_py = _venv_python()
            if not venv_py:
                self._log_line('Creating virtual environment (venv)...', TEXT)
                ok = self._stream(syspy + ['-m', 'venv', os.path.join(ROOT, 'venv')], '[venv]')
                venv_py = _venv_python()
                if not ok or not venv_py:
                    self._log_line('Failed to create the virtual environment.', RED)
                    return False
                self._log_line('venv created: ' + venv_py, GREEN)
            else:
                self._log_line('venv already exists — reusing ' + venv_py, MUTED)

            self._log_line('Upgrading pip...', TEXT)
            self._stream([venv_py, '-m', 'pip', 'install', '--upgrade', 'pip'], '[pip]')

            self._log_line('Installing dependencies (first run can take a few minutes)...', TEXT)
            ok = self._stream([venv_py, '-m', 'pip', 'install', '-r', 'requirements.txt'], '[pip]')
            if not ok:
                self._log_line('Dependency install failed — scroll up for the pip error.', RED)
                return False

            self._log_line('Running first-time setup (setup.py)...', TEXT)
            # SKIP_ADMIN_PROMPT stops setup.py from blocking on getpass(); it
            # then generates and PRINTS a temporary admin password we surface.
            env = {**os.environ, 'TRENDVAULT_AI_SKIP_ADMIN_PROMPT': '1', 'PYTHONUNBUFFERED': '1'}
            ok = self._stream([venv_py, 'setup.py'], '[setup]', env=env)
            if ok:
                self._log_line('Setup complete. Click ▶ Start on the TrendVault AI card.', GREEN)
            else:
                self._log_line('setup.py reported an error — see above.', RED)
            return ok
        finally:
            self._setting_up = False
            self._set_status('Ready')
            self._log_line('--- End ---', ACCENT)

    def _stream(self, cmd: list[str], label: str, env: dict | None = None) -> bool:
        """Run a command in ROOT, stream colour-coded output, return exit==0."""
        try:
            proc = subprocess.Popen(
                cmd, cwd=ROOT, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                encoding='utf-8', errors='replace', bufsize=1,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0) if IS_WIN else 0,
            )
            for raw in proc.stdout:
                line = raw.rstrip()
                if not line:
                    continue
                lo = line.lower()
                if 'password' in lo or 'admin account' in lo or 'admin user' in lo:
                    color = AMBER          # surface the generated admin credentials
                elif any(w in lo for w in ('error', 'failed', 'traceback', 'fatal')):
                    color = RED
                elif any(w in lo for w in ('successfully installed', '[ok]', 'complete', 'created')):
                    color = GREEN
                else:
                    color = '#a0a0c0'
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
            if key == 'app' and not self._ensure_setup():
                return
            self._launch(svc)
        threading.Thread(target=_do, daemon=True).start()

    def _stop_one(self, key: str):
        svc = next(s for s in SERVICES if s['key'] == key)
        threading.Thread(target=self._kill, args=(svc,), daemon=True).start()

    def _start_all(self):
        def _do():
            if not self._ensure_setup():
                return
            # Start Ollama first (so the app can reach it), then the app.
            for key in ('ollama', 'app'):
                svc = next(s for s in SERVICES if s['key'] == key)
                if key == 'ollama' and not resolve_ollama():
                    continue
                if port_in_use(svc['port']):
                    continue
                threading.Thread(target=self._launch, args=(svc,), daemon=True).start()
                time.sleep(0.4)
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
        if key == 'app':
            venv_py = _venv_python()
            if not venv_py:
                self._log_line('venv missing — run 📦 SETUP first.', RED)
                return
            cmd = [venv_py, '-m', 'uvicorn', 'app:app', '--host', APP_HOST, '--port', str(APP_PORT)]
        elif key == 'ollama':
            ollama_bin = resolve_ollama()
            if not ollama_bin:
                self._log_line('Ollama is not installed — skipping', RED)
                return
            cmd = [ollama_bin, 'serve']

        self._log_line('Starting ' + svc['name'] + '...', TEXT)
        self._set_status('Starting ' + svc['name'] + '...')
        try:
            env = {**os.environ}
            env.update(svc.get('env', {}))
            flags = 0
            if IS_WIN:
                flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
            proc = subprocess.Popen(
                cmd, cwd=ROOT, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                encoding='utf-8', errors='replace', bufsize=1,
                creationflags=flags,
            )
            with self._lock:
                self._procs[key] = proc
            if key == 'app':
                self._auto_opened = False
                threading.Thread(target=self._app_wait_online, daemon=True).start()
            for raw in proc.stdout:
                line = raw.rstrip()
                if line:
                    lo = line.lower()
                    if any(w in lo for w in ('application startup complete', 'uvicorn running',
                                             'ready', 'started', 'listening')):
                        color = GREEN
                    elif any(w in lo for w in ('error', 'traceback', 'critical')):
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

    def _app_wait_online(self):
        """Poll the app until it answers, then announce it and open the browser once."""
        for _ in range(60):
            time.sleep(1)
            with self._lock:
                alive = self._procs.get('app') is not None
            if not alive:
                return
            ok, _info = app_http_ok(timeout=2.0)
            if ok:
                self._log_line('TrendVault AI is live at ' + APP_URL, GREEN)
                if not self._auto_opened:
                    self._auto_opened = True
                    webbrowser.open(APP_URL)
                return

    def _kill(self, svc: dict):
        self._log_line('Stopping ' + svc['name'] + '...', AMBER)
        with self._lock:
            proc = self._procs.get(svc['key'])
        if proc:
            _kill_proc_tree(proc)
        kill_port(svc['port'])
        self._log_line(svc['name'] + ' stopped', MUTED)

    # ── Health check ──────────────────────────────────────────────────────────
    def _health(self):
        def _check():
            self._log_line('--- Health Check ---', ACCENT)
            for svc in SERVICES:
                port_up = port_in_use(svc['port'])
                probe = svc.get('http_health')
                if port_up and callable(probe):
                    ok, info = probe()
                    status = ('RUNNING (HTTP OK @ ' + info + ')') if ok else \
                             ('PORT BUSY but no HTTP response from ' + info)
                    color = GREEN if ok else AMBER
                else:
                    status = 'RUNNING' if port_up else 'STOPPED'
                    color = GREEN if port_up else RED
                self._log_line(svc['name'].ljust(16) + '  :' + str(svc['port']) + '  ' + status, color)

            syspy = _resolve_system_python()
            self._log_line('System Python'.ljust(16) + '  ' +
                           (' '.join(syspy) if syspy else 'MISSING — install Python 3.11+'),
                           TEXT if syspy else RED)
            venv_py = _venv_python()
            self._log_line('venv'.ljust(16) + '  ' + (venv_py if venv_py else 'MISSING — click 📦 SETUP'),
                           TEXT if venv_py else AMBER)
            for label, path in (('.env', os.path.join(ROOT, '.env')),
                                ('data/', os.path.join(ROOT, 'data')),
                                ('requirements', os.path.join(ROOT, 'requirements.txt')),
                                ('app.py', os.path.join(ROOT, 'app.py'))):
                exists = os.path.exists(path)
                self._log_line(label.ljust(16) + '  ' + ('OK' if exists else 'MISSING'),
                               TEXT if exists else AMBER)
            ollama_path = resolve_ollama()
            self._log_line('Ollama'.ljust(16) + '  ' +
                           (ollama_path if ollama_path else 'not installed (optional)'),
                           TEXT if ollama_path else MUTED)
            self._log_line('--- End ---', ACCENT)
        threading.Thread(target=_check, daemon=True).start()

    # ── Browser ───────────────────────────────────────────────────────────────
    def _open_browser(self):
        if not port_in_use(APP_PORT):
            self._log_line('TrendVault AI is not running on :' + str(APP_PORT) +
                           ' — click ▶ Start first', AMBER)
            return
        webbrowser.open(APP_URL)
        self._log_line('Opening ' + APP_URL, ACCENT)

    # ── Ollama install ────────────────────────────────────────────────────────
    def _run_install_ollama(self):
        if resolve_ollama():
            self._log_line('Ollama is already installed: ' + resolve_ollama(), GREEN)
            return
        self._installing_ollama = False
        self._prompt_install_ollama()

    def _prompt_install_ollama(self):
        if not IS_WIN:
            self._log_line('Auto-install is Windows-only — get Ollama from https://ollama.com/download', AMBER)
            return
        if self._installing_ollama:
            self._log_line('Ollama install already in progress...', AMBER)
            return
        if not messagebox.askyesno(
            'Install Ollama?',
            'Ollama lets TrendVault AI run local models. It was not found on this PC.\n\n'
            'Download the official installer (~700 MB) from ollama.com and run it now?\n\n'
            'Click through the Ollama setup window when it appears.',
        ):
            self._log_line('Ollama install skipped by user', MUTED)
            return
        threading.Thread(target=self._install_ollama, daemon=True).start()

    def _install_ollama(self):
        import urllib.request, tempfile
        self._installing_ollama = True
        try:
            self._log_line('Downloading Ollama installer...', AMBER)
            self._set_status('Downloading Ollama...')
            installer_path = os.path.join(tempfile.gettempdir(), 'OllamaSetup.exe')
            req = urllib.request.Request(_OLLAMA_INSTALLER_URL,
                                         headers={'User-Agent': 'TrendVaultAILauncher/1.0'})
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
            self._log_line('Launching installer — complete the setup window to finish', TEXT)
            self._set_status('Running Ollama installer...')
            subprocess.Popen([installer_path], shell=False)
            self._log_line('When it finishes, click ▶ Start on the Ollama card.', ACCENT)
        except Exception as e:
            self._log_line('Ollama install failed: ' + str(e), RED)
        finally:
            self._installing_ollama = False
            self._set_status('Ready')

    # ── CLI runner ────────────────────────────────────────────────────────────
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
        if self._cli_busy:
            self._log_line('A command is still running — click STOP first', AMBER)
            return
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
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0) if IS_WIN else 0,
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

    def _history_prev(self):
        hist = self._cli_history
        if not hist:
            return
        if self._cli_history_idx == -1:
            self._cli_draft = self._prompt_var.get()
            self._cli_history_idx = len(hist) - 1
        elif self._cli_history_idx > 0:
            self._cli_history_idx -= 1
        self._prompt_var.set(hist[self._cli_history_idx])
        self._prompt_entry.icursor('end')

    def _history_next(self):
        hist = self._cli_history
        if self._cli_history_idx == -1:
            return
        if self._cli_history_idx < len(hist) - 1:
            self._cli_history_idx += 1
            self._prompt_var.set(hist[self._cli_history_idx])
        else:
            self._cli_history_idx = -1
            self._prompt_var.set(self._cli_draft)
        self._prompt_entry.icursor('end')

    def _stop_cli(self):
        proc = self._cli_proc
        if proc and proc.poll() is None:
            try:
                if IS_WIN:
                    subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                                   capture_output=True, timeout=5)
                else:
                    proc.kill()
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            self._log_line('CLI command stopped', AMBER)
        else:
            self._log_line('No CLI command running', MUTED)


if __name__ == '__main__':
    TrendVaultAILauncher().mainloop()
