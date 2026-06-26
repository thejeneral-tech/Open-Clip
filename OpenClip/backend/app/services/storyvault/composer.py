"""Background-footage planning and the vertical-video render.

``plan_segments`` fills the narration duration with gameplay/footage segments
(least-used first, no repeats within one video, optional category filter).
``render_video`` assembles: segment slices → cover-crop to 9:16 → concat →
burned ASS captions → narration audio, with the encode offloaded to the
hardware encoder chosen by ``HWACCEL`` (``auto`` detects one, else CPU). With no
footage in the library it falls back to a dark gradient background, so the
pipeline never dead-ends.
"""
from __future__ import annotations

import os
import random
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.core.logging import get_logger
from app.services.ffmpeg import ffmpeg
from app.services.storage import storage

logger = get_logger(__name__)

ProgressCb = Callable[[float], None]

PREVIEW_W, PREVIEW_H = 540, 960
RENDER_W, RENDER_H = 1080, 1920
SEGMENT_LEN_DEFAULT = 12.0  # seconds per auto-cut footage segment
FPS = 30


@dataclass
class RenderSpec:
    narration_path: str            # absolute wav path
    total_duration: float
    ass_path: str | None           # absolute ass path (None = no captions)
    plan: list[dict[str, Any]]     # [{"storage_path", "start", "length"}, ...]
    output_path: str               # absolute output mp4
    width: int = RENDER_W
    height: int = RENDER_H
    # Intro overlays composited on top of the captioned footage, each:
    # {"path", "x", "y", "start", "end", "fade"} (absolute PNG path, target-px
    # position, on-screen window in seconds, alpha fade duration). Empty = none.
    overlays: list[dict[str, Any]] | None = None


def _escape_filter_path(path: str) -> str:
    return path.replace("\\", "/").replace(":", "\\:")


# -------------------------------------------------------------- segmentation
def auto_segments(duration: float, segment_len: float = SEGMENT_LEN_DEFAULT) -> list[tuple[float, float]]:
    """Cut a background video into fixed windows, dropping a tiny lead/tail."""
    if duration <= 4:
        return []
    lead = min(1.0, duration * 0.02)
    usable_end = duration - lead
    out: list[tuple[float, float]] = []
    t = lead
    while t + 4.0 <= usable_end:
        end = min(t + segment_len, usable_end)
        out.append((round(t, 2), round(end, 2)))
        t = end
    return out


def plan_segments(
    candidates: list[dict[str, Any]],
    total_duration: float,
    *,
    seed: int | None = None,
) -> list[dict[str, Any]]:
    """Pick segments to cover ``total_duration``.

    ``candidates``: [{"segment_id", "background_id", "storage_path", "start_sec",
    "end_sec", "times_used"}, ...]. Least-used segments are preferred; order is
    shuffled within usage tiers so consecutive videos don't repeat sequences.
    """
    if total_duration <= 0 or not candidates:
        return []
    rng = random.Random(seed)
    pool = sorted(candidates, key=lambda c: (int(c.get("times_used") or 0), rng.random()))

    plan: list[dict[str, Any]] = []
    covered = 0.0
    i = 0
    while covered < total_duration and pool:
        c = pool[i % len(pool)]
        i += 1
        seg_len = max(0.5, float(c["end_sec"]) - float(c["start_sec"]))
        take = min(seg_len, total_duration - covered + 0.25)
        if take < 0.5:
            take = min(seg_len, 0.5)
        plan.append(
            {
                "segment_id": c.get("segment_id"),
                "background_id": c.get("background_id"),
                "storage_path": c["storage_path"],
                "start": float(c["start_sec"]),
                "length": round(take, 3),
            }
        )
        covered += take
        if i >= len(pool):  # exhausted unique segments — allow reuse next lap
            rng.shuffle(pool)
    return plan


