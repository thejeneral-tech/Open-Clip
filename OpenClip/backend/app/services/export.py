"""Clip rendering & export.

Composes the full FFmpeg pipeline for a clip:

    cut → dynamic crop (subject tracking) → scale to target → burn captions → encode

Dynamic cropping is driven by an ``sendcmd`` script generated from the reframe
trajectory; when the subject is effectively static we collapse to a single
static crop for speed and robustness. Hardware encoders (NVENC/QSV/AMF) are
selected automatically.
"""
from __future__ import annotations

import contextlib
import os
import statistics
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger
from app.models.enums import ASPECT_DIMENSIONS, RESOLUTION_HEIGHTS
from app.services import captions as captions_svc
from app.services.ffmpeg import ffmpeg
from app.services.reframing import build_crop_keyframes, crop_dimensions

logger = get_logger(__name__)

ProgressCb = Callable[[float], None]


@dataclass
class RenderResult:
    path: str
    width: int
    height: int
    duration: float
    size_bytes: int


# Human-friendly resolution labels → the canonical "<height>p" keys. Without
# this, an unrecognised label (e.g. "4k") silently falls back to 1080p, quietly
# downscaling the export.
_RESOLUTION_ALIASES = {
    "4k": "2160p",
    "uhd": "2160p",
    "2k": "1440p",
    "qhd": "1440p",
    "fhd": "1080p",
    "fullhd": "1080p",
    "hd": "720p",
}


def output_dimensions(aspect_ratio: str, resolution: str) -> tuple[int, int]:
    """Compute (width, height) for an aspect ratio at a quality target."""
    aw, ah = ASPECT_DIMENSIONS.get(aspect_ratio, (9, 16))
    res = resolution.strip().lower()
    res = _RESOLUTION_ALIASES.get(res, res)
    base = RESOLUTION_HEIGHTS.get(res, 1080)
    if aw > ah:  # landscape → base is the height
        height = base
        width = round(base * aw / ah)
    else:  # portrait / square → base is the width
        width = base
        height = round(base * ah / aw)
    width -= width % 2
    height -= height % 2
    return width, height


def _escape_path(path: str) -> str:
    return path.replace("\\", "/").replace(":", "\\:")


def _pctl(sorted_vals: list[int], p: float) -> int:
    """Nearest-rank percentile of an already-sorted list."""
    if not sorted_vals:
        return 0
    idx = int(round(p / 100.0 * (len(sorted_vals) - 1)))
    return sorted_vals[max(0, min(len(sorted_vals) - 1, idx))]


def _densify(
    keyframes: list[tuple[float, int, int]], grid_fps: float, max_x: int, max_y: int
) -> list[tuple[float, int, int]]:
    """Resample sparse (t, x, y) keyframes onto a frame-aligned grid with linear
    interpolation, so the crop pans continuously instead of stepping. Re-clamps
    to [0, max] and drops consecutive duplicates. Falls back to the input if the
    grid would be degenerate or absurdly large."""
    if len(keyframes) < 2 or grid_fps <= 0:
        return keyframes
    t0, t1 = keyframes[0][0], keyframes[-1][0]
    if t1 <= t0:
        return keyframes
    n_steps = int((t1 - t0) * grid_fps)
    if n_steps <= 1:
        return keyframes
    if n_steps > 200_000:  # safety valve — fall back to sparse keyframes
        return keyframes

    dense: list[tuple[float, int, int]] = []
    j = 0
    prev: tuple[int, int] | None = None
    for k in range(n_steps + 1):
        t = min(t1, t0 + k / grid_fps)
        while j < len(keyframes) - 2 and keyframes[j + 1][0] < t:
            j += 1
        ta, xa, ya = keyframes[j]
        tb, xb, yb = keyframes[j + 1]
        frac = 0.0 if tb <= ta else max(0.0, min(1.0, (t - ta) / (tb - ta)))
        x = max(0, min(max_x, int(round(xa + (xb - xa) * frac))))
        y = max(0, min(max_y, int(round(ya + (yb - ya) * frac))))
        if prev is None or (x, y) != prev:
            dense.append((t, x, y))
            prev = (x, y)
    return dense if len(dense) >= 2 else keyframes


def _build_sendcmd(
    keyframes: list[tuple[float, int, int]],
    path: str,
    *,
    grid_fps: float = 30.0,
    max_x: int = 10**9,
    max_y: int = 10**9,
) -> bool:
    """Write an ffmpeg sendcmd script animating crop x/y. Returns False if the
    trajectory is effectively static (caller should use a fixed crop).

    The sparse trajectory is densified to ``grid_fps`` so sendcmd's step-and-hold
    becomes 1-frame-granular (a smooth glide). The static decision is made on the
    SPARSE keyframes (robust 5th/95th-pctl spread for long trajectories)."""
    if len(keyframes) < 2:
        return False
    xs = sorted(k[1] for k in keyframes)
    ys = sorted(k[2] for k in keyframes)
    if len(keyframes) >= 20:
        spread_x = _pctl(xs, 95) - _pctl(xs, 5)
        spread_y = _pctl(ys, 95) - _pctl(ys, 5)
    else:
        spread_x = xs[-1] - xs[0]
        spread_y = ys[-1] - ys[0]
    if spread_x < 4 and spread_y < 4:
        return False

    dense = _densify(keyframes, grid_fps, max_x, max_y)
    lines: list[str] = []
    px: int | None = None
    py: int | None = None
    for t, x, y in dense:
        if x != px:
            lines.append(f"{t:.3f} crop x {x};")
            px = x
        if y != py:
            lines.append(f"{t:.3f} crop y {y};")
            py = y
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return True


