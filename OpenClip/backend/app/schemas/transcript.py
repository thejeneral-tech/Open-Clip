from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class Word(BaseModel):
    word: str
    start: float
    end: float
    probability: float | None = None


class Segment(BaseModel):
    id: int
    start: float
    end: float
    text: str
    speaker: str | None = None
    words: list[Word] = []


class TranscriptOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    video_id: int
    language: str | None = None
    engine: str | None = None
    model: str | None = None
    full_text: str
    word_count: int
    num_speakers: int
    duration_seconds: float | None = None
    segments: list[Segment] = []
