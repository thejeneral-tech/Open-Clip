"""Smart reframing.

Samples the video, locates the primary subject in each sampled frame (face via
MediaPipe → person via YOLO → centre fallback), then produces a **locked,
piecewise-static centre trajectory**. Export later turns that trajectory into a
crop window for any target aspect ratio.

The guiding rule is *a parked camera beats a wandering one*: the crop locks
onto the subject and **does not move at all** while the shot lasts. It moves in
exactly two cases:

* a **scene cut** (detected via HSV-histogram correlation between samples) —
  the crop snaps instantly to the new shot's subject, which is invisible
  because the picture changes completely anyway; or
* the subject **sustainably leaves a deadband** around the locked centre (or
  the subject lock commits to a different person) — one short smoothstep glide
  re-centres the crop, then it locks again.

Detection jitter, single-frame impulses and dropouts therefore never reach the
rendered crop. Smoothing is an offline post-pass (the whole clip is sampled
before rendering), so re-anchoring can look *ahead* and settle where the
subject is about to be.

The output stored on the clip (``reframe_data``)::

    {
      "source_w": int, "source_h": int,
      "sample_fps": float, "src_fps": float,
      "centers": [ { "t": float, "cx": 0..1, "cy": 0..1, "conf": 0..1 } ],
      "method": "face" | "person" | "center"
    }
"""
from __future__ import annotations

import math
import statistics
from collections.abc import Callable
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger
from app.models.enums import ASPECT_DIMENSIONS

logger = get_logger(__name__)

ProgressCb = Callable[[float], None]


def _detect_faces(detector, frame) -> list[tuple[float, float, float]]:
    """Return list of (cx, cy, area) normalized face centers for a BGR frame."""
    import cv2

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = detector.process(rgb)
    out: list[tuple[float, float, float]] = []
    if results.detections:
        for det in results.detections:
            box = det.location_data.relative_bounding_box
            cx = box.xmin + box.width / 2
            cy = box.ymin + box.height / 2
            area = max(0.0, box.width) * max(0.0, box.height)
            out.append((min(1.0, max(0.0, cx)), min(1.0, max(0.0, cy)), area))
    return out


def _detect_persons_yolo(model, frame, w: int, h: int) -> list[tuple[float, float, float]]:
    """Return list of (cx, head_cy, area) normalized person estimates for a frame.

    The vertical anchor is a *head* estimate (box_top + a fraction of box
    height), not the box centre (torso) — so a face↔person fallback flip barely
    moves cy instead of lurching between head and torso.
    """
    # device pinned (default cpu): the P100 (sm_60) isn't supported by the
    # installed torch, so GPU inference raises "no kernel image is available".
    results = model(frame, classes=[0], verbose=False, device=settings.YOLO_DEVICE)  # class 0 = person
    out: list[tuple[float, float, float]] = []
    frac = settings.REFRAME_PERSON_HEAD_FRAC
    for r in results:
        for box in getattr(r, "boxes", []):
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
            area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
            cx = ((x1 + x2) / 2) / w if w else 0.5
            head_cy = (y1 + frac * (y2 - y1)) / h if h else 0.5
            out.append((min(1.0, max(0.0, cx)), min(1.0, max(0.0, head_cy)), area / (w * h) if w and h else 0.0))
    return out


