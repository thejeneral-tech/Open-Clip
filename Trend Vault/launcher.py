"""
Trend Vault Launcher
────────────────────
Single-file GUI launcher for the Trend Vault stack.
Replaces all .bat files with a dark-theme control panel.

Build to .exe (run build-launcher.bat):
    pip install pyinstaller
    pyinstaller --onefile --windowed --name TrendVaultLauncher launcher.py
"""

import os, sys, time, socket, subprocess, threading, webbrowser, tkinter as tk
from tkinter import font as tkfont
from datetime import datetime

# ── Project root (works as .py or frozen .exe) ───────────────────────────────
ROOT = os.path.dirname(sys.executable if getattr(sys, 'frozen', False) else os.path.abspath(__file__))

# ── Service definitions ───────────────────────────────────────────────────────
# Kokoro uses the venv Python written by setup-kokoro.bat. If the venv isn't
# present we fall back to calling start-kokoro.bat which will print the right
# "run setup-kokoro.bat first" error.
_KOKORO_VENV_PY = os.path.join(ROOT, 'kokoro-tts', '.venv', 'Scripts', 'python.exe')
_KOKORO_SCRIPT  = os.path.join(ROOT, 'kokoro-tts', 'kokoro_server.py')
if os.path.isfile(_KOKORO_VENV_PY):
    _KOKORO_CMD = [_KOKORO_VENV_PY, _KOKORO_SCRIPT]
else:
    _KOKORO_CMD = ['start-kokoro.bat']

