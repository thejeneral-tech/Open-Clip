"""Engine-agnostic narration helpers: caption timing + audio assembly.

Any TTS engine that returns only a WAV (Fish Speech S2, Piper, …) needs the same
post-processing the SAPI path gets for free:

* **word-synced caption timings** — recovered by transcribing the *synthesized*
  speech with faster-whisper for **timing only**; the caption text stays the
  known script (:func:`align_to_text`), so a mis-recognised word never reaches
  the screen.
* **audio assembly** — per-beat concatenation with small pauses
  (:func:`concat_with_gaps`) and post-hoc speed control (:func:`apply_tempo`),
  since these engines have no rate control of their own.

This module is the single, shared implementation; :mod:`fish_clone` and
:mod:`piper_tts` both build their ``narrate`` / ``narrate_story`` on top of it,
so the downstream caption + overlay code is identical for every engine.
"""
from __future__ import annotations

import difflib
import os
import re

from app.core.logging import get_logger
from app.services.ffmpeg import ffmpeg

logger = get_logger(__name__)

BEAT_GAP = 0.18  # seconds of silence between intro beats (matches the SAPI feel)

# A single caption word never holds on screen longer than this. Per-beat
# alignment keeps words sub-second; the cap only bites if whisper hallucinates or
# duplicates so badly that an unmatched word ends up bracketed by a far-away
# anchor — then the highlight is bounded instead of stalling for seconds. Mirrors
# the per-word duration cap on the SAPI path (:func:`tts._build_words`).
MAX_WORD_DUR = 2.5

_ALNUM = re.compile(r"[^a-z0-9]+")


def probe_duration(wav_path: str) -> float:
    try:
        return float(ffmpeg.probe(wav_path).duration)
    except Exception:
        return 0.0


def apply_tempo(wav_path: str, speed: float) -> None:
    """Time-stretch ``wav_path`` in place to honour a preset's speed (these engines
    have no rate control of their own). A no-op at 1.0; clamped to atempo's 0.5–2.0."""
    if abs((speed or 1.0) - 1.0) < 0.01:
        return
    tempo = max(0.5, min(2.0, float(speed)))
    tmp = wav_path + ".tempo.wav"
    ffmpeg.run(["-i", wav_path, "-filter:a", f"atempo={tempo:.3f}",
                "-ac", "1", "-c:a", "pcm_s16le", tmp])
    os.replace(tmp, wav_path)


def concat_with_gaps(wavs: list[str], out_wav: str, *, gap: float = BEAT_GAP, sr: int = 24000) -> None:
    """Concatenate ``wavs`` into ``out_wav``, separated by ``gap`` s of silence.

    Each segment (and the generated silence) is normalized to mono ``sr`` first so
    clips of differing sample rate / channel layout join cleanly.
    """
    inputs: list[str] = []
    for w in wavs:
        inputs += ["-i", w]
    fmt = f"aformat=sample_fmts=s16:sample_rates={sr}:channel_layouts=mono"
    parts: list[str] = []
    labels: list[str] = []
    for i in range(len(wavs)):
        parts.append(f"[{i}:a]{fmt}[a{i}]")
        labels.append(f"[a{i}]")
        if i < len(wavs) - 1:
            parts.append(f"anullsrc=r={sr}:cl=mono:d={gap},{fmt}[g{i}]")
            labels.append(f"[g{i}]")
    graph = ";".join(parts) + ";" + "".join(labels) + f"concat=n={len(labels)}:v=0:a=1[out]"
    ffmpeg.run([*inputs, "-filter_complex", graph, "-map", "[out]",
                "-ac", "1", "-ar", str(sr), "-c:a", "pcm_s16le", out_wav])


def whisper_words(wav_path: str) -> list[dict]:
    """Recognised word tokens ``[{word, start, end}]`` for a synthesized clip, from
    faster-whisper. These supply *timing* only — :func:`align_to_text` maps the
    known script text onto them. Best-effort: ``[]`` on any failure, so the caller
    falls back to even spacing exactly as the SAPI path does."""
    try:
        from app.services.transcription import transcribe

        result = transcribe(wav_path)
    except Exception as exc:
        logger.warning("Whisper alignment of synthesized narration failed (%s); captions fall back to even spacing", exc)
        return []
    words: list[dict] = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            word = str(w.get("word") or "").strip()
            if not word:
                continue
            start = max(0.0, float(w.get("start") or 0.0))
            end = max(start, float(w.get("end") or start))
            words.append({"word": word, "start": round(start, 3), "end": round(end, 3)})
    return words


