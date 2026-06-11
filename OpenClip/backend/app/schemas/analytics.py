from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class GpuInfo(BaseModel):
    index: int
    name: str
    memory_total_mb: int
    memory_used_mb: int
    memory_free_mb: int
    utilization_pct: int
    temperature_c: int


class LoadedModel(BaseModel):
    name: str | None = None
    size: int | None = None
    size_vram: int | None = None
    expires_at: str | None = None


class GpuProcess(BaseModel):
    pid: int
    name: str
    command: str = ""
    used_vram_bytes: int = 0
    suspended: bool = False
    can_control: bool = True


class OllamaStatusOut(BaseModel):
    ollama_up: bool
    base_url: str
    max_concurrency: int
    loaded_models: list[LoadedModel] = []
    loaded_vram_bytes: int = 0
    gpus: list[GpuInfo] = []
    gpu_processes: list[GpuProcess] = []


class BotAnalyticsOut(BaseModel):
    bot_id: int
    summary: dict[str, Any]
    insights: dict[str, Any]