def _select_subject(candidates, lock, switch_state):
    """Pick the tracked centre for one sample given the current lock.

    candidates: list of (cx, cy, area, method).
    lock: current (cx, cy) or None.    switch_state: mutable dict {cand, count}.
    Returns (chosen | None, new_lock, conf, method, hard_switch).
    ``chosen is None`` means "hold the existing lock" (pending a subject switch).
    """
    if not candidates:
        return None, lock, 0.0, None, False

    if lock is None:  # first acquisition → largest face, else largest subject
        faces = [k for k in candidates if k[3] == "face"]
        c = max(faces or candidates, key=lambda k: k[2])
        switch_state["cand"] = None
        switch_state["count"] = 0
        conf = 1.0 if c[3] == "face" else 0.7
        return (c[0], c[1]), (c[0], c[1]), conf, c[3], False

    lx, ly = lock
    nearest = min(candidates, key=lambda k: math.hypot(k[0] - lx, k[1] - ly))
    if math.hypot(nearest[0] - lx, nearest[1] - ly) <= settings.REFRAME_SWITCH_DIST:
        switch_state["cand"] = None
        switch_state["count"] = 0
        conf = 1.0 if nearest[3] == "face" else 0.7
        return (nearest[0], nearest[1]), (nearest[0], nearest[1]), conf, nearest[3], False

    # The locked subject is gone; a far candidate must persist before we commit.
    faces = [k for k in candidates if k[3] == "face"]
    far = max(faces or candidates, key=lambda k: k[2])
    prev = switch_state.get("cand")
    if prev is not None and math.hypot(far[0] - prev[0], far[1] - prev[1]) <= settings.REFRAME_SWITCH_DIST:
        switch_state["count"] += 1
    else:
        switch_state["cand"] = (far[0], far[1])
        switch_state["count"] = 1
    if switch_state["count"] >= settings.REFRAME_SWITCH_HOLD:
        switch_state["cand"] = None
        switch_state["count"] = 0
        conf = 1.0 if far[3] == "face" else 0.7
        return (far[0], far[1]), (far[0], far[1]), conf, far[3], True
    return None, lock, 0.0, None, False  # hold


def _smooth_centers(raw: list[dict[str, Any]], sample_fps: float) -> list[dict[str, Any]]:
    """Offline lock-and-hold pass producing a piecewise-static trajectory.

    Per scene segment (split at scene cuts) the crop locks onto a robust anchor
    — the median of the first lookahead window — and holds it through detection
    jitter and dropouts. It moves only when the subject sustainably leaves the
    deadband or the subject lock hard-switches: one smoothstep glide to the
    median of the *upcoming* window, then it locks again. At scene cuts an
    epsilon keyframe pins the old centre 1 ms before the new segment so the
    renderer snaps instead of smearing the jump into a visible pan.

    Input ``raw`` items: {t, cx|None, cy|None, conf, switch, scene}.
    """
    n = len(raw)
    if n == 0:
        return [{"t": 0.0, "cx": 0.5, "cy": 0.5, "conf": 0.0}]

    first_valid = next((i for i, r in enumerate(raw) if r["cx"] is not None), None)
    if first_valid is None:  # nothing was ever detected
        return [{"t": round(r["t"], 3), "cx": 0.5, "cy": 0.5, "conf": 0.0} for r in raw]

    # 1) Fill misses: back-fill leading misses to the first valid centre and
    #    hold the last valid centre across dropouts. The crop never drifts to
    #    frame centre — a parked crop is calmer than a slow unexplained pan.
    filled: list[dict[str, Any]] = []
    last_cx, last_cy = raw[first_valid]["cx"], raw[first_valid]["cy"]
    for r in raw:
        miss = r["cx"] is None
        if not miss:
            last_cx, last_cy = r["cx"], r["cy"]
        filled.append({"t": r["t"], "cx": last_cx, "cy": last_cy,
                       "conf": 0.0 if miss else r["conf"], "miss": miss,
                       "switch": bool(r.get("switch")), "scene": bool(r.get("scene"))})

    # 2) Segment ONLY at scene cuts. Everything inside a shot is handled by the
    #    deadband (hold) / glide (re-centre) logic below.
    bounds = sorted({0} | {i for i in range(1, n) if filled[i]["scene"]})

    look = max(1, int(round(settings.REFRAME_LOOKAHEAD_SECONDS * sample_fps)))
    need = max(1, int(round(settings.REFRAME_RETARGET_SECONDS * sample_fps)))
    ease_n = max(1, int(round(settings.REFRAME_EASE_SECONDS * sample_fps)))
    deadband = settings.REFRAME_DEADBAND

    def _anchor(seg: list[dict[str, Any]], i: int) -> tuple[float, float]:
        win = [g for g in seg[i:i + look] if not g["miss"]] or seg[i:i + look]
        return (statistics.median(g["cx"] for g in win),
                statistics.median(g["cy"] for g in win))

    # 3) Deadband-hold per segment.
    out: list[dict[str, Any]] = []
    for k, s in enumerate(bounds):
        e = bounds[k + 1] if k + 1 < len(bounds) else n
        seg = filled[s:e]
        if not seg:
            continue
        if out:  # pin the previous centre 1 ms before the cut → clean snap
            out.append({"t": round(seg[0]["t"] - 0.001, 3),
                        "cx": out[-1]["cx"], "cy": out[-1]["cy"], "conf": out[-1]["conf"]})
        cur = _anchor(seg, 0)
        glide_from = cur
        glide_target: tuple[float, float] | None = None
        glide_step = 0
        breach = 0
        for i, f in enumerate(seg):
            if glide_target is not None:
                glide_step += 1
                u = min(1.0, glide_step / ease_n)
                u = u * u * (3.0 - 2.0 * u)  # smoothstep: zero velocity at both ends
                cur = (glide_from[0] + (glide_target[0] - glide_from[0]) * u,
                       glide_from[1] + (glide_target[1] - glide_from[1]) * u)
                if glide_step >= ease_n:
                    cur = glide_target
                    glide_target = None
                    breach = 0
            else:
                if f["switch"]:
                    breach = need  # the subject lock already dwelled — retarget now
                elif not f["miss"] and math.hypot(f["cx"] - cur[0], f["cy"] - cur[1]) > deadband:
                    breach += 1
                else:
                    breach = 0
                if breach >= need:
                    target = _anchor(seg, i)
                    breach = 0
                    # Ignore retargets that barely move the crop.
                    if math.hypot(target[0] - cur[0], target[1] - cur[1]) > deadband / 2:
                        glide_from, glide_target, glide_step = cur, target, 0
            out.append({
                "t": round(f["t"], 3),
                "cx": round(min(1.0, max(0.0, cur[0])), 4),
                "cy": round(min(1.0, max(0.0, cur[1])), 4),
                "conf": f["conf"],
            })
    return out


