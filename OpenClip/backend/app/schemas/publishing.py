from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import SourcePlatform


class ConnectorCreate(BaseModel):
    platform: SourcePlatform = SourcePlatform.YOUTUBE
    name: str = Field(min_length=1, max_length=255)
    bot_id: int | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    credentials: dict[str, Any] = Field(default_factory=dict)


class ConnectorUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    config: dict[str, Any] | None = None
    credentials: dict[str, Any] | None = None
    bot_id: int | None = None


class ConnectorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    owner_id: int
    bot_id: int | None
    platform: str
    name: str
    status: str
    config: dict[str, Any]
    # credentials intentionally omitted from output
    has_credentials: bool = False
    last_error: str | None
    created_at: datetime


class PublishingJobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    bot_id: int | None
    clip_id: int
    connector_id: int | None
    platform: str
    status: str
    scheduled_at: datetime | None
    published_at: datetime | None
    title: str | None
    description: str | None
    payload: dict[str, Any]
    external_post_id: str | None
    external_url: str | None
    analytics: dict[str, Any]
    retries: int
    error: str | None
    created_at: datetime


class PublishJobCreate(BaseModel):
    clip_id: int
    platform: SourcePlatform | str = "manual"
    connector_id: int | None = None
    title: str | None = None
    description: str | None = None
    scheduled_at: datetime | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


# ----------------------------------------------------------------- youtube
class YouTubeStatusOut(BaseModel):
    """Whether the server has a Google OAuth client wired up."""

    configured: bool
    redirect_uri: str


class YouTubeAuthUrlIn(BaseModel):
    # Optionally pre-assign the connected channel to a bot, and give it a name
    # (defaults to the channel title once we learn it).
    bot_id: int | None = None
    name: str | None = Field(default=None, max_length=255)


class YouTubeAuthUrlOut(BaseModel):
    auth_url: str


class ConnectorAssignIn(BaseModel):
    """Assign (or unassign with ``null``) a channel to a bot."""

    bot_id: int | None = None
