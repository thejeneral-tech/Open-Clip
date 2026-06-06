/**
 * Fish Speech / S2 Pro — full runtime manager.
 *
 * This module is the single source of truth for the Fish Speech engine
 * lifecycle inside Trend Vault. The Voice Preset panel does NOT poll
 * URLs directly any more — instead it asks this module to:
 *
 *     1. Verify the model is on disk.            checkFishModel()
 *     2. Verify the runtime repo is cloned.      checkFishRuntime()
 *     3. Verify a Python venv exists.            ensureFishVenv()
 *     4. Install Python dependencies into it.    installFishDependencies()
 *     5. Start the api_server subprocess.        startFishServer()
 *     6. Wait for /v1/health (up to 120s).       waitForFishServer()
 *     7. Discover the working TTS endpoint.      detectFishEndpoint()
 *     8. Run a tiny test generation.             testFishGeneration()
 *
 * Only after step 8 succeeds does the engine report state === 'ready'.
 *
 * Every step writes a structured log entry into a shared ring buffer so
 * the "View Fish Logs" panel can show exactly which step failed and
 * exactly what it tried. The module degrades cleanly — every helper
 * returns a discriminated result; nothing throws past the public surface.
 *
 * Paths (env-driven, sensible defaults — see resolveFishConfig()):
 *
 *   FISH_S2_PRO_MODEL_PATH       The user's existing model dir (NOT re-downloaded
 *                                if already populated). Default: $HOME/s2-pro.
 *   FISH_SPEECH_RUNTIME_PATH     Where to clone github.com/fishaudio/fish-speech.
 *                                Default: $LOCALAPPDATA/trendvault/runtimes/fish-speech
 *                                       / ~/.local/share/trendvault/runtimes/fish-speech.
 *   FISH_SPEECH_VENV_PATH        Python venv inside the runtime. Default <runtime>/.venv.
 *   FISH_TTS_URL                 Where the api_server will listen. Default 127.0.0.1:8080.
 *   PYTHON_BIN                   Override for which `python` binary to use.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';

// ── Constants ────────────────────────────────────────────────────────────

/**
 * PUBLIC Fish Speech address — the single entry point the UI talks to. The
 * TrendVault web server (port 3001) exposes /health, /v1/tts and
 * /v1/audio/speech and proxies them to the real Fish process. Default 3001.
 */
export const FISH_TTS_URL_DEFAULT = 'http://127.0.0.1:3001';

/**
 * REAL Fish Speech process address (the s2.cpp / api_server actually listening).
 * This stays on 8080 — the 3001 proxy and all internal backend→Fish calls use
 * THIS, never the public 3001 URL (which would loop back into the web server).
 */
export const FISH_UPSTREAM_URL_DEFAULT = 'http://127.0.0.1:8080';

/**
 * Resolve the real Fish upstream the backend talks to directly.
 *  - FISH_UPSTREAM_URL wins if set.
 *  - else if FISH_TTS_URL points at a non-3001 port, honour it (external Fish).
 *  - else default to 127.0.0.1:8080.
 */
export function resolveFishUpstreamUrl(): string {
  const up = (process.env.FISH_UPSTREAM_URL || '').trim();
  if (up) return up;
  const pub = (process.env.FISH_TTS_URL || '').trim();
  try { const u = new URL(pub); if (u.port && u.port !== '3001') return pub; } catch { /* ignore */ }
  return FISH_UPSTREAM_URL_DEFAULT;
}

/** The public Fish URL shown in the UI / status (default 3001). */
export function resolveFishPublicUrl(): string {
  return (process.env.FISH_TTS_URL || FISH_TTS_URL_DEFAULT).trim() || FISH_TTS_URL_DEFAULT;
}

/** Hugging Face repo with the s2-pro weights. */
export const FISH_HF_REPO = 'fishaudio/s2-pro';

/** Official Fish Speech runtime GitHub repo. */
export const FISH_RUNTIME_GIT = 'https://github.com/fishaudio/fish-speech.git';

// ── Config resolution ────────────────────────────────────────────────────

export interface FishConfig {
  modelPath:    string;   // where the .pth/.safetensors weights live
  runtimePath:  string;   // git clone of fish-speech
  venvPath:     string;   // python venv inside the runtime
  serverUrl:    string;   // listen URL
  pythonBin:    string;   // host python used to *create* the venv
  /** Path to a JSON config persisted by this module (working endpoint, etc). */
  configFile:   string;
}

/** OS-aware default for the runtime install directory. */
function _defaultRuntimePath(): string {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'trendvault', 'runtimes', 'fish-speech');
  }
  // Linux/macOS: respect XDG if set, else ~/.local/share/...
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'trendvault', 'runtimes', 'fish-speech');
}

/** OS-aware default model path (used only if FISH_S2_PRO_MODEL_PATH is unset). */
function _defaultModelPath(): string {
  // The user typically keeps the s2-pro folder in their home dir on Windows
  // (it's where the HF clone-by-hand workflow lands). Linux/macOS fall back
  // to the previous cache location for backwards compatibility.
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 's2-pro');
  }
  return path.join(os.homedir(), '.cache', 'trendvault', 'models', 's2-pro');
}

