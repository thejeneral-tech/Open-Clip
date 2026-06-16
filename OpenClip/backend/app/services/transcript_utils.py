"""Helpers for slicing & formatting transcript data.

The transcript is stored as a list of segment dicts:

    { "id", "start", "end", "text", "speaker",
      "words": [{ "word", "start", "end", "probability" }] }
"""
from __future__ import annotations

from typing import Any


def iter_words(segments: list[dict[str, Any]]):
    for seg in segments:
        yield from seg.get("words", []) or []


def words_in_range(
    segments: list[dict[str, Any]], start: float, end: float
) -> list[dict[str, Any]]:
    """Return word dicts whose midpoint falls within [start, end]."""
    out: list[dict[str, Any]] = []
    for w in iter_words(segments):
        ws, we = float(w["start"]), float(w["end"])
        mid = (ws + we) / 2
        if start <= mid <= end:
            out.append(w)
    return out


def segments_in_range(
    segments: list[dict[str, Any]], start: float, end: float
) -> list[dict[str, Any]]:
    return [s for s in segments if float(s["end"]) > start and float(s["start"]) < end]


def text_in_range(segments: list[dict[str, Any]], start: float, end: float) -> str:
    parts = [s["text"].strip() for s in segments_in_range(segments, start, end)]
    return " ".join(p for p in parts if p).strip()


def clip_words_relative(
    segments: list[dict[str, Any]], start: float, end: float
) -> list[dict[str, Any]]:
    """Word list with timestamps rebased so the clip starts at t=0."""
    out: list[dict[str, Any]] = []
    for w in words_in_range(segments, start, end):
        out.append(
            {
                "word": w["word"].strip(),
                "start": max(0.0, float(w["start"]) - start),
                "end": max(0.0, float(w["end"]) - start),
                "probability": w.get("probability"),
            }
        )
    return out


def boundaries(segments: list[dict[str, Any]]) -> tuple[list[float], list[float]]:
    """Sorted lists of sentence start and end timestamps."""
    starts = sorted(float(s["start"]) for s in segments)
    ends = sorted(float(s["end"]) for s in segments)
    return starts, ends


def snap_to_boundaries(
    start: float,
    end: float,
    segments: list[dict[str, Any]],
    *,
    max_snap: float = 1.5,
) -> tuple[float, float]:
    """Snap a candidate [start, end] to the nearest sentence boundaries.

    Only snaps when a boundary is within ``max_snap`` seconds, so we don't
    distort intentionally tight cuts.
    """
    starts, ends = boundaries(segments)

    def nearest(value: float, options: list[float]) -> float:
        if not options:
            return value
        best = min(options, key=lambda o: abs(o - value))
        return best if abs(best - value) <= max_snap else value

    snapped_start = nearest(start, starts)
    snapped_end = nearest(end, ends)
    if snapped_end <= snapped_start:
        snapped_start, snapped_end = start, end
    return snapped_start, snapped_end


def format_for_llm(
    segments: list[dict[str, Any]],
    *,
    start: float | None = None,
    end: float | None = None,
) -> str:
    """Render segments as ``[start-end] text`` lines for prompt input."""
    lines: list[str] = []
    for s in segments:
        ss, se = float(s["start"]), float(s["end"])
        if start is not None and se < start:
            continue
        if end is not None and ss > end:
            continue
        text = s["text"].strip()
        if not text:
            continue
        speaker = f" {s['speaker']}:" if s.get("speaker") else ""
        lines.append(f"[{ss:.1f}-{se:.1f}]{speaker} {text}")
    return "\n".join(lines)
