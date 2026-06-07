"""
TrendVault AI Launcher
──────────────────────
Single-file GUI launcher for the TrendVault AI workspace (the self-hosted
FastAPI app in this folder). A focused control panel that creates the
virtualenv, installs dependencies, runs first-time setup (setup.py), and
starts / stops the web UI — so you never have to touch a terminal.

Modeled on the Trend Vault Studio V2.0 launcher: a left tab rail (Launch /
Settings / About), the studio's One-Dark theme, and a Settings tab where the
external servers this app talks to (the local LLM, LM Studio, SearXNG, …) are
edited as URLs and written back to .env so the web app picks them up on its
next start. Everything else — Ollama, the search engine, ChromaDB — is treated
as an *external server* you point at by URL, so it can live on this PC or
another box.

Styling mirrors the app's web theme (static/style.css): One-Dark charcoal
background, cyan text, coral accent, monospace UI.

Build to .exe (needs a GUI Python, not the Windows Store stub):
    pip install pyinstaller
    pyinstaller --onefile --windowed --name TrendVaultAILauncher launcher.py
"""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from datetime import datetime
from urllib.parse import urlparse

import tkinter as tk
from tkinter import filedialog, font as tkfont, messagebox

# ── Project root (works as plain .py or a frozen .exe) ────────────────────────
ROOT = os.path.dirname(
    sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__)
)
IS_WIN = sys.platform == "win32"

# Key paths the launcher reads / writes.
ENV_PATH     = os.path.join(ROOT, ".env")
DATA_DIR     = os.path.join(ROOT, "data")
CONFIG_PATH  = os.path.join(DATA_DIR, "launcher-config.json")   # custom servers + folders
REQUIREMENTS = os.path.join(ROOT, "requirements.txt")
VENV_PY      = os.path.join(ROOT, "venv", "Scripts", "python.exe") if IS_WIN \
               else os.path.join(ROOT, "venv", "bin", "python")
SETUP_PY     = os.path.join(ROOT, "setup.py")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 7000

# Known external endpoints the app reads from .env. (label, env key, default).
# Edited as URLs in Settings and written back to .env on save.
BUILTIN_SERVERS = [
    ("Ollama  (local LLM)",   "OLLAMA_BASE_URL",       "http://localhost:11434/v1"),
    ("LM Studio",             "LM_STUDIO_URL",         "http://localhost:1234"),
    ("SearXNG  (web search)", "SEARXNG_INSTANCE",      "http://localhost:8080"),
    ("Research LLM endpoint", "RESEARCH_LLM_ENDPOINT", "http://localhost:8000/v1/chat/completions"),
]

# Ollama (optional local LLM backend the app can connect to).
_OLLAMA_DEFAULT_EXE = os.path.expandvars(r"%LOCALAPPDATA%\Programs\Ollama\ollama.exe")

# ── Palette — matches static/style.css :root (the default "dark" theme) ───────
BG        = "#282c34"   # --bg
SURFACE   = "#21252b"   # panel / rail
SURFACE2  = "#2c313c"   # cards
SURFACE3  = "#1b1e24"   # rail / inputs
BORDER    = "#355a66"   # --border
BORDER2   = "#4a7a88"
ACCENT    = "#e06c75"   # --red (coral)
GOLD      = "#d19a66"   # --accent-warm
TEXT      = "#9cdef2"   # --fg (cyan)
TEXT2     = "#7fb8cc"
MUTED     = "#6b8a94"   # --color-subheader
GREEN     = "#50fa7b"   # --green
RED       = "#ff5b5b"
# Pre-blended tints (Tk has no color-mix): coral over the dark surfaces.
TINT      = "#3c2f35"   # ~coral 14% on surface (button hover / accents)
TINT2     = "#403037"   # ~coral 16% on surface (active tab)
HOVER     = "#353b48"   # neutral button hover


# ─────────────────────────────────────────────────────────────────────────────
#  Small helpers — ports, .env, config files
# ─────────────────────────────────────────────────────────────────────────────
def ts() -> str:
    return datetime.now().strftime("%H:%M:%S")


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


def url_reachable(url: str, timeout: float = 2.0) -> bool:
    """True if *something* is listening at the URL's host:port (TCP connect)."""
    try:
        u = urlparse(url if "://" in url else "http://" + url)
        host = u.hostname or "127.0.0.1"
        port = u.port or (443 if u.scheme == "https" else 80)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            return s.connect_ex((host, port)) == 0
    except Exception:
        return False


def kill_port(port: int) -> None:
    """Kill whatever process is listening on the given port."""
    try:
        if IS_WIN:
            result = subprocess.run(["netstat", "-aon"], capture_output=True,
                                    text=True, timeout=5)
            for line in result.stdout.splitlines():
                if f":{port} " in line and "LISTENING" in line:
                    pid = line.split()[-1]
                    if pid and pid != "0":
                        subprocess.run(["taskkill", "/F", "/PID", pid],
                                       capture_output=True, timeout=5)
        else:
            r = subprocess.run(["lsof", "-ti", f"tcp:{port}"], capture_output=True,
                               text=True, timeout=5)
            for pid in r.stdout.split():
                subprocess.run(["kill", "-9", pid], capture_output=True, timeout=5)
    except Exception:
        pass


