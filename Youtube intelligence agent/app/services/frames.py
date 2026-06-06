"""Visual understanding: download a low-res copy, extract interval +
scene-change frames with ffmpeg, and (if a vision model is installed)
caption the key frames — on-screen text, people, products, slides, charts."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Callable

from .. import config, llm, util
from ..ffmpeg_utils import ffmpeg_location_for_ytdlp, ffmpeg_path

Logger = Callable[[str], None]
_PTS_RE = re.compile(r"pts_time:([0-9.]+)")


def _noop(_: str) -> None:
    pass


class FramesError(RuntimeError):
    pass


def _workdir(video_id: str) -> Path:
    d = config.VIDEO_DATA_DIR / video_id / "frames"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _media_url(video_id: str, filename: str) -> str:
    return f"/media/{video_id}/frames/{filename}"


# --- download ------------------------------------------------------------
def _download_video(video_id: str, url: str, log: Logger) -> Path | None:
    from yt_dlp import YoutubeDL

    workdir = config.VIDEO_DATA_DIR / video_id
    workdir.mkdir(parents=True, exist_ok=True)
    existing = list(workdir.glob(f"{video_id}.video.*"))
    if existing:
        return existing[0]
    h = config.FRAME_DOWNLOAD_HEIGHT
    opts = {
        "quiet": True, "no_warnings": True, "noplaylist": True,
        "format": f"best[height<={h}]/bestvideo[height<={h}]/best",
        "outtmpl": str(workdir / f"{video_id}.video.%(ext)s"),
    }
    loc = ffmpeg_location_for_ytdlp()
    if loc:
        opts["ffmpeg_location"] = loc
    log(f"Downloading video at <= {h}p for frame analysis...")
    with YoutubeDL(opts) as ydl:
        ydl.download([url])
    files = list(workdir.glob(f"{video_id}.video.*"))
    return files[0] if files else None


# --- ffmpeg extraction ---------------------------------------------------
def _run_ffmpeg(args: list[str], timeout: int = 1800) -> subprocess.CompletedProcess:
    exe = ffmpeg_path()
    if not exe:
        raise FramesError("ffmpeg is not available.")
    return subprocess.run(
        [exe, "-hide_banner", "-y", *args],
        capture_output=True, text=True, timeout=timeout,
    )


def _extract_interval(video: Path, outdir: Path, interval: int) -> list[dict]:
    pattern = str(outdir / "interval_%04d.jpg")
    _run_ffmpeg(["-i", str(video), "-vf", f"fps=1/{interval}", "-qscale:v", "3", pattern])
    frames = []
    for f in sorted(outdir.glob("interval_*.jpg")):
        num = int(re.search(r"interval_(\d+)", f.name).group(1))
        ts = (num - 1) * interval
        frames.append({"timestamp": float(ts), "filename": f.name, "scene_change": False})
    return frames


def _extract_scenes(video: Path, outdir: Path, threshold: float) -> list[dict]:
    pattern = str(outdir / "scene_%04d.jpg")
    proc = _run_ffmpeg([
        "-i", str(video),
        "-vf", f"select='gt(scene,{threshold})',showinfo",
        "-vsync", "vfr", "-qscale:v", "3", pattern,
    ])
    times = _PTS_RE.findall(proc.stderr or "")
    files = sorted(outdir.glob("scene_*.jpg"))
    frames = []
    for i, f in enumerate(files):
        ts = float(times[i]) if i < len(times) else 0.0
        frames.append({"timestamp": round(ts, 2), "filename": f.name, "scene_change": True})
    return frames


def _merge_frames(interval: list[dict], scenes: list[dict], video_id: str) -> list[dict]:
    combined = sorted(interval + scenes, key=lambda x: x["timestamp"])
    merged: list[dict] = []
    for fr in combined:
        if merged and abs(fr["timestamp"] - merged[-1]["timestamp"]) < 1.0:
            # near-duplicate: keep scene-change flag if either is a scene change
            merged[-1]["scene_change"] = merged[-1]["scene_change"] or fr["scene_change"]
            continue
        merged.append(fr)
    if len(merged) > config.MAX_FRAMES:
        # keep all scene changes, subsample the rest
        scene = [f for f in merged if f["scene_change"]]
        rest = [f for f in merged if not f["scene_change"]]
        budget = max(0, config.MAX_FRAMES - len(scene))
        step = max(1, len(rest) // budget) if budget else len(rest) + 1
        merged = sorted(scene + rest[::step][:budget], key=lambda x: x["timestamp"])
    for idx, fr in enumerate(merged):
        fr["index"] = idx
        fr["time_str"] = util.fmt_timestamp(fr["timestamp"])
        fr["url"] = _media_url(video_id, fr["filename"])
    return merged


# --- vision captioning ---------------------------------------------------
_VISION_PROMPT = (
    "Describe this single video frame for a content editor. Respond ONLY as JSON:\n"
    '{"caption":"one concise sentence","on_screen_text":"verbatim visible text or empty",'
    '"people":<int approx number of visible people>,"objects":["notable products/objects/brands"],'
    '"scene_type":"talking-head|slideshow|chart|gameplay|interview|broll|text-card|other",'
    '"has_chart":<true|false>,"notable":"anything visually striking or empty"}'
)


def _select_vision_frames(frames: list[dict]) -> list[dict]:
    scene = [f for f in frames if f["scene_change"]]
    other = [f for f in frames if not f["scene_change"]]
    selected = scene[: config.MAX_VISION_FRAMES]
    if len(selected) < config.MAX_VISION_FRAMES and other:
        need = config.MAX_VISION_FRAMES - len(selected)
        step = max(1, len(other) // need)
        selected += other[::step][:need]
    return sorted(selected, key=lambda x: x["timestamp"])


def caption_frames(video_id: str, frames: list[dict], log: Logger) -> int:
    model = llm.detect_vision_model()
    if not model:
        log("No vision model installed — skipping visual captioning "
            "(frames still extracted). Install one with e.g. `ollama pull moondream`.")
        return 0
    outdir = _workdir(video_id)
    targets = _select_vision_frames(frames)
    log(f"Captioning {len(targets)} key frames with vision model '{model}'...")
    done = 0
    by_name = {f["filename"]: f for f in frames}
    for fr in targets:
        path = outdir / fr["filename"]
        if not path.exists():
            continue
        try:
            raw = llm.vision(_VISION_PROMPT, [path], model=model)
            data = llm.extract_json(raw)
            if isinstance(data, dict):
                by_name[fr["filename"]]["vision"] = data
                done += 1
        except Exception as e:  # noqa: BLE001
            log(f"Vision call failed for {fr['filename']}: {e}")
            break  # likely systemic; stop hammering
    log(f"Captioned {done} frames.")
    return done


# --- entry point ---------------------------------------------------------
def extract_frames(video_id: str, url: str, metadata: dict | None = None,
                   do_vision: bool = True, log: Logger | None = None) -> list[dict]:
    log = log or _noop
    if not ffmpeg_path():
        raise FramesError("ffmpeg is not available; cannot extract frames.")
    video = _download_video(video_id, url, log)
    if not video or not video.exists():
        raise FramesError("Could not download the video for frame extraction.")
    outdir = _workdir(video_id)
    log(f"Extracting frames (1 every {config.FRAME_INTERVAL}s + scene changes)...")
    interval = _extract_interval(video, outdir, config.FRAME_INTERVAL)
    try:
        scenes = _extract_scenes(video, outdir, config.SCENE_THRESHOLD)
    except Exception as e:  # noqa: BLE001
        log(f"Scene detection failed ({e}); using interval frames only.")
        scenes = []
    frames = _merge_frames(interval, scenes, video_id)
    log(f"Extracted {len(frames)} frames ({sum(f['scene_change'] for f in frames)} scene changes).")
    if do_vision:
        caption_frames(video_id, frames, log)
    return frames
