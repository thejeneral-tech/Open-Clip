"""Thin Ollama client with reasoning-model (DeepSeek-R1) handling.

Reasoning models emit <think>...</think> blocks; we strip them and then
leniently extract JSON so downstream code always gets clean structured data.
"""
from __future__ import annotations

import base64
import functools
import io
import json
import logging
import re
import sys
from pathlib import Path
from typing import Any

import httpx

from . import config

_log = logging.getLogger("yia.llm")

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_OPEN_THINK_RE = re.compile(r"<think>.*$", re.DOTALL | re.IGNORECASE)

# Session-scoped record of reasoning models we had to fall back from because they
# wouldn't load (out of memory / not installed). Once a model proves too big this
# session we route straight to the fallback that worked, so we don't re-OOM (and
# risk wedging) Ollama on every subsequent call. Cleared on restart.
_demoted: dict[str, str] = {}


class LLMError(RuntimeError):
    pass


# --- model discovery -----------------------------------------------------
def _tags() -> list[dict]:
    """Raw /api/tags model list (name + size + details), or [] if unreachable."""
    try:
        r = httpx.get(f"{config.OLLAMA_URL}/api/tags", timeout=10)
        r.raise_for_status()
        return r.json().get("models", []) or []
    except Exception:
        return []


def list_models() -> list[str]:
    return [m["name"] for m in _tags() if m.get("name")]


def health() -> dict:
    models = list_models()
    primary = config.REASONING_MODEL
    # Head of the fallback chain = the model a text call would actually use right
    # now (accounts for a session demotion *and* a proactive low-memory skip).
    chain = _text_fallback_chain(primary)
    effective = chain[0] if chain else primary
    return {
        "ollama_up": bool(models) or _ping(),
        "models": models,
        "reasoning_model": primary,
        "effective_reasoning_model": effective,
        "reasoning_demoted": effective != primary,
        "reasoning_available": any(_name_matches(primary, m) for m in models),
        "vision_model": detect_vision_model(),
    }


def _ping() -> bool:
    try:
        httpx.get(f"{config.OLLAMA_URL}/api/version", timeout=5).raise_for_status()
        return True
    except Exception:
        return False


def _name_matches(want: str, have: str) -> bool:
    # "deepseek-r1:8b" should match "deepseek-r1:8b"; "deepseek-r1" matches any tag.
    if want == have:
        return True
    return have.split(":")[0] == want.split(":")[0]


@functools.lru_cache(maxsize=1)
def detect_vision_model() -> str | None:
    if config.VISION_MODEL:
        return config.VISION_MODEL
    for name in list_models():
        low = name.lower()
        if any(h in low for h in config.VISION_MODEL_HINTS):
            return name
    return None


# --- text cleaning -------------------------------------------------------
def strip_think(text: str) -> str:
    if not text:
        return ""
    text = _THINK_RE.sub("", text)
    text = _OPEN_THINK_RE.sub("", text)  # unterminated think block (truncated output)
    return text.strip()


def strip_wrapping_fence(text: str) -> str:
    """Unwrap a single outer ```fence``` that the model put around its whole
    answer (e.g. ```markdown ... ```), so the content renders, not the fence."""
    t = (text or "").strip()
    if t.startswith("```") and t.endswith("```") and t.count("```") == 2:
        nl = t.find("\n")
        if nl != -1:
            inner = t[nl + 1:]
            cut = inner.rstrip().rfind("```")
            if cut != -1:
                return inner[:cut].strip()
    return text


def extract_json(text: str) -> Any:
    """Best-effort: find the first balanced JSON object/array in the text."""
    cleaned = strip_think(text)
    for candidate in (cleaned, text):
        if not candidate:
            continue
        # direct parse
        try:
            return json.loads(candidate)
        except Exception:
            pass
        # fenced code block
        fence = re.search(r"```(?:json)?\s*(.*?)```", candidate, re.DOTALL)
        if fence:
            try:
                return json.loads(fence.group(1))
            except Exception:
                pass
        # balanced scan
        obj = _balanced_json(candidate)
        if obj is not None:
            return obj
    return None


def _balanced_json(text: str) -> Any:
    starts = [i for i, c in enumerate(text) if c in "{["]
    for start in starts:
        opener = text[start]
        closer = "}" if opener == "{" else "]"
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            c = text[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
                continue
            if c == '"':
                in_str = True
            elif c == opener:
                depth += 1
            elif c == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : i + 1])
                    except Exception:
                        break
    return None


