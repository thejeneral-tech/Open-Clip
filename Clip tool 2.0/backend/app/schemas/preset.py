from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class PresetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int | None = None
    owner_id: int | None = None
    key: str
    name: str
    description: str | None = None
    version: int = 1
    is_system: bool = False
    based_on: str | None = None
    config: dict[str, Any]


class PresetCreate(BaseModel):
    key: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    based_on: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)


class PresetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    config: dict[str, Any] | None = None
    bump_version: bool = True


class PresetImport(BaseModel):
    name: str | None = None
    key: str | None = None
    config: dict[str, Any]