# -------------------------------------------------------------------- render
def render_video(
    spec: RenderSpec, *, hwaccel: str | None = None, on_progress: ProgressCb | None = None
) -> dict[str, Any]:
    """Run the ffmpeg composition; returns {path, width, height, duration, size_bytes}."""
    w, h, total = spec.width, spec.height, max(0.5, spec.total_duration)
    args: list[str] = []
    vlabels: list[str] = []
    filters: list[str] = []

    # Footage can be deleted between planning and (re-)rendering — skip missing
    # sources instead of failing, falling back to the gradient when none remain.
    plan = []
    for item in spec.plan:
        if os.path.exists(storage.abspath(item["storage_path"], ensure_parent=False)):
            plan.append(item)
        else:
            logger.warning("Skipping missing footage source %s", item["storage_path"])
    spec = RenderSpec(**{**spec.__dict__, "plan": plan})

    if spec.plan:
        for idx, item in enumerate(spec.plan):
            src = storage.abspath(item["storage_path"], ensure_parent=False)
            args.extend(["-ss", f"{float(item['start']):.3f}", "-t", f"{float(item['length']):.3f}", "-i", src])
            filters.append(
                f"[{idx}:v]scale={w}:{h}:force_original_aspect_ratio=increase,"
                f"crop={w}:{h},setsar=1,fps={FPS}[v{idx}]"
            )
            vlabels.append(f"[v{idx}]")
        concat = f"{''.join(vlabels)}concat=n={len(vlabels)}:v=1:a=0[vc]"
        filters.append(concat)
        vsrc = "[vc]"
        n_video_inputs = len(spec.plan)
    else:
        # No footage library yet: render on a dark gradient so the pipeline
        # still produces a watchable, caption-driven video.
        args.extend(["-f", "lavfi", "-i", f"color=c=0x141420:s={w}x{h}:d={total:.3f}:r={FPS}"])
        vsrc = "[0:v]"
        n_video_inputs = 1

    args.extend(["-i", spec.narration_path])
    audio_idx = n_video_inputs

    # Footage + captions → [base].
    chain = [f"{vsrc}trim=duration={total:.3f},setpts=PTS-STARTPTS"]
    if spec.ass_path and os.path.exists(spec.ass_path):
        chain.append(f"ass='{_escape_filter_path(spec.ass_path)}'")
    last = "[vout]"

    # Intro overlays (Reddit topic card, author intro): each PNG is looped over
    # the full timeline so its alpha-fade has frames to act on, then composited
    # only within its on-screen window.
    overlays = [o for o in (spec.overlays or []) if os.path.exists(o.get("path", ""))]
    if overlays:
        filters.append(",".join(chain) + "[base]")
        prev = "[base]"
        for k, ov in enumerate(overlays):
            ov_idx = audio_idx + 1 + k
            args.extend(["-loop", "1", "-framerate", str(FPS), "-t", f"{total:.3f}", "-i", ov["path"]])
            start, end = float(ov["start"]), float(ov["end"])
            fade = max(0.05, min(float(ov.get("fade", 0.18)), (end - start) / 2))
            filters.append(
                f"[{ov_idx}:v]format=rgba,"
                f"fade=t=in:st={start:.3f}:d={fade:.3f}:alpha=1,"
                f"fade=t=out:st={end - fade:.3f}:d={fade:.3f}:alpha=1[ov{k}]"
            )
            out = "[vout]" if k == len(overlays) - 1 else f"[base{k}]"
            filters.append(
                f"{prev}[ov{k}]overlay=x={int(ov['x'])}:y={int(ov['y'])}:"
                f"enable='between(t,{start:.3f},{end:.3f})'{out}"
            )
            prev = out
    else:
        filters.append(",".join(chain) + last)

    os.makedirs(os.path.dirname(spec.output_path), exist_ok=True)
    plan = ffmpeg.encode_plan("h264", hwaccel)
    vmap = "[vout]"
    if plan.upload_filter:
        # VAAPI: upload the composed CPU frames to a GPU surface for the encoder.
        filters.append(f"[vout]{plan.upload_filter}[venc]")
        vmap = "[venc]"
    cmd = [
        *plan.device_args,
        *args,
        "-filter_complex", ";".join(filters),
        "-map", vmap, "-map", f"{audio_idx}:a",
        *plan.codec_args,
        *plan.pix_fmt,
        "-c:a", "aac", "-b:a", "160k",
        "-t", f"{total:.3f}",
        "-movflags", "+faststart",
        spec.output_path,
    ]
    ffmpeg.run(cmd, duration=total, on_progress=on_progress)

    size = os.path.getsize(spec.output_path) if os.path.exists(spec.output_path) else 0
    return {
        "path": spec.output_path,
        "width": w,
        "height": h,
        "duration": total,
        "size_bytes": size,
    }