# --- core calls ----------------------------------------------------------
def _ollama_http_error(r: httpx.Response) -> str:
    """Turn a non-200 Ollama response into an actionable message, surfacing the
    real error body (which raise_for_status would otherwise throw away)."""
    detail = ""
    try:
        detail = (r.json().get("error") or "").strip()
    except Exception:
        detail = (r.text or "").strip()
    msg = f"Ollama error {r.status_code}: {detail or r.reason_phrase}"
    low = detail.lower()
    if "memory" in low or "system memory" in low or "out of memory" in low:
        msg += ("  -> The model needs more RAM than is currently free. Close other apps, "
                "restart Ollama, or pick a smaller model (e.g. llama3.2:1b) from the header menu.")
    elif r.status_code == 404 or "not found" in low or "try pulling" in low:
        msg += "  -> That model isn't installed. Run `ollama pull <model>` first."
    return msg


# --- model fallback (memory-pressure resilience) -------------------------
# Substrings that mark an error as "this model couldn't be loaded/run" rather
# than "the request was malformed". Only these trigger a fallback to a smaller
# model; genuine bugs (e.g. a 400) still surface immediately.
_RECOVERABLE_SIGNALS = (
    "memory", "out of memory", "system memory",          # OOM preflight rejection
    "runner process", "has terminated", "exit status",   # runner crashed mid-load
    "timed out",                                          # slow/over-committed load
    "error 500", "status 500", " 500:",                  # generic internal error
    "not found", "not installed", "try pulling",          # model isn't pulled
    "error 404", " 404 ",
)


def _is_recoverable(err: Exception) -> bool:
    s = str(err).lower()
    return any(sig in s for sig in _RECOVERABLE_SIGNALS)


def _is_vision_name(name: str) -> bool:
    low = name.lower()
    return any(h in low for h in config.VISION_MODEL_HINTS)


def _available_memory_bytes() -> int | None:
    """Best-effort reclaimable physical RAM in bytes, or None if it can't be
    determined on this platform (in which case we don't prejudge model size)."""
    try:  # optional, most accurate, cross-platform
        import psutil
        return int(psutil.virtual_memory().available)
    except Exception:
        pass
    if sys.platform == "win32":
        try:
            import ctypes

            class _MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = _MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                return int(stat.ullAvailPhys)
        except Exception:
            pass
    else:
        try:  # Linux
            with open("/proc/meminfo") as fh:
                for line in fh:
                    if line.startswith("MemAvailable:"):
                        return int(line.split()[1]) * 1024
        except Exception:
            pass
    return None


def _text_fallback_chain(primary: str) -> list[str]:
    """Ordered list of text models to try: the primary (or its session demotion)
    first, then any installed FALLBACK_MODELS, then — only if none of those are
    installed — any other installed non-vision model as a last resort. Models
    that clearly won't fit in available RAM are dropped up front so we never try
    to load an 8B model on a near-full box (which can hang/wedge Ollama)."""
    tags = _tags()
    installed = [m["name"] for m in tags if m.get("name")]
    sizes = {m["name"]: int(m.get("size") or 0) for m in tags if m.get("name")}
    installed_set = set(installed)

    chain = [_demoted.get(primary, primary)]
    for m in config.FALLBACK_MODELS:
        if m in installed_set and m not in chain:
            chain.append(m)
    if len(chain) == 1:  # configured fallbacks aren't installed — use what's here
        for m in installed:
            if m not in chain and not _is_vision_name(m):
                chain.append(m)

    avail = _available_memory_bytes()
    if avail is not None and config.MODEL_MEMORY_HEADROOM_MB >= 0:
        headroom = config.MODEL_MEMORY_HEADROOM_MB * 1024 * 1024
        original = chain[0]
        # On-disk size underestimates the loaded footprint (weights + KV cache);
        # ~1.25x matches what Ollama actually reserves for these models in practice.
        def _need(m: str) -> float:
            return sizes.get(m, 0) * 1.25 + headroom

        fits = [m for m in chain if not sizes.get(m) or _need(m) <= avail]
        if fits:
            chain = fits
        else:
            # Nothing comfortably fits — try the single smallest model (best chance
            # of loading) rather than the largest-first chain, so we never lead with
            # an 8B model on a near-full box (which can swap-thrash / wedge Ollama).
            chain = [min(chain, key=lambda m: sizes.get(m, 1 << 62))]
        if chain[0] != original:
            _log.warning(
                "Low memory (~%.1fGB free): skipping %r (~%.1fGB), using %r.",
                avail / 1e9, original, sizes.get(original, 0) / 1e9, chain[0],
            )
    return chain


def _run_text(path: str, payload: dict, primary: str, allow_fallback: bool) -> dict:
    """POST a text generate/chat request, transparently retrying with smaller
    models when the requested one can't be loaded. Returns the raw Ollama JSON."""
    chain = _text_fallback_chain(primary) if allow_fallback else [primary]
    last_err: Exception | None = None
    for i, mdl in enumerate(chain):
        payload["model"] = mdl
        try:
            data = _post(path, payload)
        except LLMError as e:
            last_err = e
            if i + 1 >= len(chain) or not _is_recoverable(e):
                raise
            _log.warning("Model %r unavailable (%s); falling back to %r.",
                         mdl, _short(e), chain[i + 1])
            continue
        if i > 0 and _demoted.get(primary) != mdl:
            _demoted[primary] = mdl  # remember for the rest of this session
            _log.warning("Reasoning model %r couldn't be loaded (low memory?); "
                         "using %r for the rest of this session.", primary, mdl)
        return data
    raise last_err if last_err else LLMError("No model available")


