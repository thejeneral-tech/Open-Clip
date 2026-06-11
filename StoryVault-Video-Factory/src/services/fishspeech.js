'use strict';
// Fish Speech S2-Pro (GGUF) integration via s2.cpp.
//
// The model repo (rodrigomt/s2-pro-gguf) ships 7 GGUF quantizations (2.4–9.3 GB
// EACH) + a tokenizer. Each GGUF is a SINGLE self-contained file (transformer +
// audio codec together). The runtime is s2.cpp — a C++/GGML engine. We:
//   • download ONE quant (default q4_k_m, CPU-friendly) + tokenizer.json,
//   • synthesise with the s2 CLI: s2 --model <gguf> --tokenizer <tok>
//        --text <text> --output <wav> [--prompt-audio ref --prompt-text txt],
//   • optionally build s2.cpp from source (needs git + cmake + a C++ compiler).
// Narration falls back to SAPI when the engine isn't ready.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { FISH, PATHS } = require('../config');
const { atomicWriteJson, readJson } = require('../util/atomicIo');

const PYTHON = FISH.python;
const REPO = 'rodrigomt/s2-pro-gguf';
const S2_REPO_URL = 'https://github.com/rodrigomatta/s2.cpp.git';
const QUANTS = ['q2_k', 'q3_k', 'q4_k_m', 'q5_k_m', 'q6_k', 'q8_0', 'f16'];
const DEFAULT_QUANT = 'q4_k_m';
const SETTINGS_FILE = path.join(PATHS.data, 'fish-settings.json');
const ENGINE_DIR = path.join(PATHS.models, 's2.cpp'); // where we clone/build the engine

