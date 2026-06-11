"""Composite 0–100 story scoring (port of StoryVault's ranking heuristics).

Four weighted components: engagement (upvotes/comments), narrative quality
(length fit, sentence rhythm), hook strength (drama in the opening), and
video-friendliness (first-person, dialogue, twist markers).
"""
from __future__ import annotations

import math
import re
from typing import Any

_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")
_DRAMA_WORDS = re.compile(
    r"\b(furious|screamed|shocked|caught|cheated|betray\w*|revenge|secret|lied?|"
    r"divorce|fired|arrested|terrified|insane|crazy|unbelievable|never|worst|"
    r"refuse[ds]?|kicked out|ultimatum|affair|ghosted|exposed)\b",
    re.IGNORECASE,
)
_FIRST_PERSON = re.compile(r"\b(I|my|me|we|our)\b")
_TWIST_MARKERS = re.compile(
    r"\b(but then|turns out|plot twist|little did|until|suddenly|however|"
    r"that's when|update:)\b",
    re.IGNORECASE,
)


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def _engagement(upvotes: int, comments: int) -> float:
    # log-scaled: 10 ups ≈ 33, 100 ≈ 55, 1k ≈ 77, 10k ≈ 100
    up_score = _clamp(math.log10(max(1, upvotes)) * 22 + 11) if upvotes > 0 else 8
    cm_score = _clamp(math.log10(max(1, comments)) * 25 + 10) if comments > 0 else 8
    return 0.7 * up_score + 0.3 * cm_score


def _quality(body: str) -> float:
    n = len(body)
    if n < 200:
        length_fit = 20.0
    elif n < 400:
        length_fit = 55.0
    elif n <= 2400:
        length_fit = 95.0
    elif n <= 5000:
        length_fit = 70.0
    else:
        length_fit = 45.0

    sentences = [s for s in _SENT_SPLIT.split(body) if s.strip()]
    if sentences:
        avg_words = sum(len(s.split()) for s in sentences) / len(sentences)
        rhythm = 90.0 if 8 <= avg_words <= 22 else (60.0 if avg_words <= 30 else 35.0)
    else:
        rhythm = 30.0
    return 0.65 * length_fit + 0.35 * rhythm


def _hook(title: str, body: str) -> float:
    opening = f"{title}. {body[:280]}"
    score = 30.0
    score += min(40.0, len(_DRAMA_WORDS.findall(opening)) * 13)
    if "?" in title or opening.strip().endswith("?"):
        score += 12
    if re.search(r"\bAITA\b|\bTIFU\b|am i (the|a)\b", opening, re.IGNORECASE):
        score += 10
    return _clamp(score)


def _video_friendliness(body: str) -> float:
    words = max(1, len(body.split()))
    fp_density = len(_FIRST_PERSON.findall(body)) / words
    score = 25.0 + _clamp(fp_density * 900, 0, 35)
    if '"' in body or "'" in body:
        score += 8
    score += min(20.0, len(_TWIST_MARKERS.findall(body)) * 10)
    return _clamp(score)


def score_story(title: str, body: str, upvotes: int = 0, comments: int = 0) -> dict[str, Any]:
    breakdown = {
        "engagement": round(_engagement(upvotes, comments), 1),
        "quality": round(_quality(body), 1),
        "hook": round(_hook(title, body), 1),
        "video_friendliness": round(_video_friendliness(body), 1),
    }
    overall = (
        0.30 * breakdown["engagement"]
        + 0.25 * breakdown["quality"]
        + 0.25 * breakdown["hook"]
        + 0.20 * breakdown["video_friendliness"]
    )
    return {"overall": round(_clamp(overall), 1), "breakdown": breakdown}


def guess_category(title: str, body: str, community: str | None = None) -> str:
    """Map a story onto one of the SV_CATEGORIES buckets."""
    haystack = f"{community or ''} {title}".lower()
    rules = [
        ("AITA", r"aita|am i the|amitheasshole"),
        ("Revenge", r"revenge|prorevenge|pettyrevenge"),
        ("Relationships", r"relationship|boyfriend|girlfriend|husband|wife|dating|marriage"),
        ("Scary", r"nosleep|scary|horror|creep|paranormal|ghost"),
        ("Confessions", r"confess|tifu|offmychest|secret"),
        ("Workplace", r"work|boss|antiwork|maliciouscompliance|job|coworker"),
        ("Family", r"family|mother|father|in-?law|parent|sibling|entitledparents"),
        ("Money", r"money|debt|inheritance|rich|broke|salary"),
        ("School", r"school|teacher|college|university|professor"),
        ("Wholesome", r"wholesome|mademesmile|humansbeingbros"),
        ("Mystery", r"mystery|unresolved|unsolved|disappear"),
    ]
    for cat, pattern in rules:
        if re.search(pattern, haystack):
            return cat
    return "Other"
