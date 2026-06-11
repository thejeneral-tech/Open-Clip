"""Speech-to-text with word-level timestamps and optional diarization.

Primary engine is **faster-whisper** (CTranslate2) for speed; the reference
**openai-whisper** engine is supported as a fallback. Speaker labels are added
via **pyannote.audio** when ``ENABLE_DIARIZATION`` is set.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger
from app.core.net import prefer_ipv4

logger = get_logger(__name__)

# Whisper/pyannote weights are pulled from the HF Hub on first use. This host's
# IPv6 path to huggingface.co resets during TLS, so prefer IPv4 for downloads.
prefer_ipv4()

ProgressCb = Callable[[float], None]

# Cache loaded models across tasks in the same worker process.
_model_cache: dict[str, Any] = {}
_diarizer: Any = None


def _get_faster_whisper(model_size: str):
    threads = max(0, settings.WHISPER_CPU_THREADS)
    key = f"fw:{model_size}:{settings.WHISPER_DEVICE}:{settings.WHISPER_COMPUTE_TYPE}:{threads}"
    if key not in _model_cache:
        from faster_whisper import WhisperModel

        # cpu_threads only applies to CPU inference; 0 lets CTranslate2 decide.
        extra = {"cpu_threads": threads} if threads else {}
        logger.info(
            "Loading faster-whisper %s on %s (cpu_threads=%s)",
            model_size, settings.WHISPER_DEVICE, threads or "auto",
        )
        try:
            _model_cache[key] = WhisperModel(
                model_size,
                device=settings.WHISPER_DEVICE,
                compute_type=settings.WHISPER_COMPUTE_TYPE,
                **extra,
            )
        except Exception as exc:  # GPU unavailable → fall back to CPU int8
            logger.warning("GPU load failed (%s); falling back to CPU int8", exc)
            _model_cache[key] = WhisperModel(
                model_size, device="cpu", compute_type="int8", **extra
            )
    return _model_cache[key]


def _transcribe_faster_whisper(
    audio_path: str,
    *,
    model_size: str,
    language: str | None,
    on_progress: ProgressCb | None,
) -> dict[str, Any]:
    model = _get_faster_whisper(model_size)
    segments_gen, info = model.transcribe(
        audio_path,
        language=language,
        beam_size=settings.WHISPER_BEAM_SIZE,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
    )
    total = float(info.duration or 0) or 1.0
    out_segments: list[dict[str, Any]] = []
    full_text_parts: list[str] = []

    for idx, seg in enumerate(segments_gen):
        words = [
            {
                "word": w.word,
                "start": round(float(w.start), 3),
                "end": round(float(w.end), 3),
                "probability": round(float(getattr(w, "probability", 0.0) or 0.0), 4),
            }
            for w in (seg.words or [])
        ]
        out_segments.append(
            {
                "id": idx,
                "start": round(float(seg.start), 3),
                "end": round(float(seg.end), 3),
                "text": seg.text.strip(),
                "speaker": None,
                "words": words,
            }
        )
        full_text_parts.append(seg.text.strip())
        if on_progress:
            on_progress(min(0.99, float(seg.end) / total))

    if on_progress:
        on_progress(1.0)

    return {
        "language": info.language,
        "duration": total,
        "segments": out_segments,
        "full_text": " ".join(full_text_parts).strip(),
    }


def _transcribe_openai_whisper(
    audio_path: str,
    *,
    model_size: str,
    language: str | None,
    on_progress: ProgressCb | None,
) -> dict[str, Any]:
    import whisper

    key = f"ow:{model_size}"
    if key not in _model_cache:
        _model_cache[key] = whisper.load_model(model_size, device=settings.WHISPER_DEVICE)
    model = _model_cache[key]
    result = model.transcribe(audio_path, language=language, word_timestamps=True, verbose=False)

    out_segments: list[dict[str, Any]] = []
    for idx, seg in enumerate(result.get("segments", [])):
        words = [
            {
                "word": w.get("word", ""),
                "start": round(float(w.get("start", 0)), 3),
                "end": round(float(w.get("end", 0)), 3),
                "probability": round(float(w.get("probability", 0.0)), 4),
            }
            for w in seg.get("words", [])
        ]
        out_segments.append(
            {
                "id": idx,
                "start": round(float(seg["start"]), 3),
                "end": round(float(seg["end"]), 3),
                "text": seg["text"].strip(),
                "speaker": None,
                "words": words,
            }
        )
    if on_progress:
        on_progress(1.0)
    return {
        "language": result.get("language"),
        "duration": out_segments[-1]["end"] if out_segments else 0.0,
        "segments": out_segments,
        "full_text": result.get("text", "").strip(),
    }


def _apply_diarization(audio_path: str, segments: list[dict[str, Any]]) -> int:
    """Annotate segments with speaker labels. Returns the speaker count."""
    global _diarizer
    if not settings.ENABLE_DIARIZATION:
        return 0
    try:
        if _diarizer is None:
            from pyannote.audio import Pipeline

            _diarizer = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                use_auth_token=settings.HUGGINGFACE_TOKEN,
            )
        diarization = _diarizer(audio_path)
    except Exception as exc:  # pragma: no cover - heavy optional dependency
        logger.warning("Diarization unavailable: %s", exc)
        return 0

    turns = [(t.start, t.end, spk) for t, _, spk in diarization.itertracks(yield_label=True)]
    speakers: set[str] = set()
    for seg in segments:
        best_spk, best_overlap = None, 0.0
        for ts, te, spk in turns:
            overlap = max(0.0, min(seg["end"], te) - max(seg["start"], ts))
            if overlap > best_overlap:
                best_overlap, best_spk = overlap, spk
        if best_spk is not None:
            seg["speaker"] = best_spk
            speakers.add(best_spk)
    return len(speakers)


def transcribe(
    audio_path: str,
    *,
    model_size: str | None = None,
    language: str | None = None,
    on_progress: ProgressCb | None = None,
) -> dict[str, Any]:
    """Transcribe an audio file.

    Returns ``{language, duration, segments, full_text, word_count, num_speakers,
    engine, model}``.
    """
    model_size = model_size or settings.WHISPER_MODEL
    engine = settings.WHISPER_ENGINE

    if engine == "whisper":
        result = _transcribe_openai_whisper(
            audio_path, model_size=model_size, language=language, on_progress=on_progress
        )
    else:
        result = _transcribe_faster_whisper(
            audio_path, model_size=model_size, language=language, on_progress=on_progress
        )

    result["num_speakers"] = _apply_diarization(audio_path, result["segments"])
    result["word_count"] = sum(len(s.get("words", [])) for s in result["segments"])
    result["engine"] = engine
    result["model"] = model_size
    return result
