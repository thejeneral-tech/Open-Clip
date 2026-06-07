"""Isolated subprocess worker for Whisper transcription.

Run as:  python -m app.whisper_worker --audio AUDIO --model base --out OUT.json

It runs openai-whisper in its OWN process so that any native crash (a bad
CPU-extension wheel, an out-of-memory, etc.) cannot take down the main server
— the parent simply sees a non-zero exit code and degrades gracefully.
"""
from __future__ import annotations

import argparse
import json
import sys


def _eprint(*a):
    print(*a, file=sys.stderr, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", default=None)
    ap.add_argument("--model", default="base")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--language", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--download-only", action="store_true")
    args = ap.parse_args()

    # Ensure a binary named `ffmpeg` is on PATH (openai-whisper calls it by name).
    try:
        from .ffmpeg_utils import ensure_ffmpeg_on_path
        ensure_ffmpeg_on_path()
    except Exception as e:  # noqa: BLE001
        _eprint(f"ffmpeg setup warning: {e}")

    try:
        import whisper
    except Exception as e:  # noqa: BLE001
        _eprint(f"openai-whisper is not installed: {e}")
        return 3

    _eprint(f"Loading Whisper model '{args.model}' on {args.device}...")
    model = whisper.load_model(args.model, device=args.device)

    if args.download_only:
        _eprint("Model ready.")
        print("ok")
        return 0

    if not args.audio:
        _eprint("No --audio provided.")
        return 2

    _eprint("Transcribing...")
    result = model.transcribe(
        args.audio,
        language=args.language,
        fp16=False,
        verbose=False,
    )

    segments = []
    for s in result.get("segments", []):
        text = " ".join((s.get("text") or "").split())
        if not text:
            continue
        start = float(s.get("start", 0.0))
        end = float(s.get("end", start))
        segments.append({"start": round(start, 2),
                         "duration": round(max(0.0, end - start), 2),
                         "text": text})

    out = {
        "source": "whisper",
        "language": result.get("language"),
        "segments": segments,
        "full_text": " ".join(x["text"] for x in segments),
    }
    payload = json.dumps(out, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(payload)
        _eprint(f"Wrote {len(segments)} segments to {args.out}")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