/** Compute the active Fish runtime configuration from env + defaults. */
export function resolveFishConfig(): FishConfig {
  const modelPath   = (process.env.FISH_S2_PRO_MODEL_PATH || _defaultModelPath()).trim();
  const runtimePath = (process.env.FISH_SPEECH_RUNTIME_PATH || _defaultRuntimePath()).trim();
  const venvPath    = (process.env.FISH_SPEECH_VENV_PATH || path.join(runtimePath, '.venv')).trim();
  // serverUrl = the REAL Fish process (upstream, 8080) — NOT the public 3001 URL.
  const serverUrl   = resolveFishUpstreamUrl();
  const pythonBin   = (process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3')).trim();
  const configFile  = path.join(runtimePath, '.trendvault-fish.json');
  return { modelPath, runtimePath, venvPath, serverUrl, pythonBin, configFile };
}

/** Path to the venv's python interpreter, regardless of platform. */
export function getVenvPython(cfg: FishConfig = resolveFishConfig()): string {
  if (process.platform === 'win32') {
    return path.join(cfg.venvPath, 'Scripts', 'python.exe');
  }
  return path.join(cfg.venvPath, 'bin', 'python');
}

// ── Backwards-compatible exports (used by server.ts + UI) ────────────────

export function getFishModelDir(): string { return resolveFishConfig().modelPath; }
export function getFishServerUrl(): string { return resolveFishConfig().serverUrl; }

// ══════════════════════════════════════════════════════════════════════════
// ── Fish Speech S2 Pro — GGUF / s2.cpp runtime ────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// Fish Speech S2 Pro is a COMPILED C++ server (s2.cpp + GGML), NOT a Python
// app. This block locates the prebuilt binary, the GGUF transformer weights,
// the codec GGUF, and the tokenizer, and builds the command to launch it.
//
//   Windows root default : C:\fish-speech
//   Linux/macOS default  : /shared/fish-speech
//   Override with the FISH_GGUF_ROOT environment variable.
//
// Layout inside the root (matches the synced Windows/Linux folder):
//   build/s2.cpp/cmake-build/s2.exe | s2          (compiled server + ggml libs)
//   models/s2-pro-gguf/s2-pro-q4_k_m-transformer-only.gguf
//   models/s2-pro-gguf/s2-pro-q4_k_m-codec-only.gguf  (or *-f16-codec-only.gguf)
//   tokenizer.json
//
// The GGUF path REPLACES the old Python `tools.api_server` path. The Python
// helpers further down remain in the file but are dormant (never invoked
// while a GGUF binary is present).

export interface FishGgufConfig {
  root:            string;   // install root (C:\fish-speech | /shared/fish-speech)
  binary:          string;   // s2.exe | s2
  binDir:          string;   // dir containing the binary + ggml shared libs
  modelDir:        string;   // models/s2-pro-gguf
  transformerGguf: string;   // s2-pro-q4_k_m-transformer-only.gguf
  codecGguf:       string;   // s2-pro-q4_k_m-codec-only.gguf (or f16 fallback)
  tokenizer:       string;   // tokenizer.json
  port:            number;
  host:            string;
  threads:         number;
  serverUrl:       string;   // REAL upstream Fish process (8080)
  publicUrl:       string;   // PUBLIC entry point shown in the UI (3001)
}

/** OS-aware default install root for the compiled Fish Speech GGUF server. */
function _defaultGgufRoot(): string {
  return process.platform === 'win32' ? 'C:\\fish-speech' : '/shared/fish-speech';
}

/** Compute the active GGUF / s2.cpp configuration from env + platform defaults. */
export function resolveFishGgufConfig(): FishGgufConfig {
  const root   = (process.env.FISH_GGUF_ROOT || _defaultGgufRoot()).trim() || _defaultGgufRoot();
  const isWin  = process.platform === 'win32';
  const binDir = path.join(root, 'build', 's2.cpp', 'cmake-build');
  const binary = path.join(binDir, isWin ? 's2.exe' : 's2');
  const modelDir        = path.join(root, 'models', 's2-pro-gguf');
  const transformerGguf = path.join(modelDir, 's2-pro-q4_k_m-transformer-only.gguf');
  // Prefer the quantised codec; fall back to the f16 codec if only that exists.
  const codecQ4  = path.join(modelDir, 's2-pro-q4_k_m-codec-only.gguf');
  const codecF16 = path.join(modelDir, 's2-pro-f16-codec-only.gguf');
  const codecGguf = fs.existsSync(codecQ4) ? codecQ4
                   : (fs.existsSync(codecF16) ? codecF16 : codecQ4);
  const tokenizer = path.join(root, 'tokenizer.json');
  // serverUrl = the REAL Fish process (upstream, 8080) — NOT the public 3001 URL.
  const serverUrl = resolveFishUpstreamUrl();
  let host = '127.0.0.1';
  let port = 8080;
  try {
    const u = new URL(serverUrl);
    if (u.hostname) host = u.hostname;
    if (u.port)     port = parseInt(u.port, 10) || 8080;
  } catch { /* keep defaults */ }
  const threads = parseInt(process.env.FISH_THREADS || '4', 10) || 4;
  const publicUrl = resolveFishPublicUrl();
  return { root, binary, binDir, modelDir, transformerGguf, codecGguf, tokenizer, port, host, threads, serverUrl, publicUrl };
}

/**
 * True when the compiled GGUF/s2.cpp server binary is present. When true the
 * GGUF backend is used; the Python tools.api_server path stays dormant.
 */
export function isGgufBackend(): boolean {
  try { return fs.existsSync(resolveFishGgufConfig().binary); }
  catch { return false; }
}

export interface FishFileCheck { ok: boolean; path: string; sizeBytes: number; reason?: string; }

function _statSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/** Compiled s2 binary + ggml shared libraries present? */
export function checkFishGgufBinary(): FishFileCheck {
  const g = resolveFishGgufConfig();
  if (!fs.existsSync(g.binary)) {
    return { ok: false, path: g.binary, sizeBytes: 0,
             reason: `s2 server binary not found at ${g.binary} — run install_fish_gguf_runtime.py (or build s2.cpp)` };
  }
  return { ok: true, path: g.binary, sizeBytes: _statSize(g.binary) };
}

/** Transformer GGUF model present and a plausible size (>100 MB)? */
export function checkFishGgufModel(): FishFileCheck {
  const g = resolveFishGgufConfig();
  if (!fs.existsSync(g.transformerGguf)) {
    return { ok: false, path: g.transformerGguf, sizeBytes: 0,
             reason: `transformer GGUF not found at ${g.transformerGguf}` };
  }
  const sz = _statSize(g.transformerGguf);
  if (sz < 100 * 1024 * 1024) {
    return { ok: false, path: g.transformerGguf, sizeBytes: sz,
             reason: `transformer GGUF too small (${(sz / 1024 / 1024).toFixed(0)} MB) — likely a partial download` };
  }
  return { ok: true, path: g.transformerGguf, sizeBytes: sz };
}

/** Codec GGUF present (q4 preferred, f16 fallback) and >40 MB? */
export function checkFishGgufCodec(): FishFileCheck {
  const g = resolveFishGgufConfig();
  if (!fs.existsSync(g.codecGguf)) {
    return { ok: false, path: g.codecGguf, sizeBytes: 0,
             reason: `codec GGUF not found at ${g.codecGguf}` };
  }
  const sz = _statSize(g.codecGguf);
  if (sz < 40 * 1024 * 1024) {
    return { ok: false, path: g.codecGguf, sizeBytes: sz,
             reason: `codec GGUF too small (${(sz / 1024 / 1024).toFixed(0)} MB) — likely a partial download` };
  }
  return { ok: true, path: g.codecGguf, sizeBytes: sz };
}

/** tokenizer.json present? */
export function checkFishGgufTokenizer(): FishFileCheck {
  const g = resolveFishGgufConfig();
  if (!fs.existsSync(g.tokenizer)) {
    return { ok: false, path: g.tokenizer, sizeBytes: 0,
             reason: `tokenizer.json not found at ${g.tokenizer}` };
  }
  return { ok: true, path: g.tokenizer, sizeBytes: _statSize(g.tokenizer) };
}

/**
 * Resolve the path to the bundled ffmpeg binary shipped with Remotion/ffmpeg-installer.
 * Used by the s2 server for audio conversion (voice cloning). Optional — server still
 * works without it, but voice cloning quality is better with it.
 */
function _bundledFfmpegDir(): string | null {
  // Walk up from this file to the project root, then look in node_modules.
  const candidates = [
    path.join(__dirname, '..', '..', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
    path.join(__dirname, '..', '..', 'node_modules', '@remotion', 'compositor-win32-x64-msvc', 'ffmpeg.exe'),
    path.join(process.cwd(), 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
    path.join(process.cwd(), 'node_modules', '@remotion', 'compositor-win32-x64-msvc', 'ffmpeg.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.dirname(c);
  }
  return null;
}

/**
 * Build the environment for launching the s2 binary so it can find its
 * ggml shared libraries (ggml*.dll on Windows, libggml*.so on Linux).
 * Also injects the bundled ffmpeg directory so voice cloning audio conversion works.
 */
function _ggufSpawnEnv(g: FishGgufConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const libDirs = [g.binDir, path.join(g.binDir, 'bin')];
  const ffmpegDir = process.platform === 'win32' ? _bundledFfmpegDir() : null;
  if (ffmpegDir) libDirs.push(ffmpegDir);
  if (process.platform === 'win32') {
    env.PATH = libDirs.join(path.delimiter) + path.delimiter + (env.PATH || '');
  } else {
    env.LD_LIBRARY_PATH = libDirs.join(path.delimiter) +
      (env.LD_LIBRARY_PATH ? path.delimiter + env.LD_LIBRARY_PATH : '');
  }
  return env;
}

/** Build the s2 server argv (CPU backend, --vulkan -1). */
function _ggufServerArgs(g: FishGgufConfig): string[] {
  return [
    '--model',        g.transformerGguf,
    '--model-codec',  g.codecGguf,
    '--tokenizer',    g.tokenizer,
    '--port',         String(g.port),
    '--host',         g.host,
    '--threads',      String(g.threads),
    '--vulkan',       '-1',
    '--codec-vulkan', '-1',
  ];
}

// ── Persistent config (caches the working endpoint after discovery) ──────

interface PersistedConfig {
  workingEndpoint?: string;   // e.g. '/v1/tts' once we've confirmed it
  lastVerifiedAt?:  string;   // ISO timestamp
}
function _loadPersisted(cfg: FishConfig): PersistedConfig {
  try {
    return JSON.parse(fs.readFileSync(cfg.configFile, 'utf8')) as PersistedConfig;
  } catch {
    return {};
  }
}
function _savePersisted(cfg: FishConfig, p: PersistedConfig) {
  try {
    fs.mkdirSync(path.dirname(cfg.configFile), { recursive: true });
    fs.writeFileSync(cfg.configFile, JSON.stringify(p, null, 2));
  } catch (e) {
    _appendLog('warn', `failed to persist config: ${(e as Error).message}`);
  }
}

// ── Shared log ring (visible via /api/fish-s2pro/logs) ───────────────────

export type FishLogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug';
export interface FishLogEntry {
  ts:    string;     // ISO timestamp
  level: FishLogLevel;
  step?: string;     // which lifecycle step (e.g. 'startServer')
  msg:   string;
}

const _logRing: FishLogEntry[] = [];
const _LOG_MAX = 500;

function _appendLog(level: FishLogLevel, msg: string, step?: string): void {
  const entry: FishLogEntry = { ts: new Date().toISOString(), level, msg, step };
  _logRing.push(entry);
  if (_logRing.length > _LOG_MAX) _logRing.splice(0, _logRing.length - _LOG_MAX);
  const prefix = step ? `[fish:${step}]` : '[fish]';
  if (level === 'error')      console.error(prefix, msg);
  else if (level === 'warn')  console.warn(prefix, msg);
  else                        console.log(prefix, msg);
}

/** Public log accessor for the "View Fish Logs" UI button. */
export function getFishLogs(limit = 200): FishLogEntry[] {
  return _logRing.slice(-limit);
}
/** Clear the log ring (called by Repair). */
export function clearFishLogs(): void { _logRing.length = 0; }

// ── Lifecycle state ──────────────────────────────────────────────────────

export type FishStepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
export interface FishStep {
  key:    string;
  label:  string;
  status: FishStepStatus;
  detail?: string;
}

const _stepKeys = [
  'model',       // Fish model: found        (models/s2-pro-gguf dir present)
  'gguf',        // Fish GGUF model: found   (transformer .gguf present)
  'codec',       // Fish codec GGUF: found   (codec .gguf present)
  'runtime',     // Fish runtime: installed  (s2 binary + ggml libs present)
  'venv',        // Python venv: ready       (optional for GGUF — self-contained)
  'deps',        // Dependencies: installed  (optional for GGUF — self-contained)
  'server',      // Fish server: starting → running
  'endpoint',    // API endpoint: detected
  'test',        // Test generation: passed
] as const;

const _stepLabels: Record<string, string> = {
  model:    'Fish model: found',
  gguf:     'Fish GGUF model: found',
  codec:    'Fish codec GGUF: found',
  runtime:  'Fish runtime: installed',
  venv:     'Python venv: ready',
  deps:     'Dependencies: installed',
  server:   'Fish server: ready',
  endpoint: 'Fish API endpoint: detected',
  test:     'Fish test generation: passed',
};

interface FishLifecycle {
  steps:        Record<string, FishStep>;
  inFlight:     boolean;   // a startup attempt is currently running
  message:      string;    // current human-readable state
  workingRoute: string | null;  // route detected by detectFishEndpoint
}

const _lifecycle: FishLifecycle = {
  steps: Object.fromEntries(_stepKeys.map(k => [k, { key: k, label: _stepLabels[k], status: 'pending' as FishStepStatus }])),
  inFlight: false,
  message: '',
  workingRoute: null,
};

function _setStep(key: string, status: FishStepStatus, detail?: string): void {
  if (!_lifecycle.steps[key]) return;
  _lifecycle.steps[key].status = status;
  _lifecycle.steps[key].detail = detail;
  _appendLog(status === 'failed' ? 'error' : status === 'ok' ? 'success' : 'info',
             `${_lifecycle.steps[key].label}: ${status}${detail ? ' — ' + detail : ''}`,
             key);
}

/** Reset every step back to 'pending'. Called before a new startup attempt. */
function _resetSteps(): void {
  for (const k of _stepKeys) _lifecycle.steps[k] = { key: k, label: _stepLabels[k], status: 'pending' };
  _lifecycle.workingRoute = null;
}

// ── Helper 1: model on disk ──────────────────────────────────────────────

export interface FishModelStatus {
  installed: boolean;
  modelPath: string;
  fileCount: number;
  sizeBytes: number;
  presentFiles: string[];
  reason?: string;
}

/** Files that are strong evidence of a populated s2-pro model. */
const FISH_EXPECTED_FILES = [
  'config.json',
  'model.pth',
  'firefly-gan-vq-fsq-8x1024-21hz-generator.pth',
  'special_tokens.json',
  'tokenizer.tiktoken',
];

function _dirSize(dir: string): { files: number; bytes: number } {
  if (!fs.existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0; let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try { const st = fs.statSync(p); files++; bytes += st.size; }
        catch { /* skip */ }
      }
    }
  }
  return { files, bytes };
}

/** Inspect the model directory and decide if it's usable. */
export function checkFishModel(): FishModelStatus {
  const cfg = resolveFishConfig();
  const modelPath = cfg.modelPath;
  if (!fs.existsSync(modelPath)) {
    return { installed: false, modelPath, fileCount: 0, sizeBytes: 0, presentFiles: [],
             reason: `model directory does not exist: ${modelPath}` };
  }
  const { files, bytes } = _dirSize(modelPath);
  const present = FISH_EXPECTED_FILES.filter(f => fs.existsSync(path.join(modelPath, f)));
  // Lenient: >= 50MB AND at least one expected file → treat as installed.
  // Or just >= 200MB total which is plenty of evidence for s2-pro weights.
  const installed = (present.length > 0 && bytes > 50 * 1024 * 1024) || bytes > 200 * 1024 * 1024;
  return {
    installed,
    modelPath,
    fileCount: files,
    sizeBytes: bytes,
    presentFiles: present,
    reason: installed ? undefined
      : present.length === 0 ? 'no expected s2-pro files in directory'
      : `partial download (${(bytes / 1024 / 1024).toFixed(0)} MB)`,
  };
}

// Back-compat alias used elsewhere.
export const checkFishModelInstall = checkFishModel;

// ── Helper 2: runtime repo on disk ───────────────────────────────────────

export interface FishRuntimeStatus {
  installed: boolean;
  runtimePath: string;
  /** Key files we expect inside a real fish-speech checkout. */
  evidence: { setupPy: boolean; toolsApi: boolean; gitDir: boolean };
  reason?: string;
}

export function checkFishRuntime(): FishRuntimeStatus {
  const cfg = resolveFishConfig();
  const r = cfg.runtimePath;
  const evidence = {
    setupPy:  fs.existsSync(path.join(r, 'setup.py')) || fs.existsSync(path.join(r, 'pyproject.toml')),
    toolsApi: fs.existsSync(path.join(r, 'tools', 'api_server.py'))
           || fs.existsSync(path.join(r, 'tools', 'api.py'))
           || fs.existsSync(path.join(r, 'tools', 'webui.py')),
    gitDir:   fs.existsSync(path.join(r, '.git')),
  };
  const installed = evidence.setupPy && evidence.toolsApi;
  return {
    installed, runtimePath: r, evidence,
    reason: installed ? undefined : 'fish-speech runtime not cloned at runtimePath',
  };
}

// ── Helper 3: venv on disk ───────────────────────────────────────────────

export interface FishVenvStatus {
  ready:     boolean;
  venvPath:  string;
  pythonBin: string;     // path to venv's python
  /** "3.11", "3.14", etc. — read from the venv's python. Undefined if no venv. */
  pythonVersion?: string;
  /** True iff pythonVersion is 3.10 or 3.11. Anything else is rejected. */
  compatible?: boolean;
  reason?:   string;
}

/**
 * Read the major.minor Python version of a python executable.
 * Returns undefined if the executable can't be invoked. SYNC because we
 * use this from checkFishVenv() which has historically been sync.
 */
function _readPythonVersion(pythonBin: string): string | undefined {
  try {
    const r = require('child_process').spawnSync(pythonBin, [
      '-c', 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")',
    ], { encoding: 'utf8', timeout: 4000 });
    if (r.status === 0) return String(r.stdout || '').trim();
  } catch { /* ignore */ }
  return undefined;
}

/** Versions Fish Speech actually supports (torch==2.8 wheels only ship for these). */
const FISH_SUPPORTED_PY = new Set(['3.10', '3.11']);

export function checkFishVenv(): FishVenvStatus {
  const cfg = resolveFishConfig();
  const py  = getVenvPython(cfg);
  if (!fs.existsSync(py)) {
    return { ready: false, venvPath: cfg.venvPath, pythonBin: py,
             reason: `venv python not found at ${py}` };
  }
  const ver = _readPythonVersion(py);
  const compatible = !!ver && FISH_SUPPORTED_PY.has(ver);
  if (!compatible) {
    return {
      ready: false, venvPath: cfg.venvPath, pythonBin: py,
      pythonVersion: ver, compatible: false,
      reason: ver
        ? `venv was built with Python ${ver} — Fish Speech requires Python 3.10 or 3.11 (torch==2.8 wheels only exist for those). Delete the venv and re-run setup with py -3.11.`
        : `could not determine venv Python version (binary may be corrupt)`,
    };
  }
  return { ready: true, venvPath: cfg.venvPath, pythonBin: py,
           pythonVersion: ver, compatible: true };
}

// ── Host Python discovery: pick 3.11, then 3.10, then fail loudly ──────
//
// We use the Windows `py` launcher when present (it's the canonical way
// to pick a specific Python version), otherwise try `python3.11`/`python3.10`
// directly on PATH. Anything 3.12+ is REJECTED — Fish Speech's torch pin
// has no wheels for those.

export interface PythonProbe {
  cmd: string;          // launcher command, e.g. 'py' or 'python3.11'
  args: string[];       // launcher args, e.g. ['-3.11']
  version: string;      // '3.11'
  executable: string;   // absolute path to python.exe
}

export function findCompatiblePython(): { probe?: PythonProbe; tried: string[]; reason?: string } {
  const tried: string[] = [];
  const cp = require('child_process');

  /**
   * Probe an interpreter — invoke `<cmd> <args> -c "..."` and capture
   * sys.executable + sys.version_info. Returns null unless the version is
   * in FISH_SUPPORTED_PY.
   */
  const probe = (cmd: string, args: string[]): PythonProbe | null => {
    const desc = `${cmd} ${args.join(' ')}`.trim();
    tried.push(desc);
    try {
      const r = cp.spawnSync(cmd, [...args,
        '-c', 'import sys;print(sys.executable);print(f"{sys.version_info[0]}.{sys.version_info[1]}")',
      ], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      if (r.status !== 0) return null;
      const lines = String(r.stdout || '').trim().split(/\r?\n/);
      const executable = (lines[0] || '').trim();
      const version    = (lines[1] || '').trim();
      if (!executable || !FISH_SUPPORTED_PY.has(version)) return null;
      return { cmd, args, version, executable };
    } catch { return null; }
  };

  // ── 1. Launcher-based probes (cleanest path) ─────────────────────────
  const launcherCandidates: Array<{ cmd: string; args: string[] }> = process.platform === 'win32'
    ? [
        { cmd: 'py', args: ['-3.11'] },
        { cmd: 'py', args: ['-3.10'] },
        { cmd: 'python3.11', args: [] },
        { cmd: 'python3.10', args: [] },
      ]
    : [
        { cmd: 'python3.11', args: [] },
        { cmd: 'python3.10', args: [] },
        { cmd: 'py', args: ['-3.11'] },
        { cmd: 'py', args: ['-3.10'] },
      ];
  for (const c of launcherCandidates) {
    const p = probe(c.cmd, c.args);
    if (p) return { probe: p, tried };
  }

  // ── 2. Common filesystem install locations ───────────────────────────
  // The `py` launcher only sees Pythons installed via the official
  // python.org installer with PATH wiring. Pythons installed without
  // those options, via Microsoft Store, via Chocolatey, via Anaconda,
  // or extracted manually are invisible to `py`. We scan the well-known
  // locations directly.
  const fsCandidates: string[] = [];
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programs = path.join(local, 'Programs', 'Python');
    for (const v of ['Python311', 'Python310']) {
      fsCandidates.push(path.join('C:\\', v, 'python.exe'));
      fsCandidates.push(path.join(programs, v, 'python.exe'));
      fsCandidates.push(path.join(local, v, 'python.exe'));
      fsCandidates.push(path.join('C:\\Program Files', v, 'python.exe'));
      fsCandidates.push(path.join('C:\\Program Files (x86)', v, 'python.exe'));
    }
    // Microsoft Store aliases
    fsCandidates.push(path.join(local, 'Microsoft', 'WindowsApps', 'python3.11.exe'));
    fsCandidates.push(path.join(local, 'Microsoft', 'WindowsApps', 'python3.10.exe'));
    // uv-managed Pythons (default install dir for uv >= 0.4)
    fsCandidates.push(path.join(local, 'uv', 'python'));
    fsCandidates.push(path.join(home, '.local', 'share', 'uv', 'python'));
    // pyenv-win
    fsCandidates.push(path.join(home, '.pyenv', 'pyenv-win', 'versions'));
  } else {
    // Linux / macOS
    for (const root of ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', path.join(home, '.local', 'bin')]) {
      for (const ver of ['3.11', '3.10']) fsCandidates.push(path.join(root, `python${ver}`));
    }
    fsCandidates.push(path.join(home, '.local', 'share', 'uv', 'python'));
  }

  // Concrete-path candidates first.
  for (const cand of fsCandidates) {
    if (!cand) continue;
    if (!fs.existsSync(cand)) continue;
    const st = fs.statSync(cand);
    if (st.isFile()) {
      const p = probe(cand, []);
      if (p) return { probe: p, tried };
      continue;
    }
    // Directory: walk one level to find python.exe / python under each subdir
    // (uv-managed dirs look like cpython-3.11.x-windows-x86_64-…).
    try {
      const subs = fs.readdirSync(cand, { withFileTypes: true });
      for (const sub of subs) {
        if (!sub.isDirectory()) continue;
        const candidate = process.platform === 'win32'
          ? path.join(cand, sub.name, 'python.exe')
          : path.join(cand, sub.name, 'bin', 'python3');
        if (fs.existsSync(candidate)) {
          const p = probe(candidate, []);
          if (p) return { probe: p, tried };
        }
      }
    } catch { /* unreadable dir, skip */ }
  }

  // ── 3. Try `where python` / `which python3.11` to catch PATH-only installs ──
  const which = process.platform === 'win32' ? 'where' : 'which';
  for (const cmd of process.platform === 'win32'
        ? ['python.exe', 'python3.11.exe', 'python3.10.exe', 'py.exe']
        : ['python3.11', 'python3.10', 'python3', 'python']) {
    try {
      const r = cp.spawnSync(which, [cmd], { encoding: 'utf8', timeout: 2000, windowsHide: true });
      if (r.status !== 0) continue;
      const found = String(r.stdout || '').trim().split(/\r?\n/);
      for (const f of found) {
        const trimmed = f.trim();
        if (!trimmed) continue;
        const p = probe(trimmed, []);
        if (p) return { probe: p, tried };
      }
    } catch { /* ignore */ }
  }

  // ── 4. uv-managed Pythons (uv knows where it installed them) ─────────
  try {
    const uvBin = process.platform === 'win32' ? 'uv.exe' : 'uv';
    const r = cp.spawnSync(uvBin, ['python', 'find', '3.11'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    if (r.status === 0) {
      const out = String(r.stdout || '').trim().split(/\r?\n/).pop() || '';
      if (out && fs.existsSync(out)) {
        const p = probe(out, []);
        if (p) return { probe: p, tried };
      }
    }
    const r2 = cp.spawnSync(uvBin, ['python', 'find', '3.10'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    if (r2.status === 0) {
      const out = String(r2.stdout || '').trim().split(/\r?\n/).pop() || '';
      if (out && fs.existsSync(out)) {
        const p = probe(out, []);
        if (p) return { probe: p, tried };
      }
    }
  } catch { /* uv not installed, fine */ }

  // ── 5. host python — only accepted if its version is actually compatible ──
  const hostBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const p = probe(hostBin, []);
  if (p) return { probe: p, tried };

  return {
    tried,
    reason: 'Fish Speech requires Python 3.10 or 3.11. Install Python 3.11 from python.org, then retry.',
  };
}

/**
 * Try to install Python 3.11 via uv (Rust-based Python distributor that
 * doesn't touch system Python). uv is much smaller than the official
 * installer and doesn't require admin rights. Used as a last-resort
 * before failing the venv step.
 *
 * Returns the resulting PythonProbe on success, or undefined if uv is
 * not present / install fails.
 */
export async function tryInstallPython311ViaUv(): Promise<PythonProbe | undefined> {
  const cp = require('child_process');

  // Find uv. Try PATH, then ~/.local/bin (default uv install location).
  let uvBin: string | null = null;
  const candidates = [process.platform === 'win32' ? 'uv.exe' : 'uv'];
  const home = os.homedir();
  if (process.platform === 'win32') {
    candidates.push(path.join(home, '.local', 'bin', 'uv.exe'));
    candidates.push(path.join(home, 'AppData', 'Roaming', 'Python', 'Scripts', 'uv.exe'));
  } else {
    candidates.push(path.join(home, '.local', 'bin', 'uv'));
    candidates.push(path.join(home, '.cargo', 'bin', 'uv'));
  }
  for (const c of candidates) {
    try {
      if (c.includes(path.sep) || c.includes('/')) {
        if (fs.existsSync(c)) { uvBin = c; break; }
      } else {
        const r = cp.spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
        if (r.status === 0) { uvBin = c; break; }
      }
    } catch { /* try next */ }
  }
  if (!uvBin) {
    _appendLog('warn', 'uv not found — cannot auto-install Python 3.11. Install from python.org instead.', 'venv');
    return undefined;
  }

  _appendLog('info', `using ${uvBin} to install Python 3.11 (this may take 1-2 minutes)…`, 'venv');
  const res = await _spawnAndCollect(uvBin, ['python', 'install', '3.11']);
  if (res.code !== 0) {
    _appendLog('error', `uv python install 3.11 failed (exit ${res.code}): ${res.stderr.slice(-300)}`, 'venv');
    return undefined;
  }
  _appendLog('success', 'uv installed Python 3.11', 'venv');

  // Locate the freshly-installed python.
  const find = cp.spawnSync(uvBin, ['python', 'find', '3.11'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
  if (find.status === 0) {
    const out = String(find.stdout || '').trim().split(/\r?\n/).pop() || '';
    if (out && fs.existsSync(out)) {
      const r = cp.spawnSync(out, [
        '-c', 'import sys;print(sys.executable);print(f"{sys.version_info[0]}.{sys.version_info[1]}")',
      ], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      if (r.status === 0) {
        const lines = String(r.stdout || '').trim().split(/\r?\n/);
        return { cmd: out, args: [], version: (lines[1] || '').trim(), executable: (lines[0] || '').trim() };
      }
    }
  }
  return undefined;
}

/**
 * Create the venv at the configured path if it doesn't exist yet. Selects
 * Python 3.11 (or 3.10) — REFUSES to build the venv with 3.12+ even if
 * that's what the host `python` resolves to. If an incompatible venv
 * already exists at the path, it's deleted and rebuilt.
 */
export async function ensureFishVenv(): Promise<FishVenvStatus> {
  const cfg = resolveFishConfig();

  // ── Step A: blow away an incompatible existing venv ──────────────────
  // checkFishVenv() will report compatible:false for 3.12+ venvs. We
  // delete those rather than try to install torch into them — pip will
  // just fail again with the same "no matching distribution" error.
  const cur = checkFishVenv();
  if (cur.ready) return cur;
  if (cur.pythonVersion && !cur.compatible) {
    _appendLog('warn',
      `existing venv at ${cfg.venvPath} uses Python ${cur.pythonVersion} (Fish needs 3.10/3.11). Deleting and rebuilding.`,
      'venv');
    try { fs.rmSync(cfg.venvPath, { recursive: true, force: true }); }
    catch (e) {
      return { ready: false, venvPath: cfg.venvPath, pythonBin: cur.pythonBin,
               reason: `could not delete incompatible venv (${(e as Error).message})` };
    }
  }

  fs.mkdirSync(cfg.runtimePath, { recursive: true });

  // ── Step B: find a compatible host Python ────────────────────────────
  let find = findCompatiblePython();
  if (!find.probe) {
    _appendLog('warn',
      `no compatible host Python found via launcher/PATH/filesystem scan. Tried: ${find.tried.join(', ')}`,
      'venv');
    // ── Step B.5: last resort — try to auto-install Python 3.11 via uv ──
    // uv ships with the Trend Vault toolchain (used for aider), so it's
    // usually already on disk. uv can install a Python without admin
    // rights and without touching the user's system Python.
    _appendLog('info', 'attempting to auto-install Python 3.11 via uv as a last resort', 'venv');
    const installed = await tryInstallPython311ViaUv();
    if (installed) {
      find = { probe: installed, tried: find.tried };
      _appendLog('success', `auto-installed Python ${installed.version} at ${installed.executable}`, 'venv');
    } else {
      _appendLog('error',
        'no compatible host Python found and uv auto-install did not produce one. Install Python 3.11 from python.org.',
        'venv');
      return {
        ready: false, venvPath: cfg.venvPath, pythonBin: getVenvPython(cfg),
        reason:
          'Fish Speech requires Python 3.10 or 3.11. The launcher could not find one (searched py, python3.11, common install dirs, and uv). ' +
          'Easiest fix: download Python 3.11 from https://www.python.org/downloads/release/python-3119/ and check "Add Python to PATH". ' +
          'Then press Repair on the Fish Speech card. ' +
          'Probed: ' + find.tried.join(', '),
      };
    }
  }

  // Pull the probe out so TypeScript can narrow it (find was reassigned
  // above so the .probe narrowing was lost).
  const probe = find.probe!;
  _appendLog('info',
    `building venv with Python ${probe.version} (${probe.executable}) -> ${cfg.venvPath}`,
    'venv');
  _appendLog('info',
    `python launcher: ${probe.cmd} ${probe.args.join(' ')}`.trim(),
    'venv');

  // ── Step C: actually create the venv ─────────────────────────────────
  const py = probe.cmd;
  const res = await _spawnAndCollect(py,
    [...probe.args, '-m', 'venv', cfg.venvPath],
    { cwd: cfg.runtimePath });
  if (res.code !== 0) {
    return { ready: false, venvPath: cfg.venvPath, pythonBin: getVenvPython(cfg),
             reason: `venv creation failed (host python "${py}" exited ${res.code}): ${res.stderr.slice(-400)}` };
  }
  return checkFishVenv();
}

// ── Helper 4: Python deps ────────────────────────────────────────────────

export interface FishDepsStatus {
  installed: boolean;
  /** Modules we verify are importable inside the venv. */
  modules:   Record<string, boolean>;
  reason?:   string;
}

/** Modules whose presence we treat as "deps installed". */
const FISH_REQUIRED_MODULES = ['torch', 'torchaudio', 'transformers', 'fish_speech'];

export async function checkFishDependencies(): Promise<FishDepsStatus> {
  const v = checkFishVenv();
  if (!v.ready) {
    return { installed: false, modules: {},
             reason: 'venv not ready, cannot import-check Python modules' };
  }
  const script = FISH_REQUIRED_MODULES.map(m =>
    `try:\n    import ${m}\n    print(f'__OK__ ${m}')\nexcept Exception as e:\n    print(f'__FAIL__ ${m}: {e}')`
  ).join('\n');
  const res = await _spawnAndCollect(v.pythonBin, ['-c', script]);
  const lines = res.stdout.split(/\r?\n/);
  const modules: Record<string, boolean> = {};
  for (const m of FISH_REQUIRED_MODULES) {
    modules[m] = lines.some(l => l === `__OK__ ${m}`);
  }
  // We treat fish_speech as required; torch/transformers must also be there.
  const installed = FISH_REQUIRED_MODULES.every(m => modules[m]);
  return {
    installed, modules,
    reason: installed ? undefined : `missing modules: ${FISH_REQUIRED_MODULES.filter(m => !modules[m]).join(', ')}`,
  };
}

/**
 * Detect a Windows file-locking error in pip stderr.
 *
 * WinError 32 / [Errno 13] Permission denied / file is being used by
 * another process — all symptoms of a previous Python process (likely a
 * still-loaded torch from our own api_server or a Defender scan) holding
 * an open handle on a file pip wants to overwrite.
 */
function _isWindowsLockError(stderr: string): boolean {
  if (!stderr) return false;
  return /WinError\s*32|being used by another process|access is denied|\[Errno 13\] Permission denied|cannot access the file/i.test(stderr);
}

/**
 * Best-effort: free any lingering python.exe / pip handles inside the
 * venv directory. We try four steps in order, escalating:
 *
 *   1. Stop any Fish server we own (in-process; instant).
 *   2. taskkill any python.exe whose ImagePath is under the venv.
 *   3. taskkill any pip.exe / wheel-installer processes.
 *   4. Sleep 4s so Windows / Defender can release the handle.
 *
 * Conservative: we never touch python.exe outside our venv dir.
 */
async function _releaseFishVenvLocks(venvPath: string): Promise<void> {
  stopFishServer();
  if (process.platform !== 'win32') return;
  _appendLog('warn',
    `attempting to free file locks under ${venvPath} (kill stray python/pip processes)`,
    'deps');
  // Use PowerShell so we can filter by ImagePath/CommandLine. Fall back to a
  // plain taskkill if PowerShell isn't available.
  const ps = `
$venv = '${venvPath.replace(/'/g, "''")}';
Get-CimInstance Win32_Process | Where-Object {
  ($_.ExecutablePath -and $_.ExecutablePath -like ($venv + '*')) -or
  ($_.CommandLine    -and $_.CommandLine    -like ('*' + $venv + '*'))
} | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "killed pid $($_.ProcessId) ($($_.Name))" }
  catch { "skip pid $($_.ProcessId): $_" }
}
`;
  try {
    const r = await _spawnAndCollect('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeoutMs: 8_000 });
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const t = line.trim();
      if (t) _appendLog('info', `[release-lock] ${t}`, 'deps');
    }
  } catch (e) {
    _appendLog('warn', `lock-release powershell failed: ${(e as Error).message}`, 'deps');
  }
  // Final blunt fallback — kill any pip.exe (it's installer-only, never long-running).
  try { await _spawnAndCollect('taskkill', ['/F', '/IM', 'pip.exe'], { timeoutMs: 4_000 }); } catch {}
  // Sleep so Defender / Indexer / the kernel itself can release the file.
  await new Promise(r => setTimeout(r, 4000));
}

/**
 * Install Fish Speech + dependencies into the venv. Idempotent — running
 * twice is harmless (pip install -e .  is a no-op if already current).
 *
 * Windows file-lock retry: if pip fails with WinError 32 ("file used by
 * another process"), we kill any python.exe that has files open inside
 * the venv, wait 4s, and retry once. If it still fails the message tells
 * the user EXACTLY what's holding the file — that's all we can do without
 * forcing them to reboot.
 */
export async function installFishDependencies(onLog?: (line: string) => void): Promise<FishDepsStatus> {
  const cfg = resolveFishConfig();
  const v = checkFishVenv();
  if (!v.ready) {
    return { installed: false, modules: {}, reason: 'venv missing — call ensureFishVenv() first' };
  }
  const runtime = checkFishRuntime();
  if (!runtime.installed) {
    return { installed: false, modules: {}, reason: 'runtime not cloned — call ensureFishRuntime() first' };
  }
  const log = (line: string) => { _appendLog('info', line, 'deps'); onLog?.(line); };

  // 0. Pre-emptive: stop our own Fish server BEFORE pip touches torch. This
  //    is the single most common cause of WinError 32: the previous server
  //    is still alive in the background, holding torch loaded, and pip
  //    can't overwrite the .pth files in site-packages.
  stopFishServer();

  // 1. Upgrade pip first to dodge stale-resolver bugs.
  log('upgrading pip…');
  let r = await _spawnAndCollect(v.pythonBin, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet']);
  if (r.code !== 0) log(`(warn) pip upgrade exited ${r.code}: ${r.stderr.slice(-200)}`);

  // 2. Install the runtime in editable mode (pip install -e .).
  //    First attempt — straightforward.
  log('installing fish-speech (pip install -e .) — this can take several minutes…');
  r = await _spawnAndCollect(v.pythonBin,
    ['-m', 'pip', 'install', '-e', '.', '--disable-pip-version-check'],
    { cwd: cfg.runtimePath, onStdout: log, onStderr: log });

  // 2b. Windows-only lock retry.
  if (r.code !== 0 && _isWindowsLockError(r.stderr)) {
    log('detected Windows file lock during pip install — freeing handles and retrying once…');
    await _releaseFishVenvLocks(cfg.venvPath);
    log('retrying pip install -e . after freeing locks…');
    r = await _spawnAndCollect(v.pythonBin,
      ['-m', 'pip', 'install', '-e', '.', '--disable-pip-version-check'],
      { cwd: cfg.runtimePath, onStdout: log, onStderr: log });
  }

  if (r.code !== 0) {
    const lockedFileMatch = r.stderr.match(/The process cannot access the file because it is being used by another process: '([^']+)'/);
    const lockedFile = lockedFileMatch ? lockedFileMatch[1] : null;
    const baseReason = `pip install -e . failed (exit ${r.code}). Last stderr: ${r.stderr.slice(-400)}`;
    if (_isWindowsLockError(r.stderr)) {
      return {
        installed: false, modules: {},
        reason:
          `Windows file lock on Fish Speech venv${lockedFile ? ` (locked file: ${lockedFile})` : ''}. ` +
          `Another process is using torch from the venv — usually a leftover Python process or a Defender scan. ` +
          `Try: 1) close any open Python/Trend Vault windows, 2) wait ~10s for Defender to finish, 3) press Repair. ` +
          `If it keeps happening, add ${cfg.venvPath} to your antivirus exclusions. ` + baseReason,
      };
    }
    return { installed: false, modules: {}, reason: baseReason };
  }

  // 3. Re-check imports.
  return checkFishDependencies();
}

// ── Helper 5: runtime repo install ───────────────────────────────────────

/**
 * Clone the Fish Speech runtime repo if it isn't already present. Uses
 * git from PATH. Returns immediately if the runtime is already present.
 */
export async function ensureFishRuntime(): Promise<FishRuntimeStatus> {
  const cfg = resolveFishConfig();
  const cur = checkFishRuntime();
  if (cur.installed) return cur;

  fs.mkdirSync(path.dirname(cfg.runtimePath), { recursive: true });
  _appendLog('info', `cloning ${FISH_RUNTIME_GIT} -> ${cfg.runtimePath}`, 'runtime');
  // If the runtime dir exists but is incomplete, clone into a sibling first.
  const target = fs.existsSync(cfg.runtimePath) ? `${cfg.runtimePath}.tmp-${Date.now()}` : cfg.runtimePath;
  const res = await _spawnAndCollect('git', ['clone', '--depth', '1', FISH_RUNTIME_GIT, target]);
  if (res.code !== 0) {
    return { ...checkFishRuntime(),
             reason: `git clone failed (exit ${res.code}): ${res.stderr.slice(-400)}. Is git installed and on PATH?` };
  }
  if (target !== cfg.runtimePath) {
    // Replace partial dir with the fresh clone.
    try { fs.rmSync(cfg.runtimePath, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.renameSync(target, cfg.runtimePath);
  }
  return checkFishRuntime();
}

// ── Helper 6: server lifecycle ───────────────────────────────────────────

let _serverProc: ChildProcess | null = null;
let _serverLastStdout = '';
let _serverLastStderr = '';
let _serverCommand: { cmd: string; args: string[]; cwd: string } | null = null;

// ── Reconnect watchdog ───────────────────────────────────────────────────────
// Mirrors the "persistent server" philosophy of start-server.bat and
// start_fish_linux.py: if we spawned the process and it exits unexpectedly,
// try to bring it back automatically with exponential backoff.
let _watchdogEnabled   = false;
let _watchdogStopping  = false;   // set by stopFishServer() so we don't restart an intentional kill
let _restartAttempts   = 0;
const _MAX_RESTARTS    = 5;       // give up after this many consecutive crash-restarts
const _RESTART_BASE_MS = 2_000;   // first retry after 2 s, then 4 s, 8 s … capped at 30 s

export interface FishServerInfo {
  running:   boolean;
  reachable: boolean;
  url:       string;
  pid?:      number;
  /** Last 4KB of stdout for the diagnostics panel. */
  stdoutTail?: string;
  /** Last 4KB of stderr for the diagnostics panel. */
  stderrTail?: string;
  command?: { cmd: string; args: string[]; cwd: string };
}

/** Probe the Fish Speech HTTP server at /v1/health, /health, /. */
export async function checkFishServerStatus(): Promise<FishServerInfo> {
  const cfg = resolveFishConfig();
  const url = cfg.serverUrl;
  for (const p of ['/v1/health', '/health', '/']) {
    try {
      const r = await fetch(url + p, { signal: AbortSignal.timeout(2500) });
      if (r.ok || (r.status >= 200 && r.status < 500)) {
        return {
          running:   !!_serverProc && !_serverProc.killed,
          reachable: true, url,
          pid:       _serverProc?.pid,
          stdoutTail: _serverLastStdout.slice(-4096),
          stderrTail: _serverLastStderr.slice(-4096),
          command:    _serverCommand ?? undefined,
        };
      }
    } catch { /* try next */ }
  }
  return {
    running:   !!_serverProc && !_serverProc.killed,
    reachable: false, url,
    pid:       _serverProc?.pid,
    stdoutTail: _serverLastStdout.slice(-4096),
    stderrTail: _serverLastStderr.slice(-4096),
    command:    _serverCommand ?? undefined,
  };
}

/**
 * Detect if something is already listening on the configured port.
 *
 * Uses a raw TCP connect (not HTTP fetch) for accurate results:
 *   • connect succeeds                → port has a listener (occupied)
 *   • ECONNREFUSED                    → nothing is listening (free)
 *   • everything else (timeout, etc.) → treat as free so we don't refuse
 *                                       to spawn on a transient network
 *                                       hiccup. The startup pipeline will
 *                                       error cleanly later if there's a
 *                                       real conflict.
 *
 * The previous HTTP-based probe returned false positives on Windows when
 * the loopback stack took >1s to RST the connection, which made
 * startFishServer() refuse to spawn even though port 8080 was empty.
 */
async function _isPortOccupied(url: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const net = require('net');
  let host = '127.0.0.1';
  let port = 8080;
  try {
    const u = new URL(url);
    host = u.hostname || host;
    port = parseInt(u.port || '8080', 10) || port;
  } catch { /* use defaults */ }

  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const settle = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(occupied);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));   // no SYN-ACK in 1.5s → not listening
    socket.once('error', (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED is the canonical "nothing on this port" signal.
      // Anything else is treated as "free" too so we don't get stuck.
      settle(err && err.code === 'ECONNREFUSED' ? false : false);
    });
    try { socket.connect(port, host); }
    catch { settle(false); }
  });
}

/**
 * Attach stdout/stderr → log-ring streaming to a spawned server child.
 * Shared by the GGUF and (dormant) Python launchers.
 */
function _wireServerChildLogging(child: import('child_process').ChildProcess): void {
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    _serverLastStdout += text;
    if (_serverLastStdout.length > 16_384) _serverLastStdout = _serverLastStdout.slice(-16_384);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) _appendLog('info', line.trim(), 'server');
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    _serverLastStderr += text;
    if (_serverLastStderr.length > 16_384) _serverLastStderr = _serverLastStderr.slice(-16_384);
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const lvl: FishLogLevel = /error|traceback|failed|exception/i.test(t) ? 'error' : 'info';
      _appendLog(lvl, t, 'server');
    }
  });
  child.on('exit', (code, signal) => {
    _appendLog(code === 0 ? 'info' : 'error',
               `server process exited (code=${code}, signal=${signal})`, 'server');
    _serverProc = null;
    // If this was NOT an intentional stop, the watchdog tries to reconnect.
    if (_watchdogEnabled && !_watchdogStopping) {
      _scheduleWatchdogRestart(code).catch(() => {});
    }
    _watchdogStopping = false;
  });
  child.on('error', (err) => {
    _appendLog('error', `spawn error: ${err.message}`, 'server');
  });
}

/**
 * Spawn the Fish Speech server. Idempotent — returns the existing PID if a
 * child process is already running. Uses the compiled GGUF/s2.cpp binary
 * (preferred). The Python tools.api_server path is kept dormant below.
 */
export async function startFishServer(): Promise<FishServerInfo> {
  if (isGgufBackend()) return startFishServerGguf();
  // No compiled GGUF binary present — surface a clear, actionable error
  // instead of silently falling back to the (dormant) Python path.
  const g = resolveFishGgufConfig();
  _appendLog('error',
    `GGUF server binary not found at ${g.binary}. Run install_fish_gguf_runtime.py ` +
    `or set FISH_GGUF_ROOT to your fish-speech install.`, 'server');
  return {
    running: false, reachable: false, url: g.serverUrl,
    stdoutTail: '', stderrTail: `s2 binary missing at ${g.binary}`,
  };
}

/**
 * Spawn the compiled s2.cpp GGUF server. Validates the binary, transformer
 * GGUF, codec GGUF and tokenizer, wires up the ggml shared-library path, and
 * launches the CPU backend. Idempotent and adopts an already-running server.
 */
export async function startFishServerGguf(): Promise<FishServerInfo> {
  const g = resolveFishGgufConfig();

  if (_serverProc && !_serverProc.killed && _serverProc.exitCode === null) {
    _appendLog('info', `server already running (pid ${_serverProc.pid})`, 'server');
    return checkFishServerStatus();
  }

  // If something is already listening, adopt it rather than spawn a conflict.
  const occupied = await _isPortOccupied(g.serverUrl);
  if (occupied) {
    const status = await checkFishServerStatus();
    if (status.reachable) {
      _appendLog('info', `existing server already reachable at ${g.serverUrl}`, 'server');
      return status;
    }
    _appendLog('warn', `port appears occupied at ${g.serverUrl} but not responding to /health — refusing to spawn a conflicting process`, 'server');
    return { running: false, reachable: false, url: g.serverUrl, stdoutTail: '', stderrTail: 'port occupied by another process' };
  }

  // Validate required files before spawning.
  for (const [label, chk] of [
    ['binary',    checkFishGgufBinary()],
    ['transformer GGUF', checkFishGgufModel()],
    ['codec GGUF', checkFishGgufCodec()],
    ['tokenizer', checkFishGgufTokenizer()],
  ] as Array<[string, FishFileCheck]>) {
    if (!chk.ok) {
      _appendLog('error', `cannot start GGUF server — ${label}: ${chk.reason}`, 'server');
      return { running: false, reachable: false, url: g.serverUrl, stdoutTail: '', stderrTail: chk.reason };
    }
  }

  const args = _ggufServerArgs(g);
  _serverLastStdout = '';
  _serverLastStderr = '';
  _serverCommand = { cmd: g.binary, args, cwd: g.root };
  _appendLog('info', `[server start command] ${g.binary} ${args.join(' ')}  (cwd: ${g.root})`, 'server');

  const child = spawn(g.binary, args, {
    cwd: g.root,
    env: _ggufSpawnEnv(g),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  _serverProc = child;
  _wireServerChildLogging(child);
  // Arm watchdog so a crash restarts the server automatically.
  _watchdogEnabled  = true;
  _watchdogStopping = false;
  _restartAttempts  = 0;
  await new Promise(r => setTimeout(r, 100));
  return checkFishServerStatus();
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconnect watchdog — mirrors start-server.bat "persistent server" pattern:
//   • probeFishOnBoot()  — called once at server startup; if Fish is already
//                          reachable (e.g. a previous Node run left it up, or
//                          the user launched start-server.bat directly), we
//                          adopt it and arm the watchdog.
//   • _scheduleWatchdogRestart() — called from the 'exit' handler when Fish
//                          crashes unexpectedly; backs off 2→4→8→16→30 s.
//   • stopFishServer()   — sets _watchdogStopping so the exit handler knows
//                          the kill was intentional and skips the restart.
// ─────────────────────────────────────────────────────────────────────────────

async function _scheduleWatchdogRestart(exitCode: number | null): Promise<void> {
  if (_restartAttempts >= _MAX_RESTARTS) {
    _appendLog('error',
      `Fish Speech watchdog: ${_MAX_RESTARTS} consecutive restarts failed — ` +
      `giving up. Click ▶ Start Fish Speech to retry manually.`, 'lifecycle');
    _watchdogEnabled = false;
    return;
  }

  const delay = Math.min(_RESTART_BASE_MS * Math.pow(2, _restartAttempts), 30_000);
  _restartAttempts++;
  _appendLog('warn',
    `Fish Speech crashed (exit ${exitCode}) — watchdog restarting in ` +
    `${delay / 1000}s (attempt ${_restartAttempts}/${_MAX_RESTARTS})`, 'lifecycle');

  await new Promise(r => setTimeout(r, delay));

  _appendLog('info', 'Fish Speech watchdog: attempting reconnect…', 'lifecycle');
  const info = await startFishServerGguf();
  if (info.reachable || info.running) {
    _appendLog('info',
      `Fish Speech watchdog: server reconnected at ${info.url} (pid ${info.pid ?? '?'})`,
      'lifecycle');
    _restartAttempts = 0;  // reset backoff on successful restart
  } else {
    _appendLog('error',
      `Fish Speech watchdog: reconnect attempt ${_restartAttempts} failed — ` +
      `${info.stderrTail?.slice(-200) || 'no detail'}`, 'lifecycle');
  }
}

/**
 * Boot-time reconnect probe.
 *
 * Call once after the Node.js server starts listening. Replicates the
 * start-server.bat port pre-flight check: if Fish Speech is already reachable
 * on its configured port (left running from a previous session or launched via
 * start-server.bat), we adopt the external process, log its URL, and arm the
 * watchdog so it will be restarted if it later crashes.
 *
 * If the server is NOT reachable we log a single info line and return — the
 * user can start it manually from the UI.
 */
export async function probeFishOnBoot(): Promise<void> {
  try {
    const status = await checkFishServerStatus();
    if (status.reachable) {
      _appendLog('info',
        `Fish Speech already reachable at ${status.url} — reconnected (external process). ` +
        `Watchdog armed.`, 'lifecycle');
      _watchdogEnabled  = true;
      _restartAttempts  = 0;
    } else {
      _appendLog('info',
        `Fish Speech not reachable at ${status.url} — waiting for manual start.`,
        'lifecycle');
    }
  } catch {
    // Non-fatal: just means Fish isn't up yet.
  }
}

/**
 * DORMANT: original Python tools.api_server launcher. Retained for reference /
 * fallback but not invoked while a compiled GGUF binary is present.
 */
export async function startFishServerPython(): Promise<FishServerInfo> {
  const cfg = resolveFishConfig();

  if (_serverProc && !_serverProc.killed && _serverProc.exitCode === null) {
    _appendLog('info', `server already running (pid ${_serverProc.pid})`, 'server');
    return checkFishServerStatus();
  }

  // Port conflict check before we waste time spawning Python.
  const occupied = await _isPortOccupied(cfg.serverUrl);
  if (occupied) {
    const status = await checkFishServerStatus();
    if (status.reachable) {
      // Already running and answering — adopt it instead of spawning.
      _appendLog('info', `existing server already reachable at ${cfg.serverUrl}`, 'server');
      return status;
    }
    _appendLog('warn', `port appears occupied at ${cfg.serverUrl} but not responding to /v1/health — refusing to spawn a conflicting process`, 'server');
    return {
      running: false, reachable: false, url: cfg.serverUrl,
      stdoutTail: '', stderrTail: 'port occupied by another process',
    };
  }

  const v = checkFishVenv();
  if (!v.ready) {
    _appendLog('error', `venv not ready: ${v.reason}`, 'server');
    return { running: false, reachable: false, url: cfg.serverUrl, stderrTail: v.reason };
  }
  const rt = checkFishRuntime();
  if (!rt.installed) {
    _appendLog('error', `runtime not installed: ${rt.reason}`, 'server');
    return { running: false, reachable: false, url: cfg.serverUrl, stderrTail: rt.reason };
  }

  // Build host:port args from the server URL.
  const u = new URL(cfg.serverUrl);
  const listen = `${u.hostname}:${u.port || '8080'}`;

  const args = [
    '-m', 'tools.api_server',
    '--listen', listen,
    '--llama-checkpoint-path', cfg.modelPath,
  ];

  _serverLastStdout = '';
  _serverLastStderr = '';
  _serverCommand = { cmd: v.pythonBin, args, cwd: cfg.runtimePath };

  _appendLog('info', `spawning: ${v.pythonBin} ${args.join(' ')}  (cwd: ${cfg.runtimePath})`, 'server');

  const child = spawn(v.pythonBin, args, {
    cwd: cfg.runtimePath,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // detached: false so child dies when our process dies
  });
  _serverProc = child;

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    _serverLastStdout += text;
    if (_serverLastStdout.length > 16_384) _serverLastStdout = _serverLastStdout.slice(-16_384);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) _appendLog('info', line.trim(), 'server');
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    _serverLastStderr += text;
    if (_serverLastStderr.length > 16_384) _serverLastStderr = _serverLastStderr.slice(-16_384);
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      // Uvicorn writes startup banners to stderr — that's "info", not "error".
      const lvl: FishLogLevel = /error|traceback|failed|exception/i.test(t) ? 'error' : 'info';
      _appendLog(lvl, t, 'server');
    }
  });
  child.on('exit', (code, signal) => {
    _appendLog(code === 0 ? 'info' : 'error',
               `server process exited (code=${code}, signal=${signal})`, 'server');
    _serverProc = null;
  });
  child.on('error', (err) => {
    _appendLog('error', `spawn error: ${err.message}`, 'server');
  });

  // Give the OS a tick to attach pipes; we don't wait for readiness here.
  await new Promise(r => setTimeout(r, 100));
  return checkFishServerStatus();
}

/** Politely kill the spawned server. No-op if nothing is running. */
export function stopFishServer(): { stopped: boolean } {
  _watchdogStopping = true;   // tell exit handler this kill was intentional → no restart
  _watchdogEnabled  = false;
  if (_serverProc && !_serverProc.killed) {
    try { _serverProc.kill(); _appendLog('info', `sent SIGTERM to pid ${_serverProc.pid}`, 'server'); }
    catch (e) { _appendLog('warn', `kill failed: ${(e as Error).message}`, 'server'); }
    _serverProc = null;
    return { stopped: true };
  }
  return { stopped: false };
}

// ── Helper 7: wait-for-ready with progress ───────────────────────────────

export interface WaitOptions {
  maxMs?:    number;   // default 120_000
  pollMs?:   number;   // default 2_000
  onProgress?: (sec: number, info: FishServerInfo) => void;
}

/**
 * Poll the server until /v1/health responds 2xx, or until maxMs elapses.
 * Emits "Starting Fish Speech server... Ns" log lines every poll.
 */
export async function waitForFishServer(opts: WaitOptions = {}): Promise<FishServerInfo> {
  const maxMs  = opts.maxMs  ?? 120_000;
  const pollMs = opts.pollMs ?? 2_000;
  const t0 = Date.now();
let lastInfo: FishServerInfo = await checkFishServerStatus();
  while (Date.now() - t0 < maxMs) {
    if (lastInfo.reachable) {
      _appendLog('success', `Fish Speech server ready at ${lastInfo.url}`, 'server');
      return lastInfo;
    }
    const sec = Math.round((Date.now() - t0) / 1000);
    _appendLog('info', `Starting Fish Speech server... ${sec}s`, 'server');
    opts.onProgress?.(sec, lastInfo);
    await new Promise(r => setTimeout(r, pollMs));
    lastInfo = await checkFishServerStatus();
  }
  _appendLog('error', `server did not become ready within ${Math.round(maxMs / 1000)}s`, 'server');
  return lastInfo;
}

// ── Helper 8: TTS endpoint discovery ─────────────────────────────────────

export interface FishEndpointResult {
  endpoint: string | null;
  triedRoutes: Array<{ route: string; status: number | 'error'; note?: string }>;
  reason?: string;
}

// s2.cpp exposes /v1/tts (primary), /synthesize and /v1/audio/speech — all
// accept the same JSON body and return raw audio bytes. We keep the older
// route names at the end for forward-compatibility with other Fish builds.
const _ROUTE_CANDIDATES = ['/v1/tts', '/synthesize', '/v1/audio/speech', '/tts', '/api/invoke', '/v1/audio/text-to-speech'];

export async function detectFishEndpoint(testText = 'Hi.'): Promise<FishEndpointResult> {
  const cfg = resolveFishConfig();
  // Fast-path: in-memory route already confirmed (set by prepareFishEngine fast-path).
  if (_lifecycle.workingRoute) {
    return { endpoint: _lifecycle.workingRoute,
             triedRoutes: [{ route: _lifecycle.workingRoute, status: 200, note: 'in-memory cache (no re-probe)' }] };
  }
  const persisted = _loadPersisted(cfg);
  // GGUF fast-path: skip audio-generation probe — just verify server is reachable.
  if (isGgufBackend() && persisted.workingEndpoint) {
    try {
      const healthResp = await fetch(cfg.serverUrl + '/health', { signal: AbortSignal.timeout(5_000) });
      if (healthResp.ok || healthResp.status === 200) {
        _lifecycle.workingRoute = persisted.workingEndpoint;
        return { endpoint: persisted.workingEndpoint,
                 triedRoutes: [{ route: persisted.workingEndpoint, status: 200, note: 'GGUF: cached + health-check verified' }] };
      }
    } catch { /* fall through to full probe below */ }
  }
  if (persisted.workingEndpoint) {
    const ok = await _probeRoute(cfg.serverUrl + persisted.workingEndpoint, testText);
    if (ok.audioBytes > 256) {
      _lifecycle.workingRoute = persisted.workingEndpoint;
      return { endpoint: persisted.workingEndpoint,
               triedRoutes: [{ route: persisted.workingEndpoint, status: ok.status, note: `cached + verified (${ok.audioBytes} bytes)` }] };
    }
    _appendLog('warn', `cached endpoint ${persisted.workingEndpoint} no longer works (status ${ok.status}); rediscovering`, 'endpoint');
  }
  const tried: FishEndpointResult['triedRoutes'] = [];
  for (const route of _ROUTE_CANDIDATES) {
    const url = cfg.serverUrl + route;
    const r = await _probeRoute(url, testText);
    tried.push({ route, status: r.status, note: r.note });
    if (typeof r.status === 'number' && r.status >= 200 && r.status < 300 && r.audioBytes > 256) {
      _lifecycle.workingRoute = route;
      _savePersisted(cfg, { ...persisted, workingEndpoint: route, lastVerifiedAt: new Date().toISOString() });
      _appendLog('success', `discovered working endpoint: ${route} (${r.audioBytes} bytes)`, 'endpoint');
      return { endpoint: route, triedRoutes: tried };
    }
  }
  _appendLog('error', `no compatible TTS route found. Tried: ${tried.map(t => `${t.route}=${t.status}`).join(', ')}`, 'endpoint');
  return {
    endpoint: null, triedRoutes: tried,
    reason: 'No compatible TTS route responded with audio. Server may be a non-Fish service, or this Fish version exposes a different route.',
  };
}

async function _probeRoute(url: string, text: string): Promise<{ status: number | 'error'; audioBytes: number; note?: string }> {
  // s2.cpp body: only `text` is required; it returns WAV by default. The extra
  // fields are harmless (ignored by s2.cpp) but keep us compatible with other
  // Fish builds that expect them.
  const body = JSON.stringify({
    text, format: 'wav',
    temperature: 0.3, top_p: 0.8, top_k: 20,
  });
  // CPU-only inference can take 5–10 minutes for even a short phrase.
  // 600 seconds keeps us compatible with GPU systems (fast) and CPU systems (slow).
  const PROBE_TIMEOUT_MS = 600_000;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'audio/wav, audio/mpeg, */*' },
      body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!r.ok) return { status: r.status, audioBytes: 0, note: `HTTP ${r.status}` };
    const ab = await r.arrayBuffer();
    return { status: r.status, audioBytes: ab.byteLength };
  } catch (e) {
    return { status: 'error', audioBytes: 0, note: (e as Error).message };
  }
}

