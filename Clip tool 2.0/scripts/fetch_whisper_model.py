"""One-off: (re)download the faster-whisper large-v3 model into the HF cache.

Run with the backend venv:
    backend\.venv\Scripts\python.exe scripts\fetch_whisper_model.py

This machine's IPv6 route to huggingface.co is broken (TLS handshakes get
reset with WinError 10054), while IPv4 works fine. DNS hands out IPv6 first,
so we force IPv4-only resolution for this process to make the download
reliable. Resumable: re-run if it ever stops and it keeps what it has.
"""
import os
import socket
import sys

# --- Force IPv4: filter all DNS resolution to A records only. -------------
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_only(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _ipv4_only
# --------------------------------------------------------------------------

os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")

from faster_whisper.utils import download_model

# Model alias may be passed as the first CLI arg; defaults to large-v3.
MODEL = sys.argv[1] if len(sys.argv) > 1 else "large-v3"

print(f"Downloading faster-whisper '{MODEL}' over IPv4 ...", flush=True)
path = download_model(MODEL)
print(f"DONE. Model cached at:\n{path}", flush=True)

bin_path = os.path.join(path, "model.bin")
size = os.path.getsize(bin_path)
print(f"model.bin = {size:,} bytes ({size / 1e9:.2f} GB)", flush=True)
if size < 1_000_000:
    print("WARNING: model.bin looks too small — download may be incomplete.", flush=True)
    sys.exit(1)
print("OK", flush=True)
