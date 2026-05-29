#!/usr/bin/env python3
"""TrendVault Coder GUI launcher.

A small desktop window that starts/stops the web UI server (``node server.js``)
and opens it in your browser. Cross-platform: Windows, macOS, Linux (incl. WSL).

Built with CustomTkinter; the package is auto-installed on first run. On Linux
you also need the system Tk bindings (``python3-tk`` / ``python3-tkinter`` /
``tk``) — we surface a friendly message if they're missing.

Usage:
    python trendvault-gui.py
    python trendvault-gui.py --port 7879
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
    """Install ``pkg``, with fallbacks for PEP 668 (Ubuntu 23.04+, Debian 12+, Fedora 38+)."""
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
    print(f"Installing '{pkg}' for the launcher UI (one-time)...")
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
import json
import os
import shutil
import signal
import socket
import threading
import urllib.request
import webbrowser
from pathlib import Path
from typing import Optional

import customtkinter as ctk


# ---------- constants ----------------------------------------------------

DEFAULT_PORT = 7878
HOST = "127.0.0.1"
POLL_INTERVAL_MS = 700

COLOR_BG          = "#1a1a1a"
COLOR_PANEL       = "#222222"
COLOR_BORDER      = "#2a2a2a"
COLOR_BUTTON      = "#333333"
COLOR_BUTTON_HVR  = "#3d3d3d"
COLOR_ACCENT      = "#d97757"
COLOR_ACCENT_HVR  = "#c2654a"
COLOR_TEXT        = "#e8e8e8"
COLOR_TEXT_DIM    = "#888888"
COLOR_OK          = "#7ec078"
COLOR_WARN        = "#d8a657"
COLOR_ERR         = "#e15d5d"


# ---------- helpers ------------------------------------------------------

def find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in (here, *here.parents):
        if (candidate / "package.json").is_file():
            return candidate
    return here


def find_exe(name: str) -> Optional[str]:
    exe = shutil.which(name)
    if exe:
        return exe
    if platform.system() == "Windows":
        for ext in (".exe", ".cmd", ".bat"):
            exe = shutil.which(name + ext)
            if exe:
                return exe
    return None


def is_port_listening(host: str, port: int, timeout: float = 0.3) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def is_our_server(port: int) -> bool:
    """True if whatever holds the port answers like our web UI."""
    try:
        url = f"http://{HOST}:{port}/api/defaults"
        with urllib.request.urlopen(url, timeout=1.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return isinstance(data, dict) and "home" in data
    except Exception:
        return False


def is_wsl() -> bool:
    if platform.system() != "Linux":
        return False
    try:
        with open("/proc/version", "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read().lower()
        return "microsoft" in text or "wsl" in text
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
    try:
        return bool(webbrowser.open(url, new=2))
    except Exception:
        return False


# ---------- the GUI ------------------------------------------------------

class LauncherApp(ctk.CTk):
    def __init__(self, port: int, repo_root: Path,
                 node: Optional[str], npm: Optional[str]) -> None:
        super().__init__()
        self.port = port
        self.repo_root = repo_root
        self.node = node
        self.npm = npm
        self.url = f"http://{HOST}:{port}"
        self.proc: Optional[subprocess.Popen] = None
        self._starting = False
        self._last_state: Optional[str] = None
        # Message state is set from any thread but only ever rendered by the
        # main-thread poll loop, since Tkinter is not thread-safe.
        self._pending_msg: tuple = ("", COLOR_TEXT_DIM)
        self._applied_msg: Optional[tuple] = None

        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("dark-blue")

        self.title("TrendVault Coder Launcher")
        self.geometry("780x300")
        self.minsize(620, 280)
        self.configure(fg_color=COLOR_BG)

        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        if not self.node:
            self._set_msg("Node.js not found on PATH - install it from https://nodejs.org", COLOR_ERR)
            self.start_btn.configure(state="disabled")

        self.after(POLL_INTERVAL_MS, self._poll)

    # ---- layout ----
    def _build_ui(self) -> None:
        header = ctk.CTkFrame(self, fg_color=COLOR_BG)
        header.pack(fill="x", padx=22, pady=(18, 6))
        ctk.CTkLabel(
            header, text="✦  TrendVault Coder",
            font=("Segoe UI", 22, "bold"), text_color=COLOR_ACCENT,
        ).pack(side="left")
        ctk.CTkLabel(
            header, text="Launcher", font=("Segoe UI", 14), text_color=COLOR_TEXT_DIM,
        ).pack(side="left", padx=(10, 0), pady=(8, 0))

        panel = ctk.CTkFrame(self, fg_color=COLOR_PANEL, corner_radius=12,
                             border_width=1, border_color=COLOR_BORDER)
        panel.pack(fill="x", padx=22, pady=8)
        ctk.CTkLabel(
            panel, text="Web UI", font=("Segoe UI", 13, "bold"),
            text_color=COLOR_TEXT, anchor="w",
        ).pack(fill="x", padx=18, pady=(12, 6))

        info = ctk.CTkFrame(panel, fg_color=COLOR_PANEL)
        info.pack(fill="x", padx=18, pady=(2, 8))
        self.status_dot = ctk.CTkLabel(info, text="●", text_color=COLOR_TEXT_DIM,
                                        font=("Segoe UI", 16))
        self.status_dot.pack(side="left")
        self.status_label = ctk.CTkLabel(info, text="Stopped", text_color=COLOR_TEXT_DIM,
                                         font=("Segoe UI", 12, "bold"))
        self.status_label.pack(side="left", padx=(6, 18))
        ctk.CTkLabel(info, text="URL", text_color=COLOR_TEXT_DIM,
                     font=("Segoe UI", 11)).pack(side="left")
        ctk.CTkLabel(info, text=self.url, text_color=COLOR_TEXT_DIM,
                     font=("Segoe UI", 11)).pack(side="left", padx=(6, 0))

        btn_row = ctk.CTkFrame(panel, fg_color=COLOR_PANEL)
        btn_row.pack(fill="x", padx=18, pady=(2, 8))
        self.start_btn = ctk.CTkButton(
            btn_row, text="▶  Start", command=self._on_start,
            fg_color=COLOR_ACCENT, hover_color=COLOR_ACCENT_HVR, text_color="#1a1a1a",
            font=("Segoe UI", 12, "bold"), width=140, height=36, corner_radius=8,
        )
        self.start_btn.pack(side="left")
        self.stop_btn = ctk.CTkButton(
            btn_row, text="■  Stop", command=self._on_stop,
            fg_color=COLOR_BUTTON, hover_color=COLOR_BUTTON_HVR, text_color=COLOR_TEXT,
            font=("Segoe UI", 12), width=140, height=36, corner_radius=8, state="disabled",
        )
        self.stop_btn.pack(side="left", padx=(10, 0))
        self.open_btn = ctk.CTkButton(
            btn_row, text="↗  Open in browser", command=self._on_open_browser,
            fg_color=COLOR_BUTTON, hover_color=COLOR_BUTTON_HVR, text_color=COLOR_TEXT,
            font=("Segoe UI", 12), width=190, height=36, corner_radius=8, state="disabled",
        )
        self.open_btn.pack(side="left", padx=(10, 0))

        self.msg_label = ctk.CTkLabel(panel, text="", text_color=COLOR_TEXT_DIM,
                                      font=("Segoe UI", 11), anchor="w", justify="left")
        self.msg_label.pack(fill="x", padx=18, pady=(0, 14))

    # ---- actions ----
    def _on_start(self) -> None:
        if self._starting or (self.proc is not None and self.proc.poll() is None):
            return
        if not self.node:
            return
        self._starting = True
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self._set_msg("Starting...", COLOR_WARN)
        threading.Thread(target=self._start_worker, daemon=True).start()

    def _start_worker(self) -> None:
        try:
            if is_port_listening(HOST, self.port):
                if is_our_server(self.port):
                    self._set_msg("Already running.", COLOR_OK)
                    return  # poll will flip status to Running
                self._fail(f"Port {self.port} is in use by another program. Try --port.")
                return

            if not (self.repo_root / "node_modules").is_dir():
                if not self.npm:
                    self._fail("Dependencies missing and npm not found. Install Node.js.")
                    return
                self._set_msg("Installing dependencies (first run)...", COLOR_WARN)
                rc = subprocess.run([self.npm, "install"], cwd=str(self.repo_root)).returncode
                if rc != 0:
                    self._fail("'npm install' failed - run it manually in a terminal.")
                    return

            env = os.environ.copy()
            env["PORT"] = str(self.port)
            kwargs: dict = {
                "cwd": str(self.repo_root),
                "env": env,
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
            }
            if platform.system() == "Windows":
                kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            else:
                kwargs["start_new_session"] = True
            self.proc = subprocess.Popen([self.node, "server.js"], **kwargs)
            self._set_msg("", COLOR_TEXT_DIM)
        except OSError as exc:
            self._fail(f"Failed to start server: {exc}")

    def _fail(self, message: str) -> None:
        self._starting = False
        self.proc = None
        self._set_msg(message, COLOR_ERR)

    def _on_stop(self) -> None:
        self._starting = False
        proc = self.proc
        if proc is None:
            self._set_msg("", COLOR_TEXT_DIM)
            return
        self._set_msg("Stopping...", COLOR_WARN)
        try:
            self._terminate_tree(proc)
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self._kill_tree(proc)
                proc.wait(timeout=4)
        except Exception as exc:
            self._set_msg(f"Stop error: {exc}", COLOR_ERR)
        self.proc = None

    def _terminate_tree(self, proc: subprocess.Popen) -> None:
        if platform.system() == "Windows":
            # node is a console app and ignores WM_CLOSE, so /F /T (force the
            # whole tree) is both reliable and fast here.
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.terminate()
            except OSError:
                pass

    def _kill_tree(self, proc: subprocess.Popen) -> None:
        if platform.system() == "Windows":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except OSError:
                pass

    def _on_open_browser(self) -> None:
        if not open_browser(self.url):
            self._set_msg(f"Couldn't auto-open a browser - visit {self.url}", COLOR_WARN)

    def _on_close(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            try:
                self._terminate_tree(self.proc)
                self.proc.wait(timeout=5)
            except Exception:
                self._kill_tree(self.proc)
        self.destroy()

    # ---- polling / state ----
    def _set_msg(self, text: str, color: str = COLOR_TEXT_DIM) -> None:
        # Thread-safe: just record it; the poll loop renders it on the main thread.
        self._pending_msg = (text, color)

    def _poll(self) -> None:
        is_up = is_port_listening(HOST, self.port)
        if self.proc is not None and self.proc.poll() is not None:
            self.proc = None  # server exited on its own

        if is_up:
            self._starting = False
            state = "running"
        elif self._starting:
            state = "starting"
        else:
            state = "stopped"

        if state != self._last_state:
            self._last_state = state
            if state == "running":
                self.status_dot.configure(text_color=COLOR_OK)
                self.status_label.configure(text="Running", text_color=COLOR_OK)
                self.start_btn.configure(state="disabled")
                self.stop_btn.configure(state="normal" if self.proc is not None else "disabled")
                self.open_btn.configure(state="normal")
            elif state == "starting":
                self.status_dot.configure(text_color=COLOR_WARN)
                self.status_label.configure(text="Starting", text_color=COLOR_WARN)
                self.start_btn.configure(state="disabled")
                self.stop_btn.configure(state="normal")
                self.open_btn.configure(state="disabled")
            else:  # stopped
                self.status_dot.configure(text_color=COLOR_TEXT_DIM)
                self.status_label.configure(text="Stopped", text_color=COLOR_TEXT_DIM)
                self.start_btn.configure(state="normal" if self.node else "disabled")
                self.stop_btn.configure(state="disabled")
                self.open_btn.configure(state="disabled")

        if self._pending_msg != self._applied_msg:
            self._applied_msg = self._pending_msg
            text, color = self._pending_msg
            self.msg_label.configure(text=text, text_color=color)

        self.after(POLL_INTERVAL_MS, self._poll)


# ---------- main ---------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="TrendVault Coder GUI launcher.")
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("PORT", DEFAULT_PORT)),
        help=f"Port for the web UI (default: {DEFAULT_PORT}; also reads $PORT)",
    )
    args = parser.parse_args()
    app = LauncherApp(args.port, find_repo_root(), find_exe("node"), find_exe("npm"))
    app.mainloop()


if __name__ == "__main__":
    main()