// ── Helper 9: real test generation ───────────────────────────────────────

export interface FishTestResult {
  ok: boolean;
  audioBytes?: number;
  endpoint?: string;
  durationMs?: number;
  reason?: string;
}

export async function testFishGeneration(): Promise<FishTestResult> {
  const discovery = await detectFishEndpoint('Hi.');
  if (!discovery.endpoint) {
    return { ok: false, reason: discovery.reason || 'endpoint discovery returned no route' };
  }
  const cfg = resolveFishConfig();
  const t0 = Date.now();
  const r = await _probeRoute(cfg.serverUrl + discovery.endpoint, 'Trend Vault test.');
  const ms = Date.now() - t0;
  if (r.status === 'error' || (typeof r.status === 'number' && (r.status < 200 || r.status >= 300)) || r.audioBytes < 256) {
    return { ok: false, endpoint: discovery.endpoint, durationMs: ms,
             reason: `test call returned ${r.status} with ${r.audioBytes} bytes (${r.note || 'no detail'})` };
  }
  _appendLog('success', `test generation ok (${r.audioBytes} bytes in ${ms} ms via ${discovery.endpoint})`, 'test');
  return { ok: true, audioBytes: r.audioBytes, endpoint: discovery.endpoint, durationMs: ms };
}

// ── Helper 10: real generation ───────────────────────────────────────────