def kill_proc_tree(proc: "subprocess.Popen") -> None:
    """Terminate a process and its child tree (uvicorn may spawn children)."""
    if proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            if IS_WIN:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                               capture_output=True, timeout=5,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            else:
                proc.kill()
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


# ── .env read / write (preserves comments + unrelated keys) ───────────────────
def _read_env_text() -> str:
    try:
        with open(ENV_PATH, "r", encoding="utf-8-sig") as f:
            return f.read()
    except OSError:
        return ""


def env_get(key: str, default: str = "") -> str:
    """Read a single uncommented KEY=value from .env (quotes stripped)."""
    pat = re.compile(r"^\s*" + re.escape(key) + r"\s*=(.*)$", re.M)
    m = pat.search(_read_env_text())
    if not m:
        return default
    return m.group(1).strip().strip('"').strip("'") or default


def env_set(updates: dict) -> None:
    """Set each KEY=value in .env, replacing the existing line or appending.
    Comment lines (#...) and every other key are left untouched."""
    lines = _read_env_text().splitlines()
    done = set()
    for i, line in enumerate(lines):
        m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if m and m.group(1) in updates:
            lines[i] = f"{m.group(1)}={updates[m.group(1)]}"
            done.add(m.group(1))
    for k, v in updates.items():
        if k not in done:
            lines.append(f"{k}={v}")
    tmp = ENV_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, ENV_PATH)


# ── launcher-config.json (custom servers + folders) ───────────────────────────
def load_config() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            d = json.load(f)
            if isinstance(d, dict):
                return d
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def save_config(cfg: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, CONFIG_PATH)