def offset(words: list[dict], by: float) -> list[dict]:
    return [
        {"word": w["word"], "start": round(w["start"] + by, 3), "end": round(w["end"] + by, 3)}
        for w in words
    ]


def _norm(word: str) -> str:
    """Alignment key for a token: lowercased, punctuation/spacing stripped."""
    return _ALNUM.sub("", word.lower())


def _spread(words: list[dict], lo: int, hi: int, t0: float, t1: float) -> None:
    """Time the unanchored tokens ``words[lo:hi]`` across ``[t0, t1]`` in place.

    Script words whisper failed to recognise get no timestamp of their own; we
    fill them between their surrounding anchors, giving longer words proportionally
    more time so the highlight still glides at a natural pace.
    """
    if hi <= lo:
        return
    t1 = max(t1, t0)
    weights = [max(1, len(words[i]["word"])) for i in range(lo, hi)]
    total = sum(weights) or 1
    span = t1 - t0
    cursor = t0
    for off, i in enumerate(range(lo, hi)):
        nxt = cursor + span * weights[off] / total
        words[i]["start"] = cursor
        words[i]["end"] = nxt
        cursor = nxt


def align_to_text(text: str, whisper_words: list[dict], duration: float) -> list[dict]:
    """Caption tokens showing the *known* script text, timed from the whisper words.

    Whisper transcribes the *synthesized* speech, so its word **text** drifts from
    the script — mishearings, merged words, numbers spelled out — and burning that
    straight in is the "slurred / wrong-lettering" caption bug. Here whisper is
    used only for **timing**: the script's own words are the caption text, each
    timestamped from the whisper word it aligns to, with any unmatched word
    interpolated between its neighbours. The displayed letters are therefore
    always exactly the script, however the recogniser heard the audio.

    Falls back to even spacing of the script when whisper returned nothing (or
    nothing that aligns), so captions still read correctly.
    """
    from app.services.storyvault.tts import _even_spacing

    display = [w for w in text.split() if w.strip()]
    if not display:
        return []

    def _even() -> list[dict]:
        return [
            {"word": w["word"], "start": w["start"], "end": w["end"]}
            for w in _even_spacing(text, duration)
        ]

    if not whisper_words:
        return _even()

    a = [_norm(w) for w in display]
    b = [_norm(w["word"]) for w in whisper_words]
    out: list[dict] = [{"word": w, "start": None, "end": None} for w in display]

    # 1) Anchor every script word whisper recognised verbatim to that word's
    # measured (start, end). SequenceMatcher's equal blocks are the run-length
    # matches between the script tokens and the recognised tokens.
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    anchors: list[int] = []
    for ai, bj, size in sm.get_matching_blocks():
        for k in range(size):
            ww = whisper_words[bj + k]
            out[ai + k]["start"] = float(ww["start"])
            out[ai + k]["end"] = float(ww["end"])
            anchors.append(ai + k)

    if not anchors:
        # Whisper heard something entirely different — no reliable timing to map.
        return _even()

    # 2) Fill the gaps around the anchors: the leading run, each internal run, and
    # the trailing run, each spread across the time between its bracketing anchors.
    end_t = max(duration, out[anchors[-1]]["end"])
    _spread(out, 0, anchors[0], 0.0, out[anchors[0]]["start"])
    for p, q in zip(anchors, anchors[1:], strict=False):
        _spread(out, p + 1, q, out[p]["end"], out[q]["start"])
    _spread(out, anchors[-1] + 1, len(out), out[anchors[-1]]["end"], end_t)

    # 3) Clean, non-zero-length tokens (the caption layer owns final ordering).
    clean: list[dict] = []
    prev = 0.0
    for w in out:
        s = max(0.0, float(w["start"] if w["start"] is not None else prev))
        e = float(w["end"] if w["end"] is not None else s)
        if e <= s:
            e = s + 0.06
        e = min(e, s + MAX_WORD_DUR)  # never let a word stall on screen
        clean.append({"word": w["word"], "start": round(s, 3), "end": round(e, 3)})
        prev = e
    return clean