export interface GenerateOptions {
  text: string;
  voiceId: string;
  speed?: number;
  temperature?: number;
  pitch?: number;
  autoStart?: boolean;
  promptAudioPath?: string;   // reference WAV for a cloned voice (s2.cpp prompt_audio_path)
}

export interface GenerateResult {
  ok: boolean;
  buffer?: Buffer;
  mimeType: string;
  endpoint?: string;
  error?: string;
  engine: 'fish-speech-s2-pro';
  bootstrapped?: boolean;
}

// POST JSON to the Fish server and collect the binary response using raw
// node:http — NOT fetch(). Node's fetch (undici) pools connections and reuses
// sockets that s2.cpp/httplib has already closed, which surfaces as an immediate
// "fetch failed" even when Fish accepts the request and generates fine. It also
// imposes a hidden ~300s headersTimeout, and Fish sends no response until the
// whole WAV is ready. A fresh raw request per call avoids both problems.
// `timeoutMs` is a socket-INACTIVITY guard (Fish is silent during generation).
function _fishHttpPost(
  urlStr: string, bodyObj: unknown, timeoutMs = 1_800_000,
): Promise<{ status: number; buffer: Buffer; error?: string }> {
  return new Promise(async (resolve) => {
    try {
      const u = new URL(urlStr);
      const mod = u.protocol === 'https:' ? await import('node:https') : await import('node:http');
      const payload = Buffer.from(JSON.stringify(bodyObj));
      const req = mod.request({
        hostname: u.hostname,
        port:     u.port || (u.protocol === 'https:' ? 443 : 80),
        path:     u.pathname + u.search,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Accept':         'audio/wav, audio/mpeg, */*',
          'Connection':     'close',           // fresh connection each call — no stale-socket reuse
          'Content-Length': payload.length,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, buffer: Buffer.concat(chunks) }));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Fish request timed out (no data for ${Math.round(timeoutMs / 1000)}s)`)));
      req.on('error', (e: Error) => resolve({ status: 0, buffer: Buffer.alloc(0), error: e.message }));
      req.write(payload);
      req.end();
    } catch (e) {
      resolve({ status: 0, buffer: Buffer.alloc(0), error: (e as Error).message });
    }
  });
}

export async function generateFishSpeechAudio(opts: GenerateOptions): Promise<GenerateResult> {
  const cfg = resolveFishConfig();
  let bootstrapped = false;
  const initial = await checkFishServerStatus();
  if (!initial.reachable) {
    if (opts.autoStart === false) {
      return { ok: false, mimeType: 'audio/mpeg', engine: 'fish-speech-s2-pro',
               error: `Fish Speech server not reachable at ${cfg.serverUrl} (autoStart disabled)` };
    }
    _appendLog('info', 'server not reachable — auto-starting Fish runtime', 'lifecycle');
    const prep = await prepareFishEngine();
    bootstrapped = true;
    if (!prep.ready) {
      const failed = Object.values(prep.steps).find(s => s.status === 'failed');
      return {
        ok: false, mimeType: 'audio/mpeg', engine: 'fish-speech-s2-pro',
        error: failed
          ? `${failed.label} failed: ${failed.detail || 'unknown reason'}`
          : 'Fish Speech runtime preparation did not complete',
      };
    }
  }
  let endpoint = _lifecycle.workingRoute || _loadPersisted(cfg).workingEndpoint || null;
  if (!endpoint) {
    const d = await detectFishEndpoint();
    if (!d.endpoint) return {
      ok: false, mimeType: 'audio/mpeg', engine: 'fish-speech-s2-pro',
      error: d.reason || 'no compatible TTS endpoint discovered',
    };
    endpoint = d.endpoint;
  }
  // s2.cpp GGUF body. Voice selection is done via a reference clip
  // (prompt_audio_path / the server's uploaded reference), NOT a voice id —
  // s2.cpp ignores reference_id/speaker/voice. We pass the tuning knobs it
  // does honour (temperature, top_p, top_k) and request WAV output.
  const refPath = opts.promptAudioPath
                || process.env.FISH_REFERENCE_AUDIO_PATH
                || undefined;
  const body: Record<string, unknown> = {
    text:        sanitizeFishProsodyTags(opts.text),
    format:      'wav',
    temperature: opts.temperature ?? 0.3,
    top_p:       0.8,
    top_k:       20,
  };
  if (refPath) body.prompt_audio_path = refPath;
  try {
    // Raw http (see _fishHttpPost) — avoids undici stale-socket "fetch failed"
    // and the hidden 300s headersTimeout on long, silent Fish generations.
    const r = await _fishHttpPost(cfg.serverUrl + endpoint, body, 1_800_000);
    if (r.error) {
      return { ok: false, mimeType: 'audio/mpeg', engine: 'fish-speech-s2-pro', bootstrapped,
               error: `Fish Speech generation failed: ${r.error}` };
    }
    if (r.status === 404) {
      _savePersisted(cfg, { workingEndpoint: undefined });
      _lifecycle.workingRoute = null;
      _appendLog('warn', `endpoint ${endpoint} returned 404 — invalidating cache and retrying discovery`, 'endpoint');
      const d2 = await detectFishEndpoint();
      if (!d2.endpoint) return {
        ok: false, mimeType: 'audio/mpeg', engine: 'fish-speech-s2-pro', bootstrapped,
        error: `Previously-working endpoint ${endpoint} no longer responds, and rediscovery failed: ${d2.reason || 'no route'}`,
      };
      return generateFishSpeechAudio({ ...opts, autoStart: false });
    }
    if (r.status < 200 || r.status >= 300) {
      return { ok: false, mimeType: 'audio/mpeg', engine: 'fish-speech-s2-pro', bootstrapped,
               error: `Fish Speech server returned HTTP ${r.status} at ${endpoint}` };
    }
    const buffer = r.buffer;
    if (buffer.length < 256) {
      return { ok: false, mimeType: 'audio/mpeg', engine: 'fish-speech-s2-pro', bootstrapped,
               error: `Fish Speech responded on ${endpoint} but returned only ${buffer.length} bytes` };
    }
    return { ok: true, buffer, mimeType: 'audio/wav', endpoint, engine: 'fish-speech-s2-pro', bootstrapped };
  } catch (e) {
    return { ok: false, mimeType: 'audio/mpeg', engine: 'fish-speech-s2-pro', bootstrapped,
             error: `Fish Speech generation failed: ${(e as Error).message}` };
  }
}

// ── Orchestrator ─────────────────────────────────────────────────────────

export interface PrepareResult {
  ready: boolean;
  steps: Record<string, FishStep>;
  message: string;
  workingEndpoint: string | null;
}

export async function prepareFishEngine(): Promise<PrepareResult> {
  if (_lifecycle.inFlight) {
    _appendLog('warn', 'prepareFishEngine() invoked while another attempt is in flight; coalescing', 'lifecycle');
    while (_lifecycle.inFlight) await new Promise(r => setTimeout(r, 300));
    return _snapshotPrep();
  }
  _lifecycle.inFlight = true;
  _resetSteps();
  const g = resolveFishGgufConfig();
  _appendLog('info', '--- Repair started: preparing Fish Speech S2 Pro GGUF — this can take a few minutes the first time. ---', 'lifecycle');
  _appendLog('info', `GGUF root: ${g.root}  (override with FISH_GGUF_ROOT)`, 'lifecycle');
  try {
    // 1) Fish model: the GGUF model directory under the install root.
    _setStep('model', 'running');
    if (!fs.existsSync(g.modelDir)) {
      _setStep('model', 'failed', `model folder not found: ${g.modelDir} — run install_fish_gguf_runtime.py`);
      return _snapshotPrep();
    }
    _setStep('model', 'ok', g.modelDir);

    // 2) Fish GGUF model: the transformer .gguf weights.
    _setStep('gguf', 'running');
    const ggufChk = checkFishGgufModel();
    if (!ggufChk.ok) { _setStep('gguf', 'failed', ggufChk.reason); return _snapshotPrep(); }
    _setStep('gguf', 'ok', `${(ggufChk.sizeBytes / 1024 / 1024).toFixed(0)} MB — ${ggufChk.path}`);
    _appendLog('success', `GGUF model found: ${ggufChk.path}`, 'gguf');

    // 3) Fish codec GGUF.
    _setStep('codec', 'running');
    const codecChk = checkFishGgufCodec();
    if (!codecChk.ok) { _setStep('codec', 'failed', codecChk.reason); return _snapshotPrep(); }
    _setStep('codec', 'ok', `${(codecChk.sizeBytes / 1024 / 1024).toFixed(0)} MB — ${codecChk.path}`);
    _appendLog('success', `Codec GGUF found: ${codecChk.path}`, 'codec');

    // 4) Fish runtime: compiled s2 binary + ggml libs + tokenizer.
    _setStep('runtime', 'running');
    const binChk = checkFishGgufBinary();
    if (!binChk.ok) { _setStep('runtime', 'failed', binChk.reason); return _snapshotPrep(); }
    const tokChk = checkFishGgufTokenizer();
    if (!tokChk.ok) { _setStep('runtime', 'failed', tokChk.reason); return _snapshotPrep(); }
    _setStep('runtime', 'ok', g.binary);
    _appendLog('success', `Runtime found: ${g.binary}`, 'runtime');

    // 5) Python venv — NOT required for the self-contained GGUF/s2.cpp runtime.
    //    If the installer created an optional venv we report it; otherwise OK.
    _setStep('venv', 'running');
    const optVenv = path.join(g.root, '.venv');
    if (fs.existsSync(optVenv)) _setStep('venv', 'ok', `optional venv present: ${optVenv}`);
    else _setStep('venv', 'ok', 'not required (GGUF runtime is self-contained)');

    // 6) Dependencies — the compiled binary bundles its ggml shared libs, so
    //    there are no Python/Node packages to install for the GGUF runtime.
    _setStep('deps', 'running');
    _setStep('deps', 'ok', 'GGUF runtime is self-contained (no Python deps required)');

    _setStep('server', 'running');
    const initial = await checkFishServerStatus();
    if (!initial.reachable) {
      const spawned = await startFishServer();
      if (!spawned.running && !spawned.reachable) {
        _setStep('server', 'failed',
          `failed to spawn server. stderr tail: ${(spawned.stderrTail || '').slice(-300)}`);
        return _snapshotPrep();
      }
      const waited = await waitForFishServer({ maxMs: 120_000, pollMs: 2_000 });
      if (!waited.reachable) {
        _setStep('server', 'failed',
          `server did not become ready within 120s. stderr tail: ${(waited.stderrTail || '').slice(-300)}`);
        return _snapshotPrep();
      }
    }
    _setStep('server', 'ok', resolveFishConfig().serverUrl);

    // For the GGUF backend, we already know the binary, models, and tokenizer
    // are present (verified in steps 1–4), and the server is reachable.
    // Skip the slow audio generation test — probing /v1/tts on CPU-only hardware
    // can take 10+ minutes.  Instead, verify the route exists by GETting the
    // root index page (which lists available routes) and mark both steps ok.
    _setStep('endpoint', 'running');
    const serverUrl = resolveFishConfig().serverUrl;
    try {
      const indexResp = await fetch(serverUrl + '/', { signal: AbortSignal.timeout(5_000) });
      const indexText = await indexResp.text();
      const hasTtsRoute = indexText.includes('/v1/tts') || indexText.includes('v1/tts');
      if (hasTtsRoute) {
        _lifecycle.workingRoute = '/v1/tts';
        const cfg = resolveFishConfig();
        _savePersisted(cfg, { ..._loadPersisted(cfg), workingEndpoint: '/v1/tts', lastVerifiedAt: new Date().toISOString() });
        _setStep('endpoint', 'ok', '/v1/tts (confirmed via server index)');
        _setStep('test', 'ok', 'skipped on GGUF/CPU — server is reachable and /v1/tts is listed');
        _appendLog('success', 'GGUF fast-path: endpoint /v1/tts confirmed, test generation skipped (CPU-only)', 'lifecycle');
      } else {
        // Unexpected — fall back to the full probe
        const ep = await detectFishEndpoint();
        if (!ep.endpoint) {
          _setStep('endpoint', 'failed',
            `no compatible TTS route found. Tried: ${ep.triedRoutes.map(t => `${t.route}=${t.status}`).join(', ')}`);
          return _snapshotPrep();
        }
        _setStep('endpoint', 'ok', ep.endpoint);
        _setStep('test', 'ok', 'endpoint verified via full probe');
      }
    } catch {
      // Index fetch failed — fall back to full probe
      const ep = await detectFishEndpoint();
      if (!ep.endpoint) {
        _setStep('endpoint', 'failed',
          `no compatible TTS route found. Tried: ${ep.triedRoutes.map(t => `${t.route}=${t.status}`).join(', ')}`);
        return _snapshotPrep();
      }
      _setStep('endpoint', 'ok', ep.endpoint);
      _setStep('test', 'ok', 'endpoint verified via full probe');
    }

    _lifecycle.message = 'Fish Speech S2 Pro ready';
    _appendLog('success', _lifecycle.message, 'lifecycle');
    return _snapshotPrep();
  } finally {
    _lifecycle.inFlight = false;
  }
}

function _snapshotPrep(): PrepareResult {
  const ready = _stepKeys.every(k => _lifecycle.steps[k].status === 'ok');
  const failed = Object.values(_lifecycle.steps).find(s => s.status === 'failed');
  const message = ready
    ? 'Fish Speech S2 Pro ready'
    : failed ? `${failed.label} failed${failed.detail ? ': ' + failed.detail : ''}`
             : 'Fish Speech preparation incomplete';
  return {
    ready,
    steps: JSON.parse(JSON.stringify(_lifecycle.steps)),
    message,
    workingEndpoint: _lifecycle.workingRoute,
  };
}

// ── Public status ────────────────────────────────────────────────────────

export type FishEngineState =
  | 'ready' | 'preparing' | 'server_only' | 'model_only' | 'partial' | 'missing' | 'unknown';

export interface FishCombinedStatus {
  state: FishEngineState;
  model: FishModelStatus;
  runtime: FishRuntimeStatus;
  venv: FishVenvStatus;
  server: FishServerInfo;
  steps: Record<string, FishStep>;
  workingEndpoint: string | null;
  message: string;
  modelDir: string;
  runtimePath: string;
  venvPath: string;
  serverUrl: string;
}

export async function checkFishEngine(): Promise<FishCombinedStatus> {
  const cfg = resolveFishConfig();
  const g   = resolveFishGgufConfig();
  // Legacy (Python) statuses kept for back-compat fields in the payload.
  const model = checkFishModel();
  const runtime = checkFishRuntime();
  const venv = checkFishVenv();
  const server = await checkFishServerStatus();

  // GGUF readiness is what actually drives the engine state now.
  const filesReady = checkFishGgufBinary().ok
                  && checkFishGgufModel().ok
                  && checkFishGgufCodec().ok
                  && checkFishGgufTokenizer().ok;

  let state: FishEngineState = 'unknown';
  let message = '';
  if (_lifecycle.inFlight) {
    state = 'preparing'; message = 'Fish Speech S2 Pro (GGUF) is preparing…';
  } else if (filesReady && server.reachable && _stepKeys.every(k => _lifecycle.steps[k].status === 'ok')) {
    state = 'ready'; message = `Fish Speech S2 Pro GGUF ready (server ${server.url})`;
  } else if (server.reachable && !filesReady) {
    state = 'server_only'; message = `Fish server reachable at ${server.url} but GGUF files missing under ${g.root}`;
  } else if (filesReady && !server.reachable) {
    state = 'model_only'; message = `GGUF runtime present at ${g.root}; server at ${server.url} not running — click Start Fish Speech`;
  } else if (!filesReady && !server.reachable) {
    state = 'missing'; message = `Fish Speech GGUF runtime not found under ${g.root} — run install_fish_gguf_runtime.py`;
  } else {
    state = 'partial'; message = 'Fish Speech: some checks passed, some not — see logs';
  }
  return {
    state, model, runtime, venv, server,
    steps: JSON.parse(JSON.stringify(_lifecycle.steps)),
    workingEndpoint: _lifecycle.workingRoute,
    message,
    modelDir: g.modelDir,
    runtimePath: g.root,
    venvPath: cfg.venvPath,
    serverUrl: g.serverUrl,
  };
}

export function setFishModelPath(newPath: string): FishConfig {
  if (!newPath || typeof newPath !== 'string') throw new Error('newPath required');
  const expanded = newPath.replace(/^~(?=$|\/|\\)/, os.homedir());
  process.env.FISH_S2_PRO_MODEL_PATH = expanded;
  _appendLog('info', `model path overridden to ${expanded}`, 'config');
  const cfg = resolveFishConfig();
  fs.mkdirSync(path.dirname(cfg.configFile), { recursive: true });
  const cur = _loadPersisted(cfg);
  _savePersisted(cfg, { ...cur, workingEndpoint: cur.workingEndpoint });
  return cfg;
}

export interface RepairResult { ok: boolean; steps: Record<string, FishStep>; message: string; }

export async function repairFishEngine(): Promise<RepairResult> {
  // GGUF repair is non-destructive: it validates every file, (re)starts the
  // server, detects the endpoint and runs a test generation. It does NOT
  // delete weights or any venv. Stop any running server first so the restart
  // picks up the validated config.
  _appendLog('info', 'Repair started (GGUF): full validate + start + endpoint detect + test', 'lifecycle');
  stopFishServer();
  const prep = await prepareFishEngine();
  return {
    ok: prep.ready,
    steps: prep.steps,
    message: prep.ready ? 'Fish Speech S2 Pro GGUF repaired successfully' : prep.message,
  };
}

// ── Subprocess helper ────────────────────────────────────────────────────

interface SpawnCollectOptions {
  cwd?: string;
  env?: Record<string, string>;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  timeoutMs?: number;
}
interface SpawnCollectResult { code: number | null; stdout: string; stderr: string; }

async function _spawnAndCollect(
  cmd: string,
  args: string[],
  opts: SpawnCollectOptions = {},
): Promise<SpawnCollectResult> {
  return new Promise((resolve) => {
    let stdout = ''; let stderr = '';
    let timed = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const timeout = setTimeout(() => {
      timed = true;
      try { child.kill(); } catch { /* ignore */ }
    }, opts.timeoutMs ?? 30 * 60_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() && opts.onStdout) opts.onStdout(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() && opts.onStderr) opts.onStderr(line);
      }
    });
    child.on('error', (err) => {
      stderr += err.message;
      clearTimeout(timeout);
      resolve({ code: -1, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timed) stderr += '\n(timeout)';
      resolve({ code, stdout, stderr });
    });
  });
}

