"""Render a real vertical clip: trim → Smart Vertical Framing (9:16) → burned
captions → mp4, plus a poster frame. Built on the bundled ffmpeg.

Captions are burned via a generated ASS file (full control over size, outline
and safe-area placement). ffmpeg runs with its working directory set to the
clip folder so the subtitles filter can reference the ASS by bare filename —
which avoids the notorious Windows path-escaping problems with `subtitles=`.
"""
from __future__ import annotations

import math
import subprocess
from pathlib import Path
from typing import Callable

from .. import config, util
from ..ffmpeg_utils import ensure_ffmpeg_on_path, ffmpeg_path
from . import framing

Logger = Callable[[str], None]


class RenderError(RuntimeError):
    pass


def _noop(_: str) -> None:
    pass


# --- aspect / canvas -----------------------------------------------------
_ASPECTS = {"9:16": (9, 16), "1:1": (1, 1), "16:9": (16, 9)}


def _canvas(aspect: str) -> tuple[int, int, tuple[int, int]]:
    ar = _ASPECTS.get(aspect, (9, 16))
    base = config.RENDER_OUT_HEIGHT  # 1920 by default
    if ar == (1, 1):
        out_w = out_h = 1080
    elif ar == (16, 9):
        out_w, out_h = 1920, 1080
    else:  # 9:16
        out_h = base
        out_w = int(round(base * ar[0] / ar[1]))
    out_w -= out_w % 2
    out_h -= out_h % 2
    return out_w, out_h, ar


# --- source download -----------------------------------------------------
def download_render_source(video_id: str, url: str, height: int | None = None,
                           log: Logger | None = None) -> Path:
    """Download (and cache) a render-quality copy of the source video."""
    log = log or _noop
    from yt_dlp import YoutubeDL

    height = height or config.RENDER_HEIGHT
    workdir = config.VIDEO_DATA_DIR / video_id
    workdir.mkdir(parents=True, exist_ok=True)
    existing = list(workdir.glob(f"{video_id}.render.*"))
    if existing:
        return existing[0]
    opts = {
        "quiet": True, "no_warnings": True, "noplaylist": True,
        "outtmpl": str(workdir / f"{video_id}.render.%(ext)s"),
    }
    # Merging separate video+audio streams needs an ffmpeg binary literally named
    # `ffmpeg`. Our bundled binary has an odd name, so ensure a real `ffmpeg(.exe)`
    # is on PATH and point yt-dlp at it; if that's unavailable, fall back to a
    # progressive (single-file) format that needs no merge.
    ff_dir = ensure_ffmpeg_on_path()
    if ff_dir:
        opts["format"] = f"bestvideo[height<={height}]+bestaudio/best[height<={height}]/best"
        opts["merge_output_format"] = "mp4"
        opts["ffmpeg_location"] = ff_dir
    else:
        opts["format"] = f"best[height<={height}]/best"
    log(f"Downloading source at <= {height}p for clipping...")
    with YoutubeDL(opts) as ydl:
        ydl.download([url])
    files = list(workdir.glob(f"{video_id}.render.*"))
    if not files:
        # fall back to any low-res copy left by the frame-analysis step
        files = list(workdir.glob(f"{video_id}.video.*"))
    if not files:
        raise RenderError("Could not download the source video for clipping.")
    return files[0]


# --- captions ------------------------------------------------------------
def build_cues(segments: list[dict], start: float, end: float,
               max_words: int = 6) -> list[tuple]:
    """Clip-relative caption cues (a, b, text), chunked to short lines."""
    cues: list[tuple] = []
    for s in segments or []:
        s_start = float(s.get("start", 0.0))
        s_end = s_start + float(s.get("duration", 0.0) or 0.0)
        if s_end <= start or s_start >= end:
            continue
        text = " ".join(str(s.get("text", "")).split())
        if not text:
            continue
        a = max(s_start, start) - start
        b = min(s_end, end) - start
        if b - a < 0.2:
            b = a + 0.6
        words = text.split()
        if len(words) <= max_words:
            cues.append((a, b, text))
            continue
        nchunks = math.ceil(len(words) / max_words)
        chunk = (b - a) / nchunks
        for i in range(nchunks):
            seg_words = words[i * max_words:(i + 1) * max_words]
            cues.append((a + i * chunk, a + (i + 1) * chunk, " ".join(seg_words)))
    return cues


def cues_to_srt(cues: list[tuple]) -> str:
    lines = []
    for i, (a, b, text) in enumerate(cues, 1):
        lines += [str(i), f"{util.srt_timestamp(a)} --> {util.srt_timestamp(b)}", text, ""]
    return "\n".join(lines)


# ASS colour is &HAABBGGRR. White text, black outline.
_CAPTION_PRESETS = {
    "bold":    {"size": 0.044, "bold": -1, "outline": 5, "shadow": 1, "marginv": 0.17, "upper": False},
    "clean":   {"size": 0.038, "bold": -1, "outline": 3, "shadow": 1, "marginv": 0.16, "upper": False},
    "minimal": {"size": 0.034, "bold":  0, "outline": 2, "shadow": 0, "marginv": 0.15, "upper": False},
    "big":     {"size": 0.055, "bold": -1, "outline": 6, "shadow": 2, "marginv": 0.18, "upper": True},
}


def _ass_escape(text: str) -> str:
    return text.replace("\\", "⧵").replace("{", "(").replace("}", ")").replace("\n", " ")