// Persistent server: model loads ONCE and stays resident (vs. reloading 2.6 GB +
// ~10 s codec init on every clip). A loopback FISH_TTS_URL runs a LOCAL s2 --server
// child; a non-loopback URL means "use my remote GPU box" and is never spawned here.
const SERVER_URL = (process.env.FISH_TTS_URL || FISH.ttsUrl || 'http://127.0.0.1:8080').replace(/\/+$/, '');
function serverPort() { const m = SERVER_URL.match(/:(\d+)/); return m ? m[1] : '8080'; }
function serverHost() { try { return new URL(SERVER_URL).hostname; } catch { return '127.0.0.1'; } }
function remoteConfigured() {
  if (!process.env.FISH_TTS_URL) return false;
  const h = serverHost();
  return !(h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0');
}
// GPU selection for the LOCAL server child. The CPU-only Windows build ignores these
// (and would fail on --cuda with no CUDA backend), so default to CPU; the Linux GPU
// box sets FISH_GPU=cuda. Env: FISH_GPU=cuda|vulkan|cpu, FISH_GPU_DEVICE, FISH_GPU_LAYERS.
function gpuArgs() {
  const mode = (process.env.FISH_GPU || 'cpu').toLowerCase();
  const dev = process.env.FISH_GPU_DEVICE || '0';
  const layers = process.env.FISH_GPU_LAYERS || '-1'; // -1 = auto (offload all that fit)
  if (mode === 'cuda') return ['--cuda', dev, '--gpu-layers', layers];
  if (mode === 'vulkan') return ['--vulkan', dev, '--gpu-layers', layers];
  return []; // cpu
}

const saved = readJson(SETTINGS_FILE, {}) || {};
const state = {
  modelDir: saved.modelDir || FISH.modelDir,
  quant: QUANTS.includes(saved.quant) ? saved.quant : DEFAULT_QUANT,
  s2Bin: saved.s2Bin || FISH.s2Bin,
};

let downloadProc = null;
let buildProc = null;
let serverProc = null;     // long-lived `s2 --server` child (local mode)
let serverStarting = null; // single-flight startup promise

// ── Log ring (backs the "View Fish Logs" panel) ───────────────────────────────
const LOG_MAX = 600;
const logRing = [];
function plog(line) {
  const s = String(line || '').replace(/\s+$/g, '');
  if (!s) return;
  for (const part of s.split(/\r?\n/)) { if (part.trim()) logRing.push(`[${new Date().toISOString().slice(11, 19)}] ${part}`); }
  while (logRing.length > LOG_MAX) logRing.shift();
}
function getLogs() { return logRing.slice(); }
function clearLogs() { logRing.length = 0; }

function persist() {
  try { atomicWriteJson(SETTINGS_FILE, { modelDir: state.modelDir, quant: state.quant, s2Bin: state.s2Bin }); } catch { /* ignore */ }
}
function getModelDir() { return state.modelDir; }

// ── model files ───────────────────────────────────────────────────────────────
function ggufName(q) { return `s2-pro-${q}.gguf`; }
function ggufPath() {
  const chosen = path.join(state.modelDir, ggufName(state.quant));
  if (fs.existsSync(chosen)) return chosen;
  try {
    const f = fs.readdirSync(state.modelDir).find((x) => /^s2-pro-.*\.gguf$/i.test(x)) || fs.readdirSync(state.modelDir).find((x) => /\.gguf$/i.test(x));
    return f ? path.join(state.modelDir, f) : null;
  } catch { return null; }
}
function tokenizerPath() {
  const p = path.join(state.modelDir, 'tokenizer.json');
  return fs.existsSync(p) ? p : null;
}
function listModelFiles() {
  try { return fs.readdirSync(state.modelDir).filter((f) => /\.(gguf|json)$/i.test(f)); }
  catch { return []; }
}
function modelPresent() { return !!ggufPath(); }

// ── engine binary ─────────────────────────────────────────────────────────────
// Must be a regular file: a folder path (e.g. the s2.cpp source dir pasted into
// "Set engine binary") exists but can't be spawned — ENOENT at synth time.
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function binPath() {
  if (state.s2Bin && isFile(state.s2Bin)) return state.s2Bin;
  const cands = [
    path.join(ENGINE_DIR, 'build', 's2.exe'),
    path.join(ENGINE_DIR, 'build', 'Release', 's2.exe'),
    path.join(ENGINE_DIR, 'build', 'bin', 's2.exe'),
    path.join(ENGINE_DIR, 'build', 'bin', 'Release', 's2.exe'),
    path.join(ENGINE_DIR, 'build', 's2'),
    path.join(ENGINE_DIR, 'build', 'bin', 's2'),
  ];
  for (const c of cands) { if (isFile(c)) return c; }
  return null;
}
function binConfigured() { return !!binPath(); }
// "Can we synthesize right now?" — a remote GPU server counts even without a local
// binary; otherwise we need a local binary + model + tokenizer to spawn the server.
function engineReady() { return remoteConfigured() || (!!binPath() && modelPresent() && !!tokenizerPath()); }

// These run synchronously (spawnSync) in the request path, so they MUST be
// bounded: a hung python.exe/git (cold start under OneDrive/AV) would otherwise
// block the whole Node event loop and freeze the server. `timeout` kills a stuck
// probe; the result is cached briefly so status polls don't re-spawn every time.
let _hfCache = null; // { val, at }
function huggingfaceAvailable() {
  const now = Date.now();
  if (_hfCache && (now - _hfCache.at) < 30000) return _hfCache.val;
  let val = false;
  try { val = spawnSync(PYTHON, ['-c', 'import huggingface_hub'], { windowsHide: true, timeout: 8000 }).status === 0; }
  catch { val = false; }
  _hfCache = { val, at: now };
  return val;
}
function hasCmd(cmd) {
  try { const r = spawnSync(cmd, ['--version'], { windowsHide: true, timeout: 8000 }); return r.status === 0 || (r.status != null && !r.error); }
  catch { return false; }
}

async function status() {
  return {
    repo: REPO,
    modelDir: state.modelDir,
    quant: state.quant,
    quants: QUANTS,
    hubInstalled: huggingfaceAvailable(),
    modelPresent: modelPresent(),
    gguf: ggufPath() ? path.basename(ggufPath()) : null,
    tokenizer: tokenizerPath() ? 'tokenizer.json' : null,
    binConfigured: binConfigured(),
    s2Bin: binPath() || state.s2Bin || null,
    engineReady: engineReady(),
    files: listModelFiles(),
    serverUrl: SERVER_URL,
    remote: remoteConfigured(),
    gpu: (process.env.FISH_GPU || 'cpu').toLowerCase(),
    serverRunning: !!serverProc || (remoteConfigured() ? await reachable(SERVER_URL) : false),
  };
}

// Point at an existing model folder, or set the engine binary path.
function setModelDir(dir) {
  if (!dir) throw new Error('No folder selected.');
  if (!fs.existsSync(dir)) throw new Error(`Folder not found: ${dir}`);
  state.modelDir = dir; persist(); plog(`Model folder set to ${dir}`);
  return status();
}
function setBin(bin) {
  if (bin && !fs.existsSync(bin)) throw new Error(`File not found: ${bin}`);
  if (bin && !isFile(bin)) throw new Error(`That path is a folder, not the engine executable — point at the s2 binary itself (e.g. …\\s2.cpp\\build\\s2.exe).`);
  state.s2Bin = bin || ''; persist(); plog(`Engine binary set to ${bin || '(none)'}`);
  return status();
}
function setQuant(q) { if (QUANTS.includes(q)) { state.quant = q; persist(); } return state.quant; }

// ── download ONE quant + tokenizer ────────────────────────────────────────────
function download({ quant, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (downloadProc) return reject(new Error('A download is already in progress.'));
    if (!huggingfaceAvailable()) {
      return reject(new Error('huggingface_hub is not installed for this Python. Run: pip install -U "huggingface_hub[hf_xet]".'));
    }
    const q = QUANTS.includes(quant) ? quant : state.quant;
    state.quant = q; persist();
    fs.mkdirSync(state.modelDir, { recursive: true });
    const fname = ggufName(q);
    plog(`Downloading ${fname} + tokenizer.json (quant ${q}) → ${state.modelDir}`);
    const code = `from huggingface_hub import hf_hub_download
import sys
files = [${JSON.stringify(fname)}, "tokenizer.json"]
for fn in files:
    print("FILE: " + fn, flush=True)
    p = hf_hub_download(repo_id=${JSON.stringify(REPO)}, filename=fn, local_dir=${JSON.stringify(state.modelDir)})
    print("SAVED: " + p, flush=True)
print("DONE", flush=True)`;
    downloadProc = spawn(PYTHON, ['-u', '-c', code], { windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HUB_ENABLE_HF_TRANSFER: '0' } });
    let err = '';
    const onLine = (s) => { plog(s); if (onProgress) onProgress(s); };
    downloadProc.stdout.on('data', (d) => onLine(d.toString()));
    downloadProc.stderr.on('data', (d) => { const s = d.toString(); if (err.length < 262144) err += s; onLine(s); });
    downloadProc.on('error', (e) => { downloadProc = null; reject(new Error(`Could not launch the downloader (${e.message}).`)); });
    downloadProc.on('close', (codeN) => {
      downloadProc = null;
      if (codeN === 0 && modelPresent()) resolve({ ok: true, dir: state.modelDir, quant: q, files: listModelFiles() });
      else reject(new Error('Model download failed: ' + (err.split('\n').filter(Boolean).slice(-2).join(' ') || `exit ${codeN}`)));
    });
  });
}
function cancelDownload() { if (downloadProc) { try { downloadProc.kill(); } catch { /* */ } downloadProc = null; return { ok: true }; } return { ok: false }; }