SERVICES = [
    {
        'key':  'webapp',
        'name': 'Web App',
        'desc': 'Express server  •  port 3001',
        'port': 3001,
        'cmd':  ['npm', 'start'],
        'url':  'http://localhost:3001/trend-vault',
    },
    {
        'key':  'worker',
        'name': 'Render Worker',
        'desc': 'Remotion worker  •  port 4000',
        'port': 4000,
        'cmd':  ['npx', 'tsx', 'render-worker.ts'],
        'url':  None,
    },
    {
        'key':  'kokoro',
        'name': 'Kokoro TTS',
        'desc': 'Local TTS server  •  port 5070',
        'port': 5070,
        'cmd':  _KOKORO_CMD,
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

def ts() -> str:
    return datetime.now().strftime('%H:%M:%S')


# ── Main app ──────────────────────────────────────────────────────────────────
class TrendVaultLauncher(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('🏦 Trend Vault Launcher')
        self.configure(bg=BG)
        self.resizable(False, False)
        self.geometry('520x720')

        # Process handles  { key: subprocess.Popen }
        self._procs: dict[str, subprocess.Popen] = {}
        self._lock  = threading.Lock()

        self._build_ui()
        self._poll()   # start status polling loop

    # ── UI construction ───────────────────────────────────────────────────────
    def _build_ui(self):
        mono = tkfont.Font(family='Consolas', size=9)

        # Header
        hdr = tk.Frame(self, bg=BG, pady=16)
        hdr.pack(fill='x', padx=24)
        tk.Label(hdr, text='🏦  TREND VAULT', bg=BG, fg=TEXT,
                 font=('Segoe UI', 17, 'bold')).pack(side='left')
        tk.Label(hdr, text='LAUNCHER', bg=BG, fg=ACCENT,
                 font=('Segoe UI', 17, 'bold')).pack(side='left', padx=(6,0))

        # Divider
        tk.Frame(self, bg=BORDER, height=1).pack(fill='x', padx=0)

        # Service cards
        cards_frame = tk.Frame(self, bg=BG, pady=16)
        cards_frame.pack(fill='x', padx=24)

        self._cards: dict[str, dict] = {}
        for svc in SERVICES:
            self._cards[svc['key']] = self._make_card(cards_frame, svc)

        # Divider
        tk.Frame(self, bg=BORDER, height=1).pack(fill='x', padx=0)

        # Global action bar
        bar = tk.Frame(self, bg=BG2, pady=14)
        bar.pack(fill='x', padx=0)
        inner = tk.Frame(bar, bg=BG2)
        inner.pack()

        self._btn(inner, '▶  START ALL',  self._start_all,   BTN_GO,  GREEN ).pack(side='left', padx=6)
        self._btn(inner, '■  STOP ALL',   self._stop_all,    BTN_STP, RED   ).pack(side='left', padx=6)
        self._btn(inner, '\U0001f4e6  INSTALL', self._run_install, BTN,    AMBER ).pack(side='left', padx=6)
        self._btn(inner, '⬡  HEALTH',     self._health,      BTN,     AMBER ).pack(side='left', padx=6)
        self._btn(inner, '\U0001f310  OPEN',   self._open_browser, BTN,    ACCENT).pack(side='left', padx=6)

        # Divider
        tk.Frame(self, bg=BORDER, height=1).pack(fill='x')

        # Log pane
        log_hdr = tk.Frame(self, bg=BG, pady=8)
        log_hdr.pack(fill='x', padx=24)
        tk.Label(log_hdr, text='LOGS', bg=BG, fg=MUTED,
                 font=('Segoe UI', 8, 'bold')).pack(side='left')
        self._btn(log_hdr, 'clear', self._clear_log, BG, MUTED,
                  font=('Segoe UI', 8)).pack(side='right')

        self._log = tk.Text(
            self, bg=BG2, fg='#a0a0c0', font=mono,
            bd=0, relief='flat', wrap='word',
            state='disabled', height=12,
            insertbackground=TEXT, selectbackground=ACCENT,
        )
        self._log.pack(fill='both', expand=True, padx=24, pady=(0, 16))

        # Status bar
        self._status_var = tk.StringVar(value='Ready')
        tk.Label(self, textvariable=self._status_var, bg=BG, fg=MUTED,
                 font=('Segoe UI', 8), anchor='w', pady=4).pack(fill='x', padx=24)

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

    # ── Service control ───────────────────────────────────────────────────────
    def _start_one(self, key: str):
        svc = next(s for s in SERVICES if s['key'] == key)
        if port_in_use(svc['port']):
            self._log_line(svc['name'] + ' already running on :' + str(svc['port']), AMBER)
            return
        def _do():
            # Kokoro doesn't need npm deps; everything else does
            if svc['key'] != 'kokoro' and not self._ensure_deps():
                return
            self._launch(svc)
        threading.Thread(target=_do, daemon=True).start()

    def _stop_one(self, key: str):
        svc = next(s for s in SERVICES if s['key'] == key)
        threading.Thread(target=self._kill, args=(svc,), daemon=True).start()

    def _start_all(self):
        def _do():
            if not self._ensure_deps():
                return
            # Boot Kokoro first so the Node server's TTS probe succeeds at startup
            ordered = sorted(SERVICES, key=lambda s: 0 if s['key'] == 'kokoro' else 1)
            for svc in ordered:
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
        self._log_line('Starting ' + svc['name'] + '...', TEXT)
        self._set_status('Starting ' + svc['name'] + '...')
        try:
            env = {**os.environ, 'NODE_OPTIONS': '--max-old-space-size=8192'}
            proc = subprocess.Popen(
                svc['cmd'], cwd=ROOT, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                encoding='utf-8', errors='replace', bufsize=1,
                shell=(sys.platform == 'win32'),
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0,
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
            try:
                proc.terminate()
                proc.wait(timeout=4)
            except Exception:
                try: proc.kill()
                except Exception: pass
        kill_port(svc['port'])
        self._log_line(svc['name'] + ' stopped', MUTED)

    # ── Health check ──────────────────────────────────────────────────────────
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
                'kokoro-tts',
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
                'Kokoro model'.ljust(15) + '  ' + ('OK' if kokoro_ready else 'MISSING -- run setup-kokoro.bat'),
                TEXT if kokoro_ready else AMBER
            )
            self._log_line('--- End ---', ACCENT)
        threading.Thread(target=_check, daemon=True).start()

    # ── Browser ───────────────────────────────────────────────────────────────
    def _open_browser(self):
        url = 'http://localhost:3001/trend-vault'
        webbrowser.open(url)
        self._log_line('Opening ' + url, ACCENT)

    # ── Window close ─────────────────────────────────────────────────────────
    def destroy(self):
        for svc in SERVICES:
            with self._lock:
                proc = self._procs.get(svc['key'])
            if proc:
                try: proc.terminate()
                except Exception: pass
        super().destroy()


if __name__ == '__main__':
    app = TrendVaultLauncher()
    app.mainloop()
