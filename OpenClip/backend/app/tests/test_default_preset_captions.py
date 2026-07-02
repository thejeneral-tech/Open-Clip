"""The default preset (Set default on the Presets page) drives OpenClip runs.

``_resolve_caption_config`` falls back to the owner's default ``SvTemplate`` when a
run names no ``template_id``. That fallback is what makes a chosen default apply
across the whole OpenClip stack — the process dialog *and* unattended bot runs —
since bot runs never name a preset. See ``app.workers.tasks``.
"""
from __future__ import annotations

import uuid

import pytest

from app.core.security import hash_password
from app.models.storyvault import SvTemplate
from app.models.user import User
from app.schemas.video import ProcessOptions
from app.workers.tasks import _resolve_caption_config

from .conftest import DB_OK

pytestmark = pytest.mark.skipif(not DB_OK, reason="No test database reachable")

DEFAULT_CAPS = {"style": "pop", "size": 96, "primary": "&H00FFFFFF"}
OTHER_CAPS = {"style": "karaoke", "size": 72, "primary": "&H0000FFFF"}


def _mk_user(db) -> User:
    u = User(email=f"preset_{uuid.uuid4().hex[:8]}@t.co", hashed_password=hash_password("x"),
             role="admin", is_superuser=True)
    db.add(u)
    db.flush()
    return u


def _mk_template(db, owner_id: int, caps: dict, *, is_default: bool) -> SvTemplate:
    tpl = SvTemplate(owner_id=owner_id, name="T", data={"captions": caps}, is_default=is_default)
    db.add(tpl)
    db.flush()
    return tpl


def test_falls_back_to_owner_default_when_no_template():
    from app.core.database import session_scope

    with session_scope() as db:
        u = _mk_user(db)
        _mk_template(db, u.id, OTHER_CAPS, is_default=False)
        _mk_template(db, u.id, DEFAULT_CAPS, is_default=True)

        cfg = _resolve_caption_config(db, ProcessOptions(), u.id)
        assert cfg == DEFAULT_CAPS


def test_explicit_template_wins_over_default():
    from app.core.database import session_scope

    with session_scope() as db:
        u = _mk_user(db)
        other = _mk_template(db, u.id, OTHER_CAPS, is_default=False)
        _mk_template(db, u.id, DEFAULT_CAPS, is_default=True)

        cfg = _resolve_caption_config(db, ProcessOptions(template_id=other.id), u.id)
        assert cfg == OTHER_CAPS


def test_dialog_overrides_layer_on_top_of_default():
    from app.core.database import session_scope

    with session_scope() as db:
        u = _mk_user(db)
        _mk_template(db, u.id, DEFAULT_CAPS, is_default=True)

        opts = ProcessOptions(caption_config={"style": "karaoke", "primary": "#ffffff"})
        cfg = _resolve_caption_config(db, opts, u.id)
        # Dialog choices win for the knobs it sets; the default preset supplies the rest.
        assert cfg["style"] == "karaoke"
        assert cfg["primary"] == "#ffffff"
        assert cfg["size"] == 96


def test_no_owner_means_no_fallback():
    from app.core.database import session_scope

    with session_scope() as db:
        u = _mk_user(db)
        _mk_template(db, u.id, DEFAULT_CAPS, is_default=True)

        assert _resolve_caption_config(db, ProcessOptions(), None) is None


def test_soft_deleted_default_is_ignored():
    from datetime import datetime, timezone

    from app.core.database import session_scope

    with session_scope() as db:
        u = _mk_user(db)
        tpl = _mk_template(db, u.id, DEFAULT_CAPS, is_default=True)
        tpl.deleted_at = datetime.now(timezone.utc)
        db.flush()

        assert _resolve_caption_config(db, ProcessOptions(), u.id) is None
