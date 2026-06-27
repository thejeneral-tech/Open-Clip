"""Audio audition of a music bed under a sample narration.

The Studio / Projects "Test" button plays a short clip of a track mixed under
narration at a chosen level, using the *same* ``volume`` + ``amix(normalize=0)``
recipe the render uses (see ``composer.render_video``) — so what the user hears
matches how the bed will sit beneath the voice in the finished video.
"""
from __future__ import annotations

import os

from app.services.ffmpeg import ffmpeg

# Spoken once and cached; the music is mixed underneath it for the audition.
SAMPLE_TEXT = (
    "Here's how your background music will sit underneath the narration in your video."
)

PREVIEW_SECONDS = 12.0


def build_preview(
    music_path: str,
    narration_path: str | None,
    volume: float,
    out_path: str,
    *,
    seconds: float = PREVIEW_SECONDS,
) -> float:
    """Render the audition MP3 and return its duration.

    With a sample narration, the music is looped underneath it at ``volume`` and
    the clip runs for the narration's length (capped at ``seconds``) — exactly
    the render's mix. Without narration (no system voice available) it falls back
    to the music alone at ``volume``, so the level is still auditioned.
    """
    vol = max(0.0, min(1.0, float(volume)))
    if narration_path and os.path.exists(narration_path):
        try:
            narr_dur = ffmpeg.probe(narration_path).duration or seconds
        except Exception:  # noqa: BLE001 — a probe hiccup just uses the cap
            narr_dur = seconds
        dur = max(0.5, min(seconds, narr_dur))
        args = [
            "-i", narration_path,
            "-stream_loop", "-1", "-i", music_path,
            "-filter_complex",
            f"[1:a]volume={vol:.3f}[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]",
            "-map", "[a]", "-t", f"{dur:.3f}",
            "-c:a", "libmp3lame", "-q:a", "4", out_path,
        ]
    else:
        dur = seconds
        args = [
            "-stream_loop", "-1", "-i", music_path,
            "-filter_complex", f"[0:a]volume={vol:.3f}[a]",
            "-map", "[a]", "-t", f"{dur:.3f}",
            "-c:a", "libmp3lame", "-q:a", "4", out_path,
        ]
    ffmpeg.run(args)
    try:
        return ffmpeg.probe(out_path).duration or dur
    except Exception:  # noqa: BLE001
        return dur
