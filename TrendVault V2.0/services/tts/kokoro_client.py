"""Kokoro TTS HTTP client — Python port of scripts/tts/localTtsAdapter.ts.

POSTs to {LOCAL_TTS_URL}/tts {text, voice, speed} → raw audio bytes. Blocking
(httpx sync) by design: called from the worker-thread TTS pipeline.
"""
from __future__ import annotations

import time
from typing import Any, Callable, Dict, Optional
from urllib.parse import urljoin

import httpx

from core.config import config

DEFAULT_TIMEOUT_SEC = 600.0
MIN_TEST_BYTES = 1024


class KokoroTimeout(Exception):
    pass


def _base_url() -> str:
    return (config.local_tts_url or "http://localhost:5070").strip()


def _tts_url() -> str:
    # urljoin with an absolute path mirrors Node's `new URL('/tts', base)`.
    path = config.local_tts_path or "/tts"
    if not path.startswith("/"):
        path = "/" + path
    return urljoin(_base_url(), path)


def synthesize(text: str, voice: Optional[str], speed: Optional[float],
               out_path: str, timeout: float = DEFAULT_TIMEOUT_SEC) -> Optional[Dict[str, Any]]:
    """Synthesize one chunk → write to out_path. Returns {bytes, mime} or None if
    the server is unreachable (connection refused). Raises KokoroTimeout on timeout."""
    payload = {"text": text, "voice": voice, "speed": 1.0 if speed is None else speed}
    try:
        r = httpx.post(_tts_url(), json=payload, timeout=timeout)
    except (httpx.ConnectError, httpx.ConnectTimeout):
        return None
    except httpx.TimeoutException:
        raise KokoroTimeout(
            f"Kokoro TTS request timed out after {round(timeout)}s for {len(text)} chars")
    except httpx.HTTPError as e:
        raise RuntimeError(f"Kokoro TTS request failed: {e}")
    if r.status_code != 200:
        body = (r.text or "")[:200]
        raise RuntimeError(f"Kokoro TTS returned HTTP {r.status_code}" + (f": {body}" if body else ""))
    data = r.content
    with open(out_path, "wb") as f:
        f.write(data)
    return {"out_path": out_path, "mime": r.headers.get("content-type", "audio/wav"), "bytes": len(data)}


def probe_alive() -> Dict[str, Any]:
    """Real-synthesis probe: POST a tiny phrase, ok if it returns >=1KB of audio."""
    try:
        r = httpx.post(_tts_url(),
                       json={"text": "test.", "voice": "en-US-JennyNeural", "speed": 1.0},
                       timeout=20.0)
    except (httpx.ConnectError, httpx.ConnectTimeout):
        return {"ok": False, "reason": "connection refused"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": str(e)}
    if r.status_code != 200:
        return {"ok": False, "reason": f"HTTP {r.status_code}"}
    n = len(r.content)
    if n < MIN_TEST_BYTES:
        return {"ok": False, "reason": f"response too small ({n} bytes)", "bytes": n}
    return {"ok": True, "bytes": n}


def probe_reachable() -> bool:
    """Light check for the status endpoints — is the port answering at all?"""
    base = _base_url()
    for url in (base, base.rstrip("/") + "/health"):
        try:
            httpx.get(url, timeout=2.0)
            return True
        except (httpx.ConnectError, httpx.ConnectTimeout):
            continue
        except Exception:  # noqa: BLE001 — any HTTP response means it's up
            return True
    return False


def wait_ready(max_ms: int = 60000, interval_ms: int = 2000,
               logger: Optional[Callable[[str], None]] = None) -> Dict[str, Any]:
    log = logger or (lambda s: None)
    start = time.time()
    attempt = 0
    last_reason: Optional[str] = None
    while (time.time() - start) * 1000 < max_ms:
        attempt += 1
        p = probe_alive()
        if p.get("ok"):
            el = int((time.time() - start) * 1000)
            log(f"Kokoro ready (attempt {attempt}, {el}ms, test audio {p.get('bytes')} bytes)")
            return {"ready": True, "elapsedMs": el}
        last_reason = p.get("reason")
        log(f"Kokoro not ready (attempt {attempt}): {last_reason or 'unknown'} - "
            f"retrying in {round(interval_ms / 1000)}s")
        time.sleep(interval_ms / 1000)
    return {"ready": False, "elapsedMs": int((time.time() - start) * 1000), "lastReason": last_reason}
