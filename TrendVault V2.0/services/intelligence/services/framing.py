"""Smart Vertical Framing.

Turns a 16:9 (or any) source into a full-screen 9:16 clip that keeps faces /
the active speaker in frame, with smooth (velocity-clamped) reframing and an
automatic blurred-background fallback when a hard crop would cut faces off.

Pipeline:
  analyze_faces()      -> sample frames in the clip window, detect faces (OpenCV)
  plan_framing()       -> choose an effective mode + crop geometry (with fallback)
  build_filtergraph()  -> a single ffmpeg filter string (crop/scale/blur/split
                          + burned captions)

OpenCV is optional: if it isn't importable, Smart Auto degrades to a centered
crop with blur fallback (no face following) and everything still renders.
"""
from __future__ import annotations

import os
from typing import Callable

Logger = Callable[[str], None]

try:
    import cv2  # type: ignore
    _HAVE_CV2 = True
except Exception:  # noqa: BLE001
    cv2 = None  # type: ignore
    _HAVE_CV2 = False

_FACE_CASCADE = None


def have_face_detection() -> bool:
    return _HAVE_CV2 and _load_cascade() is not None


def _load_cascade():
    global _FACE_CASCADE
    if not _HAVE_CV2:
        return None
    if _FACE_CASCADE is None:
        path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
        cascade = cv2.CascadeClassifier(path)
        _FACE_CASCADE = cascade if not cascade.empty() else False
    return _FACE_CASCADE or None


def _noop(_: str) -> None:
    pass


def _even(n: float) -> int:
    n = int(round(n))
    return n - (n % 2)


# --- face analysis -------------------------------------------------------
def analyze_faces(video_path: str, start: float, end: float,
                  max_samples: int = 48, detect_width: int = 480,
                  log: Logger | None = None) -> dict:
    """Sample frames across [start, end] and detect faces. Returns
    {src_w, src_h, samples:[{t, faces:[(x,y,w,h)], primary:(cx,cy,w,h)|None}]}.
    `t` is clip-relative seconds (0 at `start`)."""
    log = log or _noop
    info: dict = {"src_w": 0, "src_h": 0, "samples": [], "available": False}
    cascade = _load_cascade()
    if not _HAVE_CV2:
        return info
    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return info
        src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 0
        src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 0
        info["src_w"], info["src_h"] = src_w, src_h
        dur = max(0.1, end - start)
        n = max(4, min(max_samples, int(dur / 0.75)))
        scale = (detect_width / src_w) if (cascade and src_w > detect_width) else 1.0
        for i in range(n):
            t_rel = dur * i / max(1, n - 1)
            cap.set(cv2.CAP_PROP_POS_MSEC, (start + t_rel) * 1000.0)
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            faces: list[tuple] = []
            primary = None
            if cascade is not None:
                small = cv2.resize(frame, None, fx=scale, fy=scale) if scale != 1.0 else frame
                gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                dets = cascade.detectMultiScale(gray, scaleFactor=1.2, minNeighbors=5,
                                                minSize=(int(28), int(28)))
                for (x, y, w, h) in dets:
                    box = (int(x / scale), int(y / scale), int(w / scale), int(h / scale))
                    faces.append(box)
                if faces:
                    bx, by, bw, bh = max(faces, key=lambda f: f[2] * f[3])
                    primary = (bx + bw / 2, by + bh / 2, bw, bh)
            info["samples"].append({"t": round(t_rel, 2), "faces": faces, "primary": primary})
        cap.release()
        info["available"] = bool(cascade)
    except Exception as e:  # noqa: BLE001
        log(f"Face analysis failed ({e}); using geometric framing.")
    return info


# --- crop geometry helpers ----------------------------------------------
def _crop_box(src_w: int, src_h: int, ar: float) -> tuple[int, int]:
    """Largest crop of aspect `ar` (=w/h) that fits in the source."""
    crop_w = min(src_w, src_h * ar)
    crop_h = crop_w / ar
    if crop_h > src_h:
        crop_h = src_h
        crop_w = crop_h * ar
    return _even(crop_w), _even(crop_h)


def _face_sample_count(analysis: dict) -> int:
    return sum(1 for s in analysis.get("samples", []) if s.get("primary"))