def compute_trajectory(
    video_path: str,
    *,
    start: float = 0.0,
    end: float | None = None,
    on_progress: ProgressCb | None = None,
) -> dict[str, Any]:
    """Analyze [start, end] of a video and return a centre trajectory."""
    import cv2

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / src_fps if src_fps else 0.0
    end = min(end if end is not None else duration, duration) if duration else end

    sample_fps = max(1, settings.TRACKING_SAMPLE_FPS)
    frame_step = max(1, int(round(src_fps / sample_fps)))

    # Lazy-init detectors.
    face_detector = None
    try:
        import mediapipe as mp

        face_detector = mp.solutions.face_detection.FaceDetection(
            model_selection=1, min_detection_confidence=0.5
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("MediaPipe unavailable: %s", exc)

    yolo = None
    if settings.ENABLE_YOLO:
        try:
            from ultralytics import YOLO

            yolo = YOLO(settings.YOLO_MODEL)
        except Exception as exc:  # pragma: no cover
            logger.warning("YOLO unavailable: %s", exc)

    raw: list[dict[str, Any]] = []
    method_used = "center"
    lock: tuple[float, float] | None = None
    switch_state: dict[str, Any] = {"cand": None, "count": 0}
    prev_hist = None

    start_frame = int(start * src_fps)
    end_frame = int(end * src_fps) if end else total_frames
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    frame_idx = start_frame

    while frame_idx < end_frame:
        ok, frame = cap.read()
        if not ok:
            break
        if (frame_idx - start_frame) % frame_step == 0:
            t = frame_idx / src_fps - start

            # Scene-cut detection: HSV hue/saturation histogram correlation
            # between consecutive samples. Robust to subject/camera motion
            # (same shot keeps its palette), cheap at the sample rate.
            small = cv2.resize(frame, (160, 90), interpolation=cv2.INTER_AREA)
            hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
            hist = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
            cv2.normalize(hist, hist)
            scene_cut = False
            if prev_hist is not None:
                correl = float(cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL))
                scene_cut = correl < settings.REFRAME_SCENE_CORREL
            prev_hist = hist
            if scene_cut:  # new shot → drop the old lock, acquire fresh
                lock = None
                switch_state = {"cand": None, "count": 0}

            candidates: list[tuple[float, float, float, str]] = []
            for fcx, fcy, area in (_detect_faces(face_detector, frame) if face_detector else []):
                candidates.append((fcx, fcy, area, "face"))
            if yolo is not None:
                for pcx, pcy, area in _detect_persons_yolo(yolo, frame, width, height):
                    candidates.append((pcx, pcy, area, "person"))

            chosen, lock, conf, method, hard_switch = _select_subject(candidates, lock, switch_state)

            if chosen is not None:
                cx_out, cy_out = chosen
                is_miss = False
                if method == "face":
                    method_used = "face"
                elif method == "person" and method_used != "face":
                    method_used = "person"
            elif lock is not None:  # holding the last subject (pending switch)
                cx_out, cy_out = lock
                conf = 0.4
                is_miss = False
            else:  # genuine detection miss
                cx_out, cy_out, conf = None, None, 0.0
                is_miss = True

            raw.append({"t": t, "cx": cx_out, "cy": cy_out, "conf": conf,
                        "switch": hard_switch, "scene": scene_cut})

            if on_progress and end_frame > start_frame:
                on_progress(min(0.99, (frame_idx - start_frame) / (end_frame - start_frame)))
        frame_idx += 1

    cap.release()
    if face_detector:
        face_detector.close()
    if on_progress:
        on_progress(1.0)

    centers = _smooth_centers(raw, sample_fps)

    return {
        "source_w": width,
        "source_h": height,
        "sample_fps": sample_fps,
        "src_fps": round(src_fps, 3),
        "centers": centers,
        "method": method_used,
    }