// ── build s2.cpp from source (best-effort) ────────────────────────────────────
function buildEngine({ onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (buildProc) return reject(new Error('A build is already in progress.'));
    if (!hasCmd('git')) return reject(new Error('git is required to build the engine. Install Git, then retry.'));
    if (!hasCmd('cmake')) return reject(new Error('CMake is required to build the s2.cpp engine, and a C++ compiler (Visual Studio Build Tools on Windows). Install CMake + a C++ toolchain, then click "Build engine" again — or paste the path to a prebuilt s2 binary under "Set engine binary".'));
    const onLine = (s) => { plog(s); if (onProgress) onProgress(s); };
    fs.mkdirSync(path.dirname(ENGINE_DIR), { recursive: true });
    const steps = fs.existsSync(path.join(ENGINE_DIR, 'CMakeLists.txt'))
      ? [['git', ['-C', ENGINE_DIR, 'pull', '--recurse-submodules']]]
      : [['git', ['clone', '--recurse-submodules', S2_REPO_URL, ENGINE_DIR]]];
    steps.push(['cmake', ['-S', ENGINE_DIR, '-B', path.join(ENGINE_DIR, 'build'), '-DCMAKE_BUILD_TYPE=Release']]);
    steps.push(['cmake', ['--build', path.join(ENGINE_DIR, 'build'), '--config', 'Release', '-j']]);

    let i = 0;
    const runNext = () => {
      if (i >= steps.length) {
        buildProc = null;
        const b = binPath();
        if (b) { state.s2Bin = b; persist(); plog(`Engine built: ${b}`); resolve({ ok: true, bin: b }); }
        else reject(new Error('Build finished but the s2 binary was not found. Set its path manually under "Set engine binary".'));
        return;
      }
      const [cmd, args] = steps[i++];
      onLine(`>> ${cmd} ${args.join(' ')}`);
      buildProc = spawn(cmd, args, { windowsHide: true });
      buildProc.stdout.on('data', (d) => onLine(d.toString()));
      buildProc.stderr.on('data', (d) => onLine(d.toString()));
      buildProc.on('error', (e) => { buildProc = null; reject(new Error(`Build step failed (${e.message}).`)); });
      buildProc.on('close', (code) => {
        if (code === 0) runNext();
        else { buildProc = null; reject(new Error(`Build step "${cmd}" exited with code ${code}. See the logs.`)); }
      });
    };
    runNext();
  });
}

