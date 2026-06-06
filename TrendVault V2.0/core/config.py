"""Typed settings layer (pydantic-settings), mirroring TrendVault-Coder/src/config.py.

Reads the same `.env` the Node app used. Field names map 1:1 to the env var
names (case-insensitive), e.g. `local_llm_url` <- LOCAL_LLM_URL. Empty
values in `.env` (the file ships every key, some blank) are coalesced back to
sensible defaults so a blank LOCAL_TTS_URL= doesn't override the real default.
"""
from __future__ import annotations

import os
from typing import Optional

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from core.constants import BASE_DIR


class TVSettings(BaseSettings):
    # AI / script generation — local model only (Ollama / llama.cpp).
    # OpenAI-compatible /v1 endpoint, no API key required.
    #   Ollama:    http://localhost:11434/v1   (default; `ollama pull llama3.1:8b`)
    #   llama.cpp: http://localhost:8080/v1    (`llama-server -m model.gguf`)
    local_llm_url: str = "http://localhost:11434/v1"
    local_llm_model: str = "llama3.1:8b"

    # Caption alignment + stock media
    assemblyai_api_key: Optional[str] = None
    pexels_api_key: Optional[str] = None
    jamendo_client_id: Optional[str] = None
    huggingface_token: Optional[str] = None

    # Local TTS engines
    local_tts_url: str = "http://localhost:5070"
    local_tts_path: str = "/tts"            # live Node client posts to /tts (not /synthesize)
    local_tts_engine: str = "kokoro"
    fish_tts_url: str = "http://127.0.0.1:8080"

    # Remotion render
    render_worker_url: Optional[str] = None
    render_worker_port: int = 4000
    use_render_worker: bool = False

    port: int = 3001

    model_config = SettingsConfigDict(
        env_file=os.path.join(BASE_DIR, ".env"),   # absolute → cwd-independent
        env_file_encoding="utf-8-sig",      # tolerate a Notepad BOM
        extra="ignore",
        case_sensitive=False,
    )

    @model_validator(mode="after")
    def _coalesce_blanks(self) -> "TVSettings":
        if not (self.local_tts_url or "").strip():
            self.local_tts_url = "http://localhost:5070"
        if not (self.local_tts_path or "").strip():
            self.local_tts_path = "/tts"
        if not (self.fish_tts_url or "").strip():
            self.fish_tts_url = "http://127.0.0.1:8080"
        if not (self.local_llm_url or "").strip():
            self.local_llm_url = "http://localhost:11434/v1"
        if not (self.local_llm_model or "").strip():
            self.local_llm_model = "llama3.1:8b"
        # Treat empty-string secrets as "unset" so `if config.assemblyai_api_key`
        # is a reliable presence check.
        for k in ("assemblyai_api_key", "pexels_api_key",
                  "jamendo_client_id", "huggingface_token", "render_worker_url"):
            if not (getattr(self, k) or "").strip():
                setattr(self, k, None)
        return self


config = TVSettings()