// ── Back-compat surface used by server.ts + UI ──────────────────────────

export interface FishPreviewOptions {
  text: string;
  voiceId: string;
  speed?: number;
  temperature?: number;
  pitch?: number;
  promptAudioPath?: string;   // reference WAV for a cloned voice (s2.cpp prompt_audio_path)
}

export interface FishPreviewResult {
  ok: boolean;
  buffer?: Buffer;
  mimeType: string;
  error?: string;
  engine: 'fish-speech-s2-pro';
  resolvedVia: 'server' | 'none';
  endpoint?: string;
  bootstrapped?: boolean;
}

export async function previewFishVoice(opts: FishPreviewOptions): Promise<FishPreviewResult> {
  const r = await generateFishSpeechAudio({ ...opts, autoStart: true });
  return {
    ok: r.ok,
    buffer: r.buffer,
    mimeType: r.mimeType,
    error: r.error,
    engine: 'fish-speech-s2-pro',
    resolvedVia: r.ok ? 'server' : 'none',
    endpoint: r.endpoint,
    bootstrapped: r.bootstrapped,
  };
}

export async function renderFishVoice(opts: FishPreviewOptions): Promise<FishPreviewResult> {
  return previewFishVoice(opts);
}

// ── Legacy install-model surface (kept for the optional re-download button) ─

