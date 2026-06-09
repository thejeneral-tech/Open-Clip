"""YouTube clip detection — blends the transcript LLM pass with engagement signals.

Runs the existing transcript-based detector (:func:`viral_detection.detect_viral_clips`)
over YouTube captions (or a Whisper transcript), then folds in the "most replayed"
heatmap and comment-mentioned timestamps: LLM candidates that land on a heatmap
peak / requested timestamp get a score boost, and standalone signal moments are
added as candidates so the engagement data surfaces clips the model missed. The
upload path keeps using :func:`viral_detection.detect_viral_clips` directly.
"""
from __future__ import annotations

from typing import Any

from app.core.config import settings
from app.core.logging import get_logger
from app.services import viral_detection
from app.services.ollama_client import OllamaClient
from app.services.viral_detection import CandidateClip

logger = get_logger(__name__)

_BOOST = 15.0  # score bump for an LLM candidate sitting on an engagement signal


def _signal_candidates(
    youtube_meta: dict[str, Any], duration: float, *, min_s: int, max_s: int
) -> list[CandidateClip]:
    """Clip candidates centred on heatmap peaks + comment-mentioned timestamps."""
    span = float(min(max_s, max(min_s, 35)))
    out: list[CandidateClip] = []

    def make(center: float, score: float, title: str, reasoning: str, hook: str) -> CandidateClip:
        start = max(0.0, center - span / 2)
        end = start + span
        if duration:
            end = min(end, duration)
            if end - start < min_s:  # clip pinned to the tail — pull the start back
                start = max(0.0, end - span)
        return CandidateClip(
            start=round(start, 2), end=round(end, 2),
            title=title, viral_score=max(0.0, min(100.0, score)),
            reasoning=reasoning, hook_type=hook,
        )

    for r in youtube_meta.get("most_replayed") or []:
        out.append(
            make(
                float(r.get("time", 0)),
                60 + 35 * float(r.get("intensity") or 0),
                "Most replayed moment",
                f"YouTube heatmap shows high replay intensity ({r.get('intensity')}).",
                "replayed",
            )
        )
    for t in (youtube_meta.get("mentioned_timestamps") or [])[:6]:
        example = (t.get("example") or "")[:80]
        out.append(
            make(
                float(t.get("time", 0)),
                min(95, 55 + (t.get("mentions") or 0) * 3),
                "Audience-requested moment",
                f"Mentioned in {t.get('mentions')} comments: \"{example}\"",
                "audience",
            )
        )
    return out


def _signal_times(youtube_meta: dict[str, Any]) -> list[float]:
    times = [float(r.get("time", 0)) for r in youtube_meta.get("most_replayed") or []]
    times += [float(t.get("time", 0)) for t in youtube_meta.get("mentioned_timestamps") or []]
    return times


def _boost_overlapping(candidates: list[CandidateClip], youtube_meta: dict[str, Any]) -> None:
    """Bump LLM candidates whose span contains a heatmap/comment signal."""
    times = _signal_times(youtube_meta)
    if not times:
        return
    for c in candidates:
        if any(c.start <= t <= c.end for t in times) and c.viral_score < 100:
            c.viral_score = min(100.0, c.viral_score + _BOOST)
            c.extra["signal_boosted"] = True


def detect_from_youtube(
    *,
    caption_segments: list[dict[str, Any]],
    duration: float,
    youtube_meta: dict[str, Any],
    opts: Any,
    models: dict[str, str],
    client: OllamaClient | None = None,
) -> tuple[list[CandidateClip], list[dict[str, Any]]]:
    """Return ``(selected_clips, analyses)`` blending transcript + engagement signals."""
    min_s = opts.min_clip_seconds or settings.MIN_CLIP_SECONDS
    max_s = opts.max_clip_seconds or settings.MAX_CLIP_SECONDS
    target = max(1, min(opts.target_clip_count, settings.MAX_CLIPS_PER_VIDEO))

    candidates: list[CandidateClip] = []
    analyses: list[dict[str, Any]] = []

    if caption_segments:
        llm_clips, analyses = viral_detection.detect_viral_clips(
            caption_segments,
            duration=duration,
            target_count=target,
            min_seconds=min_s,
            max_seconds=max_s,
            model=opts.model or models["default"],
            client=client,
        )
        candidates.extend(llm_clips)

    if opts.use_youtube_signals:
        _boost_overlapping(candidates, youtube_meta)
        candidates.extend(_signal_candidates(youtube_meta, duration, min_s=min_s, max_s=max_s))

    deduped = viral_detection._dedupe_overlaps(candidates)
    deduped.sort(key=lambda c: c.viral_score, reverse=True)
    selected = deduped[:target]
    selected.sort(key=lambda c: c.start)  # chronological for the UI

    logger.info(
        "YouTube detect: %d llm + signals -> %d deduped -> %d selected",
        len(candidates), len(deduped), len(selected),
    )
    return selected, analyses
