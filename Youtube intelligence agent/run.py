"""Entry point. Start the YouTube Video Intelligence Agent server.

Usage:
    python run.py
Then open http://127.0.0.1:8000 in your browser.

Environment overrides (optional):
    YIA_REASONING_MODEL   default deepseek-r1:8b
    YIA_VISION_MODEL      e.g. llama3.2-vision / moondream / qwen2.5vl
    YIA_WHISPER_MODEL     tiny|base|small|medium|large-v3   (default base)
    YIA_PORT              default 8000
"""
from __future__ import annotations

import webbrowser

import uvicorn

from app import config, database


def main() -> None:
    database.init_db()
    url = f"http://{config.HOST}:{config.PORT}"
    print("=" * 60)
    print("  YouTube Video Intelligence Agent")
    print("=" * 60)
    print(f"  Reasoning model : {config.REASONING_MODEL}")
    print(f"  Whisper model   : {config.WHISPER_MODEL}")
    print(f"  Ollama          : {config.OLLAMA_URL}")
    print(f"  Open            : {url}")
    print("=" * 60)
    try:
        webbrowser.open(url)
    except Exception:
        pass
    uvicorn.run("app.server:app", host=config.HOST, port=config.PORT, log_level="info")


if __name__ == "__main__":
    main()
