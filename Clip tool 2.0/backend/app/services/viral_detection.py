"""Viral moment detection.

Given a transcript, asks the LLM to nominate the best candidate clips. Long
videos are analyzed in overlapping windows so we never blow the context window,
then candidates are normalized, snapped to sentence boundaries, de-overlapped,
and clamped to the requested count.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger
from app.services import prompts
from app.services.ollama_client import OllamaClient, ollama
from app.services.transcript_utils import (
    format_for_llm,
    segments_in_range,
    snap_to_boundaries,
    text_in_range,
)

logger = get_logger(__name__)

# Analyze the video in windows of this many seconds (with a little overlap).
_WINDOW_SECONDS = 600
_WINDOW_OVERLAP = 30


@dataclass
class CandidateClip:
    start: float
    end: float
    title: str
    viral_score: float
    reasoning: str
    hook_type: str = "energy"
    transcript_text: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_dict(self) -> dict[str, Any]:
        return {
            "start": round(self.start, 2),
            "end": round(self.end, 2),
            "duration": round(self.duration, 2),
            "title": self.title,
            "viral_score": float(self.viral_score),
            "reasoning": self.reasoning,
            "hook_type": self.hook_type,
            "transcript_text": self.transcript_text,
        }


def _windows(duration: float) -> list[tuple[float, float]]:
    if duration <= _WINDOW_SECONDS:
        return [(0.0, duration)]
    out: list[tuple[float, float]] = []
    step = _WINDOW_SECONDS - _WINDOW_OVERLAP
    t = 0.0
    while t < duration:
        out.append((t, min(duration, t + _WINDOW_SECONDS)))
        t += step
    return out


def _normalize(
    raw_clips: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    *,
    min_s: int,
    max_s: int,
    duration: float,
) -> list[CandidateClip]:
    out: list[CandidateClip] = []
    for c in raw_clips:
        try:
            start = max(0.0, float(c["start"]))
            end = min(duration, float(c["end"]))
        except (KeyError, TypeError, ValueError):
            continue
        if end <= start:
            continue

        start, end = snap_to_boundaries(start, end, segments)

        # Enforce duration bounds (trim/extend within reason).
        if end - start < min_s:
            end = min(duration, start + min_s)
        if end - start > max_s:
            end = start + max_s
        if end - start < max(3.0, min_s * 0.5):
            continue

        score = float(c.get("viral_score", 50) or 50)
        score = max(0.0, min(100.0, score))
        out.append(
            CandidateClip(
                start=start,
                end=end,
                title=str(c.get("title") or "Untitled clip")[:120],
                viral_score=score,
                reasoning=str(c.get("reasoning") or ""),
                hook_type=str(c.get("hook_type") or "energy"),
                transcript_text=text_in_range(segments, start, end),
            )
        )
    return out


def _dedupe_overlaps(clips: list[CandidateClip]) -> list[CandidateClip]:
    """Greedily keep the highest-scoring clips, dropping those that overlap."""
    kept: list[CandidateClip] = []
    for clip in sorted(clips, key=lambda c: c.viral_score, reverse=True):
        overlap = False
        for k in kept:
            latest_start = max(clip.start, k.start)
            earliest_end = min(clip.end, k.end)
            inter = max(0.0, earliest_end - latest_start)
            if inter > 0.4 * min(clip.duration, k.duration):
                overlap = True
                break
        if not overlap:
            kept.append(clip)
    return kept


def detect_viral_clips(
    segments: list[dict[str, Any]],
    *,
    duration: float,
    target_count: int = 12,
    min_seconds: int | None = None,
    max_seconds: int | None = None,
    model: str | None = None,
    client: OllamaClient | None = None,
) -> tuple[list[CandidateClip], list[dict[str, Any]]]:
    """Detect candidate viral clips.

    Returns ``(clips, analyses)`` where ``analyses`` is a list of raw LLM
    interaction records suitable for persisting as :class:`AIAnalysis` rows.
    """
    client = client or ollama
    min_s = min_seconds or settings.MIN_CLIP_SECONDS
    max_s = max_seconds or settings.MAX_CLIP_SECONDS
    target_count = max(1, min(target_count, settings.MAX_CLIPS_PER_VIDEO))

    windows = _windows(duration)
    per_window = max(2, math.ceil(target_count / len(windows)) + 2)

    all_candidates: list[CandidateClip] = []
    analyses: list[dict[str, Any]] = []

    for win_start, win_end in windows:
        win_segments = segments_in_range(segments, win_start, win_end)
        if not win_segments:
            continue
        transcript_text = format_for_llm(win_segments)
        user_prompt = prompts.VIRAL_USER_TEMPLATE.format(
            count=per_window,
            min_seconds=min_s,
            max_seconds=max_s,
            transcript=transcript_text,
        )
        try:
            parsed, meta = client.generate_json(
                user_prompt,
                model=model,
                system=prompts.VIRAL_SYSTEM,
                schema=prompts.VIRAL_SCHEMA,
                options={"temperature": 0.6},
            )
        except Exception as exc:
            logger.error("Viral detection failed for window %s-%s: %s", win_start, win_end, exc)
            continue

        raw_clips = parsed.get("clips", []) if isinstance(parsed, dict) else []
        candidates = _normalize(raw_clips, segments, min_s=min_s, max_s=max_s, duration=duration)
        all_candidates.extend(candidates)
        analyses.append(
            {
                "analysis_type": "viral_detection",
                "model": meta.get("model"),
                "prompt": {"window": [win_start, win_end], "count": per_window},
                "result": {"clips": [c.to_dict() for c in candidates]},
                "tokens_eval": meta.get("eval_count"),
                "duration_ms": meta.get("duration_ms"),
            }
        )

    deduped = _dedupe_overlaps(all_candidates)
    deduped.sort(key=lambda c: c.viral_score, reverse=True)
    selected = deduped[:target_count]
    # Present in chronological order in the UI.
    selected.sort(key=lambda c: c.start)

    logger.info(
        "Viral detection: %d windows -> %d raw -> %d deduped -> %d selected",
        len(windows), len(all_candidates), len(deduped), len(selected),
    )
    return selected, analyses
