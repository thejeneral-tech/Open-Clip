"""Smart reframing.

Samples the video, locates the primary subject in each sampled frame (face via
MediaPipe → person via YOLO → centre fallback), then produces a **smoothed,
normalized centre trajectory**. Export later turns that trajectory into a sliding
crop window for any target aspect ratio.

Smoothing is done in an **offline post-pass** (the whole clip is sampled before
rendering), which lets us:

* **hold** the framing through a detection dropout instead of snapping to centre,
* **lock** onto one subject (dwell/commit before switching to a new one), and
* run a per-segment **One-Euro** filter — an adaptive low-pass that is steady
  when the subject is still and responsive on fast pans, with no fixed lag.

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
from collections.abc import Callable
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger
from app.models.enums import ASPECT_DIMENSIONS

logger = get_logger(__name__)

ProgressCb = Callable[[float], None]


# --------------------------------------------------------------------------- #
#  One-Euro filter (Casiez et al. 2012) — adaptive low-pass for 2D centres.
#  Pure-Python, no SciPy. cx/cy share a single speed-driven cutoff so the two
#  axes stay coupled (no axis-decoupled stair-stepping).
# --------------------------------------------------------------------------- #
def _one_euro_alpha(cutoff: float, dt: float) -> float:
    tau = 1.0 / (2.0 * math.pi * max(1e-6, cutoff))
    return 1.0 / (1.0 + tau / max(1e-6, dt))


class _OneEuro2D:
    def __init__(self, min_cutoff: float, beta: float, d_cutoff: float) -> None:
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self._x: tuple[float, float] | None = None
        self._dx = (0.0, 0.0)
        self._t_prev: float | None = None

    def filter(self, x: float, y: float, t: float) -> tuple[float, float]:
        if self._x is None or self._t_prev is None:
            self._x = (x, y)
            self._t_prev = t
            return x, y
        dt = t - self._t_prev
        if dt <= 0:
            dt = 1e-3
        # Filter the derivative first, then derive the speed-adaptive cutoff
        # from the FILTERED velocity (raw velocity is too noisy to drive it).
        a_d = _one_euro_alpha(self.d_cutoff, dt)
        dx = a_d * ((x - self._x[0]) / dt) + (1 - a_d) * self._dx[0]
        dy = a_d * ((y - self._x[1]) / dt) + (1 - a_d) * self._dx[1]
        speed = math.hypot(dx, dy)
        cutoff = self.min_cutoff + self.beta * speed
        a = _one_euro_alpha(cutoff, dt)
        x_hat = a * x + (1 - a) * self._x[0]
        y_hat = a * y + (1 - a) * self._x[1]
        self._x = (x_hat, y_hat)
        self._dx = (dx, dy)
        self._t_prev = t
        return x_hat, y_hat


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

    if lock is None:  # first acquisition → largest subject
        c = max(candidates, key=lambda k: k[2])
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
    far = max(candidates, key=lambda k: k[2])
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
    """Offline smoothing: back-fill leads, hold dropouts (ease after a limit),
    segment at subject switches / long gaps, and run a forward One-Euro per
    segment. Input ``raw`` items: {t, cx|None, cy|None, conf, switch}."""
    n = len(raw)
    if n == 0:
        return [{"t": 0.0, "cx": 0.5, "cy": 0.5, "conf": 0.0}]

    first_valid = next((i for i, r in enumerate(raw) if r["cx"] is not None), None)
    if first_valid is None:  # nothing was ever detected
        return [{"t": round(r["t"], 3), "cx": 0.5, "cy": 0.5, "conf": 0.0} for r in raw]

    max_hold = max(1, int(round(settings.REFRAME_MAX_HOLD_SECONDS * sample_fps)))
    reacquire_gap = max(1, int(round(settings.REFRAME_REACQUIRE_GAP_SECONDS * sample_fps)))

    # 1) Fill misses: back-fill leading misses to the first valid centre; hold
    #    the last valid centre across internal misses, easing toward (0.5,0.5)
    #    after `max_hold` continuous misses.
    filled: list[dict[str, Any]] = []
    last_cx, last_cy = raw[first_valid]["cx"], raw[first_valid]["cy"]
    miss_run = 0
    for i, r in enumerate(raw):
        if r["cx"] is not None:
            cx, cy, conf = r["cx"], r["cy"], r["conf"]
            last_cx, last_cy = cx, cy
            miss_run = 0
        elif i < first_valid:
            cx, cy, conf = raw[first_valid]["cx"], raw[first_valid]["cy"], 0.0
        else:
            miss_run += 1
            if miss_run <= max_hold:
                cx, cy = last_cx, last_cy
            else:
                ease = min(1.0, (miss_run - max_hold) / max_hold)
                cx = last_cx + (0.5 - last_cx) * ease
                cy = last_cy + (0.5 - last_cy) * ease
            conf = 0.0
        filled.append({"t": r["t"], "cx": cx, "cy": cy, "conf": conf,
                       "miss": r["cx"] is None, "switch": bool(r.get("switch"))})

    # 2) Segment boundaries: hard subject switches and re-acquisition after a
    #    long detection gap (reset the filter so it snaps cleanly, no pre-echo).
    boundaries = {0}
    run = 0
    for i, f in enumerate(filled):
        if f["switch"]:
            boundaries.add(i)
        if f["miss"]:
            run += 1
        else:
            if run >= reacquire_gap:
                boundaries.add(i)
            run = 0
    bounds = sorted(boundaries)

    # 3) Forward One-Euro per segment.
    out: list[dict[str, Any]] = []
    for k, s in enumerate(bounds):
        e = bounds[k + 1] if k + 1 < len(bounds) else n
        euro = _OneEuro2D(settings.REFRAME_MIN_CUTOFF, settings.REFRAME_BETA, settings.REFRAME_D_CUTOFF)
        for i in range(s, e):
            f = filled[i]
            sx, sy = euro.filter(f["cx"], f["cy"], f["t"])
            out.append({
                "t": round(f["t"], 3),
                "cx": round(min(1.0, max(0.0, sx)), 4),
                "cy": round(min(1.0, max(0.0, sy)), 4),
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

            raw.append({"t": t, "cx": cx_out, "cy": cy_out, "conf": conf, "switch": hard_switch})

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
