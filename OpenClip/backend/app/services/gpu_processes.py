"""This program's services and their GPU memory use — list + pause/resume.

The Models & GPU dashboard lists *this program's own services* — one row each for
the API server, the background worker and the web frontend (from the pid-files
``launch.py`` records under ``data/run``), plus the model servers Open-Clip drives:
**Ollama** (LLM + embeddings) and the **Fish Speech / s2.cpp** voice server. It does
*not* list every GPU consumer on the machine. (Whisper transcription and pyannote
diarization run in-process inside the worker, so their GPU memory is already counted
under the "Background worker" row — there's no separate process for them.) Services
that aren't currently using the GPU still appear (``used_vram_bytes == 0``) so they
can be managed from one place. Each row has a toggle that **suspends** the service
(freezes every thread in its process tree so it stops doing CPU/GPU work) and
**resumes** it later — reversible, "until we need it on again" — plus an optional
hard terminate.

Each service is really a small process tree (the frontend is ``cmd → npm → node``;
the API/worker re-exec into a child interpreter), so VRAM is summed across the tree
and actions span it. The API server's tree contains *this* request handler, so it's
flagged ``can_control=False`` — suspending or killing it would deadlock the call —
as is any tree holding a protected system process; the service refuses to touch
them no matter what the client asks.

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
from pathlib import Path
from urllib.parse import urlsplit

import psutil

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# Root directory of the Open-Clip app (the folder holding ``launch.py`` and
# ``backend/``). This file lives at
# ``<root>/backend/app/services/gpu_processes.py``.
_PROGRAM_ROOT = Path(__file__).resolve().parents[3]

# Where ``launch.py`` records each background service's PID (``<name>.pid``). These
# files are the authoritative list of *this program's* processes — the dashboard
# shows one row per service rather than every GPU consumer on the machine.
_RUN_DIR = _PROGRAM_ROOT / "data" / "run"

# The launcher-tracked services, in dashboard display order, as
# ``(pid_file_stem, friendly_label)``. Each maps to a small process tree (e.g. the
# frontend is ``cmd → npm → node``); we collapse each tree into a single row.
#
# NOTE: Whisper transcription (faster-whisper) and pyannote diarization run
# *in-process* inside the Celery worker, not as separate processes — so their GPU
# memory already shows up under the "Background worker" row; there's nothing extra
# to list for them.
_SERVICES: tuple[tuple[str, str], ...] = (
    ("api", "API server"),
    ("worker", "Background worker (Whisper + jobs)"),
    ("frontend", "Web frontend"),
)


class _ExternalServer:
    """A model server Open-Clip drives but ``launch.py`` doesn't track via a pid-file.

    These run on their own (a system ``ollama serve``, the s2.cpp voice server
    started from its own launcher), so we discover them at runtime: first by the
    loopback port they listen on (read from settings), then by an image-name /
    command-line fallback. Only shown when actually running.
    """

    def __init__(self, label: str, url: str | None, name_prefixes: tuple[str, ...], cmdline_hints: tuple[str, ...] = ()):
        self.label = label
        self.url = url
        self.name_prefixes = name_prefixes
        self.cmdline_hints = cmdline_hints

    def matches(self, name: str, cmdline: str) -> bool:
        if not name.startswith(self.name_prefixes):
            return False
        # When hints are given (e.g. s2's ``--server``), require one so we don't
        # grab an unrelated binary that merely shares the name prefix.
        return not self.cmdline_hints or any(h in cmdline for h in self.cmdline_hints)


# Model servers Open-Clip talks to that aren't launcher-managed. Ports come from
# settings so they track the operator's config.
_EXTERNAL_SERVERS: tuple[_ExternalServer, ...] = (
    _ExternalServer("Ollama (LLM + embeddings)", settings.OLLAMA_BASE_URL, ("ollama",)),
    _ExternalServer("Fish Speech (voice)", settings.FISH_TTS_URL, ("s2",), ("--server", "s2-pro")),
)

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


def _is_controllable_pid(pid: int) -> bool:
    """:func:`_is_controllable` by PID — ``False`` if the process is already gone."""
    try:
        return _is_controllable(psutil.Process(pid))
    except psutil.NoSuchProcess:
        return False


def _read_service_pid(name: str) -> int | None:
    """Root PID recorded by ``launch.py`` for service ``name`` (``data/run/<name>.pid``)."""
    try:
        return int((_RUN_DIR / f"{name}.pid").read_text().strip())
    except (OSError, ValueError):
        return None


def _process_tree(pid: int) -> list[psutil.Process]:
    """A process and all its live descendants (root first). Empty if it's gone.

    Services run as small trees — ``cmd → npm → node`` for the frontend, a
    ``python`` re-exec child for the API/worker — so an action or a VRAM tally for
    "the service" must span the whole tree, not just the recorded root PID.
    """
    try:
        root = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return []
    tree = [root]
    try:
        tree.extend(root.children(recursive=True))
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass
    return tree


def _pid_listening_on(port: int) -> int | None:
    """PID of the process listening on a loopback ``port``, if we can see it.

    The most reliable way to find a model server is "who owns the port Open-Clip
    connects to" — independent of how the binary is named or where it was started.
    Best-effort: returns ``None`` if the connection table is inaccessible.
    """
    try:
        conns = psutil.net_connections(kind="inet")
    except (psutil.AccessDenied, psutil.Error, OSError) as exc:
        logger.debug("Could not read socket table for port %s: %s", port, exc)
        return None
    for conn in conns:
        if (
            conn.status == psutil.CONN_LISTEN
            and conn.laddr
            and conn.laddr.port == port
            and conn.pid
        ):
            return conn.pid
    return None


def _external_server_tree(server: _ExternalServer) -> list[psutil.Process]:
    """The process tree of an :class:`_ExternalServer`, or ``[]`` if it isn't running.

    Resolves the server first by the loopback port it listens on (from settings),
    then by an image-name/command-line scan — so it's found whether or not it was
    started by Open-Clip and regardless of the exe's exact name.
    """
    port = urlsplit(server.url).port if server.url else None
    if port is not None:
        pid = _pid_listening_on(port)
        if pid is not None:
            tree = _process_tree(pid)
            if tree:
                return tree
    found: dict[int, psutil.Process] = {}
    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        name = (proc.info.get("name") or "").lower()
        cmdline = " ".join(proc.info.get("cmdline") or []).lower()
        if server.matches(name, cmdline):
            for member in _process_tree(proc.info["pid"]):
                found[member.pid] = member
    return list(found.values())


def _build_unit(
    label: str, tree: list[psutil.Process], usage: dict[int, int], *, locked: bool = False
) -> dict:
    """Collapse a service's process tree into one dashboard row.

    VRAM is summed across the whole tree; ``can_control`` is ``False`` when
    ``locked`` (the API server, which runs this request), when the tree contains
    this very process, or when any member is a protected system process.
    ``command`` and ``suspended`` come from the root.
    """
    root = tree[0]
    pids = {p.pid for p in tree}
    vram = sum(usage.get(pid, 0) for pid in pids)
    try:
        command = " ".join(root.cmdline()) or root.name()
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        command = label
    try:
        suspended = root.status() == psutil.STATUS_STOPPED
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        suspended = False
    controllable = (
        not locked
        and os.getpid() not in pids
        and all(_is_controllable_pid(pid) for pid in pids)
    )
    return {
        "pid": root.pid,
        "name": label,
        "command": command,
        "used_vram_bytes": vram,
        "suspended": suspended,
        "can_control": controllable,
    }


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
    """This program's services, with the GPU VRAM each is using.

    One row per launcher-tracked service (API server, background worker, web
    frontend) plus each model server Open-Clip drives (Ollama, Fish Speech) — *not*
    every GPU consumer on the machine. Whisper and diarization run inside the worker,
    so their VRAM is counted there. Services that aren't using the GPU still appear,
    with ``used_vram_bytes == 0``, so the dashboard can pause/resume/terminate them.

    Each entry: ``{pid, name, command, used_vram_bytes, suspended, can_control}``,
    sorted by VRAM descending. ``suspended`` reflects the live process state so the
    UI toggle stays in sync; ``can_control`` is ``False`` for the API server (it
    runs this request) and any service tree holding a protected process. Empty only
    when no services are running.

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
    """Uncached, one row per program service — see :func:`list_gpu_processes`."""
    usage = _vram_by_pid()  # ``pid -> VRAM bytes``; empty on CPU-only hosts
    units: list[dict] = []
    for stem, label in _SERVICES:
        pid = _read_service_pid(stem)
        if pid is None:
            continue
        tree = _process_tree(pid)
        if tree:
            # The API server answers this very request — never offer to pause/kill it.
            units.append(_build_unit(label, tree, usage, locked=stem == "api"))
    for server in _EXTERNAL_SERVERS:
        tree = _external_server_tree(server)
        if tree:
            units.append(_build_unit(server.label, tree, usage))
    units.sort(key=lambda u: u["used_vram_bytes"], reverse=True)
    return units


