"""Personal assistant routes — resolve the per-user singleton, read/write
its settings, and list its scheduled check-in tasks.

The personal assistant is just a specially-flagged CrewMember that owns one
pinned Session and three daily ScheduledTasks ("Morning/Midday/Evening
check-in"). Everything about it is user-editable: name, personality, model,
enabled tools, timezone, and the three check-in times/prompts/enabled flags.
"""

import asyncio
import json
import os
import shutil
import subprocess
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from core.database import SessionLocal, CrewMember, ScheduledTask
from core.middleware import require_admin
from src.auth_helpers import get_current_user
from src.task_scheduler import compute_next_run


class CheckInUpdate(BaseModel):
    id: str                               # ScheduledTask.id
    name: Optional[str] = None
    scheduled_time: Optional[str] = None  # "HH:MM"
    prompt: Optional[str] = None
    enabled: Optional[bool] = None        # maps to status "active"/"paused"


class AssistantSettingsUpdate(BaseModel):
    name: Optional[str] = None
    avatar: Optional[str] = None
    personality: Optional[str] = None
    model: Optional[str] = None
    endpoint_url: Optional[str] = None
    enabled_tools: Optional[list[str]] = None
    allow_autonomous_email: Optional[bool] = None  # convenience toggle
    timezone: Optional[str] = None
    check_ins: Optional[list[CheckInUpdate]] = None


class WorkingDirUpdate(BaseModel):
    # Empty / null clears the override and falls back to the data/ workspace.
    path: Optional[str] = None


class GitBranchRequest(BaseModel):
    branch: Optional[str] = None


class RootPathRequest(BaseModel):
    path: Optional[str] = None


_EMAIL_TOOLS = {"send_email", "reply_to_email"}


def _git_info(path: str) -> dict:
    """Best-effort git branch + linked-worktree detection for a directory.

    Used only to decorate the working-directory chip in the UI; every failure
    degrades to "not a git repo" rather than raising.
    """
    info = {"is_git": False, "branch": None, "is_worktree": False}
    if not path or not os.path.isdir(path) or not shutil.which("git"):
        return info

    def _git(*args: str) -> Optional[str]:
        try:
            r = subprocess.run(
                ["git", "-C", path, *args],
                capture_output=True, text=True, timeout=3,
            )
            return r.stdout.strip() if r.returncode == 0 else None
        except Exception:
            return None

    if _git("rev-parse", "--is-inside-work-tree") != "true":
        return info
    info["is_git"] = True
    branch = _git("rev-parse", "--abbrev-ref", "HEAD")
    info["branch"] = branch if branch and branch != "HEAD" else None
    # A linked worktree's per-worktree git dir differs from the common dir.
    git_dir = _git("rev-parse", "--git-dir")
    common_dir = _git("rev-parse", "--git-common-dir")
    if git_dir and common_dir:
        try:
            g = os.path.realpath(os.path.join(path, git_dir))
            c = os.path.realpath(os.path.join(path, common_dir))
            info["is_worktree"] = g != c
        except OSError:
            pass
    return info


def _working_dir_payload() -> dict:
    """Assemble the working-directory chip metadata (path + git state)."""
    from src.settings import get_setting
    from src.constants import DATA_DIR
    raw = (get_setting("agent_working_dir") or "").strip()
    is_default = not raw
    try:
        effective = os.path.realpath(os.path.expanduser(raw)) if raw else os.path.realpath(DATA_DIR)
    except OSError:
        effective = raw or DATA_DIR
    exists = os.path.isdir(effective)
    git = _git_info(effective) if exists else {"is_git": False, "branch": None, "is_worktree": False}
    name = os.path.basename(effective.rstrip(os.sep)) or effective

    # Recent working directories (active first) for the folder-picker dropdown.
    recent = []
    seen = set()
    stored = get_setting("agent_working_dir_recent") or []
    for p in [effective] + [r for r in stored if isinstance(r, str) and r.strip()]:
        try:
            rp = os.path.realpath(os.path.expanduser(p))
        except OSError:
            continue
        if rp in seen:
            continue
        seen.add(rp)
        recent.append({
            "path": rp,
            "name": os.path.basename(rp.rstrip(os.sep)) or rp,
            "is_active": rp == effective,
            "exists": os.path.isdir(rp),
        })
        if len(recent) >= 10:
            break

    return {
        "location": "Local",
        "path": effective,
        "configured_path": raw,
        "name": name,
        "exists": exists,
        "is_default": is_default,
        "is_git": git["is_git"],
        "git_branch": git["branch"],
        "is_worktree": git["is_worktree"],
        "recent": recent,
    }


