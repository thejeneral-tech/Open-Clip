"""Low-level FFmpeg / FFprobe wrapper.

Handles media probing, audio extraction, thumbnailing, lossless/transcoded
cutting, and — crucially — **hardware-accelerated encoder selection** for
NVENC / QuickSync / AMF, with progress reporting parsed from ``-progress``.
"""
from __future__ import annotations

import functools
import json
import os
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

ProgressCb = Callable[[float], None]


@dataclass
class MediaInfo:
    duration: float = 0.0
    width: int = 0
    height: int = 0
    fps: float = 0.0
    codec: str | None = None
    size_bytes: int | None = None
    has_audio: bool = False


# Per-accel video encoder + extra args. {codec}: h264 | hevc
_ENCODERS: dict[str, dict[str, list[str]]] = {
    "none": {
        "h264": ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"],
        "hevc": ["-c:v", "libx265", "-preset", "fast", "-crf", "24"],
    },
    "nvenc": {
        "h264": ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "21"],
        "hevc": ["-c:v", "hevc_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "24"],
    },
    "qsv": {
        "h264": ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "21"],
        "hevc": ["-c:v", "hevc_qsv", "-preset", "medium", "-global_quality", "24"],
    },
    "amf": {
        "h264": ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "21", "-qp_p", "23"],
        "hevc": ["-c:v", "hevc_amf", "-quality", "balanced", "-rc", "cqp"],
    },
    # AMD/Intel on Linux. Unlike the drop-in encoders above, VAAPI also needs a
    # device handle + a hwupload filter + no trailing -pix_fmt; EncodePlan / the
    # render paths supply those. These are just the encoder flags.
    "vaapi": {
        "h264": ["-c:v", "h264_vaapi", "-rc_mode", "CQP", "-qp", "24"],
        "hevc": ["-c:v", "hevc_vaapi", "-rc_mode", "CQP", "-qp", "26"],
    },
}

# Decode acceleration flags (input side).
#
# Deliberately empty: the render filtergraph (crop/scale/ass) runs on the CPU,
# and there is no QSV/CUDA equivalent of the ASS subtitle filter. Requesting
# hardware-surface decode (e.g. ``-hwaccel qsv``) makes ffmpeg hand the software
# filters GPU frames they can't read ("Impossible to convert between the formats
# ... src: qsv"), so we decode in software and offload only the *encode* (the
# expensive part) to the hardware encoder. Decoding one short clip is cheap.
_HWACCEL_DECODE: dict[str, list[str]] = {
    "none": [],
    "nvenc": [],
    "qsv": [],
    "amf": [],
    "vaapi": [],
}


# --------------------------------------------------------------- hwaccel plan
@dataclass
class EncodePlan:
    """Everything needed to drive one encode at a chosen acceleration.

    ``device_args`` go before the inputs, ``upload_filter`` (when non-empty) is
    appended to the end of the video filtergraph to hand the encoder a GPU
    surface, and ``pix_fmt`` is dropped for surface-consuming encoders (VAAPI).
    For the drop-in encoders (nvenc/qsv/amf/none) device_args and upload_filter
    are empty and pix_fmt is the usual ``-pix_fmt yuv420p`` — i.e. no behaviour
    change versus the old flat ``encoder_args`` path.
    """
    accel: str
    device_args: list[str]
    upload_filter: str
    codec_args: list[str]
    pix_fmt: list[str]


# Priority order for HWACCEL=auto. vaapi covers AMD + Intel on Linux; probing an
# encoder this machine lacks fails fast, so the order is just preference.
_AUTO_CANDIDATES = ("nvenc", "qsv", "vaapi", "amf")


@functools.lru_cache(maxsize=1)
def _vaapi_device() -> str | None:
    """First DRM render node, e.g. /dev/dri/renderD128 (None off Linux)."""
    try:
        nodes = sorted(n for n in os.listdir("/dev/dri") if n.startswith("renderD"))
    except OSError:
        return None
    return os.path.join("/dev/dri", nodes[0]) if nodes else None


