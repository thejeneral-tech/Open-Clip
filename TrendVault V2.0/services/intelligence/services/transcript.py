"""Transcript acquisition with a 3-tier fallback chain:

  1. youtube-transcript-api  (manual or auto captions, no download)   -- fastest
  2. yt-dlp subtitle download (json3 auto/manual captions)            -- robust
  3. faster-whisper on downloaded audio                               -- always works

Returns timestamped segments either way.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Callable

from .. import config
from ..ffmpeg_utils import ffmpeg_location_for_ytdlp

Logger = Callable[[str], None]
_PREFERRED_LANGS = ["en", "en-US", "en-GB", "en-orig"]
# Max seconds to allow a single transcription subprocess to run (long CPU jobs).
WHISPER_TIMEOUT = int(os.environ.get("YIA_WHISPER_TIMEOUT", "5400"))


class TranscriptError(RuntimeError):
    pass


def _noop(_: str) -> None:
    pass


def _workdir(video_id: str) -> Path:
    d = config.VIDEO_DATA_DIR / video_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _clean_text(text: str) -> str:
    return " ".join((text or "").split())


def _segments_to_full_text(segments: list[dict]) -> str:
    return _clean_text(" ".join(s.get("text", "") for s in segments))


def get_transcript(video_id: str, url: str, prefer_whisper: bool = False,
                   log: Logger | None = None) -> dict:
    log = log or _noop
    errors: list[str] = []

    if not prefer_whisper:
        for name, fn in (("captions API", _via_transcript_api),
                         ("yt-dlp subtitles", _via_ytdlp_subs)):
            try:
                log(f"Trying {name}...")
                result = fn(video_id, url, log)
                if result and result.get("segments"):
                    log(f"Transcript via {name}: {len(result['segments'])} segments "
                        f"({result['source']}, {result.get('language')}).")
                    return result
            except Exception as e:  # noqa: BLE001 - we intentionally fall through
                errors.append(f"{name}: {e}")
                log(f"{name} failed: {e}")

    try:
        log("Falling back to Whisper transcription (downloading audio)...")
        result = _via_whisper(video_id, url, log)
        if result and result.get("segments"):
            log(f"Whisper produced {len(result['segments'])} segments.")
            return result
        errors.append("whisper: produced no segments")
    except Exception as e:  # noqa: BLE001
        errors.append(f"whisper: {e}")
        log(f"Whisper failed: {e}")

    raise TranscriptError("All transcript methods failed. " + " | ".join(errors))


# --- tier 1: youtube-transcript-api -------------------------------------
def _via_transcript_api(video_id: str, url: str, log: Logger) -> dict | None:
    from youtube_transcript_api import YouTubeTranscriptApi

    if hasattr(YouTubeTranscriptApi, "list_transcripts"):
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)  # old (<1.0)
    else:
        transcript_list = YouTubeTranscriptApi().list(video_id)            # new (>=1.0)

    transcript = None
    for finder_name in ("find_manually_created_transcript", "find_generated_transcript"):
        finder = getattr(transcript_list, finder_name, None)
        if not finder:
            continue
        try:
            transcript = finder(_PREFERRED_LANGS)
            break
        except Exception:
            continue

    if transcript is None:
        available = list(transcript_list)
        if not available:
            return None
        transcript = available[0]
        code = getattr(transcript, "language_code", "") or ""
        if not code.startswith("en") and getattr(transcript, "is_translatable", False):
            try:
                transcript = transcript.translate("en")
            except Exception:
                pass

    fetched = transcript.fetch()
    raw = _normalize_fetched(fetched)
    segments = _build_segments(raw)
    if not segments:
        return None
    return {
        "source": "captions_auto" if getattr(transcript, "is_generated", False) else "captions_manual",
        "language": getattr(transcript, "language_code", None),
        "segments": segments,
        "full_text": _segments_to_full_text(segments),
    }


def _normalize_fetched(fetched) -> list[dict]:
    if hasattr(fetched, "to_raw_data"):
        return fetched.to_raw_data()
    if isinstance(fetched, list):
        return fetched
    out = []
    for s in fetched:
        out.append({
            "text": getattr(s, "text", ""),
            "start": getattr(s, "start", 0.0),
            "duration": getattr(s, "duration", 0.0),
        })
    return out


def _build_segments(raw: list[dict]) -> list[dict]:
    segments = []
    for item in raw:
        text = _clean_text(item.get("text", ""))
        if not text or text in ("[Music]", "[Applause]"):
            continue
        segments.append({
            "start": round(float(item.get("start", 0.0)), 2),
            "duration": round(float(item.get("duration", 0.0)), 2),
            "text": text,
        })
    return segments


# --- tier 2: yt-dlp subtitle download -----------------------------------
def _via_ytdlp_subs(video_id: str, url: str, log: Logger) -> dict | None:
    from yt_dlp import YoutubeDL

    workdir = _workdir(video_id)
    opts = {
        "quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True,
        "writesubtitles": True, "writeautomaticsub": True,
        "subtitleslangs": ["en.*", "en", "-live_chat"],
        "subtitlesformat": "json3",
        "outtmpl": str(workdir / "%(id)s.%(ext)s"),
    }
    loc = ffmpeg_location_for_ytdlp()
    if loc:
        opts["ffmpeg_location"] = loc
    with YoutubeDL(opts) as ydl:
        ydl.download([url])

    json3_files = sorted(workdir.glob(f"{video_id}*.json3"))
    if not json3_files:
        return None
    is_auto = any(".en" in f.name and "orig" not in f.name for f in json3_files)
    segments = _parse_json3(json3_files[0])
    if not segments:
        return None
    return {
        "source": "captions_auto" if is_auto else "captions_manual",
        "language": "en",
        "segments": segments,
        "full_text": _segments_to_full_text(segments),
    }


def _parse_json3(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    segments = []
    for event in data.get("events", []):
        segs = event.get("segs")
        if not segs:
            continue
        text = _clean_text("".join(s.get("utf8", "") for s in segs))
        if not text:
            continue
        start = event.get("tStartMs", 0) / 1000.0
        dur = event.get("dDurationMs", 0) / 1000.0
        segments.append({"start": round(start, 2), "duration": round(dur, 2), "text": text})
    return segments


# --- tier 3: openai-whisper (isolated subprocess) -----------------------
def is_whisper_cached(model: str | None = None) -> bool:
    """Whether the openai-whisper model weights are already downloaded."""
    model = model or config.WHISPER_MODEL
    roots = []
    xdg = os.environ.get("XDG_CACHE_HOME")
    if xdg:
        roots.append(Path(xdg) / "whisper")
    dl = os.environ.get("WHISPER_DOWNLOAD_ROOT")
    if dl:
        roots.append(Path(dl))
    roots.append(Path.home() / ".cache" / "whisper")
    return any((r / f"{model}.pt").exists() for r in roots)


def ensure_whisper_model(log: Logger | None = None) -> bool:
    """Pre-download the Whisper model into the cache (one-time). Returns True
    if the model is available afterwards. Runs in a subprocess for isolation."""
    log = log or _noop
    if is_whisper_cached():
        log(f"Whisper model '{config.WHISPER_MODEL}' already downloaded.")
        return True
    log(f"Downloading Whisper model '{config.WHISPER_MODEL}' (one-time)...")
    cmd = [sys.executable, "-m", "app.whisper_worker",
           "--model", config.WHISPER_MODEL, "--device", config.WHISPER_DEVICE,
           "--download-only"]
    try:
        proc = subprocess.run(cmd, cwd=str(config.PROJECT_ROOT),
                              capture_output=True, text=True, timeout=3600)
    except Exception as e:  # noqa: BLE001
        log(f"Whisper model download failed: {e}")
        return False
    if proc.returncode != 0:
        log(f"Whisper model download failed (exit {proc.returncode}): "
            f"{(proc.stderr or '').strip()[-200:]}")
        return False
    return is_whisper_cached()


def _run_whisper_subprocess(audio: Path, out_json: Path, log: Logger) -> dict | None:
    cmd = [sys.executable, "-m", "app.whisper_worker",
           "--audio", str(audio), "--model", config.WHISPER_MODEL,
           "--device", config.WHISPER_DEVICE, "--out", str(out_json)]
    try:
        proc = subprocess.run(cmd, cwd=str(config.PROJECT_ROOT),
                              capture_output=True, text=True, timeout=WHISPER_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise TranscriptError(
            f"Whisper transcription timed out after {WHISPER_TIMEOUT}s. "
            f"Try a smaller model (YIA_WHISPER_MODEL=tiny) or a shorter video.")
    if proc.returncode != 0:
        # 139 / -11 == native segfault; anything non-zero means the isolated
        # worker failed, but the server itself stays alive.
        tail = (proc.stderr or proc.stdout or "").strip()[-300:]
        raise TranscriptError(
            f"Whisper worker failed (exit {proc.returncode}). {tail}")
    try:
        return json.loads(out_json.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        raise TranscriptError(f"Whisper produced no readable output: {e}")


def _download_audio(video_id: str, url: str, log: Logger) -> Path | None:
    from yt_dlp import YoutubeDL

    workdir = _workdir(video_id)
    existing = list(workdir.glob(f"{video_id}.audio.*"))
    if existing:
        return existing[0]
    opts = {
        "quiet": True, "no_warnings": True, "noplaylist": True,
        "format": "bestaudio/best",
        "outtmpl": str(workdir / f"{video_id}.audio.%(ext)s"),
    }
    loc = ffmpeg_location_for_ytdlp()
    if loc:
        opts["ffmpeg_location"] = loc
    with YoutubeDL(opts) as ydl:
        ydl.download([url])
    files = list(workdir.glob(f"{video_id}.audio.*"))
    return files[0] if files else None


def _via_whisper(video_id: str, url: str, log: Logger) -> dict | None:
    audio = _download_audio(video_id, url, log)
    if not audio or not audio.exists():
        raise TranscriptError("Could not download audio for transcription.")
    if not is_whisper_cached():
        log(f"Downloading Whisper model '{config.WHISPER_MODEL}' (one-time, this can "
            f"take a few minutes)...")
    else:
        log(f"Transcribing audio with Whisper '{config.WHISPER_MODEL}' in an isolated "
            f"process (this can take a while for long videos)...")
    out_json = _workdir(video_id) / f"{video_id}.whisper.json"
    result = _run_whisper_subprocess(audio, out_json, log)
    segments = result.get("segments") if result else None
    if not segments:
        return None
    return {
        "source": "whisper",
        "language": result.get("language"),
        "segments": segments,
        "full_text": result.get("full_text") or _segments_to_full_text(segments),
    }