def _guarded_targets(pid: int, action: str) -> list[psutil.Process] | None:
    """The controllable processes in ``pid``'s tree, or ``None`` if it's off-limits.

    Services run as trees (the recorded ``pid`` is just the root), so an action
    must span the tree. Refuses outright if the tree contains this API server —
    suspending or killing the process answering the request would hang the call —
    and skips individually protected members (e.g. a shared system child). Returns
    ``None`` (refused / nothing actionable) or a non-empty target list.
    """
    tree = _process_tree(pid)
    if not tree:
        return None
    if os.getpid() in {p.pid for p in tree}:
        logger.warning("Refusing to %s the API server's own process tree (PID %s)", action, pid)
        return None
    targets = [p for p in tree if _is_controllable(p)]
    if not targets:
        logger.warning("Refusing to %s protected PID %s", action, pid)
        return None
    return targets


def set_process_suspended(pid: int, suspended: bool) -> bool:
    """Suspend (freeze) or resume a service's process tree — the on/off toggle.

    Suspending pauses every thread of the service (root and all descendants) so it
    stops competing for the CPU/GPU; resuming picks up where it left off. Refuses
    the API server tree and protected processes (see :func:`_guarded_targets`).
    Returns ``True`` if at least one process was toggled.
    """
    action = "suspend" if suspended else "resume"
    targets = _guarded_targets(pid, action)
    if targets is None:
        return False
    changed = False
    for proc in targets:
        try:
            proc.suspend() if suspended else proc.resume()
            changed = True
        except (psutil.NoSuchProcess, psutil.AccessDenied) as exc:
            logger.warning("Could not %s PID %s: %s", action, proc.pid, exc)
    if changed:
        _invalidate_cache()
        logger.info("%s service tree at PID %s (%d process(es))", action.title() + "d", pid, len(targets))
    return changed


def terminate_gpu_process(pid: int) -> bool:
    """Hard-terminate a service's process tree to free its VRAM.

    Kills descendants before the root, resuming any suspended process first so it
    can act on the signal. Refuses the API server tree and protected processes (see
    :func:`_guarded_targets`). Returns ``True`` if anything was asked to stop.
    """
    targets = _guarded_targets(pid, "terminate")
    if targets is None:
        return False
    # Resume any frozen target so it can actually process the terminate signal.
    for proc in targets:
        try:
            if proc.status() == psutil.STATUS_STOPPED:
                proc.resume()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    # ``_process_tree`` lists root-first, so reverse to kill leaves before parents.
    asked = False
    for proc in reversed(targets):
        try:
            proc.terminate()
            asked = True
        except (psutil.NoSuchProcess, psutil.AccessDenied) as exc:
            logger.warning("Could not terminate PID %s: %s", proc.pid, exc)
    _, alive = psutil.wait_procs(targets, timeout=5)
    for proc in alive:
        try:
            proc.kill()  # graceful term didn't take — force it
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    if asked:
        _invalidate_cache()
        logger.info("Terminated service tree at PID %s (%d process(es))", pid, len(targets))
    return asked
