"""Port of buildFilterChain() from scripts/tts/audioPostProcess.ts.

Produces the ffmpeg `-af` chain string for a voice preset's FX (pitch, rate,
speed, EQ, compression, throat/rasp/chamber/robot, volume, loudnorm). Faithful
to the Node formulas so the rendered voice matches the studio's prior output.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List


def _n(x: float) -> str:
    """JS-like number→string: 3.0→'3', 3.5→'3.5' (keeps filter args tidy)."""
    if isinstance(x, float) and x.is_integer():
        return str(int(x))
    return str(x)


def _clamp_atempo(value: float) -> List[str]:
    out: List[str] = []
    v = max(0.25, min(4.0, value))
    while v > 2.0:
        out.append("atempo=2.0")
        v /= 2.0
    while v < 0.5:
        out.append("atempo=0.5")
        v *= 2.0
    out.append(f"atempo={v:.5f}")
    return out


def _lerp(slider: float, at_zero: float, at_hundred: float) -> float:
    return at_zero + (at_hundred - at_zero) * max(0, min(100, slider)) / 100


def build_filter_chain(opts: Dict[str, Any]) -> str:
    def g(k, default=0):
        v = opts.get(k)
        return default if v is None else v

    filters: List[str] = []
    throat = g("throatDepth", 0)
    throat_pitch_offset = -_lerp(throat, 0, 4)
    pace = g("royalPace", 0)
    pace_speed_multiplier = _lerp(pace, 1.0, 0.92)

    filters.append("aresample=44100")
    total_pitch = g("pitch", 0) + throat_pitch_offset
    if abs(total_pitch) > 0.05:
        ratio = math.pow(2, total_pitch / 12)
        filters.append(f"asetrate=44100*{ratio:.6f}")
        filters.append("aresample=44100")
        filters.extend(_clamp_atempo(1 / ratio))

    rate_multiplier = 1 + (g("rate", 0) / 100)
    final_speed = max(0.5, min(2.0, g("speed", 1.0) * rate_multiplier * pace_speed_multiplier))
    if abs(final_speed - 1.0) > 0.01:
        filters.extend(_clamp_atempo(final_speed))

    eq = opts.get("eq")
    if eq == "broadcast":
        filters += ["equalizer=f=100:t=h:width=80:g=-2",
                    "equalizer=f=2500:t=h:width=600:g=3",
                    "equalizer=f=8000:t=h:width=2000:g=2"]
    elif eq == "warm":
        filters += ["equalizer=f=200:t=h:width=150:g=3",
                    "equalizer=f=1200:t=h:width=400:g=1",
                    "equalizer=f=5000:t=h:width=2000:g=-2"]
    elif eq == "dark":
        filters += ["equalizer=f=80:t=h:width=60:g=4",
                    "equalizer=f=400:t=h:width=200:g=1",
                    "equalizer=f=5000:t=h:width=3000:g=-5"]
    elif eq == "bright":
        filters += ["equalizer=f=200:t=h:width=100:g=-2",
                    "equalizer=f=4000:t=h:width=2000:g=3",
                    "equalizer=f=10000:t=h:width=3000:g=4"]
    elif eq == "thin":
        filters += ["equalizer=f=100:t=h:width=80:g=-6",
                    "equalizer=f=800:t=h:width=300:g=2"]
    elif eq == "clear":
        filters += ["equalizer=f=250:t=h:width=100:g=-1",
                    "equalizer=f=3000:t=h:width=500:g=2"]
    elif eq == "velvet":
        filters += ["equalizer=f=120:t=h:width=80:g=4",
                    "equalizer=f=400:t=h:width=200:g=1",
                    "equalizer=f=2700:t=h:width=600:g=2",
                    "equalizer=f=6000:t=h:width=3000:g=-3"]

    filters.append("acompressor=threshold=-18dB:ratio=4:attack=5:release=50:makeup=3dB")

    if throat > 1:
        filters.append(f"equalizer=f=180:t=h:width=120:g={_lerp(throat,0,6):.2f}")
        filters.append(f"bass=g={_lerp(throat,0,4):.2f}")
        filters.append(f"treble=g=-{_lerp(throat,0,2.5):.2f}")

    rasp = g("ancientRasp", 0)
    if rasp > 1:
        filters.append(f"equalizer=f=2200:t=h:width=900:g={_lerp(rasp,0,4.5):.2f}")
        filters.append(f"equalizer=f=10000:t=h:width=3000:g=-{_lerp(rasp,0,2.0):.2f}")
        filters.append(
            f"acompressor=threshold=-22dB:ratio=2.2:attack=8:release=120:"
            f"knee={_lerp(rasp,8,1):.1f}:makeup={_lerp(rasp,0,2.5):.1f}dB"
        )

    volume = g("volume", 0)
    if abs(volume) > 0.1:
        filters.append(f"volume={'+' if volume > 0 else ''}{_n(volume)}dB")

    intensity = g("intensity", 0)
    if opts.get("reverb") and intensity > 5:
        wet = intensity / 100 * 0.45
        decay = 0.1 + intensity / 100 * 0.5
        filters.append(f"aecho=0.85:{wet:.3f}:55:{decay:.3f}")

    chamber = g("chamberSpace", 0)
    if chamber > 1:
        filters.append(f"aecho=0.8:{_lerp(chamber,0,0.32):.3f}:35|55:0.18|0.14")
        if chamber > 30:
            tail_wet = _lerp(chamber, 0, 0.28)
            tail_decay = _lerp(chamber, 0.15, 0.42)
            filters.append(
                f"aecho=0.7:{tail_wet:.3f}:120|180|240:"
                f"{tail_decay:.3f}|{tail_decay:.3f}|{tail_decay:.3f}"
            )

    if opts.get("robot"):
        ri = intensity / 100
        in_gain = 0.4 + ri * 0.3
        out_gain = 0.6 + ri * 0.3
        filters.append(f"chorus={in_gain:.2f}:{out_gain:.2f}:45|55:0.4|0.32:0.25|0.4:2|1.5")

    filters.append("loudnorm=I=-16:LRA=11:TP=-1.5")
    return ",".join(filters)
