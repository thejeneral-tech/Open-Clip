"""Per-workflow workspace filesystem helpers.

Each Automation Map workflow gets an isolated directory under
``data/workspaces/<workflow_id>/`` where agent / file / function nodes write
generated code and where terminal nodes run. All paths are realpath-guarded so
a node can never write or read outside its own workspace (defence in depth on
top of the node executors).
"""

from __future__ import annotations

import os
import re
from typing import Dict, List

from src.constants import DATA_DIR

WORKSPACES_DIR = os.path.join(DATA_DIR, "workspaces")

# Workspace ids come from board ids ("board-ab12cd") — keep them filesystem-safe.
_SAFE_ID = re.compile(r"[^A-Za-z0-9_.-]")


def _safe_id(workflow_id: str) -> str:
    wid = _SAFE_ID.sub("_", (workflow_id or "").strip())
    if not wid or wid in (".", ".."):
        raise ValueError("invalid workflow id")
    return wid


def workspace_dir(workflow_id: str, *, create: bool = True) -> str:
    """Absolute path to a workflow's workspace, created on demand."""
    path = os.path.join(WORKSPACES_DIR, _safe_id(workflow_id))
    if create:
        os.makedirs(path, exist_ok=True)
    return os.path.realpath(path)


def resolve(workflow_id: str, rel_path: str) -> str:
    """Resolve ``rel_path`` inside the workspace, rejecting traversal.

    Raises ValueError if the resulting path escapes the workspace root.
    """
    root = workspace_dir(workflow_id)
    rel = (rel_path or "").strip().lstrip("/\\")
    target = os.path.realpath(os.path.join(root, rel))
    if target != root and not target.startswith(root + os.sep):
        raise ValueError("path escapes workspace")
    return target


def write_text(workflow_id: str, rel_path: str, content: str) -> int:
    """Write text to a file inside the workspace (creating parent dirs).
    Returns the byte size written."""
    target = resolve(workflow_id, rel_path)
    if not rel_path or target == workspace_dir(workflow_id):
        raise ValueError("a file path is required")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    data = content if isinstance(content, str) else str(content)
    with open(target, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(data)
    return len(data.encode("utf-8"))


def read_text(workflow_id: str, rel_path: str, *, max_bytes: int = 2_000_000) -> str:
    """Read a UTF-8 text file from the workspace (truncated to max_bytes)."""
    target = resolve(workflow_id, rel_path)
    with open(target, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read(max_bytes)


def list_files(workflow_id: str) -> List[Dict[str, object]]:
    """List every file in the workspace as {rel_path, size} (sorted)."""
    root = workspace_dir(workflow_id)
    out: List[Dict[str, object]] = []
    for dirpath, dirs, files in os.walk(root):
        # Skip dot-directories (e.g. .run/ holds internal function scripts).
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            try:
                size = os.path.getsize(full)
            except OSError:
                size = None
            out.append({"rel_path": rel, "size": size})
    out.sort(key=lambda f: f["rel_path"])
    return out
