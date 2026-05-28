#!/usr/bin/env python3
"""TrendVault Coder launcher — modern terminal UI.

A cross-platform launcher (Windows / Linux / macOS) that boots the web UI,
shows a live setup checklist, streams server output, and stops cleanly on
Ctrl+C. Uses the `rich` library for the UI; if rich isn't installed it is
auto-installed on first run.

Usage:
    python launchers/trendvault-coder.py
    python launchers/trendvault-coder.py --port 7879
    python launchers/trendvault-coder.py --no-browser
    python launchers/trendvault-coder.py --no-kill
"""

from __future__ import annotations

import subprocess
import sys

# ---------- bootstrap rich -----------------------------------------------

def _ensure_rich() -> None:
    try:
        import rich  # noqa: F401
        return
    except ImportError:
        pass
    print("Installing 'rich' for the launcher UI (one-time)…")
    rc = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet", "rich"],
    ).returncode
    if rc != 0:
        print("error: failed to install 'rich'. Run: python -m pip install rich")
        sys.exit(1)


_ensure_rich()


# Force UTF-8 on stdout/stderr so unicode icons render on Windows consoles
# that default to cp1252. Best-effort — older Python versions and unusual
# stream types will silently skip this.
for _stream_name in ("stdout", "stderr"):
    _s = getattr(sys, _stream_name, None)
    if _s is not None and hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass


import argparse
import collections
import os
import platform
import re
import shutil
import signal
import socket
import threading
import time
import webbrowser
from pathlib import Path
from typing import Deque, Optional

from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.spinner import Spinner
from rich.table import Table
from rich.text import Text


# ---------- constants ----------------------------------------------------

DEFAULT_PORT = 7878
HOST = "127.0.0.1"
LOG_LINES = 12  # how many recent server log lines stay visible in the feed

PENDING = "pending"
ACTIVE = "active"
DONE = "done"
FAILED = "failed"
SKIPPED = "skipped"

STEP_ORDER = [
    ("npm",     "Check npm"),
    ("deps",    "Install dependencies"),
    ("port",    "Free port"),
    ("server",  "Start server"),
    ("browser", "Open browser"),
]

ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

console = Console()


# ---------- helpers ------------------------------------------------------

def find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in (here, *here.parents):
        if (candidate / "package.json").is_file():
            return candidate
    sys.exit("error: package.json not found in any parent directory")


def find_npm() -> Optional[str]:
    return shutil.which("npm")


def is_port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return True
    return False