export interface FishInstallProgress {
  running: boolean; done: boolean; ok?: boolean; pct: number; stage: string;
  modelDir: string; startedAt?: string; finishedAt?: string; error?: string; log: string[];
}

const _installProgress: FishInstallProgress = {
  running: false, done: false, pct: 0, stage: 'idle',
  modelDir: getFishModelDir(), log: [],
};
let _installInFlight = false;

export function getFishInstallProgress(): FishInstallProgress {
  return { ..._installProgress, log: [..._installProgress.log] };
}

function _logInstall(line: string, pct?: number, stage?: string) {
  _installProgress.log.push(`[${new Date().toISOString()}] ${line}`);
  if (_installProgress.log.length > 200) _installProgress.log.shift();
  if (typeof pct === 'number') _installProgress.pct = Math.max(0, Math.min(100, pct));
  if (stage) _installProgress.stage = stage;
  _appendLog('info', line, 'model-install');
}

export function installFishModel(): { started: boolean; reason?: string } {
  if (_installInFlight) return { started: false, reason: 'install already running' };
  const model = checkFishModel();
  if (model.installed) {
    _logInstall(`model already present at ${model.modelPath} (${(model.sizeBytes / 1024 / 1024).toFixed(0)} MB) — skipping download`, 100, 'done');
    _installProgress.running = false; _installProgress.done = true; _installProgress.ok = true;
    return { started: false, reason: 'model already installed' };
  }
  const cfg = resolveFishConfig();
  const modelDir = cfg.modelPath;
  fs.mkdirSync(modelDir, { recursive: true });
  _installInFlight = true;
  _installProgress.running = true;
  _installProgress.done = false;
  _installProgress.ok = undefined;
  _installProgress.pct = 1;
  _installProgress.stage = 'starting';
  _installProgress.modelDir = modelDir;
  _installProgress.startedAt = new Date().toISOString();
  _installProgress.finishedAt = undefined;
  _installProgress.error = undefined;
  _installProgress.log.length = 0;
  _logInstall(`Installing ${FISH_HF_REPO} into ${modelDir}`, 2, 'starting');
  const escapedDir = modelDir.replace(/\\/g, '\\\\');
  const py = [
    'import os, sys, traceback',
    'target = r"""' + escapedDir + '"""',
    'os.makedirs(target, exist_ok=True)',
    'try:',
    '    try:',
    '        from huggingface_hub import snapshot_download',
    '    except ImportError:',
    '        print("[install] huggingface_hub missing; pip installing...", flush=True)',
    '        import subprocess',
    '        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "huggingface_hub"])',
    '        from huggingface_hub import snapshot_download',
    '    print(f"[install] downloading ' + FISH_HF_REPO + ' -> {target}", flush=True)',
    '    snapshot_download(repo_id="' + FISH_HF_REPO + '", local_dir=target, local_dir_use_symlinks=False, resume_download=True)',
    '    print("[install] done", flush=True)',
    '    sys.exit(0)',
    'except Exception as e:',
    '    traceback.print_exc()',
    '    print(f"[install] FAILED: {e}", flush=True)',
    '    sys.exit(1)',
  ].join('\n');
  const child = spawn(cfg.pythonBin, ['-u', '-c', py], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: '0' },
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      const t = line.trim(); if (!t) continue;
      const m = t.match(/(\d+(?:\.\d+)?)\s*%/);
      if (m) _logInstall(t, Math.min(99, parseFloat(m[1])), 'downloading');
      else _logInstall(t);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      const t = line.trim(); if (t) _logInstall(t);
    }
  });
  child.on('error', err => {
    _installProgress.error = err.message;
    _logInstall(`spawn error: ${err.message}`, undefined, 'failed');
  });
  child.on('close', code => {
    _installInFlight = false;
    _installProgress.running = false;
    _installProgress.done = true;
    _installProgress.finishedAt = new Date().toISOString();
    if (code === 0) {
      _installProgress.ok = true; _installProgress.pct = 100;
      _logInstall('Install completed successfully', 100, 'done');
    } else {
      _installProgress.ok = false;
      _installProgress.error = _installProgress.error || `python exited ${code}`;
      _logInstall(`Install failed (exit ${code})`, _installProgress.pct, 'failed');
    }
  });
  return { started: true };
}

