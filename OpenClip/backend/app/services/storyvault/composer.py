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

from app.core.config import settings
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
    # Optional background-music bed: an absolute MP3 path looped to fill the
    # timeline and mixed under the narration at ``music_volume`` (0..1). The
    # narration always stays at full level on top. None = narration only.
    music_path: str | None = None
    music_volume: float = 0.18


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

    # --- Seamless-loop planning -------------------------------------------
    # For a natural, flowing wrap we render a little EXTRA footage past the
    # narration — a continuation of the *last* segment's own source — and then
    # cross-dissolve that ending footage back into the opening over
    # SV_LOOP_SECONDS. Because the extra footage is the genuine continuation of
    # what was just on screen, the end flows continuously into the start: no
    # hard cut and (unlike a tail-only overlay) no rewind/stutter of the opening.
    # If the final source has no room to extend (e.g. a short clip), fall back to
    # a length-preserving tail dissolve. The wrap sits below the captions so the
    # text is never ghosted, and the output duration is always exactly ``total``.
    loop_s = max(0.0, float(settings.SV_LOOP_SECONDS))
    seamless_l = 0.0   # >0 => extend the last segment and xfade-wrap it
    overlay_l = 0.0    # >0 => length-preserving tail-overlay fallback
    if loop_s and spec.plan and total > 2 * loop_s:
        last = spec.plan[-1]
        try:
            src_dur = ffmpeg.probe(
                storage.abspath(last["storage_path"], ensure_parent=False)
            ).duration
        except Exception:  # noqa: BLE001 — a probe failure just disables the nicer path
            src_dur = 0.0
        room = src_dur - (float(last["start"]) + float(last["length"])) - 0.10
        seamless_l = min(loop_s, max(0.0, room), total * 0.45)
        if seamless_l < 0.30:  # not enough spare footage — use the tail overlay
            seamless_l = 0.0
            overlay_l = min(loop_s, 0.6, total * 0.45)

    if spec.plan:
        last_idx = len(spec.plan) - 1
        for idx, item in enumerate(spec.plan):
            src = storage.abspath(item["storage_path"], ensure_parent=False)
            seg_len = float(item["length"])
            # Read a touch more from the final clip so its continuation can be
            # dissolved into the opening for the seamless wrap.
            if idx == last_idx and seamless_l > 0:
                seg_len += seamless_l + 0.20
            args.extend(["-ss", f"{float(item['start']):.3f}", "-t", f"{seg_len:.3f}", "-i", src])
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

    if seamless_l > 0:
        # Split the over-length footage into opening A[0,L), body B[L,total) and
        # the extra tail C[total,total+L); cross-dissolve C into A to form the
        # first L seconds, then play B. The wrap moment (B's end → C's start) is
        # one continuous motion, and the dissolve eases the scene change.
        L = seamless_l
        filters.append(f"{vsrc}split=3[sa][sb][sc]")
        filters.append(f"[sa]trim=0:{L:.3f},setpts=PTS-STARTPTS[swa]")
        filters.append(f"[sc]trim={total:.3f}:{total + L:.3f},setpts=PTS-STARTPTS[swc]")
        filters.append(f"[swc][swa]xfade=transition=fade:duration={L:.3f}:offset=0[swr]")
        filters.append(f"[sb]trim={L:.3f}:{total:.3f},setpts=PTS-STARTPTS[sbrest]")
        filters.append("[swr][sbrest]concat=n=2:v=1:a=0[lbase]")
        foot = "[lbase]"
    elif overlay_l > 0:
        # No spare footage to extend: dissolve the opening frames back in over
        # the final ``overlay_l`` seconds (length-preserving tail overlay).
        L = overlay_l
        shift = total - L
        filters.append(f"{vsrc}trim=duration={total:.3f},setpts=PTS-STARTPTS[fbase]")
        filters.append("[fbase]split[lmain][lhead]")
        filters.append(
            f"[lhead]trim=duration={L:.3f},setpts=PTS-STARTPTS,format=yuva420p,"
            f"fade=t=in:st=0:d={L:.3f}:alpha=1,setpts=PTS+{shift:.3f}/TB[lhead2]"
        )
        filters.append(
            f"[lmain][lhead2]overlay=enable='gte(t,{shift:.3f})':"
            f"format=auto,format=yuv420p[lbase]"
        )
        foot = "[lbase]"
    else:
        filters.append(f"{vsrc}trim=duration={total:.3f},setpts=PTS-STARTPTS[fbase]")
        foot = "[fbase]"

    # Captions burned on top of the (looped) footage. The source label glues
    # directly onto the first filter (no comma); ``null`` stands in when there
    # are no captions so the label is still a valid filterchain to attach to.
    steps = []
    if spec.ass_path and os.path.exists(spec.ass_path):
        steps.append(f"ass='{_escape_filter_path(spec.ass_path)}'")
    body = foot + (",".join(steps) if steps else "null")
    last = "[vout]"

    # Intro overlays (Reddit topic card, author intro): each PNG is looped over
    # the full timeline so its alpha-fade has frames to act on, then composited
    # only within its on-screen window.
    overlays = [o for o in (spec.overlays or []) if os.path.exists(o.get("path", ""))]
    if overlays:
        filters.append(body + "[base]")
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
        filters.append(body + last)

    amap = f"{audio_idx}:a"

    # Optional background-music bed: loop the track to fill the timeline, scale it
    # down, and mix it under the narration (narration stays at full level — the
    # mixer's normalize is off so it isn't attenuated by the second input). Its
    # input is appended last, so its index sits after the narration + overlays.
    music_vol = max(0.0, min(1.0, float(spec.music_volume)))
    if spec.music_path and os.path.exists(spec.music_path) and music_vol > 0:
        music_idx = audio_idx + 1 + len(overlays)
        args.extend(["-stream_loop", "-1", "-i", spec.music_path])
        narr_ref = amap if amap.startswith("[") else f"[{amap}]"
        filters.append(f"[{music_idx}:a]volume={music_vol:.3f}[svmusic]")
        filters.append(
            f"{narr_ref}[svmusic]amix=inputs=2:duration=first:normalize=0[amixed]"
        )
        amap = "[amixed]"

    # Loop seam: a tiny fade on the *final* audio (narration, plus the music bed
    # if any) so the waveform starts and ends near silence and there's no click
    # where the clip wraps on social autoplay. Kept short so speech isn't
    # clipped; applied last so it covers the music too. Tied to the loop feature.
    if loop_s and total > 0.3:
        a_in = amap if amap.startswith("[") else f"[{amap}]"
        out_d = min(0.08, total / 4)
        filters.append(
            f"{a_in}afade=t=in:st=0:d=0.03,"
            f"afade=t=out:st={total - out_d:.3f}:d={out_d:.3f}[aloop]"
        )
        amap = "[aloop]"

    os.makedirs(os.path.dirname(spec.output_path), exist_ok=True)
    plan = ffmpeg.encode_plan("h264", hwaccel)
    vmap = "[vout]"
    if plan.upload_filter:
        # VAAPI: upload the composed CPU frames to a GPU surface for the encoder.
        filters.append(f"[vout]{plan.upload_filter}[venc]")
        vmap = "[venc]"
    # Bound the filter graph's thread count (and therefore its peak memory) so a
    # long/many-segment render doesn't exhaust RAM on a memory-constrained box.
    filter_thread_args = (
        ["-filter_complex_threads", str(settings.SV_RENDER_FILTER_THREADS)]
        if settings.SV_RENDER_FILTER_THREADS > 0
        else []
    )
    cmd = [
        *plan.device_args,
        *args,
        *filter_thread_args,
        "-filter_complex", ";".join(filters),
        "-map", vmap, "-map", amap,
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
