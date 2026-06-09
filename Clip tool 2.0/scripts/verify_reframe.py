"""Objective before/after jitter metric for the reframe-stability fix.

Builds a realistic 5Hz sampled trajectory (a pan + detection noise + a 2-sample
dropout), then compares the rendered per-frame crop-x at 30fps for:

  1. OLD trajectory (causal EMA + center-snap on miss) + OLD step-hold render
  2. OLD trajectory + NEW dense render            (render fix only)
  3. NEW trajectory (_smooth_centers)  + NEW dense render   (full fix)

Metrics on the 30fps crop-x signal: worst single-frame jump (px) and mean jerk
(|2nd difference|, px). Lower = smoother.
"""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.services.export import _densify  # noqa: E402
from app.services.reframing import _smooth_centers, build_crop_keyframes  # noqa: E402

SW, SH = 1920, 1080
FPS = 30.0
SAMPLE_FPS = 5

# ---- build a 6s, 5Hz raw trajectory: pan 0.30->0.70 with noise + a dropout ----
raw = []
old_inputs = []  # what the OLD code would feed per sample (miss -> 0.5)
n = 6 * SAMPLE_FPS
noise = [0.012, -0.008, 0.015, -0.013, 0.009, -0.011, 0.014, -0.006] * 8
for i in range(n):
    t = i / SAMPLE_FPS
    cx = 0.30 + 0.40 * (i / (n - 1)) + noise[i % len(noise)]
    cy = 0.45 + noise[(i + 3) % len(noise)] * 0.5
    miss = i in (14, 15)  # 0.4s detection dropout mid-pan
    if miss:
        raw.append({"t": t, "cx": None, "cy": None, "conf": 0.0, "switch": False})
        old_inputs.append((t, 0.5, 0.5))  # OLD code snaps to center on a miss
    else:
        raw.append({"t": t, "cx": cx, "cy": cy, "conf": 1.0, "switch": False})
        old_inputs.append((t, cx, cy))


def old_centers():
    """Replicate the pre-fix causal EMA + per-axis deadzone (alpha=0.25, dz=0.015)."""
    a, dz = 0.25, 0.015
    ex = ey = 0.5
    init = False
    out = []
    for t, cx, cy in old_inputs:
        if not init:
            ex, ey, init = cx, cy, True
        else:
            if abs(cx - ex) > dz:
                ex = (1 - a) * ex + a * cx
            if abs(cy - ey) > dz:
                ey = (1 - a) * ey + a * cy
        out.append({"t": t, "cx": ex, "cy": ey, "conf": 1.0})
    return out


def step_hold_render(keyframes):
    """OLD render: sendcmd step-and-hold -> sample the last keyframe per frame."""
    t0, t1 = keyframes[0][0], keyframes[-1][0]
    frames = []
    j = 0
    k = 0
    while True:
        t = t0 + k / FPS
        if t > t1:
            break
        while j < len(keyframes) - 1 and keyframes[j + 1][0] <= t:
            j += 1
        frames.append(keyframes[j][1])
        k += 1
    return frames


def dense_render(keyframes, max_x, max_y):
    return [x for _, x, _ in _densify(keyframes, FPS, max_x, max_y)]


def metrics(xs):
    jumps = [abs(xs[i + 1] - xs[i]) for i in range(len(xs) - 1)]
    jerks = [abs(xs[i + 1] - 2 * xs[i] + xs[i - 1]) for i in range(1, len(xs) - 1)]
    return max(jumps) if jumps else 0, (sum(jerks) / len(jerks)) if jerks else 0


oc = old_centers()
nc = _smooth_centers(raw, SAMPLE_FPS)

cw, ch, old_kf = build_crop_keyframes({"source_w": SW, "source_h": SH, "centers": oc}, "9:16")
_, _, new_kf = build_crop_keyframes({"source_w": SW, "source_h": SH, "centers": nc}, "9:16")
max_x, max_y = SW - cw, SH - ch

scenarios = [
    ("1. OLD traj + OLD step render (status quo)", step_hold_render(old_kf)),
    ("2. OLD traj + NEW dense render (render fix)", dense_render(old_kf, max_x, max_y)),
    ("3. NEW traj + NEW dense render (full fix)  ", dense_render(new_kf, max_x, max_y)),
]

print(f"crop = {cw}x{ch}, max_x = {max_x}px, 30fps over {raw[-1]['t']:.1f}s\n")
print(f"{'scenario':<46}  {'worst jump':>11}  {'mean jerk':>10}")
print("-" * 72)
for name, xs in scenarios:
    mj, jk = metrics(xs)
    print(f"{name:<46}  {mj:>9.1f}px  {jk:>8.2f}px")

# Dropout check: did the NEW trajectory avoid the center-snap at the miss?
miss_t = 14 / SAMPLE_FPS
old_at_miss = min(oc, key=lambda c: abs(c["t"] - miss_t))["cx"]
new_at_miss = min(nc, key=lambda c: abs(c["t"] - miss_t))["cx"]
neighbor = nc[13]["cx"]
print(f"\nDropout @ t={miss_t:.1f}s:  OLD cx={old_at_miss:.3f} (pulled toward 0.5)  "
      f"NEW cx={new_at_miss:.3f} (held near neighbor {neighbor:.3f})")