def _static_crop(keyframes: list[tuple[float, int, int]], crop_w: int, crop_h: int,
                 source_w: int, source_h: int) -> tuple[int, int]:
    if keyframes:
        x = int(statistics.median(k[1] for k in keyframes))
        y = int(statistics.median(k[2] for k in keyframes))
    else:
        x = max(0, (source_w - crop_w) // 2)
        y = max(0, (source_h - crop_h) // 2)
    return x, y


def render_clip(
    *,
    source_path: str,
    output_path: str,
    start: float,
    end: float,
    aspect_ratio: str,
    resolution: str = "1080p",
    reframe_data: dict[str, Any] | None = None,
    caption_tokens: list[dict[str, Any]] | None = None,
    caption_style: str = "hormozi",
    caption_overrides: dict[str, Any] | None = None,
    burn_captions: bool = True,
    hwaccel: str | None = None,
    on_progress: ProgressCb | None = None,
) -> RenderResult:
    duration = max(0.1, end - start)
    out_w, out_h = output_dimensions(aspect_ratio, resolution)

    # ---- determine crop geometry ----
    reframe_data = reframe_data or {}
    source_w = int(reframe_data.get("source_w") or 0)
    source_h = int(reframe_data.get("source_h") or 0)
    if not source_w or not source_h:
        info = ffmpeg.probe(source_path)
        source_w, source_h = info.width, info.height
        reframe_data.setdefault("source_w", source_w)
        reframe_data.setdefault("source_h", source_h)

    if reframe_data.get("centers"):
        crop_w, crop_h, keyframes = build_crop_keyframes(reframe_data, aspect_ratio)
    else:
        crop_w, crop_h = crop_dimensions(source_w, source_h, aspect_ratio)
        keyframes = []

    max_x = max(0, source_w - crop_w)
    max_y = max(0, source_h - crop_h)

    # Animate the crop at min(REFRAME_RENDER_FPS, source fps) so it pans
    # continuously rather than stepping at the analysis sample rate.
    src_fps = float(reframe_data.get("src_fps") or 0.0)
    if src_fps <= 0:
        try:
            src_fps = ffmpeg.probe(source_path).fps or 0.0
        except Exception:
            src_fps = 0.0
    grid_fps = max(1.0, min(float(settings.REFRAME_RENDER_FPS), src_fps or float(settings.REFRAME_RENDER_FPS)))

    tmp_files: list[str] = []
    vchain: list[str] = []

    # ---- crop (static or animated) ----
    sendcmd_path = os.path.join(tempfile.gettempdir(), f"sendcmd_{os.getpid()}_{int(start*1000)}.txt")
    animated = _build_sendcmd(keyframes, sendcmd_path, grid_fps=grid_fps, max_x=max_x, max_y=max_y)
    if animated:
        tmp_files.append(sendcmd_path)
        # Seed the crop from the first (clamped) keyframe so it matches the first
        # sendcmd command — avoids a first-frame pop.
        x0 = max(0, min(max_x, keyframes[0][1]))
        y0 = max(0, min(max_y, keyframes[0][2]))
        vchain.append(f"sendcmd=f='{_escape_path(sendcmd_path)}'")
        vchain.append(f"crop=w={crop_w}:h={crop_h}:x={x0}:y={y0}")
    else:
        x0, y0 = _static_crop(keyframes, crop_w, crop_h, source_w, source_h)
        vchain.append(f"crop=w={crop_w}:h={crop_h}:x={x0}:y={y0}")

    # ---- scale to output ----
    vchain.append(f"scale={out_w}:{out_h}:flags=lanczos")
    vchain.append("setsar=1")

    # ---- captions ----
    if burn_captions and caption_tokens:
        ass_path = os.path.join(tempfile.gettempdir(), f"caps_{os.getpid()}_{int(start*1000)}.ass")
        captions_svc.write_ass(ass_path, caption_tokens, caption_style, out_w, out_h, overrides=caption_overrides)
        tmp_files.append(ass_path)
        vchain.append(f"ass='{_escape_path(ass_path)}'")

    # ---- assemble command ----
    plan = ffmpeg.encode_plan("h264", hwaccel)
    # VAAPI consumes GPU surfaces: upload the CPU-filtered frames before the
    # encoder. For every other path upload_filter is empty (no change).
    tail = f",{plan.upload_filter}" if plan.upload_filter else ""
    filtergraph = f"[0:v]{','.join(vchain)}{tail}[v]"

    args = [
        *plan.device_args,
        *ffmpeg.decode_args(hwaccel),
        "-ss", f"{start:.3f}", "-i", source_path, "-t", f"{duration:.3f}",
        "-filter_complex", filtergraph,
        "-map", "[v]", "-map", "0:a?",
        *plan.codec_args,
        *plan.pix_fmt,
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        output_path,
    ]
    try:
        ffmpeg.run(args, duration=duration, on_progress=on_progress)
    finally:
        for f in tmp_files:
            with contextlib.suppress(OSError):
                os.remove(f)

    size = os.path.getsize(output_path) if os.path.exists(output_path) else 0
    return RenderResult(path=output_path, width=out_w, height=out_h, duration=duration, size_bytes=size)
