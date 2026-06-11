import re

from app.services import reframing
from app.services.export import _build_sendcmd, _densify, _escape_path, output_dimensions
from app.services.reframing import (
    _select_subject,
    _smooth_centers,
    _zoom_faces,
    build_crop_keyframes,
    crop_dimensions,
)


def test_output_dimensions_vertical():
    assert output_dimensions("9:16", "1080p") == (1080, 1920)


def test_output_dimensions_landscape():
    assert output_dimensions("16:9", "1080p") == (1920, 1080)


def test_output_dimensions_square_and_portrait():
    assert output_dimensions("1:1", "720p") == (720, 720)
    assert output_dimensions("4:5", "1080p") == (1080, 1350)


def test_output_dimensions_4k():
    assert output_dimensions("9:16", "4k") == (2160, 3840)


def test_crop_dimensions_wide_source_to_vertical():
    # 1920x1080 cropped to 9:16 → full height, narrower width.
    w, h = crop_dimensions(1920, 1080, "9:16")
    assert h == 1080
    # round(1080 * 9/16) = round(607.5) = 608, already even
    assert w == 608
    assert w % 2 == 0


def test_build_crop_keyframes_clamps_into_frame():
    data = {
        "source_w": 1920,
        "source_h": 1080,
        "centers": [
            {"t": 0.0, "cx": 0.0, "cy": 0.5},   # far left → clamps to x=0
            {"t": 1.0, "cx": 1.0, "cy": 0.5},   # far right → clamps to max
        ],
    }
    crop_w, crop_h, keyframes = build_crop_keyframes(data, "9:16")
    max_x = 1920 - crop_w
    assert keyframes[0][1] == 0
    assert keyframes[1][1] == max_x


def test_escape_path():
    # Backslashes are normalized to '/', then ':' is escaped for ffmpeg filters.
    assert _escape_path("C:\\x\\y.ass") == "C\\:/x/y.ass"
    assert _escape_path("/data/storage/clip.ass") == "/data/storage/clip.ass"


# --------------------------------------------------------------------------- #
#  Reframe stability: keyframe densification (render-side anti-stepping)
# --------------------------------------------------------------------------- #
def test_densify_interpolates_smoothly_and_endpoints_exact():
    # A 60px pan over 0.2s: sparse = one 60px teleport; dense = small steps.
    kf = [(0.0, 0, 100), (0.2, 60, 100)]
    dense = _densify(kf, grid_fps=30.0, max_x=1000, max_y=1000)
    ts = [d[0] for d in dense]
    assert ts == sorted(ts)                       # monotonic time
    assert dense[0][1] == 0 and dense[-1][1] == 60  # endpoints exact
    deltas = [abs(dense[i + 1][1] - dense[i][1]) for i in range(len(dense) - 1)]
    assert max(deltas) <= 12                       # never the full 60px jump again


def test_densify_clamps_into_bounds():
    kf = [(0.0, 0, 0), (1.0, 500, 500)]
    dense = _densify(kf, grid_fps=30.0, max_x=100, max_y=100)
    assert all(0 <= x <= 100 and 0 <= y <= 100 for _, x, y in dense)


def test_densify_degenerate_returns_input():
    kf = [(0.0, 5, 5)]
    assert _densify(kf, 30.0, 100, 100) == kf  # <2 keyframes → unchanged


def test_build_sendcmd_static_shortcircuit(tmp_path):
    p = str(tmp_path / "s.txt")
    static = [(0.0, 10, 10), (1.0, 12, 11)]  # <4px spread on both axes
    assert _build_sendcmd(static, p, grid_fps=30.0, max_x=1000, max_y=1000) is False


def test_build_sendcmd_real_pan_emits_valid_lines(tmp_path):
    p = str(tmp_path / "s.txt")
    pan = [(0.0, 0, 100), (1.0, 400, 100)]
    assert _build_sendcmd(pan, p, grid_fps=30.0, max_x=1000, max_y=1000) is True
    lines = [ln for ln in open(p, encoding="utf-8").read().splitlines() if ln.strip()]
    assert lines
    assert all(re.match(r"^[0-9]+\.[0-9]+ crop [xy] -?[0-9]+;$", ln) for ln in lines)


# --------------------------------------------------------------------------- #
#  Reframe stability: lock-and-hold smoothing
# --------------------------------------------------------------------------- #
def _raw(t, cx, cy, conf=1.0, switch=False, scene=False):
    return {"t": t, "cx": cx, "cy": cy, "conf": conf, "switch": switch, "scene": scene}


def test_smooth_centers_holds_dropout_not_center_snap():
    raw = [_raw(0.0, 0.8, 0.8), _raw(0.2, None, None, 0.0), _raw(0.4, 0.8, 0.8)]
    out = _smooth_centers(raw, sample_fps=5)
    assert len(out) == 3
    assert all(c["cx"] == 0.8 and c["cy"] == 0.8 for c in out)  # locked, NOT 0.5


def test_smooth_centers_all_miss_falls_back_to_center():
    raw = [_raw(i * 0.2, None, None, 0.0) for i in range(3)]
    out = _smooth_centers(raw, sample_fps=5)
    assert all(c["cx"] == 0.5 and c["cy"] == 0.5 and c["conf"] == 0.0 for c in out)