# ── Python / Ollama resolution ────────────────────────────────────────────────
def system_python() -> list[str] | None:
    """Find a Python 3.11+ to *build* the venv with (mirrors launch-windows.ps1).
    Returns a command prefix list (e.g. ['py', '-3.12'] or ['/usr/bin/python3'])."""
    def _ver_ok(cmd: list[str]) -> bool:
        try:
            r = subprocess.run(cmd + ["-c", "import sys;print('%d.%d' % sys.version_info[:2])"],
                               capture_output=True, text=True, timeout=5,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if r.returncode != 0:
                return False
            major, _, minor = r.stdout.strip().partition(".")
            return (int(major) == 3 and int(minor) >= 11) or int(major) > 3
        except Exception:
            return False

    if shutil.which("py"):
        for v in ("-3.13", "-3.12", "-3.11"):
            if _ver_ok(["py", v]):
                return ["py", v]
    for name in ("python3.13", "python3.12", "python3.11", "python3", "python"):
        path = shutil.which(name)
        if path and _ver_ok([path]):
            return [path]
    return None


def resolve_ollama() -> str | None:
    """Return the path to the ollama binary, or None if it isn't installed."""
    p = shutil.which("ollama")
    if p:
        return p
    if IS_WIN and os.path.isfile(_OLLAMA_DEFAULT_EXE):
        return _OLLAMA_DEFAULT_EXE
    return None


# ─────────────────────────────────────────────────────────────────────────────
#  Main application window
# ─────────────────────────────────────────────────────────────────────────────
class TrendVaultAILauncher(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("TrendVault AI Launcher")
        self.configure(bg=BG)
        self.minsize(960, 680)
        self.geometry("1040x720")

        # State
        self._cfg     = load_config()
        self._host    = env_get("APP_BIND", env_get("TRENDVAULT_AI_HOST", DEFAULT_HOST))
        self._port    = self._read_port()
        self._folders = [p for p in (self._cfg.get("folders") or []) if p]
        self._proc: subprocess.Popen | None = None
        self._lock    = threading.Lock()
        self._running = False
        self._setting_up = False
        self._auto_opened = False
        self._server_rows: list[dict] = []

        self._pick_fonts()
        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self._poll()
        self.after(400, self._initial_check)

    def _read_port(self) -> int:
        try:
            return int(env_get("APP_PORT", env_get("TRENDVAULT_AI_PORT", str(DEFAULT_PORT))))
        except ValueError:
            return DEFAULT_PORT

    # ── URLs ──────────────────────────────────────────────────────────────────
    def _browse_host(self) -> str:
        # The bind host may be 0.0.0.0 (all interfaces); browse to loopback.
        return "127.0.0.1" if self._host in ("0.0.0.0", "::", "") else self._host

    def _app_url(self) -> str:
        return f"http://{self._browse_host()}:{self._port}"

    def _app_http_ok(self, timeout: float = 2.0) -> tuple[bool, str]:
        """Confirm the server is actually answering (not just the port being open)."""
        base = self._app_url()
        for path in ("/login.html", "/", "/static/login.html"):
            try:
                with urllib.request.urlopen(base + path, timeout=timeout) as r:
                    if 200 <= r.status < 500:
                        return True, base
            except Exception:
                continue
        return False, base

    # ── Fonts (prefer Fira Code like the web theme, fall back to Consolas) ────
    def _pick_fonts(self):
        fams = set(tkfont.families())
        mono = next((f for f in ("Fira Code", "Cascadia Code", "Consolas",
                                 "Courier New") if f in fams), "Courier New")
        self.F_MONO   = (mono, 10)
        self.F_SMALL  = (mono, 9)
        self.F_TINY   = (mono, 8)
        self.F_BOLD   = (mono, 10, "bold")
        self.F_HEAD   = (mono, 11, "bold")
        self.F_WORD   = (mono, 17, "bold")
        self.F_DOT    = (mono, 13)

    # ── UI construction ───────────────────────────────────────────────────────
    def _build_ui(self):
        # Header
        hdr = tk.Frame(self, bg=BG)
        hdr.pack(fill="x", padx=22, pady=(16, 10))
        tk.Label(hdr, text="Trend", bg=BG, fg=TEXT, font=self.F_WORD).pack(side="left")
        tk.Label(hdr, text="Vault", bg=BG, fg=ACCENT, font=self.F_WORD).pack(side="left")
        tk.Label(hdr, text=" AI", bg=BG, fg=GOLD, font=self.F_WORD).pack(side="left")
        tk.Label(hdr, text="LAUNCHER", bg=BG, fg=MUTED, font=self.F_TINY).pack(
            side="left", padx=(10, 0), pady=(8, 0))
        self._status_var = tk.StringVar(value="Ready")
        tk.Label(hdr, textvariable=self._status_var, bg=BG, fg=MUTED,
                 font=self.F_SMALL).pack(side="right")

        tk.Frame(self, bg=BORDER, height=1).pack(fill="x")

        # Body: left tab rail + content
        body = tk.Frame(self, bg=BG)
        body.pack(fill="both", expand=True)

        rail = tk.Frame(body, bg=SURFACE3, width=168)
        rail.pack(side="left", fill="y")
        rail.pack_propagate(False)
        tk.Frame(body, bg=BORDER, width=1).pack(side="left", fill="y")

        content = tk.Frame(body, bg=BG)
        content.pack(side="left", fill="both", expand=True)

        # Tabs
        self._tabs: dict[str, tk.Button] = {}
        self._panels: dict[str, tk.Frame] = {}
        tk.Label(rail, text="  MENU", bg=SURFACE3, fg=MUTED, font=self.F_TINY,
                 anchor="w").pack(fill="x", pady=(14, 6))
        for key, label, glyph in (("launch", "Launch", "▶"),
                                   ("settings", "Settings", "⚙"),
                                   ("about", "About", "ⓘ")):
            self._tabs[key] = self._make_tab(rail, key, label, glyph)

        # Panels
        self._panels["launch"]   = self._build_launch_panel(content)
        self._panels["settings"] = self._build_settings_panel(content)
        self._panels["about"]    = self._build_about_panel(content)

        self._select_tab("launch")

    def _make_tab(self, parent, key, label, glyph) -> tk.Button:
        b = tk.Button(parent, text="  " + glyph + "   " + label, anchor="w",
                      bg=SURFACE3, fg=TEXT2, activebackground=TINT2,
                      activeforeground=TEXT, font=self.F_BOLD, bd=0,
                      relief="flat", padx=14, pady=10, cursor="hand2",
                      command=lambda k=key: self._select_tab(k))
        b.pack(fill="x", padx=8, pady=2)
        b.bind("<Enter>", lambda e, w=b: w.configure(bg=HOVER)
               if self._active_tab != key else None)
        b.bind("<Leave>", lambda e, w=b, k=key: w.configure(
            bg=TINT2 if self._active_tab == k else SURFACE3))
        return b

    _active_tab = None

    def _select_tab(self, key):
        self._active_tab = key
        for k, b in self._tabs.items():
            on = (k == key)
            b.configure(bg=TINT2 if on else SURFACE3, fg=TEXT if on else TEXT2)
        for k, p in self._panels.items():
            p.pack_forget()
            if k == key:
                p.pack(fill="both", expand=True)

    # ── LAUNCH panel ──────────────────────────────────────────────────────────
    def _build_launch_panel(self, parent) -> tk.Frame:
        p = tk.Frame(parent, bg=BG)

        self._section(p, "WEB UI")
        card = self._card(p)

        top = tk.Frame(card, bg=SURFACE2)
        top.pack(fill="x")
        self._dot = tk.Label(top, text="○", bg=SURFACE2, fg=MUTED, font=self.F_DOT)
        self._dot.pack(side="left", padx=(0, 10))
        info = tk.Frame(top, bg=SURFACE2)
        info.pack(side="left", fill="x", expand=True)
        tk.Label(info, text="TrendVault AI", bg=SURFACE2, fg=TEXT,
                 font=self.F_BOLD, anchor="w").pack(anchor="w")
        self._svc_desc = tk.StringVar()
        tk.Label(info, textvariable=self._svc_desc, bg=SURFACE2, fg=MUTED,
                 font=self.F_TINY, anchor="w").pack(anchor="w")

        btns = tk.Frame(card, bg=SURFACE2)
        btns.pack(fill="x", pady=(14, 0))
        self._btn(btns, "▶  Start", self._start, kind="go").pack(side="left", padx=(0, 7))
        self._btn(btns, "■  Stop", self._stop, kind="stop").pack(side="left", padx=(0, 7))
        self._btn(btns, "🌐  Open App", self._open_app, kind="accent").pack(side="left", padx=(0, 7))
        self._btn(btns, "⚙  Setup deps", self._setup_deps).pack(side="left")

        # Console
        chdr = tk.Frame(p, bg=BG)
        chdr.pack(fill="x", padx=20, pady=(16, 4))
        tk.Label(chdr, text="CONSOLE", bg=BG, fg=ACCENT, font=self.F_TINY).pack(side="left")
        self._btn(chdr, "clear", self._clear_log, small=True).pack(side="right")
        self._btn(chdr, "⬡  health", self._health, small=True).pack(side="right", padx=(0, 6))

        wrap = tk.Frame(p, bg=BORDER)
        wrap.pack(fill="both", expand=True, padx=20, pady=(0, 18))
        self._console = tk.Text(wrap, bg=SURFACE3, fg=TEXT2, font=self.F_SMALL,
                                bd=0, relief="flat", wrap="word", state="disabled",
                                padx=12, pady=10, insertbackground=TEXT,
                                selectbackground=TINT)
        self._console.pack(fill="both", expand=True, padx=1, pady=1)

        self._refresh_desc()
        return p

    # ── SETTINGS panel ────────────────────────────────────────────────────────
    def _build_settings_panel(self, parent) -> tk.Frame:
        p = tk.Frame(parent, bg=BG)

        # Scrollable body (settings can grow with many rows).
        canvas = tk.Canvas(p, bg=BG, bd=0, highlightthickness=0)
        sb = tk.Scrollbar(p, orient="vertical", command=canvas.yview)
        inner = tk.Frame(canvas, bg=BG)
        inner.bind("<Configure>",
                   lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        win = canvas.create_window((0, 0), window=inner, anchor="nw")
        canvas.bind("<Configure>", lambda e: canvas.itemconfig(win, width=e.width))
        canvas.configure(yscrollcommand=sb.set)
        canvas.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        # Mouse wheel scrolling while hovering the settings tab.
        canvas.bind_all("<MouseWheel>",
                        lambda e: canvas.yview_scroll(int(-e.delta / 120), "units")
                        if self._active_tab == "settings" else None)

        # ── External servers ──
        self._section(inner, "EXTERNAL SERVERS")
        card = self._card(inner)
        tk.Label(card, text="Links the app connects to (local or remote). Known\n"
                            "endpoints are written to .env so the web app uses them on\n"
                            "its next start. Add your own as bookmarks.",
                 bg=SURFACE2, fg=MUTED, font=self.F_TINY, justify="left").pack(anchor="w")
        self._servers_box = tk.Frame(card, bg=SURFACE2)
        self._servers_box.pack(fill="x", pady=(12, 0))
        row = tk.Frame(card, bg=SURFACE2)
        row.pack(fill="x", pady=(12, 0))
        self._btn(row, "+  Add server", self._add_server).pack(side="left")
        self._btn(row, "💾  Save & apply", self._save_servers, kind="accent").pack(side="left", padx=(7, 0))

        # ── Folders ──
        self._section(inner, "FOLDERS")
        fcard = self._card(inner)
        tk.Label(fcard, text="Bookmarked folders — open them from here in one click.",
                 bg=SURFACE2, fg=MUTED, font=self.F_TINY, justify="left").pack(anchor="w")
        self._folders_box = tk.Frame(fcard, bg=SURFACE2)
        self._folders_box.pack(fill="x", pady=(12, 0))
        self._btn(fcard, "+  Add folder", self._add_folder).pack(anchor="w", pady=(12, 0))

        # ── Web UI host + port ──
        self._section(inner, "WEB UI ADDRESS")
        pcard = self._card(inner)
        tk.Label(pcard, text="Where the web UI binds. Keep the host on 127.0.0.1 unless\n"
                             "you want other devices on your LAN to reach it (0.0.0.0).",
                 bg=SURFACE2, fg=MUTED, font=self.F_TINY, justify="left").pack(anchor="w")
        prow = tk.Frame(pcard, bg=SURFACE2)
        prow.pack(fill="x", pady=(12, 0))
        tk.Label(prow, text="Host", bg=SURFACE2, fg=TEXT2, font=self.F_SMALL).pack(side="left", padx=(0, 8))
        self._host_var = tk.StringVar(value=self._host)
        self._entry(prow, self._host_var, width=16).pack(side="left", padx=(0, 16))
        tk.Label(prow, text="Port", bg=SURFACE2, fg=TEXT2, font=self.F_SMALL).pack(side="left", padx=(0, 8))
        self._port_var = tk.StringVar(value=str(self._port))
        self._entry(prow, self._port_var, width=8).pack(side="left")
        self._btn(prow, "Save", self._save_address).pack(side="left", padx=(10, 0))

        self._render_servers()
        self._render_folders()
        return p

    def _build_about_panel(self, parent) -> tk.Frame:
        p = tk.Frame(parent, bg=BG)
        self._section(p, "ABOUT")
        card = self._card(p)
        tk.Label(card, text="TrendVault AI Launcher", bg=SURFACE2, fg=ACCENT,
                 font=self.F_HEAD).pack(anchor="w")
        tk.Label(card, text="Sets up and starts the self-hosted TrendVault AI web UI.\n"
                            "Configure the servers it talks to in the Settings tab.",
                 bg=SURFACE2, fg=MUTED, font=self.F_TINY, justify="left").pack(anchor="w", pady=(6, 12))
        for k, v in (("Web app", "FastAPI + uvicorn  •  app:app"),
                     ("Setup", "venv → pip install → setup.py"),
                     ("LLM", "Ollama / LM Studio / OpenAI-compatible (local)"),
                     ("Project", ROOT)):
            r = tk.Frame(card, bg=SURFACE2)
            r.pack(fill="x", pady=3)
            tk.Label(r, text=k, bg=SURFACE2, fg=MUTED, font=self.F_TINY, width=10,
                     anchor="w").pack(side="left")
            tk.Label(r, text=v, bg=SURFACE2, fg=TEXT2, font=self.F_TINY,
                     anchor="w").pack(side="left")
        return p

    # ── Reusable styled widgets ───────────────────────────────────────────────
    def _section(self, parent, text):
        tk.Label(parent, text=text, bg=BG, fg=MUTED, font=self.F_TINY,
                 anchor="w").pack(fill="x", padx=22, pady=(16, 6))

    def _card(self, parent) -> tk.Frame:
        outer = tk.Frame(parent, bg=BORDER)
        outer.pack(fill="x", padx=20)
        card = tk.Frame(outer, bg=SURFACE2, padx=16, pady=14)
        card.pack(fill="x", padx=1, pady=1)
        return card

    def _btn(self, parent, text, cmd, kind="default", small=False):
        fg = {"go": GREEN, "stop": RED, "accent": ACCENT}.get(kind, TEXT2)
        bg = SURFACE3 if not small else BG
        b = tk.Button(parent, text=text, command=cmd, bg=bg, fg=fg,
                      activebackground=TINT, activeforeground=TEXT,
                      font=self.F_TINY if small else self.F_SMALL, bd=0,
                      relief="flat", padx=(8 if small else 13), pady=(4 if small else 7),
                      cursor="hand2", highlightthickness=0)
        b.bind("<Enter>", lambda e, w=b: w.configure(bg=TINT, fg=TEXT))
        b.bind("<Leave>", lambda e, w=b, c=bg, f=fg: w.configure(bg=c, fg=f))
        return b

    def _entry(self, parent, var, width=None):
        return tk.Entry(parent, textvariable=var, bg=SURFACE3, fg=TEXT,
                        insertbackground=TEXT, relief="flat", bd=0,
                        highlightthickness=1, highlightbackground=BORDER,
                        highlightcolor=ACCENT, font=self.F_SMALL,
                        width=width or 0)

    # ── Settings: external servers ────────────────────────────────────────────
    def _render_servers(self):
        for w in self._servers_box.winfo_children():
            w.destroy()
        self._server_rows = []

        # Builtin endpoints first (fixed label, editable URL), then custom rows.
        def add_row(label, url, env_key, builtin):
            row = tk.Frame(self._servers_box, bg=SURFACE2)
            row.pack(fill="x", pady=4)
            url_var = tk.StringVar(value=url)
            entry = {"env": env_key, "builtin": builtin, "url_var": url_var,
                     "frame": row, "label_var": None}
            if builtin:
                tk.Label(row, text=label, bg=SURFACE2, fg=TEXT2, font=self.F_TINY,
                         width=26, anchor="w").pack(side="left")
            else:
                lbl_var = tk.StringVar(value=label)
                entry["label_var"] = lbl_var
                e = self._entry(row, lbl_var)
                e.configure(width=22)
                e.pack(side="left", padx=(0, 6))
            self._entry(row, url_var).pack(side="left", fill="x", expand=True, padx=(0, 6), ipady=2)
            self._btn(row, "Test", lambda u=url_var, l=label: self._test_server(u, l),
                      small=True).pack(side="left")
            if not builtin:
                self._btn(row, "✕", lambda en=entry: self._remove_server(en),
                          small=True, kind="stop").pack(side="left", padx=(4, 0))
            self._server_rows.append(entry)

        for label, env_key, default in BUILTIN_SERVERS:
            add_row(label, env_get(env_key) or default, env_key, True)
        for s in (self._cfg.get("servers") or []):
            add_row(s.get("label", ""), s.get("url", ""), None, False)

    def _add_server(self):
        self._cfg.setdefault("servers", []).append({"label": "New server", "url": "http://"})
        self._render_servers()

    def _remove_server(self, entry):
        # Rebuild the custom list from the current rows, dropping this one.
        self._cfg["servers"] = [
            {"label": r["label_var"].get().strip(), "url": r["url_var"].get().strip()}
            for r in self._server_rows
            if not r["builtin"] and r is not entry and r["url_var"].get().strip()
        ]
        save_config(self._cfg)
        self._render_servers()

    def _test_server(self, url_var, label):
        url = url_var.get().strip()
        if not url:
            return
        def _do():
            ok = url_reachable(url)
            self._log(("✓ " if ok else "✗ ") + label.strip() + " — " +
                      ("reachable" if ok else "no response") + " at " + url,
                      GREEN if ok else RED)
        threading.Thread(target=_do, daemon=True).start()

    def _save_servers(self):
        updates, custom = {}, []
        for r in self._server_rows:
            url = r["url_var"].get().strip()
            if r["builtin"]:
                if url:
                    updates[r["env"]] = url
            elif url:
                custom.append({"label": (r["label_var"].get().strip() or url), "url": url})
        try:
            if updates:
                env_set(updates)
            self._cfg["servers"] = custom
            save_config(self._cfg)
        except Exception as e:
            messagebox.showerror("Save failed", str(e))
            return
        self._log("External servers saved to .env", GREEN)
        if self._running:
            self._log("Restart the Web UI to apply the new server URLs.", GOLD)

    # ── Settings: folders ─────────────────────────────────────────────────────
    def _render_folders(self):
        for w in self._folders_box.winfo_children():
            w.destroy()
        if not self._folders:
            tk.Label(self._folders_box, text="No folders yet.", bg=SURFACE2,
                     fg=MUTED, font=self.F_TINY).pack(anchor="w")
            return
        for path in list(self._folders):
            row = tk.Frame(self._folders_box, bg=SURFACE2)
            row.pack(fill="x", pady=3)
            exists = os.path.isdir(path)
            tk.Label(row, text=("📁 " if exists else "⚠ ") + path, bg=SURFACE2,
                     fg=TEXT2 if exists else GOLD, font=self.F_TINY, anchor="w").pack(
                side="left", fill="x", expand=True)
            self._btn(row, "Open", lambda p=path: self._open_folder(p), small=True).pack(side="left", padx=(6, 0))
            self._btn(row, "✕", lambda p=path: self._remove_folder(p), small=True, kind="stop").pack(side="left", padx=(4, 0))

    def _add_folder(self):
        path = filedialog.askdirectory(title="Add a folder", initialdir=ROOT)
        if not path:
            return
        path = os.path.normpath(path)
        if path not in self._folders:
            self._folders.append(path)
            self._cfg["folders"] = self._folders
            save_config(self._cfg)
            self._render_folders()

    def _open_folder(self, path):
        if not os.path.isdir(path):
            messagebox.showwarning("Folder missing", "This folder no longer exists:\n" + path)
            return
        try:
            if IS_WIN:
                os.startfile(path)  # noqa: S606 — Windows
            else:
                subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", path])
        except Exception as e:
            self._log("Could not open folder: " + str(e), RED)

    def _remove_folder(self, path):
        self._folders = [p for p in self._folders if p != path]
        self._cfg["folders"] = self._folders
        save_config(self._cfg)
        self._render_folders()

    def _save_address(self):
        host = self._host_var.get().strip() or DEFAULT_HOST
        try:
            port = int(self._port_var.get().strip())
            if not (1 <= port <= 65535):
                raise ValueError
        except ValueError:
            messagebox.showerror("Invalid port", "Enter a port between 1 and 65535.")
            return
        self._host, self._port = host, port
        try:
            env_set({"APP_BIND": host, "APP_PORT": str(port)})
        except Exception as e:
            messagebox.showerror("Save failed", str(e))
            return
        self._refresh_desc()
        self._log(f"Web UI address set to {host}:{port}. Restart the Web UI to apply.", GOLD)

    # ── Logging / status ──────────────────────────────────────────────────────
    def _log(self, msg, color=TEXT2):
        self.after(0, lambda: self._log_widget_insert(msg, color))

    def _log_widget_insert(self, msg, color):
        self._console.configure(state="normal")
        tag = "c" + color.lstrip("#")
        self._console.tag_configure(tag, foreground=color)
        self._console.insert("end", f"[{ts()}]  {msg}\n", tag)
        self._console.see("end")
        self._console.configure(state="disabled")

    def _clear_log(self):
        self._console.configure(state="normal")
        self._console.delete("1.0", "end")
        self._console.configure(state="disabled")

    def _set_status(self, msg):
        self.after(0, lambda: self._status_var.set(msg))

    def _refresh_desc(self):
        self._svc_desc.set(f"FastAPI workspace  •  {self._app_url()}")

    # ── Status polling ────────────────────────────────────────────────────────
    def _poll(self):
        up = port_in_use(self._port)
        if up != self._running:
            self._running = up
            self._dot.configure(fg=GREEN if up else MUTED, text="●" if up else "○")
            self._set_status("Web UI online" if up else "Ready")
        self.after(2000, self._poll)

    def _initial_check(self):
        self._log("TrendVault AI Launcher ready.", ACCENT)
        self._log("App URL: " + self._app_url(), MUTED)
        if not os.path.isfile(VENV_PY):
            self._log("Project venv not found — click 'Setup deps' for first-time setup.", GOLD)
        elif not os.path.isfile(ENV_PATH):
            self._log(".env not found — click 'Setup deps' to run first-time setup.", GOLD)
        if resolve_ollama():
            self._log("Ollama detected: " + resolve_ollama(), GREEN)
        else:
            self._log("Ollama not detected (optional — set its URL in Settings or install it).", MUTED)

    # ── Dependency / first-time setup ─────────────────────────────────────────
    def _deps_ready(self) -> bool:
        if not os.path.isfile(VENV_PY) or not os.path.isfile(ENV_PATH):
            return False
        try:
            r = subprocess.run([VENV_PY, "-c", "import uvicorn, fastapi"],
                               capture_output=True, timeout=15,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            return r.returncode == 0
        except Exception:
            return False

    def _ensure_deps(self) -> bool:
        """Start gate: True when the app is ready to launch, else run full setup."""
        if self._deps_ready():
            return True
        return self._full_setup()

    def _full_setup(self) -> bool:
        """Create the venv, install requirements, run setup.py. Idempotent —
        safe to re-run; skips whatever already exists."""
        if self._setting_up:
            self._log("Setup already in progress…", GOLD)
            return False
        self._setting_up = True
        try:
            self._log("─── Setup ───", ACCENT)
            self._set_status("Setting up…")

            # 1 — venv
            if not os.path.isfile(VENV_PY):
                syspy = system_python()
                if not syspy:
                    self._log("Python 3.11+ not found. Install it from python.org.", RED)
                    return False
                self._log("Creating virtual environment (./venv)…", TEXT)
                if not self._run_stream(syspy + ["-m", "venv", os.path.join(ROOT, "venv")], "venv"):
                    self._log("Failed to create the virtual environment.", RED)
                    return False
            else:
                self._log("venv already exists — reusing it.", MUTED)

            # 2 — python deps
            self._log("Upgrading pip…", TEXT)
            self._run_stream([VENV_PY, "-m", "pip", "install", "--upgrade", "pip"], "pip")
            self._log("Installing dependencies (first run can take a few minutes)…", TEXT)
            if not self._run_stream([VENV_PY, "-m", "pip", "install", "-r", REQUIREMENTS], "pip"):
                self._log("Dependency install failed — scroll up for the pip error.", RED)
                return False

            # 3 — first-time setup (data dirs, DB, .env, admin user)
            if os.path.isfile(SETUP_PY):
                self._log("Running first-time setup (setup.py)…", TEXT)
                # SKIP_ADMIN_PROMPT stops setup.py blocking on getpass(); it then
                # generates and PRINTS a temporary admin password we surface.
                env = {**os.environ, "TRENDVAULT_AI_SKIP_ADMIN_PROMPT": "1",
                       "PYTHONUNBUFFERED": "1"}
                if not self._run_stream([VENV_PY, SETUP_PY], "setup", env=env):
                    self._log("setup.py reported an error — see above.", RED)
                    return False
            self._log("Setup complete. Click ▶ Start.", GREEN)
            return True
        finally:
            self._setting_up = False
            self._set_status("Ready")
            self._log("─── End ───", ACCENT)

    def _setup_deps(self):
        threading.Thread(target=self._full_setup, daemon=True).start()

    def _run_stream(self, cmd, label, env=None) -> bool:
        """Run a build command, streaming its output to the console. True on exit 0."""
        try:
            proc = subprocess.Popen(
                cmd, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, encoding="utf-8", errors="replace",
                bufsize=1, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            for raw in proc.stdout:
                line = raw.rstrip()
                if line:
                    self._log(f"[{label}] {line}", self._line_color(line))
            proc.wait()
            return proc.returncode == 0
        except FileNotFoundError as e:
            self._log(f"[{label}] command not runnable: {e}", RED)
            return False
        except Exception as e:
            self._log(f"[{label}] error: {e}", RED)
            return False

    @staticmethod
    def _line_color(line: str) -> str:
        lo = line.lower()
        if "password" in lo or "admin account" in lo or "admin user" in lo:
            return GOLD          # surface the generated admin credentials
        if any(w in lo for w in ("error", "traceback", "failed", "fatal")):
            return RED
        if any(w in lo for w in ("warning", "deprecat")):
            return GOLD
        if any(w in lo for w in ("ready", "started", "running", "listening",
                                 "complete", "created", "[ok]", "successfully installed",
                                 "up to date", "success")):
            return GREEN
        return TEXT2

    # ── Web UI start / stop ───────────────────────────────────────────────────
    def _webapp_cmd(self) -> list[str]:
        py = VENV_PY if os.path.isfile(VENV_PY) else sys.executable
        return [py, "-m", "uvicorn", "app:app", "--host", self._host,
                "--port", str(self._port)]

    def _start(self):
        if port_in_use(self._port):
            self._log(f"Web UI already running on :{self._port}.", GOLD)
            return
        with self._lock:
            if self._proc is not None:
                self._log("Web UI is already starting.", GOLD)
                return

        def _do():
            self._set_status("Preparing…")
            if not self._ensure_deps():
                self._set_status("Setup failed")
                return
            self._launch()
        threading.Thread(target=_do, daemon=True).start()

    def _launch(self):
        self._log(f"Starting Web UI on {self._host}:{self._port}…", TEXT)
        self._set_status("Starting Web UI…")
        try:
            flags = 0
            if IS_WIN:
                flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
            proc = subprocess.Popen(
                self._webapp_cmd(), cwd=ROOT, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, encoding="utf-8", errors="replace",
                bufsize=1, creationflags=flags)
            with self._lock:
                self._proc = proc
            self._auto_opened = False
            threading.Thread(target=self._wait_online, daemon=True).start()
            for raw in proc.stdout:
                line = raw.rstrip()
                if line:
                    self._log(f"[web] {line}", self._line_color(line))
            proc.wait()
            self._log(f"Web UI exited (code {proc.returncode}).",
                      GOLD if proc.returncode else MUTED)
        except Exception as e:
            self._log("Failed to start Web UI: " + str(e), RED)
        finally:
            with self._lock:
                self._proc = None
            self._set_status("Ready")

    def _wait_online(self):
        """Poll the app until it answers, announce it, and open the browser once."""
        for _ in range(60):
            time.sleep(1)
            with self._lock:
                alive = self._proc is not None
            if not alive:
                return
            ok, _info = self._app_http_ok(timeout=2.0)
            if ok:
                self._log("TrendVault AI is live at " + self._app_url(), GREEN)
                if not self._auto_opened:
                    self._auto_opened = True
                    webbrowser.open(self._app_url())
                return

    def _stop(self):
        def _do():
            self._log("Stopping Web UI…", GOLD)
            with self._lock:
                proc = self._proc
            if proc:
                kill_proc_tree(proc)
            kill_port(self._port)
            self._log("Web UI stopped.", MUTED)
        threading.Thread(target=_do, daemon=True).start()

    def _open_app(self):
        if not port_in_use(self._port):
            self._log(f"Web UI is not running on :{self._port} — start it first.", GOLD)
            return
        webbrowser.open(self._app_url())
        self._log("Opening " + self._app_url(), ACCENT)

    # ── Health check ──────────────────────────────────────────────────────────
    def _health(self):
        def _check():
            self._log("─── Health Check ───", ACCENT)
            port_up = port_in_use(self._port)
            if port_up:
                ok, info = self._app_http_ok()
                status = f"RUNNING (HTTP OK @ {info})" if ok else \
                         f"PORT BUSY but no HTTP response from {info}"
                self._log("TrendVault AI".ljust(18) + f":{self._port}  " + status,
                          GREEN if ok else GOLD)
            else:
                self._log("TrendVault AI".ljust(18) + f":{self._port}  STOPPED", RED)

            # External servers (TCP reachability of whatever .env points at).
            for label, env_key, default in BUILTIN_SERVERS:
                url = env_get(env_key) or default
                up = url_reachable(url)
                self._log(label.strip().ljust(18) + "  " +
                          ("reachable" if up else "no response") + "  " + url,
                          GREEN if up else MUTED)

            syspy = system_python()
            self._log("System Python".ljust(18) + "  " +
                      (" ".join(syspy) if syspy else "MISSING — install Python 3.11+"),
                      TEXT2 if syspy else RED)
            for label, path in (("venv", VENV_PY), (".env", ENV_PATH),
                                ("data/", DATA_DIR), ("requirements", REQUIREMENTS),
                                ("app.py", os.path.join(ROOT, "app.py"))):
                exists = os.path.exists(path)
                self._log(label.ljust(18) + "  " + ("OK" if exists else "MISSING"),
                          TEXT2 if exists else GOLD)
            ollama = resolve_ollama()
            self._log("Ollama binary".ljust(18) + "  " +
                      (ollama if ollama else "not installed (optional)"),
                      TEXT2 if ollama else MUTED)
            self._log("─── End ───", ACCENT)
        threading.Thread(target=_check, daemon=True).start()

    # ── Shutdown ──────────────────────────────────────────────────────────────
    def _on_close(self):
        with self._lock:
            running = self._proc is not None or port_in_use(self._port)
        if running and not messagebox.askyesno(
                "Quit launcher?",
                "The Web UI is running. Stop it and quit the launcher?"):
            return
        with self._lock:
            proc = self._proc
        if proc:
            kill_proc_tree(proc)
        kill_port(self._port)
        self.destroy()


if __name__ == "__main__":
    TrendVaultAILauncher().mainloop()