def crop_dimensions(source_w: int, source_h: int, aspect_ratio: str) -> tuple[int, int]:
    """Largest crop of ``aspect_ratio`` that fits inside the source frame."""
    aw, ah = ASPECT_DIMENSIONS.get(aspect_ratio, (9, 16))
    target = aw / ah
    src = source_w / source_h
    if src >= target:
        # Source is wider: full height, narrower width.
        crop_h = source_h
        crop_w = int(round(crop_h * target))
    else:
        crop_w = source_w
        crop_h = int(round(crop_w / target))
    # Make even (required by most encoders).
    crop_w -= crop_w % 2
    crop_h -= crop_h % 2
    return max(2, crop_w), max(2, crop_h)


def build_crop_keyframes(
    reframe_data: dict[str, Any], aspect_ratio: str
) -> tuple[int, int, list[tuple[float, int, int]]]:
    """Translate a centre trajectory into ``(crop_w, crop_h, [(t, x, y)])``
    for a given aspect ratio, clamped to frame bounds."""
    sw = int(reframe_data.get("source_w") or 0)
    sh = int(reframe_data.get("source_h") or 0)
    centers = reframe_data.get("centers") or [{"t": 0.0, "cx": 0.5, "cy": 0.5}]
    if not sw or not sh:
        return 0, 0, []

    crop_w, crop_h = crop_dimensions(sw, sh, aspect_ratio)
    max_x = max(0, sw - crop_w)
    max_y = max(0, sh - crop_h)

    keyframes: list[tuple[float, int, int]] = []
    for c in centers:
        x = int(round(c["cx"] * sw - crop_w / 2))
        y = int(round(c["cy"] * sh - crop_h / 2))
        x = max(0, min(max_x, x))
        y = max(0, min(max_y, y))
        keyframes.append((float(c["t"]), x, y))
    return crop_w, crop_h, keyframes