def _short(err: Exception, limit: int = 140) -> str:
    s = " ".join(str(err).split())
    return s if len(s) <= limit else s[:limit] + "..."


def _post(path: str, payload: dict) -> dict:
    """POST to Ollama with uniform, actionable error handling for every caller."""
    url = f"{config.OLLAMA_URL}{path}"
    try:
        r = httpx.post(url, json=payload, timeout=config.LLM_TIMEOUT)
    except httpx.TimeoutException as e:
        raise LLMError(
            f"Ollama timed out after {config.LLM_TIMEOUT}s. It may be loading a large model "
            "or low on memory — try restarting Ollama or switching to a smaller model."
        ) from e
    except httpx.RequestError as e:
        raise LLMError(
            f"Cannot reach Ollama at {config.OLLAMA_URL} ({type(e).__name__}). "
            "Is it running? Start the Ollama app or run `ollama serve`."
        ) from e
    if r.status_code != 200:
        raise LLMError(_ollama_http_error(r))
    try:
        return r.json()
    except Exception as e:
        raise LLMError(f"Ollama returned an unreadable response: {(r.text or '')[:200]}") from e


def generate(
    prompt: str,
    system: str | None = None,
    model: str | None = None,
    temperature: float = 0.4,
    force_json: bool = False,
    images: list[str] | None = None,
) -> str:
    primary = model or config.REASONING_MODEL
    payload: dict[str, Any] = {
        "model": primary,  # set per-attempt by _run_text
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": temperature, "num_ctx": config.LLM_NUM_CTX},
    }
    if system:
        payload["system"] = system
    if force_json:
        payload["format"] = "json"
    if images:
        payload["images"] = images
    # Image prompts need the (explicit) vision model — never fall back to a text one.
    data = _run_text("/api/generate", payload, primary, allow_fallback=not images)
    return strip_wrapping_fence(strip_think(data.get("response", "")))


def chat(
    messages: list[dict],
    model: str | None = None,
    temperature: float = 0.4,
    force_json: bool = False,
    allow_fallback: bool = True,
) -> str:
    primary = model or config.REASONING_MODEL
    payload: dict[str, Any] = {
        "model": primary,  # set per-attempt by _run_text
        "messages": messages,
        "stream": False,
        "options": {"temperature": temperature, "num_ctx": config.LLM_NUM_CTX},
    }
    if force_json:
        payload["format"] = "json"
    # Don't swap models out from under an image request (vision needs its model).
    has_images = any(isinstance(m, dict) and m.get("images") for m in messages)
    data = _run_text("/api/chat", payload, primary,
                     allow_fallback=allow_fallback and not has_images)
    msg = data.get("message", {})
    return strip_wrapping_fence(strip_think(msg.get("content", "")))


def generate_json(
    prompt: str,
    system: str | None = None,
    model: str | None = None,
    temperature: float = 0.2,
    default: Any = None,
) -> Any:
    """Generate and parse JSON, with one reinforced retry on parse failure."""
    raw = generate(prompt, system=system, model=model, temperature=temperature, force_json=True)
    parsed = extract_json(raw)
    if parsed is not None:
        return parsed
    retry_prompt = (
        prompt
        + "\n\nIMPORTANT: Respond with ONLY valid JSON. No prose, no markdown, no commentary."
    )
    raw = generate(retry_prompt, system=system, model=model, temperature=0.0, force_json=True)
    parsed = extract_json(raw)
    return parsed if parsed is not None else default


# --- vision --------------------------------------------------------------
def encode_image(path: str | Path, max_width: int | None = None) -> str | None:
    """Read image, optionally downscale, return base64 (no data: prefix)."""
    try:
        from PIL import Image

        img = Image.open(path).convert("RGB")
        mw = max_width or config.VISION_FRAME_WIDTH
        if img.width > mw:
            h = int(img.height * mw / img.width)
            img = img.resize((mw, h))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=82)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        # fall back to raw bytes if Pillow unavailable / fails
        try:
            return base64.b64encode(Path(path).read_bytes()).decode("ascii")
        except Exception:
            return None


def vision(prompt: str, image_paths: list[str | Path], model: str | None = None,
           temperature: float = 0.2) -> str:
    mdl = model or detect_vision_model()
    if not mdl:
        raise LLMError("No vision-capable Ollama model available")
    images = [b for b in (encode_image(p) for p in image_paths) if b]
    if not images:
        raise LLMError("No images could be encoded")
    messages = [{"role": "user", "content": prompt, "images": images}]
    return chat(messages, model=mdl, temperature=temperature, allow_fallback=False)
