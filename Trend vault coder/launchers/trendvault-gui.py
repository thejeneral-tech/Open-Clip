#!/usr/bin/env python3
"""TrendVault Coder GUI launcher.

A small desktop window that:
  - starts/stops the web UI server (`npm run web`),
  - shows live status + a tail of the server log,
  - launches the bundled Claude Code CLI in a new terminal window
    (with the chosen provider).

Cross-platform — Windows, macOS, Linux (incl. WSL).

Built with CustomTkinter. The package is auto-installed on first run.
On Linux you must also have the system Tk bindings (`python3-tk` /
`python3-tkinter` / `tk`); we surface a friendly message if not.

Usage:
    python launchers/trendvault-gui.py
    python launchers/trendvault-gui.py --port 7879
"""

from __future__ import annotations

import platform
import subprocess
import sys


# ---------- dependency bootstrap ----------------------------------------

def _check_tkinter_present() -> None:
    """tkinter ships with Python on Windows/macOS but is a separate package on Linux."""
    try:
        import tkinter  # noqa: F401
        return
    except ImportError:
        pass
    print("error: tkinter (Python's GUI toolkit) is required but not installed.", file=sys.stderr)
    print(file=sys.stderr)
    if platform.system() == "Linux":
        print("Install the system package for your distro:", file=sys.stderr)
        print("  Debian / Ubuntu:  sudo apt install python3-tk", file=sys.stderr)
        print("  Fedora / RHEL:    sudo dnf install python3-tkinter", file=sys.stderr)
        print("  Arch:             sudo pacman -S tk", file=sys.stderr)
    elif platform.system() == "Darwin":
        print("Reinstall Python from python.org — Apple's system Python lacks Tk.", file=sys.stderr)
    else:
        print("Reinstall Python from python.org and select the 'tcl/tk' option.", file=sys.stderr)
    sys.exit(1)


