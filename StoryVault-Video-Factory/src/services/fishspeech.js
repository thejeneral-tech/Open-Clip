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
const { FISH, PATHS } = require('../config');
const { atomicWriteJson, readJson } = require('../util/atomicIo');

const PYTHON = FISH.python;
const REPO = 'rodrigomt/s2-pro-gguf';
const S2_REPO_URL = 'https://github.com/rodrigomatta/s2.cpp.git';
const QUANTS = ['q2_k', 'q3_k', 'q4_k_m', 'q5_k_m', 'q6_k', 'q8_0', 'f16'];
const DEFAULT_QUANT = 'q4_k_m';
const SETTINGS_FILE = path.join(PATHS.data, 'fish-settings.json');
const ENGINE_DIR = path.join(PATHS.models, 's2.cpp'); // where we clone/build the engine

const saved = readJson(SETTINGS_FILE, {}) || {};
const state = {
  modelDir: saved.modelDir || FISH.modelDir,
  quant: QUANTS.includes(saved.quant) ? saved.quant : DEFAULT_QUANT,
  s2Bin: saved.s2Bin || FISH.s2Bin,
};

let downloadProc = null;
let buildProc = null;

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
function binPath() {
  if (state.s2Bin && fs.existsSync(state.s2Bin)) return state.s2Bin;
  const cands = [
    path.join(ENGINE_DIR, 'build', 's2.exe'),
    path.join(ENGINE_DIR, 'build', 'Release', 's2.exe'),
    path.join(ENGINE_DIR, 'build', 'bin', 's2.exe'),
    path.join(ENGINE_DIR, 'build', 'bin', 'Release', 's2.exe'),
    path.join(ENGINE_DIR, 'build', 's2'),
    path.join(ENGINE_DIR, 'build', 'bin', 's2'),
  ];
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  return null;
}
function binConfigured() { return !!binPath(); }
function engineReady() { return !!binPath() && modelPresent() && !!tokenizerPath(); }

function huggingfaceAvailable() {
  try { return spawnSync(PYTHON, ['-c', 'import huggingface_hub'], { windowsHide: true }).status === 0; }
  catch { return false; }
}
function hasCmd(cmd) {
  try { const r = spawnSync(cmd, ['--version'], { windowsHide: true }); return r.status === 0 || (r.status != null && !r.error); }
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
    downloadProc.stderr.on('data', (d) => { const s = d.toString(); err += s; onLine(s); });
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

// Repair = re-validate; re-download model if missing. Non-destructive.
async function repair() {
  plog('Repair: validating Fish Speech engine…');
  if (!modelPresent()) {
    plog('Repair: model missing — downloading…');
    try { await download({}); } catch (e) { return { ok: false, reason: e.message }; }
  }
  if (!binConfigured()) {
    return { ok: false, reason: 'Engine binary not found. Click "Build engine" (needs CMake + a C++ compiler) or set its path under "Set engine binary".' };
  }
  return { ok: engineReady(), reason: engineReady() ? 'Engine ready.' : 'Engine still not ready — check the logs.' };
}

// ── synthesis via the s2 CLI ──────────────────────────────────────────────────
// opts: { temperature, refPath (clone reference), promptText (reference transcript) }
function synth(text, outWav, opts = {}) {
  return new Promise((resolve, reject) => {
    const bin = binPath();
    if (!bin) return reject(new Error('Fish Speech engine not built. On Voice Lab → Setup, click "Build engine" (needs CMake + a C++ compiler) or set a prebuilt s2 binary path. Narration falls back to SAPI until then.'));
    const gguf = ggufPath();
    if (!gguf) return reject(new Error('No GGUF model found — download the model first (Voice Lab → Setup).'));
    const tok = tokenizerPath() || path.join(state.modelDir, 'tokenizer.json');
    const args = ['--model', gguf, '--tokenizer', tok, '--text', String(text), '--output', outWav];
    // The s2 engine clones from reference audio + its transcript and REJECTS a
    // reference without one ("prompt audio was provided without prompt text").
    // Only pass the reference when we also have a transcript; otherwise fall back
    // to non-cloned synthesis so a missing transcript degrades instead of crashing.
    const promptText = opts.promptText == null ? '' : String(opts.promptText).trim();
    if (opts.refPath && promptText) { args.push('--prompt-audio', opts.refPath, '--prompt-text', promptText); }
    else if (opts.refPath) { plog('Synth warning: reference audio provided without a transcript — synthesizing without the voice reference.'); }
    if (opts.temperature != null) args.push('--temperature', String(opts.temperature));
    // Extra engine flags (e.g. "-v 0" for Vulkan GPU) via env.
    const extra = (process.env.FISH_S2_ARGS || '').trim();
    if (extra) args.push(...extra.split(/\s+/));
    plog(`Synth: ${path.basename(bin)} --text "${String(text).slice(0, 40)}…" → ${path.basename(outWav)}`);
    let err = '';
    let ps;
    try { ps = spawn(bin, args, { windowsHide: true }); }
    catch (e) { return reject(new Error(`Could not run the engine (${e.message}).`)); }
    ps.stdout && ps.stdout.on('data', (d) => plog(d.toString()));
    ps.stderr && ps.stderr.on('data', (d) => { const s = d.toString(); err += s; plog(s); });
    ps.on('error', (e) => reject(new Error(`Could not run the engine (${e.message}).`)));
    ps.on('close', (code) => {
      if (code === 0 && fs.existsSync(outWav) && fs.statSync(outWav).size > 256) resolve({ path: outWav });
      else reject(new Error(`Fish synthesis failed (exit ${code}). ${(err || '').split('\n').filter(Boolean).slice(-2).join(' ')}`));
    });
  });
}

module.exports = {
  status, download, cancelDownload, buildEngine, repair, synth, modelPresent, engineReady,
  getLogs, clearLogs, setModelDir, setBin, setQuant, getModelDir, binPath,
  REPO, QUANTS, DEFAULT_QUANT, ENGINE_DIR,
};
