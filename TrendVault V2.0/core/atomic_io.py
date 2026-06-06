"""Atomic JSON/text file writes (copied from TrendVault-Coder/core/atomic_io.py).

A plain `open("w") + json.dump` truncates the file on first write and only
fills it with new content afterwards — a crash in between produces a truncated
or empty file. For live state (presets, hidden-voices, recent-hooks, drafts)
that's a data-loss event. `atomic_write_json` writes to a sibling tmp file,
fsyncs, then `os.replace`s into place (atomic on the same filesystem).
"""
from __future__ import annotations

import json
import os
from typing import Any, Optional


def atomic_write_json(path: str, data: Any, *, indent: Optional[int] = 2) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=indent)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def atomic_write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_json(path: str, default: Any = None) -> Any:
    """Best-effort JSON read; returns `default` if missing or corrupt."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default
