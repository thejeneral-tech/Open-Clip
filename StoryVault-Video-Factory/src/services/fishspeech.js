'use strict';
// Fish Speech S2-Pro (GGUF) integration. Downloads the model locally from Hugging Face
// (rodrigomt/s2-pro-gguf) via the installed huggingface_hub, can start a local s2 GGUF
// inference server when its binary is configured, and synthesises (incl. voice cloning via a
// reference prompt) over HTTP. Falls back cleanly to SAPI when the runtime isn't available.
//
// Ported from TrendVault's fishSpeechS2Pro runtime: server on 127.0.0.1:8080, POST {text,
// prompt_audio_path, temperature, top_p, top_k, format:'wav'} → WAV bytes.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../config');

const PYTHON = process.env.PYTHON_PATH || 'python';
const REPO = 'rodrigomt/s2-pro-gguf';
const MODEL_DIR = process.env.FISH_MODEL_DIR || path.join(ROOT, 'data', 'models', 's2-pro-gguf');
const SERVER_URL = process.env.FISH_TTS_URL || 'http://127.0.0.1:8080';
const S2_BIN = process.env.FISH_S2_BIN || '';        // path to the s2.cpp server binary, if installed
const ROUTES = ['/v1/tts', '/tts', '/synthesize', '/v1/audio/speech'];

let serverProc = null;

function listModelFiles() {
  try { return fs.readdirSync(MODEL_DIR).filter((f) => /\.(gguf|json|txt|tiktoken|model)$/i.test(f)); }
  catch { return []; }
}
function findFile(re) { return listModelFiles().find((f) => re.test(f)) || null; }
function modelPresent() { return !!findFile(/\.gguf$/i); }

function huggingfaceAvailable() {
  try { return spawnSync(PYTHON, ['-c', 'import huggingface_hub'], { windowsHide: true }).status === 0; }
  catch { return false; }
}

async function reachable(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(url, { signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    return !!res;
  } catch { return false; }
}

async function status() {
  const files = listModelFiles();
  return {
    repo: REPO,
    modelDir: MODEL_DIR,
    hubInstalled: huggingfaceAvailable(),
    modelPresent: modelPresent(),
    files,
    transformer: findFile(/transformer|q4_k_m(?!.*codec)/i) || findFile(/\.gguf$/i),
    codec: findFile(/codec/i),
    tokenizer: findFile(/tokenizer|\.tiktoken$/i),
    serverUrl: SERVER_URL,
    serverConfigured: !!S2_BIN,
    serverRunning: !!serverProc || await reachable(SERVER_URL),
  };
}

// Download the GGUF model locally. onProgress(line) streams pip/hub output.
function download({ onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!huggingfaceAvailable()) {
      return reject(new Error('huggingface_hub is not installed for this Python. Run: pip install -U "huggingface_hub[hf_xet]".'));
    }
    fs.mkdirSync(MODEL_DIR, { recursive: true });
    const code = `from huggingface_hub import snapshot_download
import sys
p = snapshot_download(repo_id=${JSON.stringify(REPO)}, local_dir=${JSON.stringify(MODEL_DIR)})
print("DONE:"+p)`;
    const ps = spawn(PYTHON, ['-u', '-c', code], { windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HUB_ENABLE_HF_TRANSFER: '0' } });
    let err = '';
    ps.stdout.on('data', (d) => { const s = d.toString(); if (onProgress) onProgress(s); });
    ps.stderr.on('data', (d) => { const s = d.toString(); err += s; if (onProgress) onProgress(s); });
    ps.on('error', (e) => reject(new Error(`Could not launch the downloader (${e.message}).`)));
    ps.on('close', (codeN) => {
      if (codeN === 0 && modelPresent()) resolve({ ok: true, dir: MODEL_DIR, files: listModelFiles() });
      else reject(new Error('Model download failed: ' + (err.split('\n').filter(Boolean).slice(-2).join(' ') || `exit ${codeN}`)));
    });
  });
}

// Start the local GGUF inference server (requires FISH_S2_BIN). No-op if already reachable.
async function startServer() {
  if (await reachable(SERVER_URL)) return { ok: true, already: true, url: SERVER_URL };
  if (!S2_BIN || !fs.existsSync(S2_BIN)) {
    throw new Error('No Fish Speech server binary configured. Set FISH_S2_BIN to the s2 GGUF server executable (or point FISH_TTS_URL at an external Fish server).');
  }
  if (!modelPresent()) throw new Error('Model not downloaded yet — download it first.');
  const port = (SERVER_URL.match(/:(\d+)/) || [])[1] || '8080';
  const args = [
    '--model', path.join(MODEL_DIR, findFile(/transformer|\.gguf$/i)),
    '--model-codec', path.join(MODEL_DIR, findFile(/codec/i) || findFile(/\.gguf$/i)),
    '--tokenizer', path.join(MODEL_DIR, findFile(/tokenizer|\.tiktoken$/i) || 'tokenizer.json'),
    '--host', '127.0.0.1', '--port', port,
  ];
  serverProc = spawn(S2_BIN, args, { windowsHide: true, detached: false });
  serverProc.on('exit', () => { serverProc = null; });
  // wait up to 30s for it to answer
  for (let i = 0; i < 30; i++) { if (await reachable(SERVER_URL)) return { ok: true, url: SERVER_URL }; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error('Fish Speech server did not become reachable within 30s.');
}
function stopServer() {
  if (serverProc) { try { serverProc.kill(); } catch { /* */ } serverProc = null; return { ok: true }; }
  return { ok: false, reason: 'not running' };
}

// Synthesise to a WAV file. opts: { voice, speed, temperature, refPath (clone reference) }.
async function synth(text, outWav, opts = {}) {
  const body = {
    text: String(text), format: 'wav',
    temperature: opts.temperature != null ? opts.temperature : 0.3, top_p: 0.8, top_k: 20,
  };
  if (opts.refPath) body.prompt_audio_path = opts.refPath;     // voice cloning reference
  let lastErr = '';
  for (const route of ROUTES) {
    try {
      const res = await fetch(SERVER_URL + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { lastErr = `HTTP ${res.status} on ${route}`; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 256) { lastErr = `tiny response on ${route}`; continue; }
      fs.writeFileSync(outWav, buf);
      return { path: outWav, route };
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(`Fish Speech synthesis failed (${lastErr}). Is the server running at ${SERVER_URL}?`);
}

module.exports = { status, download, startServer, stopServer, synth, modelPresent, MODEL_DIR, REPO, SERVER_URL };
