#!/usr/bin/env bash
# ============================================================================
# StoryVault — Fish Speech (s2.cpp) GPU server for Linux + NVIDIA.
#
# Builds s2.cpp with CUDA, downloads the GGUF model once, and runs the
# persistent `s2 --server` that StoryVault talks to over HTTP. This is the
# only realistic way to hit 100-1000 videos/day: the model stays resident on
# the GPU and synthesis runs at ~realtime instead of ~25x realtime on CPU.
#
#   Quick start:   ./scripts/fish-server.sh            # build (first run) + serve
#                  ./scripts/fish-server.sh serve      # just serve (already built)
#                  ./scripts/fish-server.sh build      # just build
#
# Wire StoryVault to it (see docs/FISH_SERVER_LINUX.md):
#   - StoryVault on a DIFFERENT machine:  set FISH_TTS_URL=http://<this-host>:8080
#   - StoryVault on THIS machine:         set FISH_GPU=cuda   (it auto-starts s2)
# ============================================================================
set -euo pipefail

# ---- Config (override via env) ---------------------------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="${FISH_ENGINE_DIR:-$ROOT/data/models/s2.cpp}"
MODEL_DIR="${FISH_MODEL_DIR:-$ROOT/data/models/s2-pro-gguf}"
REPO_URL="https://github.com/rodrigomatta/s2.cpp.git"
HF_REPO="rodrigomt/s2-pro-gguf"
QUANT="${FISH_QUANT:-q8_0}"          # 32GB VRAM => q8_0 (best quality, ~9GB). q4_k_m is smaller/faster.
HOST="${FISH_HOST:-0.0.0.0}"          # 0.0.0.0 = reachable from other machines on the LAN
PORT="${FISH_PORT:-8080}"
CUDA_DEVICE="${FISH_GPU_DEVICE:-0}"
GPU_LAYERS="${FISH_GPU_LAYERS:--1}"   # -1 = offload all layers that fit
PYTHON="${PYTHON_PATH:-python3}"
BIN="$ENGINE_DIR/build/s2"
GGUF="$MODEL_DIR/s2-pro-$QUANT.gguf"
TOK="$MODEL_DIR/tokenizer.json"

log() { printf '\033[1;36m[fish-server]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[fish-server] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

build() {
  command -v git   >/dev/null || die "git not found. Install: sudo apt-get install -y git"
  command -v cmake >/dev/null || die "cmake not found. Install: sudo apt-get install -y cmake build-essential"
  command -v nvcc  >/dev/null || die "CUDA toolkit (nvcc) not found. Install CUDA >= 12.4 and ensure nvcc is on PATH."
  command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || log "warn: nvidia-smi missing (driver?)"

  if [ ! -f "$ENGINE_DIR/CMakeLists.txt" ]; then
    log "Cloning s2.cpp -> $ENGINE_DIR"
    git clone --recurse-submodules "$REPO_URL" "$ENGINE_DIR"
  else
    log "Updating s2.cpp"
    git -C "$ENGINE_DIR" pull --recurse-submodules || true
  fi

  log "Configuring (CUDA on)…"
  cmake -S "$ENGINE_DIR" -B "$ENGINE_DIR/build" -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON
  log "Building (this takes a while on first run)…"
  cmake --build "$ENGINE_DIR/build" --config Release -j"$(nproc)"
  [ -f "$BIN" ] || BIN="$(find "$ENGINE_DIR/build" -name s2 -type f -perm -u+x | head -n1)"
  [ -n "${BIN:-}" ] && [ -f "$BIN" ] || die "Build finished but the s2 binary was not found under $ENGINE_DIR/build."
  log "Built: $BIN"
}

fetch_model() {
  if [ -f "$GGUF" ] && [ -f "$TOK" ]; then log "Model present: $(basename "$GGUF") + tokenizer.json"; return; fi
  command -v "$PYTHON" >/dev/null || die "$PYTHON not found — needed to download the model."
  "$PYTHON" -c 'import huggingface_hub' 2>/dev/null || { log "Installing huggingface_hub…"; "$PYTHON" -m pip install -U "huggingface_hub[hf_xet]"; }
  mkdir -p "$MODEL_DIR"
  log "Downloading $HF_REPO  (quant $QUANT + tokenizer) -> $MODEL_DIR"
  "$PYTHON" - "$HF_REPO" "$MODEL_DIR" "$QUANT" <<'PY'
import sys
from huggingface_hub import snapshot_download
repo, out, quant = sys.argv[1], sys.argv[2], sys.argv[3]
snapshot_download(repo_id=repo, local_dir=out,
                  allow_patterns=[f"*{quant}.gguf", "tokenizer.json", "LICENSE.md"])
print("model ready")
PY
}

serve() {
  [ -f "$BIN" ]  || die "s2 binary missing ($BIN). Run: $0 build"
  [ -f "$GGUF" ] || die "model missing ($GGUF). Run: $0 build  (or set FISH_QUANT to a downloaded quant)"
  log "Serving on http://$HOST:$PORT  (cuda:$CUDA_DEVICE, gpu-layers $GPU_LAYERS, $(basename "$GGUF"))"
  log "Health check from another box:  curl -s -o /dev/null -w '%{http_code}\\n' http://<this-host>:$PORT/"
  exec "$BIN" --server \
    --model "$GGUF" --tokenizer "$TOK" \
    --host "$HOST" --port "$PORT" \
    --cuda "$CUDA_DEVICE" --gpu-layers "$GPU_LAYERS"
}

case "${1:-all}" in
  build) build ;;
  model) fetch_model ;;
  serve) serve ;;
  all)   build; fetch_model; serve ;;
  *)     die "usage: $0 [build|model|serve|all]" ;;
esac
