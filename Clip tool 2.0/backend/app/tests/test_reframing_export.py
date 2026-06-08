import re

from app.services.export import _build_sendcmd, _densify, _escape_path, output_dimensions
from app.services.reframing import (
    _OneEuro2D,
    _smooth_centers,
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
#  Reframe stability: offline smoothing (dropout hold, impulse suppression)
# --------------------------------------------------------------------------- #
def _raw(t, cx, cy, conf=1.0, switch=False):
    return {"t": t, "cx": cx, "cy": cy, "conf": conf, "switch": switch}


def test_smooth_centers_holds_dropout_not_center_snap():
    raw = [_raw(0.0, 0.8, 0.8), _raw(0.2, None, None, 0.0), _raw(0.4, 0.8, 0.8)]
    out = _smooth_centers(raw, sample_fps=5)
    assert len(out) == 3
    assert out[1]["cx"] > 0.6 and out[1]["cy"] > 0.6  # held near 0.8, NOT 0.5


def test_smooth_centers_all_miss_falls_back_to_center():
    raw = [_raw(i * 0.2, None, None, 0.0) for i in range(3)]
    out = _smooth_centers(raw, sample_fps=5)
    assert all(c["cx"] == 0.5 and c["cy"] == 0.5 and c["conf"] == 0.0 for c in out)


def test_smooth_centers_suppresses_single_impulse():
    raw = [_raw(i * 0.2, 0.5, 0.5) for i in range(8)]
    raw[4] = _raw(0.8, 0.9, 0.5)  # one off-center spike
    out = _smooth_centers(raw, sample_fps=5)
    assert 0.5 < out[4]["cx"] < 0.8  # attenuated, not snapped to 0.9


def test_smooth_centers_singleton_is_identity():
    out = _smooth_centers([_raw(0.0, 0.3, 0.7)], sample_fps=5)
    assert out == [{"t": 0.0, "cx": 0.3, "cy": 0.7, "conf": 1.0}]


# --------------------------------------------------------------------------- #
#  Reframe stability: One-Euro filter behavior
# --------------------------------------------------------------------------- #
def test_one_euro_step_no_overshoot_and_converges():
    euro = _OneEuro2D(min_cutoff=1.0, beta=0.02, d_cutoff=1.0)
    euro.filter(0.0, 0.5, 0.0)
    vals = [euro.filter(1.0, 0.5, 0.1 * i)[0] for i in range(1, 25)]
    assert all(v <= 1.0 + 1e-9 for v in vals)  # never overshoots the step target
    assert vals[-1] > 0.9                       # converges toward it


def test_one_euro_ramp_tracks_with_bounded_lag():
    euro = _OneEuro2D(min_cutoff=1.0, beta=0.02, d_cutoff=1.0)
    out = (0.0, 0.5)
    for i in range(40):
        out = euro.filter(0.02 * i, 0.5, 0.1 * i)  # slow constant-velocity ramp
    assert abs(out[0] - 0.02 * 39) < 0.1           # follows with small lag
