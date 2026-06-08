"""DB-level tests for the bot cycle logic (SQLite test DB, no network/LLM)."""
from __future__ import annotations

import os
import tempfile
import uuid
from datetime import datetime, timezone

import pytest

from app.core.security import hash_password
from app.models.bot import Bot
from app.models.clip import Clip
from app.models.enums import ApprovalMode, JobStatus, SourceListMode, TrendItemStatus
from app.models.publishing import PublishingJob
from app.models.trend import TrendItem, TrendSource
from app.models.user import User
from app.models.video import Video
from app.services import bot_runner, presets
from app.services.discovery.base import DiscoveredItem

from .conftest import DB_OK

pytestmark = pytest.mark.skipif(not DB_OK, reason="No test database reachable")


def _mk_user(db) -> User:
    u = User(email=f"bot_{uuid.uuid4().hex[:8]}@t.co", hashed_password=hash_password("x"),
             role="admin", is_superuser=True)
    db.add(u)
    db.flush()
    return u


def _mk_bot(db, owner_id: int, *, preset="AI_NEWS", approval=ApprovalMode.AUTONOMOUS) -> Bot:
    cfg = presets.builtin(preset)["config"]
    cfg["scoring"]["use_llm_relevance"] = False
    cols = presets.config_to_bot_columns(cfg)
    bot = Bot(owner_id=owner_id, name="Runner Bot", bot_type="ai_news", preset_key=preset,
              approval_mode=approval.value, schedule_config={"interval_minutes": 60}, **cols)
    db.add(bot)
    db.flush()
    return bot


def test_ensure_bot_project_idempotent():
    from app.core.database import session_scope

    with session_scope() as db:
        u = _mk_user(db)
        bot = _mk_bot(db, u.id)
        p1 = bot_runner.ensure_bot_project(db, bot)
        p2 = bot_runner.ensure_bot_project(db, bot)
        assert p1.id == p2.id
        assert bot.project_id == p1.id


def test_select_sources_modes():
    from app.core.database import session_scope

    with session_scope() as db:
        u = _mk_user(db)
        bot = _mk_bot(db, u.id)
        allow = TrendSource(owner_id=u.id, bot_id=bot.id, platform="rss", name="allow",
                            identifier="http://a", list_mode=SourceListMode.ALLOW.value)
        deny = TrendSource(owner_id=u.id, bot_id=bot.id, platform="rss", name="deny",
                           identifier="http://b", list_mode=SourceListMode.DENY.value)
        db.add_all([allow, deny])
        db.flush()

        bot.discovery_config = {**bot.discovery_config, "source_mode": "whitelist"}
        assert {s.name for s in bot_runner.select_sources(db, bot)} == {"allow"}

        bot.discovery_config = {**bot.discovery_config, "source_mode": "blacklist"}
        names = {s.name for s in bot_runner.select_sources(db, bot)}
        assert "deny" not in names and "allow" in names


def test_run_discovery_filters_and_dedupes(monkeypatch):
    from app.core.database import session_scope

    synthetic = [
        DiscoveredItem(platform="youtube", external_id="keep", url="https://y/keep",
                       title="Amazing AI agent breakthrough", description="llm",
                       duration_seconds=120, published_at=datetime.now(timezone.utc),
                       metrics={"views": 1000}),
        DiscoveredItem(platform="youtube", external_id="drop", url="https://y/drop",
                       title="boring vlog", description="", duration_seconds=5,
                       published_at=datetime.now(timezone.utc)),
        DiscoveredItem(platform="youtube", external_id="keep", url="https://y/keep",
                       title="duplicate", description=""),  # dup external_id
    ]
    monkeypatch.setattr(bot_runner, "discover_source", lambda *a, **k: synthetic)

    with session_scope() as db:
        u = _mk_user(db)
        bot = _mk_bot(db, u.id)
        bot.filter_config = {**bot.filter_config, "keywords": ["ai"], "min_duration": 30}
        db.add(TrendSource(owner_id=u.id, bot_id=bot.id, platform="youtube", name="src",
                           identifier="@chan", list_mode=SourceListMode.ALLOW.value))
        db.flush()
        created = bot_runner.run_discovery(db, bot)
        # "keep" passes; "drop" too short; duplicate "keep" suppressed.
        assert [c.external_id for c in created] == ["keep"]
        rejected = db.query(TrendItem).filter(
            TrendItem.bot_id == bot.id, TrendItem.status == TrendItemStatus.REJECTED.value
        ).count()
        assert rejected == 1