def _ass_time(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


def cues_to_ass(cues: list[tuple], style: str, out_w: int, out_h: int) -> str:
    p = _CAPTION_PRESETS.get(style, _CAPTION_PRESETS["bold"])
    fontsize = max(18, int(round(p["size"] * out_h)))
    marginv = int(round(p["marginv"] * out_h))
    margin_side = int(round(0.08 * out_w))
    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {out_w}\nPlayResY: {out_h}\n"
        "WrapStyle: 0\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Cap,Arial,{fontsize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,"
        f"{p['bold']},0,0,0,100,100,0,0,1,{p['outline']},{p['shadow']},2,"
        f"{margin_side},{margin_side},{marginv},1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    rows = []
    for (a, b, text) in cues:
        if b <= a:
            b = a + 0.6
        t = _ass_escape(text.upper() if p["upper"] else text)
        rows.append(f"Dialogue: 0,{_ass_time(a)},{_ass_time(b)},Cap,,0,0,0,,{t}")
    return header + "\n".join(rows) + "\n"


# --- probing -------------------------------------------------------------
def probe_dimensions(path: str) -> tuple[int, int]:
    try:
        import cv2  # type: ignore
        cap = cv2.VideoCapture(str(path))
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        cap.release()
        if w and h:
            return w, h
    except Exception:
        pass
    return 1280, 720  # safe default


# --- ffmpeg --------------------------------------------------------------
def _run(args: list[str], cwd: str, timeout: int) -> subprocess.CompletedProcess:
    exe = ffmpeg_path()
    if not exe:
        raise RenderError("ffmpeg is not available.")
    return subprocess.run([exe, "-hide_banner", "-y", *args], cwd=cwd,
                          capture_output=True, text=True, timeout=timeout)


# --- main entry ----------------------------------------------------------
def render_clip(clip: dict, source_path: str, segments: list[dict], run_id: str,
                rank: int, framing_mode: str = "smart", caption_style: str = "bold",
                aspect: str = "9:16", log: Logger | None = None) -> dict:
    """Cut clip[start:end] from source_path, frame to vertical, burn captions.
    Returns {file_path, poster_path, srt_path, framing_mode, note}."""
    log = log or _noop
    if not ffmpeg_path():
        raise RenderError("ffmpeg is not available; cannot render clips.")
    # ffmpeg runs with cwd set to the clip dir (so the ASS can be a bare name),
    # so the input must be absolute or it won't resolve.
    source_path = str(Path(source_path).resolve())
    start = float(clip["start"])
    end = float(clip["end"])
    dur = max(1.0, end - start)
    out_w, out_h, ar = _canvas(aspect)

    out_dir = config.CLIPS_DIR / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = util.safe_filename(clip.get("title") or f"clip_{rank}", 48)
    base = f"{rank:02d}_{slug}"
    out_mp4 = out_dir / f"{base}.mp4"
    poster = out_dir / f"{base}.jpg"
    ass_name = f"{base}.ass"
    srt_path = out_dir / f"{base}.srt"

    # 1. plan framing (face analysis only when it can help)
    src_w, src_h = probe_dimensions(source_path)
    if framing_mode in ("smart", "center", "split") and framing.have_face_detection():
        log(f"Analyzing faces for clip {rank} ({framing_mode})...")
        analysis = framing.analyze_faces(source_path, start, end, log=log)
    else:
        analysis = {"src_w": src_w, "src_h": src_h, "samples": [], "available": False}
    if not analysis.get("src_w"):
        analysis["src_w"], analysis["src_h"] = src_w, src_h
    plan = framing.plan_framing(analysis, framing_mode,
                                analysis["src_w"], analysis["src_h"], ar)
    effective = plan["mode"]
    if plan.get("note"):
        log(plan["note"])

    # 2. captions
    subtitle_file = None
    cues = build_cues(segments, start, end) if caption_style != "none" else []
    if cues:
        (out_dir / ass_name).write_text(cues_to_ass(cues, caption_style, out_w, out_h),
                                        encoding="utf-8")
        srt_path.write_text(cues_to_srt(cues), encoding="utf-8")
        subtitle_file = ass_name

    # 3. build filtergraph + render
    graph, out_label = framing.build_filtergraph(plan, out_w, out_h, subtitle_file)
    args = [
        "-ss", f"{start:.2f}", "-t", f"{dur:.2f}", "-i", str(source_path),
        "-filter_complex", graph, "-map", out_label, "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart", str(out_mp4),
    ]
    log(f"Rendering clip {rank} -> {out_w}x{out_h} ({effective})...")
    proc = _run(args, cwd=str(out_dir), timeout=config.RENDER_TIMEOUT)
    if proc.returncode != 0 or not out_mp4.exists():
        tail = (proc.stderr or "").strip()[-400:]
        raise RenderError(f"ffmpeg failed for clip {rank}: {tail}")

    # 4. poster frame (mid-clip)
    try:
        _run(["-ss", f"{dur / 2:.2f}", "-i", str(out_mp4), "-frames:v", "1",
              "-q:v", "3", str(poster)], cwd=str(out_dir), timeout=60)
    except Exception:  # noqa: BLE001
        poster = None

    return {
        "file_path": _media_path(run_id, out_mp4.name),
        "poster_path": _media_path(run_id, poster.name) if poster and poster.exists() else None,
        "srt_path": _media_path(run_id, srt_path.name) if srt_path.exists() else None,
        "framing_mode": effective,
        "note": plan.get("note", ""),
        "out_w": out_w, "out_h": out_h,
    }


def _media_path(run_id: str, filename: str) -> str:
    """URL path served by the /intel-clips static mount."""
    return f"/intel-clips/{run_id}/{filename}"