def _smooth_track(samples: list[dict], crop_w: int, src_w: int,
                  max_px_per_s: float) -> list[tuple]:
    """Build velocity-clamped x(t) keyframes that follow the primary face."""
    pts: list[tuple] = []  # (t, desired_x)
    last = (src_w - crop_w) / 2
    for s in samples:
        p = s.get("primary")
        if p:
            last = max(0, min(src_w - crop_w, p[0] - crop_w / 2))
        pts.append((s["t"], last))
    # forward velocity clamp for smooth motion (no sudden jumps)
    smoothed: list[tuple] = []
    prev_t, prev_x = pts[0][0], pts[0][1]
    smoothed.append((prev_t, prev_x))
    for t, x in pts[1:]:
        dt = max(0.05, t - prev_t)
        max_step = max_px_per_s * dt
        x = max(prev_x - max_step, min(prev_x + max_step, x))
        smoothed.append((t, x))
        prev_t, prev_x = t, x
    return _simplify_keyframes(smoothed, src_w - crop_w)


def _simplify_keyframes(pts: list[tuple], max_x: float, max_keys: int = 14) -> list[tuple]:
    """Drop near-collinear / near-equal points so the ffmpeg expr stays small."""
    if len(pts) <= 2:
        return pts
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        if abs(pts[i][1] - out[-1][1]) >= max(6.0, 0.02 * max(1.0, max_x)):
            out.append(pts[i])
    out.append(pts[-1])
    if len(out) > max_keys:  # uniformly thin
        step = len(out) / max_keys
        out = [out[int(i * step)] for i in range(max_keys)] + [out[-1]]
    return out


def _x_expr(keyframes: list[tuple], lo: float, hi: float) -> str:
    """Piecewise-linear ffmpeg expression in clip-relative time `t`."""
    if not keyframes:
        return str(int((lo + hi) / 2))
    if len(keyframes) == 1:
        return str(int(round(keyframes[0][1])))
    expr = f"{keyframes[-1][1]:.1f}"  # value past the last keyframe
    for i in range(len(keyframes) - 2, -1, -1):
        t0, x0 = keyframes[i]
        t1, x1 = keyframes[i + 1]
        seg = f"({x0:.1f}+({x1 - x0:.1f})*(t-{t0:.2f})/{max(0.05, t1 - t0):.2f})"
        expr = f"if(lt(t,{t1:.2f}),{seg},{expr})"
    # clamp into the valid range
    return f"max(0,min({int(hi - lo)},{expr}))"