def test_run_scoring_approves_above_threshold():
    from app.core.database import session_scope

    with session_scope() as db:
        u = _mk_user(db)
        bot = _mk_bot(db, u.id)
        bot.scoring_config = {**bot.scoring_config, "min_score": 40, "use_llm_relevance": False}
        item = TrendItem(bot_id=bot.id, platform="youtube", external_id="v",
                         url="https://y/v", title="ai",
                         published_at=datetime.now(timezone.utc),
                         metrics={"views": 200000, "likes": 10000, "comments": 2000})
        db.add(item)
        db.flush()
        bot_runner.run_scoring(db, bot, [item])
        assert item.trend_score > 0
        assert item.status == TrendItemStatus.APPROVED.value


def test_finalize_item_autonomous_creates_jobs():
    from app.core.database import session_scope

    with session_scope() as db:
        u = _mk_user(db)
        bot = _mk_bot(db, u.id, approval=ApprovalMode.AUTONOMOUS)
        bot.publishing_config = {"platforms": ["manual"], "schedule_spacing_minutes": 0,
                                 "auto_publish_threshold": 80}
        proj = bot_runner.ensure_bot_project(db, bot)
        v = Video(project_id=proj.id, source="youtube", status=JobStatus.COMPLETED.value)
        db.add(v)
        db.flush()
        item = TrendItem(bot_id=bot.id, platform="youtube", external_id="v", url="u", video_id=v.id)
        db.add(item)
        c = Clip(video_id=v.id, order_index=0, start_time=0, end_time=30, duration=30,
                 title="t", ranking_score=90, status=JobStatus.COMPLETED.value,
                 preview_path="clips/x.mp4", caption_style="hormozi")
        db.add(c)
        db.flush()
        ready = bot_runner.finalize_item(db, bot, item)
        jobs = db.query(PublishingJob).filter(PublishingJob.bot_id == bot.id).all()
        assert len(jobs) == 1
        assert jobs[0].status == "scheduled"
        assert len(ready) == 1
        assert item.status == TrendItemStatus.PROCESSED.value


def test_finalize_item_manual_holds_for_approval():
    from app.core.database import session_scope

    with session_scope() as db:
        u = _mk_user(db)
        bot = _mk_bot(db, u.id, approval=ApprovalMode.MANUAL)
        bot.publishing_config = {"platforms": ["manual"]}
        proj = bot_runner.ensure_bot_project(db, bot)
        v = Video(project_id=proj.id, source="youtube", status=JobStatus.COMPLETED.value)
        db.add(v)
        db.flush()
        item = TrendItem(bot_id=bot.id, platform="youtube", external_id="v2", url="u", video_id=v.id)
        db.add(item)
        c = Clip(video_id=v.id, order_index=0, start_time=0, end_time=30, duration=30,
                 title="t", ranking_score=95, status=JobStatus.COMPLETED.value,
                 preview_path="clips/y.mp4", caption_style="hormozi")
        db.add(c)
        db.flush()
        ready = bot_runner.finalize_item(db, bot, item)
        jobs = db.query(PublishingJob).filter(PublishingJob.bot_id == bot.id).all()
        assert len(jobs) == 1 and jobs[0].status == "awaiting_approval"
        assert ready == []


def test_manual_connector_publishes_existing_asset():
    from app.services.publishing import get_connector

    fd, path = tempfile.mkstemp(suffix=".mp4")
    os.write(fd, b"fake video bytes")
    os.close(fd)

    class _Job:
        id = 1
        payload = {"asset_key": "clips/x.mp4"}

    result = get_connector("manual").publish(_Job(), path, None)
    assert result.success
    assert result.external_url == "/media/clips/x.mp4"
    os.remove(path)


def test_youtube_connector_requires_credentials():
    from app.services.publishing import ConnectorNotConfigured, get_connector

    class _Conn:
        credentials: dict = {}
        config: dict = {}

    class _Job:
        id = 1
        title = "t"
        description = "d"
        payload: dict = {}

    with pytest.raises(ConnectorNotConfigured):
        get_connector("youtube").publish(_Job(), "/nonexistent.mp4", _Conn())