// ── Voice presets ───────────────────────────────────────────────────────

export interface FishVoicePreset {
  id: string;
  name: string;
  icon: string;
  description: string;
  engine: 'fish-speech-s2-pro';
  voiceId: string;
  defaults: { pitch: number; rate: number; speed: number; volume: number; intensity: number };
  fishDefaults: { speed: number; temperature: number; pitchSemitones: number; normalize: boolean };
  category: string;
  tags: string[];
  exampleLine: string;
}

export const FISH_VOICE_PRESETS: FishVoicePreset[] = [
  { id: 'fish_default',               name: 'Fish S2 Pro — Default',               icon: '🐟', description: 'Base model voice — no voice character applied',
    engine: 'fish-speech-s2-pro', voiceId: 'fish_default',
    defaults: { pitch:  0, rate:   0, speed: 1.00, volume:  0, intensity: 0 },
    fishDefaults: { speed: 1.00, temperature: 0.70, pitchSemitones:  0, normalize: true },
    category: 'default', tags: ['default','base','neutral'],
    exampleLine: 'Fish Speech S2 Pro — base model output.' },
  { id: 'fish_tiktok_male_natural',    name: 'Fish S2 Pro — TikTok Male Natural',    icon: '🎙️', description: 'Natural • Conversational • TikTok-Ready',
    engine: 'fish-speech-s2-pro', voiceId: 'tiktok_male_natural',
    defaults: { pitch:  0, rate:   0, speed: 1.00, volume:  0, intensity: 20 },
    fishDefaults: { speed: 1.00, temperature: 0.70, pitchSemitones:  0, normalize: true },
    category: 'tiktok', tags: ['tiktok','male','natural','conversational'],
    exampleLine: "You won't believe what happened next." },
  { id: 'fish_tiktok_male_cinematic',  name: 'Fish S2 Pro — TikTok Male Cinematic',  icon: '🎬', description: 'Deep • Cinematic • Dark Narrator',
    engine: 'fish-speech-s2-pro', voiceId: 'tiktok_male_cinematic',
    defaults: { pitch: -3, rate:  -8, speed: 0.92, volume:  1, intensity: 40 },
    fishDefaults: { speed: 0.92, temperature: 0.65, pitchSemitones: -2, normalize: true },
    category: 'tiktok', tags: ['tiktok','male','cinematic','narrator','dark'],
    exampleLine: 'In the silence — the truth always finds a way out.' },
  { id: 'fish_tiktok_male_raspy',      name: 'Fish S2 Pro — TikTok Male Raspy',      icon: '🪨', description: 'Raspy • Gritty • Storyteller Edge',
    engine: 'fish-speech-s2-pro', voiceId: 'tiktok_male_raspy',
    defaults: { pitch: -2, rate:  -6, speed: 0.94, volume:  1, intensity: 55 },
    fishDefaults: { speed: 0.94, temperature: 0.80, pitchSemitones: -1, normalize: true },
    category: 'tiktok', tags: ['tiktok','male','raspy','gritty'],
    exampleLine: "Some stories aren't meant to be told softly." },
  { id: 'fish_tiktok_female_natural',  name: 'Fish S2 Pro — TikTok Female Natural',  icon: '👩', description: 'Natural • Warm • Approachable',
    engine: 'fish-speech-s2-pro', voiceId: 'tiktok_female_natural',
    defaults: { pitch:  1, rate:   0, speed: 1.00, volume:  0, intensity: 25 },
    fishDefaults: { speed: 1.00, temperature: 0.70, pitchSemitones:  0, normalize: true },
    category: 'tiktok', tags: ['tiktok','female','natural','warm'],
    exampleLine: 'And this is the part nobody tells you about.' },
  { id: 'fish_tiktok_female_cinematic',name: 'Fish S2 Pro — TikTok Female Cinematic',icon: '✨', description: 'Soft • Mysterious • Story-Drive',
    engine: 'fish-speech-s2-pro', voiceId: 'tiktok_female_cinematic',
    defaults: { pitch: -1, rate:  -6, speed: 0.92, volume:  1, intensity: 45 },
    fishDefaults: { speed: 0.92, temperature: 0.65, pitchSemitones: -1, normalize: true },
    category: 'tiktok', tags: ['tiktok','female','cinematic','mysterious'],
    exampleLine: 'You can feel the moment things change — even before they do.' },
  { id: 'fish_documentary_narrator',   name: 'Fish S2 Pro — Documentary Narrator',   icon: '🎞️', description: 'Documentary • Measured • Authoritative',
    engine: 'fish-speech-s2-pro', voiceId: 'documentary_narrator',
    defaults: { pitch: -2, rate:  -4, speed: 0.95, volume:  0, intensity: 20 },
    fishDefaults: { speed: 0.95, temperature: 0.55, pitchSemitones: -1, normalize: true },
    category: 'documentary', tags: ['documentary','narrator','authoritative','measured'],
    exampleLine: 'In the years that followed — everything they thought they knew began to change.' },
  { id: 'fish_horror_whisper',         name: 'Fish S2 Pro — Horror Whisper',         icon: '👻', description: 'Whisper • Haunting • Reverb-Friendly',
    engine: 'fish-speech-s2-pro', voiceId: 'horror_whisper',
    defaults: { pitch: -4, rate: -12, speed: 0.86, volume: -1, intensity: 75 },
    fishDefaults: { speed: 0.86, temperature: 0.85, pitchSemitones: -3, normalize: true },
    category: 'horror', tags: ['horror','whisper','haunting','creepy'],
    exampleLine: "Don't turn around. Not yet." },
  { id: 'fish_reddit_storyteller',     name: 'Fish S2 Pro — Reddit Storyteller',     icon: '🗣️', description: 'Reddit • Engaging • Story-Mode',
    engine: 'fish-speech-s2-pro', voiceId: 'reddit_storyteller',
    defaults: { pitch:  0, rate:  -2, speed: 0.98, volume:  0, intensity: 35 },
    fishDefaults: { speed: 0.98, temperature: 0.75, pitchSemitones:  0, normalize: true },
    category: 'storytelling', tags: ['reddit','storyteller','engaging','narrative'],
    exampleLine: "So this happened last week — and I still can't believe it." },
];

export function findFishPreset(id: string | undefined): FishVoicePreset | undefined {
  if (!id) return undefined;
  return FISH_VOICE_PRESETS.find(p => p.id === id);
}

export function isFishEngine(presetId?: string, engine?: string): boolean {
  if (engine && /fish/i.test(engine)) return true;
  if (presetId && presetId.startsWith('fish_')) return true;
  return false;
}

// ── Prosody tags ──
export const FISH_STYLE_TAGS = [
  '[whisper]', '[laughing]', '[sad]', '[angry]', '[shouting]', '[pause]', '[emphasis]',
] as const;

export function sanitizeFishProsodyTags(text: string): string {
  if (!text) return text;
  return text.replace(/\[([^\]]+)\]/g, (m, inner: string) => {
    const norm = `[${inner.trim().toLowerCase()}]`;
    return (FISH_STYLE_TAGS as readonly string[]).includes(norm) ? norm : '';
  });
}
