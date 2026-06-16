"""Import voice presets from a StoryVault (Node) install into Clip Tool 2.0.

StoryVault stores its voice presets + saved audition clips in a SQLite database
(``data/database/storyvault.sqlite``) with the preview ``.wav`` files under
``data/voice-previews/``. This one-off script copies those presets into Clip Tool
2.0's own database (``sv_voice_presets``) and copies each saved preview into the
app's storage so the Voice Lab "Preview" button plays it directly.

It is **idempotent** — presets are matched by (owner, name), so re-running updates
the existing rows instead of creating duplicates.

Run from the ``backend`` directory:

    python -m app.import_storyvault_voices                      # sensible defaults
    python -m app.import_storyvault_voices --owner-email me@x.com
    python -m app.import_storyvault_voices --source "C:\\path\\storyvault.sqlite"

Defaults target the StoryVault install at the path below and the first non-admin
user. Pass ``--owner-email`` (or ``--owner-id``) to import for a specific account.
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from pathlib import Path

from sqlalchemy import select

DEFAULT_SOURCE = (
    r"C:\Users\Anton\OneDrive\Documents\GitHub\TrendVault-Program"
    r"\StoryVault-Video-Factory\data\database\storyvault.sqlite"
)

_TOKEN_RE = re.compile(r"[^a-z0-9_]+")


def _safe_token(raw: str) -> str:
    """Make a StoryVault preset id safe to use as a storage filename."""
    return _TOKEN_RE.sub("_", (raw or "preset").lower()).strip("_") or "preset"


def _read_source_presets(source: Path) -> list[dict]:
    """Read voice presets from the StoryVault SQLite database (read-only)."""
    if not source.exists():
        raise SystemExit(f"StoryVault database not found: {source}")
    uri = f"file:{source.as_posix()}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            """
            SELECT id, name, engine, voice, speed, preview_path, is_default
            FROM voice_presets
            WHERE COALESCE(builtin, 0) = 0
            ORDER BY is_default DESC, created_at
            """
        ).fetchall()
    finally:
        con.close()
    return [dict(r) for r in rows]


def _resolve_preview(preview_path: str | None, previews_dir: Path | None) -> Path | None:
    """Find the on-disk preview wav: the stored absolute path, else by basename."""
    if preview_path:
        p = Path(preview_path)
        if p.exists():
            return p
        if previews_dir:
            alt = previews_dir / p.name
            if alt.exists():
                return alt
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Import StoryVault voice presets.")
    parser.add_argument("--source", default=DEFAULT_SOURCE, help="StoryVault SQLite path.")
    parser.add_argument(
        "--previews-dir",
        default=None,
        help="Fallback dir for preview wavs (defaults to <source>/../voice-previews).",
    )
    parser.add_argument("--owner-email", default=None, help="Import presets for this user.")
    parser.add_argument("--owner-id", type=int, default=None, help="Import presets for this user id.")
    args = parser.parse_args()

    # Ensure the schema (and the new engine/preview_url columns) exists first.
    from app.db_init import init_db

    init_db()

    from app.core.database import session_scope
    from app.models.storyvault import SvVoicePreset
    from app.models.user import User
    from app.services.storage import storage, sv_voice_preset_preview_key

    source = Path(args.source)
    previews_dir = (
        Path(args.previews_dir)
        if args.previews_dir
        else source.parent.parent / "voice-previews"
    )

    presets = _read_source_presets(source)
    if not presets:
        print("No (non-builtin) presets found in the source database — nothing to import.")
        return 0

    with session_scope() as db:
        # Resolve the owner.
        if args.owner_id is not None:
            owner = db.get(User, args.owner_id)
        elif args.owner_email:
            owner = db.execute(
                select(User).where(User.email == args.owner_email.lower())
            ).scalar_one_or_none()
        else:
            # First real (non-superuser) account, else the very first user.
            owner = db.execute(
                select(User).where(User.is_superuser == False).order_by(User.id)  # noqa: E712
            ).scalars().first() or db.execute(
                select(User).order_by(User.id)
            ).scalars().first()
        if owner is None:
            raise SystemExit("No matching user found to own the presets.")
        print(f"Importing {len(presets)} preset(s) for {owner.email} (id={owner.id})")

        existing = {
            p.name.strip().lower(): p
            for p in db.execute(
                select(SvVoicePreset).where(SvVoicePreset.owner_id == owner.id)
            ).scalars().all()
        }

        default_id: int | None = None
        for row in presets:
            name = (row["name"] or "Voice preset").strip()
            engine = (row["engine"] or "sapi").strip()
            voice = (row["voice"] or ("fish-clone" if engine != "sapi" else "")).strip() or engine
            speed = float(row["speed"] or 1.0)
            is_default = bool(row["is_default"])

            # Copy the saved audition clip into storage (if present).
            preview_url: str | None = None
            src_wav = _resolve_preview(row.get("preview_path"), previews_dir)
            if src_wav is not None:
                key = sv_voice_preset_preview_key(_safe_token(str(row["id"])))
                storage.save_file(str(src_wav), key)
                preview_url = storage.url(key)
                status = f"preview OK ({src_wav.name})"
            else:
                status = "no preview file found"

            preset = existing.get(name.lower())
            if preset is None:
                preset = SvVoicePreset(owner_id=owner.id, name=name)
                db.add(preset)
            preset.voice = voice
            preset.speed = speed
            preset.engine = engine
            preset.preview_url = preview_url
            preset.is_default = is_default
            db.flush()
            if is_default:
                default_id = preset.id
            print(f"  - {name}  [{engine}, speed {speed:g}]  {status}")

        # Enforce a single default for this owner (StoryVault has exactly one).
        if default_id is not None:
            for p in db.execute(
                select(SvVoicePreset).where(SvVoicePreset.owner_id == owner.id)
            ).scalars().all():
                p.is_default = p.id == default_id

    print("Done.")
    return 0


if __name__ == "__main__":  # `python -m app.import_storyvault_voices`
    sys.exit(main())
