"""GPU (VRAM-consuming) processes that belong to this program — list + pause/resume.

The Models & GPU dashboard lists only *this program's* processes that are holding
GPU memory: the Open-Clip process tree (the launcher and every worker it spawns)
plus the **Ollama** model server Open-Clip drives for inference. Unrelated GPU
consumers on the machine (Chrome, games, other apps) are filtered out — see
:func:`_program_pids`. Each process has a toggle that **suspends** it (freezes all
its threads so it stops doing CPU/GPU work) and **resumes** it later — reversible,
"until we need it on again" — plus an optional hard terminate.

Suspending or killing certain Windows processes (the session/kernel critical ones,
the desktop compositor, this very API server) would hang the machine or deadlock
the request, so those are flagged ``can_control=False`` and the service refuses to
touch them no matter what the client asks.

Per-process VRAM comes from the Windows ``GPU Process Memory`` performance counter
(reliable on consumer GeForce cards, where ``nvidia-smi`` reports ``[N/A]``), with
an ``nvidia-smi`` fallback for non-Windows hosts.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import threading
import time
from collections import defaultdict
from pathlib import Path

import psutil

from app.core.logging import get_logger

logger = get_logger(__name__)

# Root directory of the Open-Clip app (the folder holding ``launch.py`` and
# ``backend/``). Every program process — the launcher, the API server, the Celery
# workers — runs with this path in its command line or executable, so it's how we
# recognize "our" processes when scoping the GPU list (see :func:`_program_pids`).
# This file lives at ``<root>/backend/app/services/gpu_processes.py``.
_PROGRAM_ROOT = str(Path(__file__).resolve().parents[3]).lower()

# Image-name prefix of the Ollama model server (``ollama.exe serve`` and the
# inference runners it spawns). Ollama installs outside the project tree, so it's
# matched by name rather than path. Open-Clip drives it for inference, so it counts
# as part of "this program" for the GPU dashboard.
_OLLAMA_PREFIX = "ollama"

# The per-process VRAM probe shells out to PowerShell (``Get-Counter``) on
# Windows, which costs ~1-2s per call — far too slow to repeat on every 5s poll
# of the dashboard. Cache the assembled listing for a short window so rapid
# re-renders and the dashboard's polling reuse a recent result instead of
# re-spawning PowerShell each time. VRAM figures move slowly; a few seconds of
# staleness is invisible to the operator.
_CACHE_TTL_SECONDS = 4.0
_cache_lock = threading.Lock()
_cache: dict[str, object] = {"at": 0.0, "value": None}

# Processes we must never suspend or kill — doing so hangs the session, freezes
# the display, or deadlocks this API server. Matched case-insensitively by image
# name. ``os.getpid()`` (and the running interpreter) is guarded separately.
_PROTECTED_NAMES = frozenset(
    {
        "system",
        "system idle process",
        "registry",
        "memory compression",
        "memcompression",
        "smss.exe",
        "csrss.exe",
        "wininit.exe",
        "winlogon.exe",
        "services.exe",
        "lsass.exe",
        "svchost.exe",
        "dwm.exe",  # desktop compositor — suspending freezes the whole screen
        "fontdrvhost.exe",
        "ntoskrnl.exe",
        "wudfhost.exe",
        "ctfmon.exe",
    }
)


def _is_controllable(proc: psutil.Process) -> bool:
    """Whether we'll allow suspend/resume/terminate on this process.

    Refuses protected system processes and our own API process (suspending the
    request handler would deadlock the call). Used as the authorization gate for
    every mutating action — the client cannot override it.
    """
    if proc.pid in (os.getpid(), 0, 4):
        return False
    try:
        if (proc.name() or "").lower() in _PROTECTED_NAMES:
            return False
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        return False
    return True


def _program_pids() -> set[int]:
    """PIDs that belong to this program: the Open-Clip tree plus Ollama.

    Used to scope the GPU dashboard to *our* GPU consumers and hide everything
    else on the machine. A process is "ours" if either:

    * it (or an ancestor) runs from the Open-Clip root — the launcher, the API
      server, the Celery workers, and any helper they spawn. We seed on the
      launcher/API processes (whose command line carries the project path) and
      expand to all their descendants, so worker processes started via a bare
      ``-m uvicorn``/``-m celery`` command line (no project path of their own)
      are still included via their parent; **or**
    * its image name is the Ollama model server (and its inference-runner
      children), which Open-Clip drives for inference.

    Returns the set of owning PIDs. Best-effort: processes that vanish or deny
    access mid-scan are simply skipped.
    """
    children: dict[int, list[int]] = defaultdict(list)
    seeds: set[int] = {os.getpid()}
    for proc in psutil.process_iter(["pid", "ppid", "name", "exe", "cmdline"]):
        info = proc.info
        pid = info.get("pid")
        if pid is None:
            continue
        ppid = info.get("ppid")
        if ppid is not None:
            children[ppid].append(pid)
        if (info.get("name") or "").lower().startswith(_OLLAMA_PREFIX):
            seeds.add(pid)
            continue
        haystack = " ".join(
            [info.get("exe") or "", *(info.get("cmdline") or [])]
        ).lower()
        if _PROGRAM_ROOT in haystack:
            seeds.add(pid)

    # Expand each seed to its whole subtree so child workers/runners that don't
    # carry the project path themselves are pulled in via their parent.
    owned: set[int] = set()
    stack = list(seeds)
    while stack:
        pid = stack.pop()
        if pid in owned:
            continue
        owned.add(pid)
        stack.extend(children.get(pid, ()))
    return owned


_PID_RE = re.compile(r"pid_(\d+)")


def _vram_by_pid_windows() -> dict[int, int]:
    """``pid -> dedicated VRAM bytes`` from the Windows ``GPU Process Memory`` counter.

    This is the reliable per-process source on Windows: ``nvidia-smi`` reports
    ``[N/A]`` for per-process memory on consumer GeForce cards in WDDM mode, but
    the performance counter works for every GPU vendor. A process can appear under
    several adapter instances — we sum them.
    """
    ps = shutil.which("powershell") or shutil.which("pwsh")
    if not ps:
        return {}
    script = (
        "$ErrorActionPreference='SilentlyContinue';"
        "(Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage').CounterSamples "
        "| ForEach-Object { '{0}={1}' -f $_.InstanceName, [int64]$_.CookedValue }"
    )
    try:
        out = subprocess.run(  # noqa: S603 - fixed args, no shell
            [ps, "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("GPU Process Memory counter probe failed: %s", exc)
        return {}
    usage: dict[int, int] = {}
    for line in out.stdout.splitlines():
        inst, sep, val = line.strip().partition("=")
        if not sep:
            continue
        match = _PID_RE.search(inst)
        if not match:
            continue
        try:
            byts = int(val)
        except ValueError:
            continue
        if byts <= 0:
            continue
        pid = int(match.group(1))
        usage[pid] = usage.get(pid, 0) + byts
    return usage


def _vram_by_pid_nvidia() -> dict[int, int]:
    """``pid -> VRAM bytes`` from ``nvidia-smi`` (non-Windows fallback).

    Returns an empty map on CPU-only hosts (no ``nvidia-smi``) — callers treat
    that as "no GPU processes", not an error.
    """
    exe = shutil.which("nvidia-smi")
    if not exe:
        return {}
    try:
        out = subprocess.run(  # noqa: S603 - fixed args, no shell
            [
                exe,
                "--query-compute-apps=pid,used_gpu_memory",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("nvidia-smi compute-apps probe failed: %s", exc)
        return {}
    usage: dict[int, int] = {}
    for line in out.stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 2:
            continue
        try:
            usage[int(parts[0])] = int(float(parts[1])) * 1024 * 1024  # MiB -> bytes
        except ValueError:
            continue  # "[N/A]" — per-process memory unsupported on this GPU
    return usage


def _vram_by_pid() -> dict[int, int]:
    """``pid -> VRAM bytes`` for every process using the GPU, platform-appropriate."""
    if sys.platform == "win32":
        win = _vram_by_pid_windows()
        if win:
            return win
    return _vram_by_pid_nvidia()


def _invalidate_cache() -> None:
    """Drop the cached process listing so the next read reflects a just-made change."""
    with _cache_lock:
        _cache["at"] = 0.0
        _cache["value"] = None


def list_gpu_processes() -> list[dict]:
    """This program's processes currently using GPU VRAM.

    Scoped to the Open-Clip process tree plus the Ollama model server (see
    :func:`_program_pids`); unrelated GPU consumers on the machine are excluded.
    Each entry: ``{pid, name, command, used_vram_bytes, suspended, can_control}``,
    sorted by VRAM descending. ``suspended`` reflects the live process state so the
    UI toggle stays in sync; ``can_control`` is ``False`` for protected processes.
    Empty on CPU-only hosts.

    Results are cached for a few seconds (see :data:`_CACHE_TTL_SECONDS`) so the
    dashboard's polling doesn't re-spawn the slow PowerShell counter probe on every
    tick; mutating actions bust the cache so the toggle state stays in sync.
    """
    now = time.monotonic()
    with _cache_lock:
        cached = _cache["value"]
        if cached is not None and now - float(_cache["at"]) < _CACHE_TTL_SECONDS:
            return cached  # type: ignore[return-value]

    procs = _collect_gpu_processes()

    with _cache_lock:
        _cache["at"] = time.monotonic()
        _cache["value"] = procs
    return procs


def _collect_gpu_processes() -> list[dict]:
    """Uncached enumeration of GPU-VRAM-holding processes — see :func:`list_gpu_processes`."""
    usage = _vram_by_pid()
    if not usage:
        return []
    # Keep only VRAM held by this program (Open-Clip tree + Ollama); drop every
    # unrelated GPU consumer on the machine.
    owned = _program_pids()
    usage = {pid: vram for pid, vram in usage.items() if pid in owned}
    if not usage:
        return []
    procs: list[dict] = []
    for pid, vram in usage.items():
        name = f"pid {pid}"
        command = ""
        suspended = False
        controllable = False
        try:
            p = psutil.Process(pid)
            name = p.name() or name
            try:
                command = " ".join(p.cmdline()) or name
            except (psutil.AccessDenied, psutil.ZombieProcess):
                command = name
            suspended = p.status() == psutil.STATUS_STOPPED
            controllable = _is_controllable(p)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass
        procs.append(
            {
                "pid": pid,
                "name": name,
                "command": command,
                "used_vram_bytes": vram,
                "suspended": suspended,
                "can_control": controllable,
            }
        )
    procs.sort(key=lambda x: x["used_vram_bytes"], reverse=True)
    return procs


def set_process_suspended(pid: int, suspended: bool) -> bool:
    """Suspend (freeze) or resume a GPU process — the dashboard on/off toggle.

    Suspending pauses every thread of the process so it stops competing for the
    CPU/GPU; resuming picks up exactly where it left off. Refuses protected
    processes (see :func:`_is_controllable`). Returns ``True`` on success.
    """
    try:
        proc = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return False
    if not _is_controllable(proc):
        logger.warning("Refusing to %s protected PID %s", "suspend" if suspended else "resume", pid)
        return False
    try:
        if suspended:
            proc.suspend()
        else:
            proc.resume()
        _invalidate_cache()
        logger.info("%s GPU process %s (%s)", "Suspended" if suspended else "Resumed", pid, proc.name())
        return True
    except (psutil.NoSuchProcess, psutil.AccessDenied) as exc:
        logger.warning("Could not toggle PID %s: %s", pid, exc)
        return False


def terminate_gpu_process(pid: int) -> bool:
    """Hard-terminate a GPU process by PID to free its VRAM.

    Refuses protected processes (kernel/session-critical, the API server itself),
    so the dashboard can never kill something that would crash the machine. Returns
    ``True`` if the process was asked to stop, ``False`` if it's protected / gone.
    """
    try:
        proc = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return False
    if not _is_controllable(proc):
        logger.warning("Refusing to terminate protected PID %s", pid)
        return False
    try:
        # Resume first so a suspended process can actually process the signal.
        try:
            if proc.status() == psutil.STATUS_STOPPED:
                proc.resume()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except psutil.TimeoutExpired:
            proc.kill()  # graceful term didn't take — force it
        _invalidate_cache()
        logger.info("Terminated GPU process %s (%s)", pid, proc.name())
        return True
    except (psutil.NoSuchProcess, psutil.AccessDenied) as exc:
        logger.warning("Could not terminate PID %s: %s", pid, exc)
        return False