def _plan_for(accel: str, codec: str = "h264") -> EncodePlan | None:
    """Build the EncodePlan for a *concrete* accel, or None if unavailable."""
    codec = codec or "h264"
    if accel == "vaapi":
        node = _vaapi_device()
        if not node:
            return None
        table = _ENCODERS["vaapi"]
        return EncodePlan(
            accel="vaapi",
            device_args=["-vaapi_device", node],
            upload_filter="format=nv12,hwupload",
            codec_args=table.get(codec, table["h264"]),
            pix_fmt=[],
        )
    table = _ENCODERS.get(accel)
    if table is None:
        accel, table = "none", _ENCODERS["none"]
    return EncodePlan(
        accel=accel,
        device_args=[],
        upload_filter="",
        codec_args=table.get(codec, table["h264"]),
        pix_fmt=["-pix_fmt", "yuv420p"],
    )


def _probe_encoder(accel: str) -> bool:
    """True if this box can actually encode with ``accel`` right now.

    Runs a throwaway few-frame encode to the null muxer — the only reliable
    check, since an ffmpeg build can advertise an encoder (e.g. h264_nvenc) the
    hardware can't run. A Tesla P100 has no NVENC engine, so this fails here at
    detection time rather than mid-render.
    """
    plan = _plan_for(accel)
    if plan is None:
        return False
    vf = ["-vf", plan.upload_filter] if plan.upload_filter else []
    cmd = [
        settings.FFMPEG_BIN, "-hide_banner", "-loglevel", "error",
        *plan.device_args,
        "-f", "lavfi", "-i", "color=c=black:s=128x128:r=5:d=1",
        *vf, *plan.codec_args, *plan.pix_fmt,
        "-f", "null", "-",
    ]
    try:
        return subprocess.run(cmd, capture_output=True, timeout=30).returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False


@functools.lru_cache(maxsize=8)
def _resolve_hwaccel(requested: str) -> str:
    """Map a requested HWACCEL (incl. "auto") to a concrete, working encoder.

    Cached: the probe runs once per worker process, on the first render.
    """
    if requested != "auto":
        return requested
    for cand in _AUTO_CANDIDATES:
        if _probe_encoder(cand):
            logger.info("HWACCEL=auto: encoding on GPU via '%s'", cand)
            return cand
    logger.info("HWACCEL=auto: no usable GPU encoder; encoding on CPU (libx264)")
    return "none"