// Repair = re-validate, non-destructive. Returns FAST and NEVER blocks the HTTP
// request on a multi-GB model download (doing so froze the UI/app). When the model
// is missing it returns { needsDownload: true } and the route kicks the download
// off in the background, streaming progress over the `fish` SSE channel.
async function repair() {
  plog('Repair: validating Fish Speech engine…');
  // Drop a stale engine-binary path that no longer exists (or is a folder) so status reflects reality.
  if (state.s2Bin && !isFile(state.s2Bin)) { plog(`Repair: clearing stale engine path ${state.s2Bin}`); state.s2Bin = ''; persist(); }
  if (!modelPresent()) {
    if (downloadProc) return { ok: false, busy: true, reason: 'A model download is already running — watch progress in the Fish logs.' };
    if (!huggingfaceAvailable()) {
      return { ok: false, reason: 'Model missing and huggingface_hub isn\'t installed for this Python. Run: pip install -U "huggingface_hub[hf_xet]", then click Repair again.' };
    }
    return { ok: false, needsDownload: true, reason: 'Model missing — download started in the background. Watch the Fish logs; click Repair again once it finishes.' };
  }
  if (!binConfigured()) {
    return { ok: false, reason: 'Model present, but the s2.cpp engine binary isn\'t built. Click "Build engine" (needs CMake + a C++ compiler) or set its path under "Set engine binary". Narration uses SAPI until then.' };
  }
  return { ok: engineReady(), reason: engineReady() ? 'Engine ready.' : 'Engine still not ready — check the Fish logs.' };
}

