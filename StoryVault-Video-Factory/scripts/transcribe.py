#!/usr/bin/env python
"""
Best-effort speech-to-text for a reference voice clip, used by the Voice Lab's
"Upload & Convert" auto-transcribe. Uses faster-whisper (CTranslate2 backend, no
PyTorch), which it auto-installs on first run along with a small model. Prints the
transcript (first <maxWords> words) to STDOUT; all logs/progress go to STDERR.

Usage: python transcribe.py <audio.wav> [maxWords]
"""
import sys
import subprocess


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def ensure_pkg():
    try:
        import faster_whisper  # noqa: F401
        return
    except ImportError:
        log("Installing faster-whisper (one-time)...")
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-q", "--disable-pip-version-check", "faster-whisper"],
            stdout=sys.stderr, stderr=sys.stderr, check=True,
        )


def main():
    if len(sys.argv) < 2:
        log("usage: transcribe.py <audio> [maxWords]")
        sys.exit(2)
    audio = sys.argv[1]
    maxw = int(sys.argv[2]) if len(sys.argv) > 2 else 80

    ensure_pkg()
    from faster_whisper import WhisperModel

    # 'base' (~145 MB) balances speed/accuracy; int8 on CPU keeps it light.
    log("Loading whisper model (downloads on first use)...")
    model = WhisperModel("base", device="cpu", compute_type="int8")

    log("Transcribing...")
    segments, _info = model.transcribe(audio, beam_size=1, vad_filter=True)

    words = []
    for seg in segments:
        for w in seg.text.strip().split():
            words.append(w)
            if len(words) >= maxw:
                break
        if len(words) >= maxw:
            break

    sys.stdout.write(" ".join(words[:maxw]))
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        log("pip install failed:", e)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        log("transcribe error:", e)
        sys.exit(1)