def _crew_to_dict(c: CrewMember) -> dict:
    try:
        tools = json.loads(c.enabled_tools) if c.enabled_tools else []
    except Exception:
        tools = []
    return {
        "id": c.id,
        "name": c.name,
        "avatar": c.avatar,
        "personality": c.personality,
        "model": c.model,
        "endpoint_url": c.endpoint_url,
        "greeting": c.greeting,
        "enabled_tools": tools,
        "session_id": c.session_id,
        "is_default_assistant": bool(c.is_default_assistant),
        "timezone": c.timezone,
        "allow_autonomous_email": any(t in _EMAIL_TOOLS for t in tools),
    }


def _task_to_checkin_dict(t: ScheduledTask) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "scheduled_time": t.scheduled_time,
        "prompt": t.prompt,
        "enabled": (t.status or "active") == "active",
        "next_run": t.next_run.isoformat() + "Z" if t.next_run else None,
        "last_run": t.last_run.isoformat() + "Z" if t.last_run else None,
        "run_count": t.run_count or 0,
    }


def _list_dir_payload(path: str) -> dict:
    """List the sub-directories of `path` for the folder picker.

    Directories only (it's a folder picker), dot-folders hidden, with the
    parent + home for navigation. Raises HTTPException with a human message
    on a bad/inaccessible path so the UI can show "Couldn't list: …".
    """
    home = os.path.expanduser("~")
    raw = (path or "").strip()
    try:
        target = os.path.realpath(os.path.expanduser(raw)) if raw else home
    except OSError:
        raise HTTPException(status_code=400, detail="Invalid path")
    if not os.path.isdir(target):
        raise HTTPException(status_code=400, detail=f"Not a directory: {target}")
    parent = os.path.dirname(target.rstrip(os.sep)) or None
    if parent == target:
        parent = None  # filesystem root
    entries = []
    try:
        with os.scandir(target) as it:
            for e in it:
                if e.name.startswith("."):
                    continue
                try:
                    if e.is_dir(follow_symlinks=False):
                        entries.append({"name": e.name, "path": os.path.join(target, e.name)})
                except OSError:
                    continue
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {target}")
    except OSError as ex:
        raise HTTPException(status_code=400, detail=f"Cannot list: {ex}")
    entries.sort(key=lambda x: x["name"].lower())
    return {"path": target, "parent": parent, "home": home, "entries": entries[:1000]}