def test_smooth_centers_ignores_single_impulse():
    raw = [_raw(i * 0.2, 0.5, 0.5) for i in range(8)]
    raw[4] = _raw(0.8, 0.9, 0.5)  # one off-center spike
    out = _smooth_centers(raw, sample_fps=5)
    assert all(c["cx"] == 0.5 for c in out)  # the lock never moves


def test_smooth_centers_jitter_inside_deadband_is_static():
    # Detection noise around 0.5 — well inside the deadband.
    wiggle = [0.02, -0.03, 0.01, -0.02, 0.03, 0.0]
    raw = [_raw(i * 0.2, 0.5 + wiggle[i % 6], 0.5 - wiggle[i % 6] / 2) for i in range(20)]
    out = _smooth_centers(raw, sample_fps=5)
    assert len({c["cx"] for c in out}) == 1  # one position the whole way
    assert len({c["cy"] for c in out}) == 1


def test_smooth_centers_sustained_move_glides_once_then_locks():
    # Subject sits at 0.3 for 2s, then sits at 0.8 for the rest.
    raw = [_raw(i * 0.2, 0.3 if i < 10 else 0.8, 0.5) for i in range(30)]
    out = _smooth_centers(raw, sample_fps=5)
    xs = [c["cx"] for c in out]
    assert xs[0] == xs[9] == 0.3            # locked before the move
    assert xs[-1] == 0.8                    # locked on the new position
    assert xs == sorted(xs)                 # monotonic glide, no overshoot/wobble
    assert len({x for x in xs}) <= 8        # static-glide-static, not continuous drift


def test_smooth_centers_scene_cut_snaps_with_pinned_keyframe():
    raw = [_raw(i * 0.2, 0.2, 0.5) for i in range(5)]
    raw += [_raw(1.0 + i * 0.2, 0.8, 0.5, scene=(i == 0)) for i in range(5)]
    out = _smooth_centers(raw, sample_fps=5)
    assert len(out) == 11  # 10 samples + 1 epsilon pin before the cut
    pin = out[5]
    assert pin["t"] == 0.999 and pin["cx"] == 0.2  # old centre pinned 1ms pre-cut
    assert out[6]["t"] == 1.0 and out[6]["cx"] == 0.8  # instant snap at the cut
    assert all(c["cx"] == 0.2 for c in out[:6])
    assert all(c["cx"] == 0.8 for c in out[6:])


def test_smooth_centers_skips_glide_that_cannot_finish_before_cut():
    # Subject relocates only in the last second of the shot — a pan would be
    # cut off mid-motion, so the crop must stay parked.
    raw = [_raw(i * 0.2, 0.3 if i < 25 else 0.8, 0.5) for i in range(30)]
    out = _smooth_centers(raw, sample_fps=5)
    assert all(c["cx"] == 0.3 for c in out)


def test_smooth_centers_singleton_is_identity():
    out = _smooth_centers([_raw(0.0, 0.3, 0.7)], sample_fps=5)
    assert out == [{"t": 0.0, "cx": 0.3, "cy": 0.7, "conf": 1.0}]


def test_zoom_faces_maps_crop_coords_back_to_full_frame(monkeypatch):
    # A face found at the centre of a person's (upscaled) head crop must map
    # back to that head region's centre in full-frame normalized coords.
    import numpy as np

    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    person = (860.0, 400.0, 1060.0, 1000.0)  # 200x600 px box
    monkeypatch.setattr(reframing, "_detect_faces", lambda det, crop: [(0.5, 0.5, 0.25)])
    out = _zoom_faces(object(), frame, [person], 1920, 1080)
    assert len(out) == 1
    cx, cy, area = out[0]
    # Head region: x 830..1090 (15% pad), y 400..670 (45% of box height).
    assert abs(cx - (830 + 1090) / 2 / 1920) < 0.01
    assert abs(cy - (400 + 670) / 2 / 1080) < 0.01
    assert 0 < area < 1


def test_zoom_faces_skips_degenerate_boxes(monkeypatch):
    import numpy as np

    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    monkeypatch.setattr(reframing, "_detect_faces", lambda det, crop: [(0.5, 0.5, 0.25)])
    assert _zoom_faces(object(), frame, [(10.0, 10.0, 15.0, 15.0)], 1920, 1080) == []


def test_build_crop_keyframes_subject_headroom():
    # Vertical source cropped to 1:1: the crop CAN move vertically, so the
    # subject sits at REFRAME_SUBJECT_Y (0.42) of the crop, not dead centre.
    data = {"source_w": 1080, "source_h": 1920,
            "centers": [{"t": 0.0, "cx": 0.5, "cy": 0.5}]}
    crop_w, crop_h, kf = build_crop_keyframes(data, "1:1")
    assert (crop_w, crop_h) == (1080, 1080)
    assert kf[0][2] == round(0.5 * 1920 - 1080 * 0.42)  # 506, not 420


def test_select_subject_acquires_face_over_larger_person():
    # A person box always out-areas a face box; acquisition must still prefer
    # the face so the crop locks onto it.
    candidates = [(0.3, 0.5, 0.40, "person"), (0.62, 0.38, 0.02, "face")]
    chosen, lock, conf, method, _ = _select_subject(candidates, None, {"cand": None, "count": 0})
    assert chosen == (0.62, 0.38) and lock == (0.62, 0.38)
    assert method == "face" and conf == 1.0