def _pip_install(pkg: str) -> bool:
    """Install `pkg`, with fallbacks for PEP 668 (Ubuntu 23.04+, Debian 12+, Fedora 38+).

    Modern distros refuse system-wide pip installs. We try the plain invocation
    first, then `--user`, then `--user --break-system-packages` so the launcher
    actually starts on a fresh box.
    """
    base = [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check"]
    for extra in ([], ["--user"], ["--user", "--break-system-packages"]):
        try:
            rc = subprocess.run(base + extra + [pkg]).returncode
        except OSError:
            return False
        if rc == 0:
            return True
    return False


def _ensure_pip_package(pkg: str, import_name: str | None = None) -> None:
    name = import_name or pkg
    try:
        __import__(name)
        return
    except ImportError:
        pass
    print(f"Installing '{pkg}' for the launcher UI (one-time)…")
    if _pip_install(pkg):
        return
    print(f"error: failed to install '{pkg}'.", file=sys.stderr)
    print(file=sys.stderr)
    if platform.system() == "Linux":
        print("Your Python likely blocks system-wide pip installs (PEP 668).", file=sys.stderr)
        print("Create a venv and re-run from inside it:", file=sys.stderr)
        print("  python3 -m venv .venv && source .venv/bin/activate", file=sys.stderr)
        print(f"  python -m pip install {pkg}", file=sys.stderr)
    else:
        print(f"Run manually: python -m pip install {pkg}", file=sys.stderr)
    sys.exit(1)


_check_tkinter_present()
_ensure_pip_package("customtkinter")


import argparse
import collections
import os
import shutil
import signal
import socket
import threading
import time
import webbrowser
from pathlib import Path
from typing import Deque, List, Optional

import customtkinter as ctk


# ---------- constants ----------------------------------------------------

DEFAULT_PORT = 7878
HOST = "127.0.0.1"
POLL_INTERVAL_MS = 800        # how often to refresh server-status + flush log
LOG_BUFFER_LINES = 600        # cap on the in-memory log tail

# Colour tokens that line up with the existing TrendVault dark UI.
COLOR_BG          = "#1a1a1a"
COLOR_PANEL       = "#222222"
COLOR_PANEL_DEEP  = "#181818"
COLOR_BORDER      = "#2a2a2a"
COLOR_BUTTON      = "#333333"
COLOR_BUTTON_HVR  = "#3d3d3d"
COLOR_ACCENT      = "#d97757"
COLOR_ACCENT_HVR  = "#c2654a"
COLOR_TEXT        = "#e8e8e8"
COLOR_TEXT_DIM    = "#888888"
COLOR_OK          = "#7ec078"
COLOR_ERR         = "#e15d5d"


# ---------- helpers ------------------------------------------------------

def find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in (here, *here.parents):
        if (candidate / "package.json").is_file():
            return candidate
    sys.exit("error: package.json not found in any parent directory")


def find_npm() -> Optional[str]:
    return shutil.which("npm")


def is_port_listening(host: str, port: int, timeout: float = 0.3) -> bool:
    """Cheap TCP probe — returns True if something is accepting connections."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def is_wsl() -> bool:
    if platform.system() != "Linux":
        return False
    try:
        with open("/proc/version", "r", encoding="utf-8", errors="replace") as fh:
            return "microsoft" in fh.read().lower() or "wsl" in fh.read().lower()
    except OSError:
        return False


def open_browser(url: str) -> bool:
    """Best-effort cross-platform browser open. WSL/headless friendly."""
    system = platform.system()
    if is_wsl():
        for cmd in (
            ["wslview", url],
            ["powershell.exe", "-NoProfile", "-Command", f"Start-Process '{url}'"],
            ["cmd.exe", "/c", "start", "", url],
        ):
            if not shutil.which(cmd[0]):
                continue
            try:
                if subprocess.run(cmd, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL).returncode == 0:
                    return True
            except OSError:
                continue
        return False
    if system == "Linux" and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return False
    if system == "Darwin" and shutil.which("open"):
        try:
            return subprocess.run(["open", url], stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL).returncode == 0
        except OSError:
            pass
    try:
        return bool(webbrowser.open(url, new=2))
    except Exception:  # noqa: BLE001
        return False


def open_in_new_terminal(repo_root: Path, command: List[str], title: str = "TrendVault CLI") -> bool:
    """Spawn the OS terminal emulator with `command` running in `repo_root`. True on success."""
    system = platform.system()
    cwd = str(repo_root)

    # ---- WSL: hand the command to the Windows host so the new window is a real cmd/Terminal.
    if is_wsl():
        # Translate /mnt/c/... back to C:\... for cmd.exe.
        win_cwd_proc = subprocess.run(
            ["wslpath", "-w", cwd], capture_output=True, text=True, check=False,
        )
        win_cwd = win_cwd_proc.stdout.strip() if win_cwd_proc.returncode == 0 else cwd
        joined = subprocess.list2cmdline(command)
        full = f'start "{title}" cmd.exe /K "cd /d \"{win_cwd}\" && {joined}"'
        try:
            subprocess.Popen(["cmd.exe", "/c", full])
            return True
        except OSError:
            return False

    if system == "Windows":
        joined = subprocess.list2cmdline(command)
        try:
            # `start` is a cmd.exe builtin — invoke through cmd.exe /c.
            subprocess.Popen(
                ["cmd.exe", "/c", "start", title, "cmd.exe", "/K",
                 f"cd /d \"{cwd}\" && {joined}"],
                creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
            )
            return True
        except OSError:
            return False

    if system == "Darwin":
        # AppleScript: open Terminal.app and run the command.
        script = (
            f'tell application "Terminal" to do script '
            f'"cd {subprocess.list2cmdline([cwd])} && {subprocess.list2cmdline(command)}"'
        )
        try:
            subprocess.Popen(["osascript", "-e", script])
            return True
        except OSError:
            return False

    # ---- Linux: try several terminal emulators in order.
    quoted = " ".join(_shell_quote(arg) for arg in command)
    inner = f'cd {_shell_quote(cwd)} && {quoted}; exec $SHELL'
    candidates: List[List[str]] = [
        ["x-terminal-emulator", "-e", "bash", "-lc", inner],
        ["gnome-terminal", "--", "bash", "-lc", inner],
        ["konsole", "-e", "bash", "-lc", inner],
        ["xfce4-terminal", "-e", f"bash -lc {_shell_quote(inner)}"],
        ["alacritty", "-e", "bash", "-lc", inner],
        ["kitty", "bash", "-lc", inner],
        ["tilix", "-e", "bash", "-lc", inner],
        ["xterm", "-e", "bash", "-lc", inner],
    ]
    for term_cmd in candidates:
        if not shutil.which(term_cmd[0]):
            continue
        try:
            subprocess.Popen(term_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except OSError:
            continue
    return False


def _shell_quote(arg: str) -> str:
    """Minimal POSIX shell quoting — single-quotes the arg if it contains anything risky."""
    if arg and all(c.isalnum() or c in "@%+=:,./-_" for c in arg):
        return arg
    return "'" + arg.replace("'", "'\\''") + "'"


# ---------- the GUI ------------------------------------------------------

class LauncherApp(ctk.CTk):
    def __init__(self, port: int, repo_root: Path, npm: Optional[str]) -> None:
        super().__init__()
        self.port = port
        self.repo_root = repo_root
        self.npm = npm
        self.url = f"http://{HOST}:{port}"
        self.proc: Optional[subprocess.Popen[str]] = None
        self.log_lines: Deque[str] = collections.deque(maxlen=LOG_BUFFER_LINES)
        self._log_dirty = False
        self._last_status: Optional[bool] = None

        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("dark-blue")

        self.title("TrendVault Coder Launcher")
        self.geometry("720x680")
        self.minsize(600, 560)
        self.configure(fg_color=COLOR_BG)

        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(POLL_INTERVAL_MS, self._poll)
        self._log_append(f"[launcher] ready — repo: {self.repo_root}")
        self._log_append(f"[launcher] target URL: {self.url}")
        if not self.npm:
            self._log_append("[launcher] WARNING: npm is not on PATH — install Node.js ≥ 22")

    # ---- layout ----
    def _build_ui(self) -> None:
        # Header
        header = ctk.CTkFrame(self, fg_color=COLOR_BG)
        header.pack(fill="x", padx=22, pady=(20, 8))
        ctk.CTkLabel(
            header, text="✦  TrendVault Coder",
            font=("Segoe UI", 22, "bold"), text_color=COLOR_ACCENT,
        ).pack(side="left")
        ctk.CTkLabel(
            header, text="Launcher", font=("Segoe UI", 14),
            text_color=COLOR_TEXT_DIM,
        ).pack(side="left", padx=(10, 0), pady=(6, 0))

        # ---- Web UI panel ----
        server_panel = self._panel("Web UI")
        info = ctk.CTkFrame(server_panel, fg_color=COLOR_PANEL)
        info.pack(fill="x", padx=18, pady=(4, 6))
        self.status_dot = ctk.CTkLabel(
            info, text="●", text_color=COLOR_TEXT_DIM, font=("Segoe UI", 16),
        )
        self.status_dot.pack(side="left")
        self.status_label = ctk.CTkLabel(
            info, text="Stopped", text_color=COLOR_TEXT_DIM, font=("Segoe UI", 12, "bold"),
        )
        self.status_label.pack(side="left", padx=(6, 16))
        ctk.CTkLabel(
            info, text=f"URL  {self.url}", text_color=COLOR_TEXT_DIM, font=("Segoe UI", 11),
        ).pack(side="left")

        btn_row = ctk.CTkFrame(server_panel, fg_color=COLOR_PANEL)
        btn_row.pack(fill="x", padx=18, pady=(2, 16))
        self.start_btn = ctk.CTkButton(
            btn_row, text="▶  Start", command=self._on_start,
            fg_color=COLOR_ACCENT, hover_color=COLOR_ACCENT_HVR, text_color="#1a1a1a",
            font=("Segoe UI", 12, "bold"), width=120, height=34, corner_radius=8,
        )
        self.start_btn.pack(side="left")
        self.stop_btn = ctk.CTkButton(
            btn_row, text="■  Stop", command=self._on_stop,
            fg_color=COLOR_BUTTON, hover_color=COLOR_BUTTON_HVR, text_color=COLOR_TEXT,
            font=("Segoe UI", 12), width=120, height=34, corner_radius=8, state="disabled",
        )
        self.stop_btn.pack(side="left", padx=(8, 0))
        self.open_btn = ctk.CTkButton(
            btn_row, text="↗  Open in browser", command=self._on_open_browser,
            fg_color=COLOR_BUTTON, hover_color=COLOR_BUTTON_HVR, text_color=COLOR_TEXT,
            font=("Segoe UI", 12), width=170, height=34, corner_radius=8, state="disabled",
        )
        self.open_btn.pack(side="left", padx=(8, 0))

        # ---- Claude CLI panel ----
        cli_panel = self._panel("Claude CLI")
        ctk.CTkLabel(
            cli_panel,
            text="Launch the bundled Claude Code CLI in a new terminal window.",
            text_color=COLOR_TEXT_DIM, font=("Segoe UI", 11), justify="left", anchor="w",
        ).pack(fill="x", padx=18, pady=(0, 8))

        cli_row = ctk.CTkFrame(cli_panel, fg_color=COLOR_PANEL)
        cli_row.pack(fill="x", padx=18, pady=(0, 16))
        ctk.CTkLabel(cli_row, text="Provider", text_color=COLOR_TEXT_DIM,
                     font=("Segoe UI", 11)).pack(side="left")
        self.provider_var = ctk.StringVar(value="anthropic")
        provider_menu = ctk.CTkOptionMenu(
            cli_row, values=["anthropic", "gemini", "groq", "ollama"],
            variable=self.provider_var,
            fg_color=COLOR_BUTTON, button_color=COLOR_BUTTON_HVR,
            button_hover_color="#4a4a4a", text_color=COLOR_TEXT, width=140, height=32,
            corner_radius=8,
        )
        provider_menu.pack(side="left", padx=(10, 16))
        ctk.CTkButton(
            cli_row, text="▶  Open CLI", command=self._on_open_cli,
            fg_color=COLOR_ACCENT, hover_color=COLOR_ACCENT_HVR, text_color="#1a1a1a",
            font=("Segoe UI", 12, "bold"), width=130, height=32, corner_radius=8,
        ).pack(side="left")

        # ---- Server log panel ----
        log_panel = self._panel("Server log", expand=True)
        self.log_text = ctk.CTkTextbox(
            log_panel, fg_color=COLOR_PANEL_DEEP, text_color=COLOR_TEXT,
            font=("Consolas", 10), wrap="none", corner_radius=6, border_width=0,
        )
        self.log_text.pack(fill="both", expand=True, padx=14, pady=(0, 14))
        self.log_text.configure(state="disabled")

    def _panel(self, title: str, expand: bool = False) -> ctk.CTkFrame:
        panel = ctk.CTkFrame(self, fg_color=COLOR_PANEL, corner_radius=12,
                             border_width=1, border_color=COLOR_BORDER)
        panel.pack(fill="both" if expand else "x", expand=expand,
                   padx=22, pady=8)
        ctk.CTkLabel(
            panel, text=title, font=("Segoe UI", 13, "bold"),
            text_color=COLOR_TEXT, anchor="w",
        ).pack(fill="x", padx=18, pady=(12, 6))
        return panel

    # ---- actions ----
    def _on_start(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            return
        if not self.npm:
            self._log_append("[launcher] cannot start — npm is not on PATH")
            return
        env = os.environ.copy()
        env["WEB_PORT"] = str(self.port)
        env["FORCE_COLOR"] = "0"
        creationflags = 0
        if platform.system() == "Windows":
            creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        try:
            self.proc = subprocess.Popen(
                [self.npm, "run", "web"],
                cwd=str(self.repo_root),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            self._log_append(f"[launcher] failed to spawn npm: {exc}")
            return
        self._log_append("[launcher] starting server…")
        threading.Thread(target=self._reader_loop, daemon=True).start()
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")

    def _on_stop(self) -> None:
        if self.proc is None:
            return
        self._log_append("[launcher] stopping server…")
        try:
            if platform.system() == "Windows":
                self.proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        except Exception as exc:  # noqa: BLE001
            self._log_append(f"[launcher] stop error: {exc}")
        self.proc = None
        self._after_safe(self._reset_buttons_to_idle)

    def _on_open_browser(self) -> None:
        if not open_browser(self.url):
            self._log_append(f"[launcher] couldn't auto-open — visit {self.url} manually")

    def _on_open_cli(self) -> None:
        provider = self.provider_var.get()
        command = ["node", "launchers/trendvault-coder-launcher.cjs", "--provider", provider]
        self._log_append(f"[launcher] opening CLI ({provider}) in a new terminal…")
        if not open_in_new_terminal(self.repo_root, command):
            self._log_append("[launcher] couldn't find a terminal emulator — run this manually:")
            self._log_append(f"           {' '.join(command)}")

    def _on_close(self) -> None:
        self._on_stop()
        self.destroy()

    # ---- background ----
    def _reader_loop(self) -> None:
        if self.proc is None or self.proc.stdout is None:
            return
        for line in self.proc.stdout:
            self._log_append(line.rstrip("\r\n"))
        self._log_append("[launcher] server process exited")
        self.proc = None
        self._after_safe(self._reset_buttons_to_idle)

    def _reset_buttons_to_idle(self) -> None:
        self.start_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")
        # open_btn state is driven by the port poll, not here.

    def _log_append(self, line: str) -> None:
        if line:
            self.log_lines.append(line)
            self._log_dirty = True

    def _poll(self) -> None:
        # Server status
        is_up = is_port_listening(HOST, self.port)
        if is_up != self._last_status:
            self._last_status = is_up
            if is_up:
                self.status_dot.configure(text_color=COLOR_OK)
                self.status_label.configure(text="Running", text_color=COLOR_OK)
                self.open_btn.configure(state="normal")
            else:
                self.status_dot.configure(text_color=COLOR_TEXT_DIM)
                self.status_label.configure(text="Stopped", text_color=COLOR_TEXT_DIM)
                self.open_btn.configure(state="disabled")

        # Flush log buffer (only when dirty to keep idle CPU near zero).
        if self._log_dirty:
            self._log_dirty = False
            self.log_text.configure(state="normal")
            self.log_text.delete("1.0", "end")
            self.log_text.insert("1.0", "\n".join(self.log_lines))
            self.log_text.see("end")
            self.log_text.configure(state="disabled")

        self.after(POLL_INTERVAL_MS, self._poll)

    def _after_safe(self, fn) -> None:
        """Schedule `fn` on the Tk main loop from any thread."""
        try:
            self.after(0, fn)
        except RuntimeError:
            pass  # window already destroyed


# ---------- main ---------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="TrendVault Coder GUI launcher.")
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("WEB_PORT", DEFAULT_PORT)),
        help=f"Port for the web UI (default: {DEFAULT_PORT}; also reads $WEB_PORT)",
    )
    args = parser.parse_args()
    app = LauncherApp(args.port, find_repo_root(), find_npm())
    app.mainloop()


if __name__ == "__main__":
    main()