def _git_run(cwd: str, *args: str, timeout: int = 15):
    """Run a git command in cwd; return (returncode, stdout, stderr)."""
    try:
        r = subprocess.run(["git", "-C", cwd, *args],
                           capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()
    except Exception as ex:
        return 1, "", str(ex)


def _agent_workdir() -> str:
    from src.tool_execution import get_agent_working_dir
    from src.constants import DATA_DIR
    return get_agent_working_dir() or os.path.realpath(DATA_DIR)


def _git_state_payload() -> dict:
    """Branch + local-branch list + worktree list for the working dir's repo."""
    wd = _agent_workdir()
    info = {"is_git": False, "path": wd, "branch": None, "is_worktree": False,
            "repo_root": None, "branches": [], "worktrees": []}
    if not shutil.which("git") or not os.path.isdir(wd):
        return info
    code, out, _ = _git_run(wd, "rev-parse", "--is-inside-work-tree")
    if code != 0 or out != "true":
        return info
    info["is_git"] = True
    _, branch, _ = _git_run(wd, "rev-parse", "--abbrev-ref", "HEAD")
    info["branch"] = branch if branch and branch != "HEAD" else None
    _, root, _ = _git_run(wd, "rev-parse", "--show-toplevel")
    info["repo_root"] = os.path.realpath(root) if root else None
    info["is_worktree"] = _git_info(wd).get("is_worktree", False)
    _, br, _ = _git_run(wd, "for-each-ref", "--format=%(refname:short)", "refs/heads")
    info["branches"] = [b for b in br.splitlines() if b][:300]
    _, wt, _ = _git_run(wd, "worktree", "list", "--porcelain")
    worktrees, cur = [], None
    for line in wt.splitlines():
        if line.startswith("worktree "):
            if cur:
                worktrees.append(cur)
            cur = {"path": line[9:], "branch": None}
        elif line.startswith("branch ") and cur is not None:
            cur["branch"] = line[7:].replace("refs/heads/", "")
        elif line.startswith("detached") and cur is not None:
            cur["branch"] = None
    if cur:
        worktrees.append(cur)
    # Mark the worktree that *contains* the working dir (longest path prefix),
    # since the working dir may be a sub-folder of a worktree root.
    wd_norm = wd.rstrip(os.sep)
    best = None
    for w in worktrees:
        try:
            w["path"] = os.path.realpath(w["path"])
        except OSError:
            pass
        w["is_current"] = False
        w["name"] = os.path.basename((w.get("path") or "").rstrip(os.sep)) or w.get("path") or "?"
        p = (w.get("path") or "").rstrip(os.sep)
        if p and (wd_norm == p or wd_norm.startswith(p + os.sep)):
            if best is None or len(p) > len((best.get("path") or "").rstrip(os.sep)):
                best = w
    if best:
        best["is_current"] = True
    info["worktrees"] = worktrees
    return info


def _roots_payload() -> dict:
    """Directories the agent's file tools may access: the working dir plus the
    user-added extra roots (the ``tool_path_extra_roots`` allowlist)."""
    from src.settings import get_setting
    from src.tool_execution import get_agent_working_dir
    from src.constants import DATA_DIR
    wd = get_agent_working_dir() or os.path.realpath(DATA_DIR)
    extra, seen = [], set()
    for p in (get_setting("tool_path_extra_roots") or []):
        if not isinstance(p, str) or not p.strip():
            continue
        try:
            rp = os.path.realpath(os.path.expanduser(p))
        except OSError:
            continue
        if rp in seen:
            continue
        seen.add(rp)
        extra.append({"path": rp, "name": os.path.basename(rp.rstrip(os.sep)) or rp,
                      "exists": os.path.isdir(rp)})
    return {
        "working_dir": {"path": wd, "name": os.path.basename(wd.rstrip(os.sep)) or wd,
                        "exists": os.path.isdir(wd)},
        "extra": extra,
    }


def setup_assistant_routes(task_scheduler) -> APIRouter:
    router = APIRouter(prefix="/api/assistant", tags=["assistant"])

    def _owner(request: Request) -> str:
        owner = get_current_user(request)
        if not owner:
            raise HTTPException(status_code=401, detail="Not authenticated")
        return owner

    # Synthetic / non-human owners that should NEVER get an assistant +
    # check-in tasks seeded. Hitting any /assistant route under one of these
    # used to seed a full CrewMember + Morning/Midday/Evening tasks under that
    # owner, which then double-fired alongside the real user's check-ins.
    _SYNTHETIC_OWNERS = frozenset({"internal-tool", "api", "demo", "system", ""})

    async def _get_or_create(owner: str) -> CrewMember:
        """Return the per-owner assistant CrewMember, creating it on demand."""
        if not owner or owner in _SYNTHETIC_OWNERS:
            raise HTTPException(status_code=400, detail=f"Cannot seed assistant for {owner!r}")
        db = SessionLocal()
        try:
            crew = db.query(CrewMember).filter(
                CrewMember.owner == owner,
                CrewMember.is_default_assistant == True,  # noqa: E712
            ).first()
            if crew:
                return crew
        finally:
            db.close()
        # Seed lazily. This is the same code the startup hook runs for each
        # user — safe to call again, it's idempotent.
        await task_scheduler.ensure_assistant_defaults(owner)
        db = SessionLocal()
        try:
            crew = db.query(CrewMember).filter(
                CrewMember.owner == owner,
                CrewMember.is_default_assistant == True,  # noqa: E712
            ).first()
            return crew
        finally:
            db.close()

    @router.get("/session")
    async def get_assistant_session(request: Request):
        """Resolve (or lazily create) the pinned Assistant session for this user."""
        owner = _owner(request)
        crew = await _get_or_create(owner)
        if not crew or not crew.session_id:
            raise HTTPException(status_code=500, detail="Assistant session could not be resolved")
        return {
            "session_id": crew.session_id,
            "crew_member_id": crew.id,
            "name": crew.name,
        }

    @router.get("/settings")
    async def get_assistant_settings(request: Request):
        """Return CrewMember fields + the three check-in task rows + task IDs for logs."""
        owner = _owner(request)
        crew = await _get_or_create(owner)
        if not crew:
            raise HTTPException(status_code=500, detail="Assistant not available")
        db = SessionLocal()
        try:
            tasks = db.query(ScheduledTask).filter(
                ScheduledTask.owner == owner,
                ScheduledTask.crew_member_id == crew.id,
            ).order_by(ScheduledTask.scheduled_time.asc()).all()
            return {
                "crew": _crew_to_dict(crew),
                "check_ins": [_task_to_checkin_dict(t) for t in tasks],
                "task_ids": [t.id for t in tasks],
            }
        finally:
            db.close()

    @router.patch("/settings")
    async def update_assistant_settings(payload: AssistantSettingsUpdate, request: Request):
        """Update CrewMember fields and/or check-in tasks in one call."""
        owner = _owner(request)
        crew = await _get_or_create(owner)
        if not crew:
            raise HTTPException(status_code=500, detail="Assistant not available")

        db = SessionLocal()
        try:
            crew_db = db.query(CrewMember).filter(CrewMember.id == crew.id).first()
            if not crew_db:
                raise HTTPException(status_code=404, detail="Assistant not found")

            # Update CrewMember fields.
            if payload.name is not None:
                crew_db.name = payload.name.strip() or crew_db.name
            if payload.avatar is not None:
                crew_db.avatar = payload.avatar
            if payload.personality is not None:
                crew_db.personality = payload.personality
            if payload.model is not None:
                crew_db.model = payload.model or None
            if payload.endpoint_url is not None:
                crew_db.endpoint_url = payload.endpoint_url or None
            if payload.timezone is not None:
                crew_db.timezone = payload.timezone or None

            # Tool list: either explicit list, or implicit toggle.
            if payload.enabled_tools is not None:
                crew_db.enabled_tools = json.dumps(payload.enabled_tools)
            if payload.allow_autonomous_email is not None:
                try:
                    existing = json.loads(crew_db.enabled_tools) if crew_db.enabled_tools else []
                except Exception:
                    existing = []
                if payload.allow_autonomous_email:
                    for t in ("send_email", "reply_to_email"):
                        if t not in existing:
                            existing.append(t)
                else:
                    existing = [t for t in existing if t not in _EMAIL_TOOLS]
                crew_db.enabled_tools = json.dumps(existing)

            crew_db.updated_at = datetime.utcnow()

            # Update check-in tasks.
            if payload.check_ins:
                now_utc = datetime.utcnow()
                tz_name = crew_db.timezone or None
                for ci in payload.check_ins:
                    task = db.query(ScheduledTask).filter(
                        ScheduledTask.id == ci.id,
                        ScheduledTask.owner == owner,
                        ScheduledTask.crew_member_id == crew_db.id,
                    ).first()
                    if not task:
                        continue
                    if ci.name is not None:
                        task.name = ci.name.strip() or task.name
                    time_changed = False
                    if ci.scheduled_time is not None and ci.scheduled_time != task.scheduled_time:
                        task.scheduled_time = ci.scheduled_time
                        time_changed = True
                    if ci.prompt is not None:
                        task.prompt = ci.prompt
                    if ci.enabled is not None:
                        task.status = "active" if ci.enabled else "paused"
                    if time_changed or ci.enabled is True:
                        task.next_run = compute_next_run(
                            task.schedule or "daily",
                            task.scheduled_time,
                            task.scheduled_day,
                            task.scheduled_date,
                            after=now_utc,
                            cron_expression=task.cron_expression,
                            tz_name=tz_name,
                        )
                    task.updated_at = datetime.utcnow()

            # Timezone change also shifts the NEXT run of all check-ins even if
            # the user didn't touch the time fields.
            if payload.timezone is not None:
                now_utc = datetime.utcnow()
                tz_name = crew_db.timezone or None
                tasks = db.query(ScheduledTask).filter(
                    ScheduledTask.owner == owner,
                    ScheduledTask.crew_member_id == crew_db.id,
                ).all()
                for t in tasks:
                    if t.schedule and t.scheduled_time:
                        t.next_run = compute_next_run(
                            t.schedule, t.scheduled_time, t.scheduled_day, t.scheduled_date,
                            after=now_utc, cron_expression=t.cron_expression, tz_name=tz_name,
                        )

            db.commit()

            # Re-read crew_db + tasks to return the fresh state.
            crew_out = db.query(CrewMember).filter(CrewMember.id == crew.id).first()
            tasks_out = db.query(ScheduledTask).filter(
                ScheduledTask.owner == owner,
                ScheduledTask.crew_member_id == crew.id,
            ).order_by(ScheduledTask.scheduled_time.asc()).all()
            return {
                "crew": _crew_to_dict(crew_out),
                "check_ins": [_task_to_checkin_dict(t) for t in tasks_out],
                "task_ids": [t.id for t in tasks_out],
            }
        finally:
            db.close()

    @router.post("/run/{task_id}")
    async def run_check_in_now(task_id: str, request: Request):
        """Trigger one of the assistant's check-ins immediately (manual test)."""
        owner = _owner(request)
        db = SessionLocal()
        try:
            task = db.query(ScheduledTask).filter(
                ScheduledTask.id == task_id,
                ScheduledTask.owner == owner,
            ).first()
            if not task:
                raise HTTPException(status_code=404, detail="Task not found")
            crew = db.query(CrewMember).filter(
                CrewMember.id == task.crew_member_id,
                CrewMember.is_default_assistant == True,  # noqa: E712
            ).first()
            if not crew:
                raise HTTPException(status_code=400, detail="Not an assistant task")
        finally:
            db.close()
        started = await task_scheduler.run_task_now(task_id)
        return {"started": bool(started)}

    @router.get("/run-status/{task_id}")
    async def run_status(task_id: str, request: Request):
        """Check whether the most recent run of a task has finished."""
        from core.database import TaskRun, ScheduledTask
        user = _owner(request)
        db = SessionLocal()
        try:
            # SECURITY: 404 if the task doesn't belong to this user — without
            # this any authenticated user could poll the status of any task_id.
            task = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
            if not task:
                raise HTTPException(404, "Task not found")
            if user and task.owner != user:
                raise HTTPException(404, "Task not found")
            run = db.query(TaskRun).filter(
                TaskRun.task_id == task_id,
            ).order_by(TaskRun.started_at.desc()).first()
            if not run:
                return {"status": "unknown"}
            if run.status == "running":
                return {"status": "running"}
            return {"status": "done", "result_status": run.status}
        finally:
            db.close()

    @router.get("/available-timezones")
    async def list_timezones():
        """Return the IANA tz name list used to populate the settings dropdown."""
        try:
            from zoneinfo import available_timezones
            zones = sorted(available_timezones())
        except Exception:
            zones = ["UTC"]
        return {"timezones": zones}

    @router.get("/working-dir")
    async def get_working_dir(request: Request):
        """Return the agent's working directory + git state for the header chip.

        Readable by any authenticated user (the chip is informational); only
        admins can change it, since the file/shell tools it scopes are
        admin-only.
        """
        _owner(request)
        return await asyncio.to_thread(_working_dir_payload)

    @router.post("/working-dir")
    async def set_working_dir(payload: WorkingDirUpdate, request: Request):
        """Set (or clear) the agent's working directory.

        Admin-only: this is the scope for the bash/python/write_file tools.
        An empty path clears the override and falls back to the data/ workspace.
        """
        require_admin(request)
        raw = (payload.path or "").strip()
        if raw:
            try:
                expanded = os.path.realpath(os.path.expanduser(raw))
            except OSError:
                raise HTTPException(status_code=400, detail="Invalid path")
            if not os.path.isdir(expanded):
                raise HTTPException(status_code=400, detail=f"Not a directory: {expanded}")
            store = expanded
        else:
            store = ""  # clear -> back to the default data/ workspace

        from src.settings import load_settings, save_settings
        from src.constants import DATA_DIR
        settings = load_settings()
        settings["agent_working_dir"] = store
        # Track recent working dirs (store the effective absolute path, deduped).
        eff = store or os.path.realpath(DATA_DIR)
        recent = [eff]
        for r in (settings.get("agent_working_dir_recent") or []):
            if not isinstance(r, str):
                continue
            try:
                if os.path.realpath(os.path.expanduser(r)) != os.path.realpath(eff):
                    recent.append(r)
            except OSError:
                continue
        settings["agent_working_dir_recent"] = recent[:10]
        save_settings(settings)
        return await asyncio.to_thread(_working_dir_payload)

    @router.get("/list-dir")
    async def list_dir(request: Request, path: str = ""):
        """List sub-directories of `path` for the working-dir folder picker.

        Admin-only — it browses the host filesystem (directory names only).
        """
        require_admin(request)
        return await asyncio.to_thread(_list_dir_payload, path)

    @router.get("/git")
    async def git_state(request: Request):
        """Branch + worktree state for the working dir's git repo (read-only)."""
        _owner(request)
        return await asyncio.to_thread(_git_state_payload)

    @router.post("/git/checkout")
    async def git_checkout(payload: GitBranchRequest, request: Request):
        """Switch the working dir's repo to an existing branch (admin-only)."""
        require_admin(request)
        branch = (payload.branch or "").strip()
        if not branch or branch.startswith("-"):
            raise HTTPException(status_code=400, detail="A branch name is required")
        code, out, err = _git_run(_agent_workdir(), "checkout", branch, timeout=30)
        if code != 0:
            raise HTTPException(status_code=400, detail=err or out or "checkout failed")
        return await asyncio.to_thread(_git_state_payload)

    @router.post("/git/worktree")
    async def git_worktree(payload: GitBranchRequest, request: Request):
        """Create a new linked worktree on a new branch beside the repo (admin-only).

        Returns the new worktree path; the client then points the working dir at it.
        """
        require_admin(request)
        branch = (payload.branch or "").strip()
        if not branch or branch.startswith("-"):
            raise HTTPException(status_code=400, detail="A branch name is required")
        wd = _agent_workdir()
        code, root, _ = _git_run(wd, "rev-parse", "--show-toplevel")
        if code != 0 or not root:
            raise HTTPException(status_code=400, detail="Not a git repository")
        root = os.path.realpath(root)
        safe = "".join(c if (c.isalnum() or c in "-_.") else "-" for c in branch).strip("-") or "worktree"
        path = os.path.join(os.path.dirname(root), f"{os.path.basename(root)}-{safe}")
        if os.path.exists(path):
            raise HTTPException(status_code=400, detail=f"Path already exists: {path}")
        code, out, err = _git_run(wd, "worktree", "add", path, "-b", branch, timeout=60)
        if code != 0:
            # Branch may already exist — attach it to the new worktree instead.
            code2, out2, err2 = _git_run(wd, "worktree", "add", path, branch, timeout=60)
            if code2 != 0:
                raise HTTPException(status_code=400, detail=err or err2 or out or "worktree add failed")
        return {"path": os.path.realpath(path), "branch": branch}

    @router.get("/roots")
    async def get_roots(request: Request):
        """List the directories the AI can access (working dir + extra roots)."""
        _owner(request)
        return await asyncio.to_thread(_roots_payload)

    @router.post("/roots")
    async def add_root(payload: RootPathRequest, request: Request):
        """Add an existing directory to the agent's accessible roots (admin-only).

        These extend what the file tools (read_file / write_file) may touch
        beyond the working directory. Sensitive subpaths stay blocked.
        """
        require_admin(request)
        raw = (payload.path or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="A directory path is required")
        try:
            rp = os.path.realpath(os.path.expanduser(raw))
        except OSError:
            raise HTTPException(status_code=400, detail="Invalid path")
        if not os.path.isdir(rp):
            raise HTTPException(status_code=400, detail=f"Not a directory: {rp}")
        from src.settings import load_settings, save_settings
        settings = load_settings()
        roots = [r for r in (settings.get("tool_path_extra_roots") or []) if isinstance(r, str)]
        existing = {os.path.realpath(os.path.expanduser(r)) for r in roots}
        if rp not in existing:
            roots.append(rp)
        settings["tool_path_extra_roots"] = roots[:50]
        save_settings(settings)
        return await asyncio.to_thread(_roots_payload)

    @router.post("/roots/remove")
    async def remove_root(payload: RootPathRequest, request: Request):
        """Remove a directory from the agent's accessible roots (admin-only)."""
        require_admin(request)
        raw = (payload.path or "").strip()
        try:
            rp = os.path.realpath(os.path.expanduser(raw)) if raw else ""
        except OSError:
            rp = raw
        from src.settings import load_settings, save_settings
        settings = load_settings()
        kept = []
        for r in (settings.get("tool_path_extra_roots") or []):
            if not isinstance(r, str):
                continue
            try:
                if os.path.realpath(os.path.expanduser(r)) == rp:
                    continue
            except OSError:
                pass
            kept.append(r)
        settings["tool_path_extra_roots"] = kept
        save_settings(settings)
        return await asyncio.to_thread(_roots_payload)

    return router
