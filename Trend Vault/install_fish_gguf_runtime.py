#!/usr/bin/env python3
"""
install_fish_gguf_runtime.py
════════════════════════════
Cross-platform setup / validation for the Fish Speech S2 Pro **GGUF** runtime
(the compiled s2.cpp + GGML server — NOT the Python Fish Speech API).

What this script DOES:
  • Detects the platform (Windows vs Linux/macOS) and uses the right paths.
  • Locates the install root (FISH_GGUF_ROOT env, else a platform default).
  • Validates the compiled s2 binary and its ggml shared libraries.
  • Validates the GGUF transformer model, the codec GGUF, and tokenizer.json.
  • Creates missing *runtime* folders (logs/, models dir) — never weights.
  • Optionally creates a Python venv and installs requirements.txt IF one
    exists in the root (the GGUF server itself needs no Python deps).
  • Optionally runs `npm install` IF a package.json exists in the root.
  • Prints a clear, step-by-step install log and a final summary.

What this script does NOT do:
  • It never downloads models (no "random model downloads").
  • It never compiles s2.cpp from source (that needs cmake + a C++ toolchain).
    If the binary is missing it prints exact build instructions instead.
  • It never touches Kokoro or any other engine.

Usage:
  python install_fish_gguf_runtime.py            # validate + set up folders/venv
  python install_fish_gguf_runtime.py --check    # validate only, change nothing
  python install_fish_gguf_runtime.py --root D:\fish-speech
  python install_fish_gguf_runtime.py --with-venv   # force venv creation

Defaults (override with FISH_GGUF_ROOT):
  Windows : C:\\fish-speech
  Linux   : /shared/fish-speech
"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

IS_WINDOWS = (platform.system() == "Windows")

# Make stdout/stderr UTF-8 so the install log never crashes on a legacy
# Windows code page (cp1252). Best-effort — ignored on Python < 3.7.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:
        pass

_BAR = "=" * 60

# ── Pretty logging ────────────────────────────────────────────────────────
# ANSI colors (auto-disabled when not a TTY or on legacy Windows consoles).
_USE_COLOR = sys.stdout.isatty() and not (IS_WINDOWS and not os.environ.get("WT_SESSION"))


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _USE_COLOR else text


def log_step(msg: str) -> None:   print(_c("36", f"\n=== {msg} ==="))
def log_ok(msg: str) -> None:     print(_c("32", f"  [OK]   {msg}"))
def log_warn(msg: str) -> None:   print(_c("33", f"  [WARN] {msg}"))
def log_err(msg: str) -> None:    print(_c("31", f"  [FAIL] {msg}"))
def log_info(msg: str) -> None:   print(f"  [..]   {msg}")
def log_fix(msg: str) -> None:    print(_c("33", f"         fix: {msg}"))


# ── Path layout ───────────────────────────────────────────────────────────
def default_root() -> str:
    return r"C:\fish-speech" if IS_WINDOWS else "/shared/fish-speech"


class Layout:
    """Resolves every path relative to the install root for this platform."""

    def __init__(self, root: str):
        self.root = Path(root)
        self.bin_dir = self.root / "build" / "s2.cpp" / "cmake-build"
        self.binary = self.bin_dir / ("s2.exe" if IS_WINDOWS else "s2")
        self.model_dir = self.root / "models" / "s2-pro-gguf"
        self.transformer = self.model_dir / "s2-pro-q4_k_m-transformer-only.gguf"
        self.codec_q4 = self.model_dir / "s2-pro-q4_k_m-codec-only.gguf"
        self.codec_f16 = self.model_dir / "s2-pro-f16-codec-only.gguf"
        self.tokenizer = self.root / "tokenizer.json"
        self.logs_dir = self.root / "logs"
        self.venv_dir = self.root / ".venv"
        self.requirements = self.root / "requirements.txt"
        self.package_json = self.root / "package.json"

    @property
    def codec(self) -> Path:
        """Preferred codec GGUF: q4 if present, else f16."""
        if self.codec_q4.exists():
            return self.codec_q4
        if self.codec_f16.exists():
            return self.codec_f16
        return self.codec_q4  # report the expected name when neither exists


# ── Validation helpers ──────────────────────────────────────────────────────
def _mb(path: Path) -> float:
    try:
        return path.stat().st_size / 1024 / 1024
    except OSError:
        return 0.0


def find_ggml_libs(bin_dir: Path) -> list[Path]:
    """Return ggml shared libraries next to the binary (dll on Win, so on Linux)."""
    libs: list[Path] = []
    search_dirs = [bin_dir, bin_dir / "bin"]
    pattern = "ggml*.dll" if IS_WINDOWS else "libggml*.so"
    for d in search_dirs:
        if d.is_dir():
            libs.extend(d.glob(pattern))
    return libs


# ── Validation steps. Each returns True/False and logs its own status. ──────
def check_binary(lo: Layout) -> bool:
    log_step("Runtime binary (s2.cpp / GGML server)")
    if lo.binary.exists():
        log_ok(f"binary found: {lo.binary} ({_mb(lo.binary):.1f} MB)")
        libs = find_ggml_libs(lo.bin_dir)
        if libs:
            log_ok(f"ggml libraries found: {len(libs)} ({', '.join(l.name for l in libs[:4])})")
        else:
            log_warn("no ggml shared libraries found next to the binary")
            log_fix(f"expected {'ggml*.dll' if IS_WINDOWS else 'libggml*.so'} in {lo.bin_dir} or {lo.bin_dir / 'bin'}")
        return True
    log_err(f"server binary NOT found: {lo.binary}")
    if IS_WINDOWS:
        log_fix("build s2.cpp: open 'x64 Native Tools' prompt, cd into build\\s2.cpp, then "
                "cmake -B cmake-build -DCMAKE_BUILD_TYPE=Release && cmake --build cmake-build --config Release")
    else:
        log_fix("build s2.cpp: cd build/s2.cpp && cmake -B cmake-build -DCMAKE_BUILD_TYPE=Release && "
                "cmake --build cmake-build -j")
    return False


def check_transformer(lo: Layout) -> bool:
    log_step("GGUF transformer model")
    if not lo.model_dir.exists():
        log_err(f"model folder NOT found: {lo.model_dir}")
        log_fix(f"place the GGUF model files under {lo.model_dir}")
        return False
    if lo.transformer.exists() and _mb(lo.transformer) > 100:
        log_ok(f"transformer GGUF found: {lo.transformer.name} ({_mb(lo.transformer):.0f} MB)")
        return True
    if lo.transformer.exists():
        log_err(f"transformer GGUF too small ({_mb(lo.transformer):.0f} MB) — partial download: {lo.transformer}")
    else:
        log_err(f"transformer GGUF NOT found: {lo.transformer}")
    log_fix(f"place s2-pro-q4_k_m-transformer-only.gguf in {lo.model_dir} (no auto-download)")
    return False


def check_codec(lo: Layout) -> bool:
    log_step("GGUF codec model")
    codec = lo.codec
    if codec.exists() and _mb(codec) > 40:
        log_ok(f"codec GGUF found: {codec.name} ({_mb(codec):.0f} MB)")
        return True
    if codec.exists():
        log_err(f"codec GGUF too small ({_mb(codec):.0f} MB) — partial download: {codec}")
    else:
        log_err(f"codec GGUF NOT found: {lo.codec_q4} (or {lo.codec_f16.name})")
    log_fix(f"place s2-pro-q4_k_m-codec-only.gguf (or the f16 codec) in {lo.model_dir}")
    return False


def check_tokenizer(lo: Layout) -> bool:
    log_step("Tokenizer")
    if lo.tokenizer.exists():
        log_ok(f"tokenizer found: {lo.tokenizer}")
        return True
    log_err(f"tokenizer.json NOT found: {lo.tokenizer}")
    log_fix(f"place tokenizer.json in {lo.root}")
    return False


def ensure_folders(lo: Layout, check_only: bool) -> None:
    log_step("Runtime folders")
    for d in (lo.logs_dir, lo.model_dir):
        if d.exists():
            log_ok(f"exists: {d}")
        elif check_only:
            log_warn(f"missing (would create): {d}")
        else:
            try:
                d.mkdir(parents=True, exist_ok=True)
                log_ok(f"created: {d}")
            except OSError as e:
                log_err(f"could not create {d}: {e}")
                log_fix("check folder permissions or create it manually")


# ── Optional Python venv + deps (only if a requirements.txt exists) ─────────
def venv_python(lo: Layout) -> Path:
    return lo.venv_dir / ("Scripts/python.exe" if IS_WINDOWS else "bin/python")


def setup_venv(lo: Layout, force: bool, check_only: bool) -> bool:
    has_reqs = lo.requirements.exists()
    if not has_reqs and not force:
        log_step("Python venv")
        log_ok("not required — the GGUF/s2.cpp runtime is self-contained")
        return True

    log_step("Python venv + dependencies")
    if check_only:
        log_warn("venv setup skipped (--check). Would create venv and install requirements.txt")
        return True

    py = venv_python(lo)
    if not py.exists():
        log_info(f"creating venv at {lo.venv_dir}")
        try:
            subprocess.run([sys.executable, "-m", "venv", str(lo.venv_dir)], check=True)
            log_ok(f"venv created: {lo.venv_dir}")
        except (subprocess.CalledProcessError, OSError) as e:
            log_err(f"venv creation failed: {e}")
            log_fix("ensure Python 3.10+ with the venv module is installed")
            return False
    else:
        log_ok(f"venv already present: {lo.venv_dir}")

    if has_reqs:
        log_info(f"installing dependencies from {lo.requirements}")
        try:
            subprocess.run([str(py), "-m", "pip", "install", "-r", str(lo.requirements)], check=True)
            log_ok("Python dependencies installed")
        except (subprocess.CalledProcessError, OSError) as e:
            log_err(f"pip install failed: {e}")
            log_fix(f"run manually: {py} -m pip install -r {lo.requirements}")
            return False
    return True


# ── Optional Node deps (only if a package.json exists in the root) ──────────
def setup_node(lo: Layout, check_only: bool) -> bool:
    if not lo.package_json.exists():
        return True  # nothing to do — silent
    log_step("Node dependencies")
    if check_only:
        log_warn("npm install skipped (--check)")
        return True
    npm = shutil.which("npm.cmd" if IS_WINDOWS else "npm") or shutil.which("npm")
    if not npm:
        log_warn("npm not found on PATH — skipping Node dependency install")
        log_fix("install Node.js from https://nodejs.org if the runtime needs it")
        return True
    try:
        subprocess.run([npm, "install"], cwd=str(lo.root), check=True)
        log_ok("Node dependencies installed")
        return True
    except (subprocess.CalledProcessError, OSError) as e:
        log_err(f"npm install failed: {e}")
        return False


# ── Main ─────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(description="Validate / set up the Fish Speech S2 Pro GGUF runtime.")
    ap.add_argument("--root", default=os.environ.get("FISH_GGUF_ROOT", default_root()),
                    help="install root (default: FISH_GGUF_ROOT env or platform default)")
    ap.add_argument("--check", action="store_true", help="validate only — make no changes")
    ap.add_argument("--with-venv", action="store_true", help="force-create a Python venv even without requirements.txt")
    args = ap.parse_args()

    lo = Layout(args.root)

    print(_c("36", _BAR))
    print(_c("36", " Fish Speech S2 Pro - GGUF / s2.cpp runtime installer"))
    print(_c("36", _BAR))
    log_info(f"platform   : {platform.system()} ({platform.machine()})")
    log_info(f"install root: {lo.root}   (override with FISH_GGUF_ROOT)")
    log_info(f"mode       : {'CHECK ONLY (no changes)' if args.check else 'SETUP'}")

    if not lo.root.exists():
        log_err(f"install root does not exist: {lo.root}")
        log_fix("create it or pass --root / set FISH_GGUF_ROOT to your fish-speech folder")
        return 2

    # Folders first so subsequent steps have somewhere to log.
    ensure_folders(lo, args.check)

    results = {
        "binary":      check_binary(lo),
        "transformer": check_transformer(lo),
        "codec":       check_codec(lo),
        "tokenizer":   check_tokenizer(lo),
        "venv":        setup_venv(lo, args.with_venv, args.check),
        "node":        setup_node(lo, args.check),
    }

    # ── Summary ──
    log_step("Summary")
    label = {
        "binary": "Fish runtime (s2 binary)",
        "transformer": "Fish GGUF model",
        "codec": "Fish codec GGUF",
        "tokenizer": "Tokenizer",
        "venv": "Python venv",
        "node": "Node deps",
    }
    for key, ok in results.items():
        (log_ok if ok else log_err)(label[key])

    core_ok = results["binary"] and results["transformer"] and results["codec"] and results["tokenizer"]
    print()
    if core_ok:
        log_ok("GGUF runtime is ready. Start the server from the Voice Preset panel "
               "(Start Fish Speech) or with the start script.")
        log_info(f"server will listen on http://127.0.0.1:8080  (POST /v1/tts)")
        return 0
    log_err("GGUF runtime is NOT ready — resolve the items marked [FAIL] above.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