def kill_port_listeners(port: int) -> int:
    """Best-effort: terminate processes LISTENING on the port. Returns count."""
    system = platform.system()
    killed = 0
    try:
        if system == "Windows":
            out = subprocess.check_output(
                ["netstat", "-ano"], text=True, stderr=subprocess.DEVNULL
            )
            pids: set[str] = set()
            needle = f":{port}"
            for line in out.splitlines():
                parts = line.split()
                if (
                    len(parts) >= 5
                    and needle in parts[1]
                    and parts[3].upper() == "LISTENING"
                ):
                    pids.add(parts[4])
            for pid in pids:
                rc = subprocess.run(
                    ["taskkill", "/F", "/PID", pid],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                ).returncode
                if rc == 0:
                    killed += 1
        else:
            if shutil.which("lsof"):
                try:
                    out = subprocess.check_output(
                        ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
                        text=True,
                        stderr=subprocess.DEVNULL,
                    )
                except subprocess.CalledProcessError:
                    out = ""
                for pid_text in out.split():
                    try:
                        os.kill(int(pid_text), signal.SIGTERM)
                        killed += 1
                    except (ValueError, ProcessLookupError, PermissionError):
                        pass
            elif shutil.which("fuser"):
                subprocess.run(
                    ["fuser", "-k", f"{port}/tcp"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
    except Exception:  # noqa: BLE001 — best-effort cleanup
        pass
    return killed


def strip_ansi(line: str) -> str:
    return ANSI_ESCAPE_RE.sub("", line)


def _is_wsl() -> bool:
    """Detect Windows Subsystem for Linux. /proc/version mentions Microsoft."""
    if platform.system() != "Linux":
        return False
    try:
        with open("/proc/version", "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read().lower()
    except OSError:
        return False
    return "microsoft" in text or "wsl" in text


def _open_url_for_platform(url: str) -> bool:
    """Best-effort cross-platform browser open. Returns True on apparent success.

    Python's stdlib webbrowser.open() works fine on Windows/macOS and on Linux
    desktops with xdg-open. It quietly fails on WSL, headless servers, and SSH
    sessions, leaving the user staring at a launcher that says "opening
    browser…" forever. We special-case those.
    """
    system = platform.system()

    # ---- WSL: shell out to the Windows host so the user's real browser opens.
    if _is_wsl():
        for cmd in (
            ["wslview", url],
            ["powershell.exe", "-NoProfile", "-Command", f"Start-Process '{url}'"],
            ["cmd.exe", "/c", "start", "", url],
        ):
            if not shutil.which(cmd[0]):
                continue
            try:
                rc = subprocess.run(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                ).returncode
            except Exception:  # noqa: BLE001
                continue
            if rc == 0:
                return True
        return False

    # ---- Headless Linux: no DISPLAY / no Wayland → skip silently.
    if system == "Linux" and not (
        os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
    ):
        return False

    # ---- Native macOS: use `open` (more reliable than the stdlib fallback).
    if system == "Darwin" and shutil.which("open"):
        try:
            rc = subprocess.run(
                ["open", url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            ).returncode
            if rc == 0:
                return True
        except Exception:  # noqa: BLE001
            pass

    # ---- Everything else (Windows, Linux desktop): let stdlib try.
    try:
        return bool(webbrowser.open(url, new=2))
    except Exception:  # noqa: BLE001 — browser launch is best-effort
        return False


# ---------- the launcher dashboard --------------------------------------

class Launcher:
    def __init__(
        self,
        port: int,
        no_browser: bool,
        no_kill: bool,
        repo_root: Path,
        npm: Optional[str],
    ) -> None:
        self.port = port
        self.no_browser = no_browser
        self.no_kill = no_kill
        self.repo_root = repo_root
        self.npm = npm
        self.url = f"http://{HOST}:{port}"

        self.steps: dict[str, str] = {key: PENDING for key, _ in STEP_ORDER}
        self.step_detail: dict[str, str] = {}
        self.log_lines: Deque[str] = collections.deque(maxlen=LOG_LINES)
        self.proc: Optional[subprocess.Popen[str]] = None
        self.shutting_down = False
        self.failure_message: Optional[str] = None

    # ----- step helpers -----
    def _set(self, key: str, state: str, detail: Optional[str] = None) -> None:
        self.steps[key] = state
        if detail is not None:
            self.step_detail[key] = detail

    def _log(self, line: str) -> None:
        line = strip_ansi(line).rstrip("\r\n")
        if line:
            self.log_lines.append(line)

    # ----- rendering -----
    def __rich__(self) -> Group:
        return Group(
            self._header_panel(),
            Text(),
            self._status_table(),
            Text(),
            self._log_panel(),
            Text(),
            self._footer(),
        )

    def _header_panel(self) -> Panel:
        body = Text()
        body.append("URL   ", style="dim")
        body.append(self.url, style="bold cyan")
        body.append("\n")
        body.append("Root  ", style="dim")
        body.append(str(self.repo_root), style="white")
        body.append("\n")
        body.append("Port  ", style="dim")
        body.append(str(self.port), style="white")
        return Panel(
            body,
            title="[bold #d97757]TrendVault Coder[/]",
            border_style="bright_black",
            padding=(1, 2),
        )

    def _status_table(self) -> Table:
        table = Table.grid(padding=(0, 1))
        table.add_column(width=2, no_wrap=True)
        table.add_column()
        for key, label in STEP_ORDER:
            state = self.steps[key]
            icon = self._icon_for(state)
            label_text = self._label_for(label, state, self.step_detail.get(key))
            table.add_row(icon, label_text)
        return table

    def _icon_for(self, state: str):
        if state == ACTIVE:
            return Spinner("dots", style="cyan")
        if state == DONE:
            return Text("✓", style="green")
        if state == FAILED:
            return Text("✗", style="red")
        if state == SKIPPED:
            return Text("–", style="dim")
        return Text("○", style="bright_black")

    def _label_for(self, label: str, state: str, detail: Optional[str]) -> Text:
        if state == FAILED:
            label_style = "red"
            detail_style = "red dim"
        elif state == DONE:
            label_style = "white"
            detail_style = "dim"
        elif state == ACTIVE:
            label_style = "bold white"
            detail_style = "cyan"
        elif state == SKIPPED:
            label_style = "dim"
            detail_style = "dim"
        else:
            label_style = "bright_black"
            detail_style = "bright_black"
        text = Text(label, style=label_style)
        if detail:
            text.append("   ")
            text.append(detail, style=detail_style)
        return text

    def _log_panel(self) -> Panel:
        if not self.log_lines:
            body = Text("server output will appear here…", style="dim italic")
        else:
            body = Text("\n".join(self.log_lines), style="white")
        return Panel(
            body,
            title="[dim]server output[/]",
            border_style="bright_black",
            padding=(0, 1),
            height=LOG_LINES + 2,
        )

    def _footer(self) -> Text:
        if self.failure_message:
            return Text(f"  {self.failure_message}", style="bold red")
        if self.shutting_down:
            return Text("  shutting down…", style="dim")
        if self.proc is not None and self.proc.poll() is None:
            return Text("  Press Ctrl+C to stop the server.", style="dim")
        return Text("  starting…", style="dim")

    # ----- setup flow -----
    def setup(self) -> None:
        """Run the full setup → server-launch flow. Called in a thread."""
        try:
            self._step_npm()
            self._step_deps()
            self._step_port()
            self._step_server()
            self._step_browser()
        except SystemExit as exc:
            self.failure_message = str(exc) or "setup failed"

    def _step_npm(self) -> None:
        self._set("npm", ACTIVE)
        time.sleep(0.1)  # let the spinner be visible briefly
        if not self.npm:
            self._set("npm", FAILED, "not found on PATH")
            raise SystemExit("npm is missing — install Node.js >= 22")
        self._set("npm", DONE, Path(self.npm).name)

    def _step_deps(self) -> None:
        self._set("deps", ACTIVE)
        node_modules = self.repo_root / "node_modules"
        if node_modules.is_dir():
            self._set("deps", DONE, "node_modules present")
            return
        self._set("deps", ACTIVE, "running 'npm install'…")
        proc = subprocess.Popen(
            [self.npm, "install"],
            cwd=str(self.repo_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            self._log(f"[npm install] {line.rstrip()}")
        rc = proc.wait()
        if rc != 0:
            self._set("deps", FAILED, f"exit {rc}")
            raise SystemExit(f"npm install failed (exit {rc})")
        self._set("deps", DONE, "installed")

    def _step_port(self) -> None:
        self._set("port", ACTIVE)
        if not is_port_in_use(HOST, self.port):
            self._set("port", DONE, f"{self.port} available")
            return
        if self.no_kill:
            self._set("port", FAILED, f"{self.port} busy")
            raise SystemExit(f"port {self.port} is in use (--no-kill set)")
        self._set("port", ACTIVE, "stopping previous server…")
        killed = kill_port_listeners(self.port)
        time.sleep(0.6)
        if killed:
            self._set("port", DONE, f"freed (stopped {killed} pid{'s' if killed != 1 else ''})")
        else:
            self._set("port", DONE, "freed")

    def _step_server(self) -> None:
        self._set("server", ACTIVE, "spawning 'npm run web'…")
        env = os.environ.copy()
        env["WEB_PORT"] = str(self.port)
        env["FORCE_COLOR"] = "0"  # keep our log feed plain
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
        except FileNotFoundError as exc:
            self._set("server", FAILED, str(exc))
            raise SystemExit("failed to start npm")

        threading.Thread(target=self._reader_loop, daemon=True).start()
        threading.Thread(target=self._watch_for_ready, daemon=True).start()

    def _step_browser(self) -> None:
        if self.no_browser:
            self._set("browser", SKIPPED, "disabled")
            return
        self._set("browser", ACTIVE, "opens in 2 s…")
        threading.Thread(target=self._open_browser_later, daemon=True).start()

    # ----- background workers -----
    def _reader_loop(self) -> None:
        if self.proc is None or self.proc.stdout is None:
            return
        for line in self.proc.stdout:
            self._log(line)

    def _watch_for_ready(self) -> None:
        deadline = time.time() + 60
        while time.time() < deadline:
            if self.proc is None:
                return
            if self.proc.poll() is not None:
                self._set("server", FAILED, f"exited {self.proc.returncode}")
                self.failure_message = f"server exited early (code {self.proc.returncode})"
                return
            if any("ready at" in line.lower() for line in list(self.log_lines)):
                self._set("server", DONE, f"listening on {self.port}")
                return
            time.sleep(0.25)
        # Reached the deadline without seeing "ready at"; surface a soft warning
        # but don't fail (the server might still be coming up).
        if self.steps.get("server") == ACTIVE:
            self._set("server", DONE, "running (no ready banner seen)")

    def _open_browser_later(self) -> None:
        time.sleep(2.0)
        if _open_url_for_platform(self.url):
            self._set("browser", DONE, self.url)
        else:
            # Don't surface this as a hard failure — the server is fine, the
            # user just has to click the URL themselves (common on WSL without
            # wslu / headless boxes / SSH sessions).
            self._set("browser", SKIPPED, f"open {self.url} manually")

    # ----- shutdown -----
    def shutdown(self) -> None:
        if self.proc is None or self.shutting_down:
            return
        self.shutting_down = True
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
        except Exception:  # noqa: BLE001 — shutdown is best-effort
            pass


# ---------- main ---------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Launch the TrendVault Coder web UI with a live terminal dashboard.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("WEB_PORT", DEFAULT_PORT)),
        help=f"Port for the web UI (default: {DEFAULT_PORT}; also reads $WEB_PORT)",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Don't auto-open the browser",
    )
    parser.add_argument(
        "--no-kill",
        action="store_true",
        help="Fail if the port is busy instead of stopping the previous process",
    )
    parser.add_argument(
        "--plain",
        action="store_true",
        help="Use a plain non-TUI mode (no live refresh — useful for CI/redirection)",
    )
    args = parser.parse_args()

    repo_root = find_repo_root()
    npm = find_npm()
    launcher = Launcher(args.port, args.no_browser, args.no_kill, repo_root, npm)

    # Plain mode is forced when stdout isn't a TTY (pipes, CI logs, etc.) so
    # users always see progress, never an empty buffer.
    use_plain = args.plain or not sys.stdout.isatty()

    if use_plain:
        _run_plain(launcher)
        return

    try:
        with Live(launcher, console=console, refresh_per_second=12, screen=False):
            # Run setup in a thread so the spinner keeps animating.
            setup_thread = threading.Thread(target=launcher.setup, daemon=True)
            setup_thread.start()
            # Block until the server exits (or setup never produced one).
            while True:
                if launcher.failure_message:
                    break
                if launcher.proc is not None and launcher.proc.poll() is not None:
                    # The npm server exited.
                    break
                time.sleep(0.2)
    except KeyboardInterrupt:
        launcher.shutdown()

    rc = launcher.proc.returncode if launcher.proc else 1
    if launcher.failure_message:
        console.print(f"[red]{launcher.failure_message}[/]")
    sys.exit(rc or 0)


def _run_plain(launcher: Launcher) -> None:
    """Fallback non-TUI runner. Useful in CI or when piping output to a file."""
    last_log_count = 0
    setup_thread = threading.Thread(target=launcher.setup, daemon=True)
    setup_thread.start()
    last_states: dict[str, str] = {}
    try:
        while True:
            # Print step changes
            for key, label in STEP_ORDER:
                state = launcher.steps[key]
                if last_states.get(key) != state:
                    detail = launcher.step_detail.get(key, "")
                    suffix = f" — {detail}" if detail else ""
                    icon = {ACTIVE: ">>", DONE: "OK", FAILED: "!!", SKIPPED: "--"}.get(state, "..")
                    print(f"  [{icon}] {label}{suffix}")
                    last_states[key] = state
            # Print new server output lines
            current = list(launcher.log_lines)
            if len(current) > last_log_count:
                for line in current[last_log_count:]:
                    print(f"    {line}")
                last_log_count = len(current)
            if launcher.failure_message:
                print(f"\n  ERROR: {launcher.failure_message}")
                break
            if launcher.proc is not None and launcher.proc.poll() is not None:
                break
            time.sleep(0.2)
    except KeyboardInterrupt:
        launcher.shutdown()


if __name__ == "__main__":
    main()