// ── persistent s2 --server lifecycle ──────────────────────────────────────────
// A GET that resolves at all (even 404) means the socket is bound and weights are
// loaded — the s2 server binds only AFTER the model is ready.
async function reachable(url, ms = 2000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(url, { signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    return !!res;
  } catch { return false; }
}

// Ensure a synth-capable server is reachable. Remote URL → use it as-is. Local →
// reuse a running child or spawn one (single-flight; multi-GB weights take a while).
function ensureServer() {
  if (serverStarting) return serverStarting;
  serverStarting = (async () => {
    if (await reachable(SERVER_URL)) return SERVER_URL;
    if (remoteConfigured()) {
      throw new Error(`Fish server not reachable at ${SERVER_URL} (FISH_TTS_URL). Start "s2 --server" on that machine, or unset FISH_TTS_URL to run locally.`);
    }
    const bin = binPath();
    if (!bin) throw new Error('Fish Speech engine not built. Voice Lab → Setup → "Build engine", or set a prebuilt s2 binary. Narration falls back to SAPI until then.');
    const gguf = ggufPath();
    if (!gguf) throw new Error('No GGUF model found — download the model first (Voice Lab → Setup).');
    const tok = tokenizerPath() || path.join(state.modelDir, 'tokenizer.json');
    const args = ['--server', '--model', gguf, '--tokenizer', tok, '--host', '127.0.0.1', '--port', serverPort(), ...gpuArgs()];
    if (process.env.FISH_THREADS) args.push('--threads', String(process.env.FISH_THREADS));
    const extra = (process.env.FISH_S2_ARGS || '').trim();
    if (extra) args.push(...extra.split(/\s+/));
    plog(`Starting Fish server: ${path.basename(bin)} ${args.join(' ')}`);
    // stdio: drop stdout (verbose per-request logs that nothing reads would fill the
    // pipe and hang the engine); keep stderr for the log panel.
    serverProc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    serverProc.stderr && serverProc.stderr.on('data', (d) => plog(d.toString()));
    serverProc.on('exit', (code) => { plog(`Fish server exited (code ${code}).`); serverProc = null; });
    for (let i = 0; i < 240; i++) { // weights + codec load can take ~20s (CPU) to a few min cold off OneDrive/AV
      if (await reachable(SERVER_URL)) { plog(`Fish server ready at ${SERVER_URL}`); return SERVER_URL; }
      if (!serverProc) throw new Error('Fish server exited during startup — check the Fish logs (model complete? GPU backend available for FISH_GPU?).');
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('Fish server did not become reachable within 240s.');
  })();
  serverStarting.catch(() => {}).finally(() => { serverStarting = null; });
  return serverStarting;
}
async function startServer() { await ensureServer(); return { ok: true, url: SERVER_URL, remote: remoteConfigured() }; }
function stopServer() { if (serverProc) { try { serverProc.kill(); } catch { /* */ } serverProc = null; return { ok: true }; } return { ok: false, reason: 'not running' }; }
// Windows won't reap the engine child when the app exits — kill it so it doesn't leak RAM.
process.once('exit', () => { if (serverProc) { try { serverProc.kill(); } catch { /* */ } } });

// ── synthesis via the persistent s2 server ────────────────────────────────────
// opts: { temperature, refPath (clone reference clip), promptText|refText (its
// transcript), voice (a SAPI name — ignored for Fish) }. The server takes ONE synth
// at a time (HTTP 503 otherwise), so serialize every call through this promise chain.
let synthQueue = Promise.resolve();
function synth(text, outWav, opts = {}) {
  const result = synthQueue.then(() => synthOnce(text, outWav, opts));
  synthQueue = result.catch(() => {}); // next call waits for this one to settle (errors swallowed for the chain)
  return result;
}

async function synthOnce(text, outWav, opts = {}) {
  const promptText = String((opts.promptText != null ? opts.promptText : opts.refText) || '').trim();
  // Cloning needs a reference clip AND its transcript; the engine 400s without the
  // transcript, so degrade to plain synthesis instead of failing the render.
  let refPath = opts.refPath || null;
  if (refPath && (!fs.existsSync(refPath) || !promptText)) {
    plog('Synth warning: reference audio missing or has no transcript — synthesizing without the voice reference.');
    refPath = null;
  }
  await ensureServer();
  const refBytes = refPath ? fs.readFileSync(refPath) : null;
  // segment_sentences = render sentence-by-sentence: long scripts never truncate at
  // max_new_tokens, and per-utterance synthesis is exactly how Fish keeps quality.
  const params = {
    temperature: opts.temperature != null ? Number(opts.temperature) : Number(process.env.FISH_TEMPERATURE || 0.7),
    top_p: 0.8,
    top_k: 30,
    max_new_tokens: Number(process.env.FISH_MAX_TOKENS || 2048),
    segment_sentences: true,
    segment_max_chars: Number(process.env.FISH_SEGMENT_CHARS || 240),
    sentence_pause_ms: Number(process.env.FISH_SENTENCE_PAUSE_MS || 180),
  };
  const buildBody = (boundary) => {
    const parts = [
      { name: 'text', value: String(text) },
      { name: 'params', value: JSON.stringify(params) },
    ];
    if (refPath) {
      parts.push({ name: 'reference', filename: path.basename(refPath), data: refBytes });
      parts.push({ name: 'reference_text', value: promptText });
    }
    return encodeMultipart(parts, boundary);
  };
  plog(`Synth → ${SERVER_URL}/generate: "${String(text).slice(0, 48)}…" (${String(text).length} chars) → ${path.basename(outWav)}`);

  let resp;
  for (let attempt = 0; ; attempt++) {
    const boundary = '----storyvaults2' + Date.now().toString(16) + attempt;
    try { resp = await postMultipart(SERVER_URL + '/generate', boundary, buildBody(boundary)); }
    catch (e) { throw new Error(`Fish synthesis failed (${e.message}). Server ${SERVER_URL}.`); }
    if (resp.status !== 503 || attempt >= 1800) break; // 503 = busy with another synth — wait it out
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (resp.status < 200 || resp.status >= 300) {
    const detail = resp.body.toString('utf8').slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new Error(`Fish synthesis failed (HTTP ${resp.status}${detail ? ': ' + detail : ''}).`);
  }
  if (!resp.body || resp.body.length < 256) throw new Error('Fish synthesis returned an unexpectedly small audio response.');
  fs.writeFileSync(outWav, resp.body);
  return { path: outWav };
}

// Build a multipart/form-data body. parts: { name, value } text field, or
// { name, filename, data:Buffer } binary file field.
function encodeMultipart(parts, boundary) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.filename != null) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
      chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
      chunks.push(Buffer.from(String(p.value)));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

// POST a multipart body via node:http(s) with NO response-headers timeout. The s2
// server sends headers only AFTER synthesis, which can take minutes — Node's global
// fetch() (undici) aborts at a 300s headers timeout even though valid audio is coming.
// FISH_SYNTH_TIMEOUT_MS (default 30 min) is a backstop against a truly hung server.
function postMultipart(urlStr, boundary, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      const bufs = [];
      res.on('data', (d) => bufs.push(d));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(bufs) }));
    });
    // 4h default: on a slow CPU long-form synthesis runs ~45x realtime (codec decode dominates),
    // so a 5-minute narration can take ~3.5h. The socket is idle the whole time (s2 sends headers
    // only when done), so this must cover the ENTIRE synth, not just stalls. Raise it further via
    // FISH_SYNTH_TIMEOUT_MS on very slow boxes, or it falls back to SAPI mid-video.
    req.setTimeout(Number(process.env.FISH_SYNTH_TIMEOUT_MS || 4 * 60 * 60 * 1000), () => req.destroy(new Error('synthesis timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  status, download, cancelDownload, buildEngine, repair, synth, modelPresent, engineReady,
  getLogs, clearLogs, setModelDir, setBin, setQuant, getModelDir, binPath,
  startServer, stopServer, ensureServer, reachable,
  REPO, QUANTS, DEFAULT_QUANT, ENGINE_DIR, SERVER_URL,
};