class FFmpeg:
    def __init__(self) -> None:
        self.bin = settings.FFMPEG_BIN
        self.probe_bin = settings.FFPROBE_BIN

    # ------------------------------------------------------------------ probe
    def probe(self, path: str) -> MediaInfo:
        cmd = [
            self.probe_bin, "-v", "error", "-print_format", "json",
            "-show_format", "-show_streams", path,
        ]
        out = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(out.stdout)
        info = MediaInfo()

        fmt = data.get("format", {})
        info.duration = float(fmt.get("duration", 0) or 0)
        info.size_bytes = int(fmt.get("size", 0) or 0) or None

        for stream in data.get("streams", []):
            if stream.get("codec_type") == "video" and info.width == 0:
                info.width = int(stream.get("width", 0) or 0)
                info.height = int(stream.get("height", 0) or 0)
                info.codec = stream.get("codec_name")
                info.fps = _parse_fps(stream.get("avg_frame_rate") or stream.get("r_frame_rate"))
                if not info.duration:
                    info.duration = float(stream.get("duration", 0) or 0)
            elif stream.get("codec_type") == "audio":
                info.has_audio = True
        return info

    def encode_plan(self, codec: str = "h264", hwaccel: str | None = None) -> EncodePlan:
        """Resolve HWACCEL (incl. "auto") into a ready-to-use encode recipe."""
        accel = _resolve_hwaccel(hwaccel or settings.HWACCEL)
        return _plan_for(accel, codec) or _plan_for("none", codec)

    def encoder_args(self, codec: str = "h264", hwaccel: str | None = None) -> list[str]:
        # Back-compat: bare encoder flags only. Prefer encode_plan(), which also
        # carries the device + hwupload + pix_fmt pieces VAAPI needs.
        return self.encode_plan(codec, hwaccel).codec_args

    def decode_args(self, hwaccel: str | None = None) -> list[str]:
        accel = _resolve_hwaccel(hwaccel or settings.HWACCEL)
        return _HWACCEL_DECODE.get(accel, [])

    # ------------------------------------------------------------------- runs
    def run(
        self,
        args: list[str],
        *,
        duration: float | None = None,
        on_progress: ProgressCb | None = None,
    ) -> None:
        """Run ffmpeg, parsing ``-progress`` for completion percentage."""
        cmd = [self.bin, "-y", "-hide_banner", "-loglevel", "error", *args]
        if on_progress is not None and duration:
            cmd += ["-progress", "pipe:1", "-nostats"]
            logger.debug("ffmpeg: %s", " ".join(cmd))
            # stderr goes to a temp file rather than a pipe: we only consume
            # stdout (progress) in the loop below, so a chatty stderr filling its
            # pipe buffer would otherwise deadlock the process on long renders.
            with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as errf:
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errf, text=True)
                assert proc.stdout is not None
                try:
                    for line in proc.stdout:
                        line = line.strip()
                        if line.startswith("out_time_ms="):
                            try:
                                ms = int(line.split("=", 1)[1])
                            except ValueError:
                                continue
                            on_progress(max(0.0, min(1.0, (ms / 1_000_000) / duration)))
                        elif line == "progress=end":
                            on_progress(1.0)
                    proc.wait()
                except BaseException:
                    # A progress callback that raises (e.g. a cooperative-cancel
                    # signal) — or any other error — must not leave ffmpeg running
                    # detached. Kill it before propagating.
                    if proc.poll() is None:
                        proc.kill()
                        proc.wait()
                    raise
                if proc.returncode != 0:
                    errf.seek(0)
                    err = errf.read()
                    raise RuntimeError(f"ffmpeg failed ({proc.returncode}): {err[:500]}")
        else:
            logger.debug("ffmpeg: %s", " ".join(cmd))
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode != 0:
                raise RuntimeError(f"ffmpeg failed ({res.returncode}): {res.stderr[:500]}")

    # --------------------------------------------------------------- helpers
    def extract_audio(self, src: str, dst: str, sample_rate: int = 16000) -> str:
        """Extract mono PCM WAV suited to Whisper."""
        self.run(["-i", src, "-vn", "-ac", "1", "-ar", str(sample_rate), "-c:a", "pcm_s16le", dst])
        return dst

    def extract_thumbnail(self, src: str, dst: str, at: float = 1.0) -> str:
        self.run(["-ss", f"{at:.2f}", "-i", src, "-frames:v", "1", "-q:v", "3", dst])
        return dst

    def cut(
        self,
        src: str,
        dst: str,
        start: float,
        end: float,
        *,
        reencode: bool = True,
        on_progress: ProgressCb | None = None,
    ) -> str:
        """Cut [start, end]. Re-encode for frame accuracy by default."""
        dur = max(0.1, end - start)
        if reencode:
            plan = self.encode_plan("h264")
            vf = ["-vf", plan.upload_filter] if plan.upload_filter else []
            args = [
                *plan.device_args,
                "-ss", f"{start:.3f}", "-i", src, "-t", f"{dur:.3f}",
                *vf, *plan.codec_args, *plan.pix_fmt,
                "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
                dst,
            ]
        else:
            args = ["-ss", f"{start:.3f}", "-i", src, "-t", f"{dur:.3f}", "-c", "copy", dst]
        self.run(args, duration=dur, on_progress=on_progress)
        return dst


def _parse_fps(rate: str | None) -> float:
    if not rate or rate == "0/0":
        return 0.0
    try:
        if "/" in rate:
            num, den = rate.split("/")
            return round(float(num) / float(den), 3) if float(den) else 0.0
        return float(rate)
    except (ValueError, ZeroDivisionError):
        return 0.0


ffmpeg = FFmpeg()