def _two_clusters(analysis: dict, crop_w: int) -> tuple | None:
    """Find two persistent, well-separated face columns (left/right speakers)."""
    centers = [s["primary"][0] for s in analysis.get("samples", []) if s.get("primary")]
    multi = [s for s in analysis.get("samples", []) if len(s.get("faces", [])) >= 2]
    if len(centers) < 3 or len(multi) < max(2, 0.2 * len(analysis.get("samples", []))):
        return None
    src_w = analysis["src_w"]
    lefts, rights = [], []
    for s in multi:
        xs = sorted(f[0] + f[2] / 2 for f in s["faces"])
        lefts.append(xs[0])
        rights.append(xs[-1])
    lx = sorted(lefts)[len(lefts) // 2]
    rx = sorted(rights)[len(rights) // 2]
    if rx - lx < 0.28 * src_w:        # too close together — not a side-by-side split
        return None
    return lx, rx


# --- planning ------------------------------------------------------------
def plan_framing(analysis: dict, mode: str, src_w: int, src_h: int,
                 aspect: tuple[int, int] = (9, 16)) -> dict:
    ar = aspect[0] / aspect[1]
    crop_w, crop_h = _crop_box(src_w, src_h, ar)
    y = _even((src_h - crop_h) / 2)
    center_x = _even((src_w - crop_w) / 2)
    n_faces = _face_sample_count(analysis)
    n_samples = len(analysis.get("samples", [])) or 1
    face_ratio = n_faces / n_samples
    plan = {"mode": mode, "requested": mode, "crop_w": crop_w, "crop_h": crop_h,
            "y": y, "x_static": center_x, "note": ""}

    # SPLIT — explicit two-up podcast layout
    if mode == "split":
        clusters = _two_clusters(analysis, crop_w)
        if clusters:
            plan.update(_plan_split(clusters, src_w, src_h, ar))
            return plan
        plan["note"] = "Split requested but two speakers weren't found - using blurred background."
        plan["mode"] = "blur"
        return plan

    # BLUR — always safe, no crop
    if mode == "blur":
        plan["mode"] = "blur"
        return plan

    # SMART — follow the face, fall back to blur when no faces to track
    if mode == "smart":
        if analysis.get("available") and face_ratio >= 0.25:
            max_px = 0.18 * src_w  # gentle pan speed (px/sec) → smooth, no jumps
            keys = _smooth_track(analysis["samples"], crop_w, src_w, max_px)
            plan["x_keyframes"] = keys
            plan["x_expr"] = _x_expr(keys, 0, src_w - crop_w)
            plan["note"] = f"Following the speaker across {n_faces} detections."
            plan["mode"] = "smart"
            return plan
        plan["mode"] = "blur"
        plan["note"] = ("No trackable faces - using a clean blurred-background layout."
                        if analysis.get("available") else
                        "Face detection unavailable - using blurred-background layout.")
        return plan

    # CENTER — static crop, fall back to blur if it clearly cuts faces
    if _center_cuts_faces(analysis, center_x, crop_w):
        plan["mode"] = "blur"
        plan["note"] = "A centered crop would cut faces - using blurred background instead."
        return plan
    plan["mode"] = "center"
    return plan


def _plan_split(clusters: tuple, src_w: int, src_h: int, ar: float) -> dict:
    lx, rx = clusters
    cell_ar = ar * 2  # each cell is out_w x out_h/2
    cw, ch = _crop_box(src_w, src_h, cell_ar)
    def clamp(cx):
        return _even(max(0, min(src_w - cw, cx - cw / 2)))
    return {
        "mode": "split",
        "split": {"cw": cw, "ch": ch, "y": _even((src_h - ch) / 2),
                  "lx": clamp(lx), "rx": clamp(rx)},
        "note": "Two speakers detected — stacked split layout.",
    }


def _center_cuts_faces(analysis: dict, x: int, crop_w: int, tol: float = 0.30) -> bool:
    samples = [s for s in analysis.get("samples", []) if s.get("primary")]
    if not samples:
        return False
    cut = 0
    for s in samples:
        for (fx, fy, fw, fh) in s["faces"]:
            outside = max(0, x - fx) + max(0, (fx + fw) - (x + crop_w))
            if outside > tol * fw:
                cut += 1
                break
    return cut / len(samples) > 0.34


# --- filtergraph ---------------------------------------------------------
def build_filtergraph(plan: dict, out_w: int, out_h: int,
                      subtitle_file: str | None = None) -> tuple[str, str]:
    """Return (filter_complex graph, output pad label to -map) for the plan.
    Captions are appended last. `subtitle_file` is a BARE filename (ffmpeg is
    run with cwd set to its directory, sidestepping Windows path escaping)."""
    mode = plan["mode"]
    half = _even(out_h / 2)

    if mode == "split":
        s = plan["split"]
        graph = (
            f"[0:v]split=2[a][b];"
            f"[a]crop={s['cw']}:{s['ch']}:{s['lx']}:{s['y']},scale={out_w}:{half},setsar=1[top];"
            f"[b]crop={s['cw']}:{s['ch']}:{s['rx']}:{s['y']},scale={out_w}:{half},setsar=1[bot];"
            f"[top][bot]vstack=inputs=2,setsar=1[v]"
        )
    elif mode == "blur":
        graph = (
            f"[0:v]split=2[bg][fg];"
            f"[bg]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{out_h},gblur=sigma=24[bgb];"
            f"[fg]scale={out_w}:-2:force_original_aspect_ratio=decrease[fgs];"
            f"[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[v]"
        )
    else:  # center / smart — single crop chain
        cw, ch, y = plan["crop_w"], plan["crop_h"], plan["y"]
        if plan.get("x_expr"):
            crop = f"crop={cw}:{ch}:x='{plan['x_expr']}':y={y}"
        else:
            crop = f"crop={cw}:{ch}:{plan['x_static']}:{y}"
        graph = f"[0:v]{crop},scale={out_w}:{out_h},setsar=1[v]"

    if subtitle_file:
        graph += f";[v]subtitles={subtitle_file}[vout]"
        return graph, "[vout]"
    return graph, "[v]"
