"""ORM models.

Importing this package imports every model module, which registers all tables on
``Base.metadata`` — required before ``create_all`` (``app.db_init``), the test
schema fixture, and Alembic autogeneration. Keep importing the whole package
(``import app.models``) rather than individual modules where table registration
matters.
"""
from __future__ import annotations

from app.models.analysis import AIAnalysis
from app.models.bot import Bot, BotPreset, BotRun
from app.models.clip import Clip
from app.models.export import Export
from app.models.metrics import BotMetric
from app.models.project import Project
from app.models.publishing import PublishingConnector, PublishingJob
from app.models.settings import UserSettings
from app.models.storyvault import (
    SvBackground,
    SvExport,
    SvScript,
    SvSegment,
    SvStory,
    SvVideo,
    SvVoicePreset,
)
from app.models.transcript import Transcript
from app.models.trend import TrendItem, TrendSource
from app.models.user import User
from app.models.video import Video

__all__ = [
    "AIAnalysis",
    "Bot",
    "BotMetric",
    "BotPreset",
    "BotRun",
    "Clip",
    "Export",
    "Project",
    "PublishingConnector",
    "PublishingJob",
    "SvBackground",
    "SvExport",
    "SvScript",
    "SvSegment",
    "SvStory",
    "SvVideo",
    "SvVoicePreset",
    "Transcript",
    "TrendItem",
    "TrendSource",
    "User",
    "UserSettings",
    "Video",
]
