from __future__ import annotations

from typing import Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class Message(BaseModel):
    detail: str


class IDResponse(BaseModel):
    id: int


class TaskResponse(BaseModel):
    """Returned when an async (Celery) job is kicked off."""

    task_id: str | None = None
    detail: str = "Task queued"


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int = 1
    page_size: int = 20


class PaginationParams(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(20, ge=1, le=100)

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size
