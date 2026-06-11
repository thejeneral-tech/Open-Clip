'use strict';
// Narration (spec §14). Local Windows SAPI is the always-available provider; Fish
// Speech / Kokoro / Trend Vault hooks are pluggable via HTTP if configured. Real
// word-boundary timings are captured from SAPI for accurate captions; for other
// providers we estimate timings proportionally from syllable counts.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db/database');
const { id } = require('../util/ids');
const { PATHS, ROOT } = require('../config');
const fp = require('./fingerprint');
const text = require('../util/text');
const ff = require('./ffmpeg');
const log = require('./logger');

const POWERSHELL = process.env.POWERSHELL_PATH || 'powershell';
const PS_SCRIPT = path.join(ROOT, 'scripts', 'sapi-tts.ps1');

// Map a 0.5..1.5 speed multiplier + narration style to a SAPI rate (-10..10).
function sapiRate(speed = 1.0, style = '') {
  let rate = Math.round((speed - 1) * 10);
  const s = (style || '').toLowerCase();
  if (s.includes('dramatic') || s.includes('suspense')) rate -= 1;
  if (s.includes('funny')) rate += 1;
  return Math.max(-10, Math.min(10, rate));
}

function settingsHash(scriptText, opts) {
  // refPath + temperature identify WHICH cloned voice (and how it was sampled): for Fish
  // presets the `voice` field carries a SAPI name, so without these two different clones
  // hash identically and switching presets would silently reuse the wrong voice's audio.
  return fp.sha256([scriptText, opts.provider, opts.voice, opts.speed, opts.style, opts.refPath || '', opts.temperature != null ? opts.temperature : ''].join('|'));
}

async function listVoices() {
  // Best-effort: query SAPI; fall back to the two common desktop voices.
  return new Promise((resolve) => {
    const ps = spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | % { $_.VoiceInfo.Name }"], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.on('error', () => resolve(fallbackVoices()));
    ps.on('close', () => {
      const voices = out.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
      resolve(voices.length ? voices.map((name) => ({ name, provider: 'sapi' })) : fallbackVoices());
    });
  });
}
function fallbackVoices() { return [{ name: 'Microsoft Zira Desktop', provider: 'sapi' }, { name: 'Microsoft David Desktop', provider: 'sapi' }]; }
// When falling back from Fish to SAPI, make sure we hand SAPI a real SAPI voice name
// (a Fish/clone voice id would error). Default to a voice that ships on every Windows.
function sapiSafeVoice(v) { return /microsoft|desktop|zira|david|hazel|mark|eva|catherine|hortense|huihui/i.test(String(v || '')) ? v : 'Microsoft Zira Desktop'; }

// Run the SAPI helper → WAV + raw timing events.
function runSapi(scriptText, wavPath, timingsPath, { voice, speed, style }) {
  return new Promise((resolve, reject) => {
    const textFile = path.join(PATHS.tmp, `tts_${id('t')}.txt`);
    fs.writeFileSync(textFile, scriptText, 'utf8');
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT,
      '-TextFile', textFile, '-Out', wavPath, '-Voice', voice || '', '-Rate', String(sapiRate(speed, style)),
      '-TimingsOut', timingsPath];
    const ps = spawn(POWERSHELL, args, { windowsHide: true });
    let err = '';
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('error', (e) => { cleanup(textFile); reject(new Error(`Could not launch PowerShell for narration: ${e.message}`)); });
    ps.on('close', (code) => {
      cleanup(textFile);
      if (code === 0 && fs.existsSync(wavPath)) resolve();
      else reject(new Error(`SAPI narration failed (exit ${code}). ${err.split('\n').slice(-3).join(' ').trim()}`));
    });
  });
}
function cleanup(f) { try { fs.unlinkSync(f); } catch { /* */ } }

// Convert SAPI word events → normalized [{word,start,end}] using audio duration.
function buildTimingsFromSapi(rawPath, durationSec, scriptText) {
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(rawPath, 'utf8')); } catch { raw = []; }
  if (!Array.isArray(raw)) raw = [raw];
  raw = raw.filter((r) => r && r.word && r.word.trim());
  if (!raw.length) return estimateTimings(scriptText, durationSec);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const start = raw[i].audioMs / 1000;
    const end = i + 1 < raw.length ? raw[i + 1].audioMs / 1000 : durationSec;
    out.push({ word: raw[i].word.trim(), start: round(start), end: round(Math.max(start + 0.05, end)) });
  }
  return out;
}

// Proportional fallback timing (used when no boundary events are available).
function estimateTimings(scriptText, durationSec) {
  const words = String(scriptText).trim().split(/\s+/).filter(Boolean);
  const weights = words.map((w) => Math.max(1, text.syllables(w)) + (/[.,!?;:]$/.test(w) ? 1.2 : 0));
  const totalW = weights.reduce((a, b) => a + b, 0) || 1;
  let t = 0; const out = [];
  for (let i = 0; i < words.length; i++) {
    const dur = (weights[i] / totalW) * durationSec;
    out.push({ word: words[i].replace(/[^\w'’-]+$/, ''), start: round(t), end: round(t + dur) });
    t += dur;
  }
  return out;
}

function round(n) { return Math.round(n * 1000) / 1000; }

// Generate (or reuse) narration for a script. Returns the narration record.
async function generate(script, opts = {}) {
  const provider = opts.provider || 'sapi';
  const voice = opts.voice || 'Microsoft Zira Desktop';
  const speed = opts.speed != null ? opts.speed : 1.0;
  const style = opts.style || 'Calm storyteller';
  const scriptText = script.full_text;
  const hash = settingsHash(scriptText, { provider, voice, speed, style, refPath: opts.refPath, temperature: opts.temperature });

  // Reuse if identical settings already produced a still-present file (§14).
  const existing = db.get('SELECT * FROM narration WHERE script_id = ? AND settings_hash = ? ORDER BY created_at DESC LIMIT 1', [script.id, hash]);
  if (existing && existing.path && fs.existsSync(existing.path)) {
    log.activity('AUDIO', 'Reused existing narration (script and voice settings unchanged).', { refId: script.id });
    return hydrate(existing);
  }

  const narrId = id('narr');
  const wavPath = path.join(PATHS.narration, `${narrId}.wav`);
  const timingsPath = path.join(PATHS.tmp, `${narrId}.timings.json`);

  log.activity('AUDIO', `Generating narration (${provider}, ${voice})…`, { refId: script.id });

  let wordTimings;
  if (provider === 'sapi' || provider === 'local') {
    await runSapi(scriptText, wavPath, timingsPath, { voice, speed, style });
    const meta = await ff.probe(wavPath);
    wordTimings = buildTimingsFromSapi(timingsPath, meta.duration, scriptText);
    cleanup(timingsPath);
    var duration = meta.duration;
  } else if (provider === 'fish' || provider === 'fish-clone') {
    try {
      const fishspeech = require('./fishspeech');
      await fishspeech.synth(scriptText, wavPath, { temperature: opts.temperature, refPath: opts.refPath, promptText: opts.promptText, voice });
      const meta = await ff.probe(wavPath);
      duration = meta.duration;
      wordTimings = estimateTimings(scriptText, duration);
    } catch (e) {
      // Never fail a render on a TTS engine hiccup — degrade to the always-available SAPI voice.
      log.activity('AUDIO', `Fish Speech synthesis failed (${e.message}). Falling back to SAPI for this narration.`, { level: 'warning', refId: script.id });
      await runSapi(scriptText, wavPath, timingsPath, { voice: sapiSafeVoice(voice), speed, style });
      const meta = await ff.probe(wavPath);
      wordTimings = buildTimingsFromSapi(timingsPath, meta.duration, scriptText);
      cleanup(timingsPath);
      duration = meta.duration;
    }
  } else if (provider === 'kokoro' || provider === 'http') {
    duration = await generateViaHttp(provider, scriptText, wavPath, { voice, speed, style });
    const meta = await ff.probe(wavPath);
    duration = meta.duration || duration;
    wordTimings = estimateTimings(scriptText, duration);
  } else {
    throw new Error(`Unknown narration provider "${provider}".`);
  }

  const row = {
    id: narrId, script_id: script.id, provider, voice, speed, style, path: wavPath,
    duration: round(duration), settings_hash: hash, word_timings: JSON.stringify(wordTimings),
    created_at: db.nowIso(),
  };
  db.insert('narration', row);
  log.activity('AUDIO', `Narration ready (${round(duration)}s, ${wordTimings.length} words).`, { level: 'success', refId: script.id });
  return hydrate(row);
}

// Optional external TTS providers (Fish Speech / Kokoro / Trend Vault). Configure
// via env: <PROVIDER>_TTS_URL accepting {text,voice,speed} and returning WAV bytes.
async function generateViaHttp(provider, scriptText, wavPath, opts) {
  const url = process.env[`${provider.toUpperCase()}_TTS_URL`];
  if (!url) throw new Error(`${provider} narration is not configured. Set ${provider.toUpperCase()}_TTS_URL or use the local SAPI voice.`);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: scriptText, voice: opts.voice, speed: opts.speed }) });
  if (!res.ok) throw new Error(`${provider} TTS server returned HTTP ${res.status}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(wavPath, buf);
  return 0;
}

function hydrate(row) { if (!row) return row; const o = { ...row }; try { o.word_timings = JSON.parse(row.word_timings || '[]'); } catch { o.word_timings = []; } return o; }
function getNarration(nid) { return hydrate(db.get('SELECT * FROM narration WHERE id = ?', [nid])); }

// Raw synth → file, no DB writes. Used by the composer for intro cards (title /
// "Posted by …") so their audio can be measured and the cards timed to it precisely.
// Returns { path, duration, wordTimings }.
async function synth(textStr, opts = {}) {
  const provider = opts.provider || 'sapi';
  const voice = opts.voice || 'Microsoft Zira Desktop';
  const speed = opts.speed != null ? opts.speed : 1.0;
  const style = opts.style || 'Calm storyteller';
  const outWav = opts.out || path.join(PATHS.tmp, `synth_${id('s')}.wav`);
  if (provider === 'sapi' || provider === 'local') {
    const timingsPath = outWav + '.timings.json';
    await runSapi(String(textStr), outWav, timingsPath, { voice, speed, style });
    const meta = await ff.probe(outWav);
    const wordTimings = buildTimingsFromSapi(timingsPath, meta.duration, String(textStr));
    cleanup(timingsPath);
    return { path: outWav, duration: round(meta.duration), wordTimings };
  }
  if (provider === 'fish' || provider === 'fish-clone') {
    try {
      const fishspeech = require('./fishspeech');
      await fishspeech.synth(String(textStr), outWav, { temperature: opts.temperature, refPath: opts.refPath, promptText: opts.promptText, voice });
      const meta = await ff.probe(outWav);
      return { path: outWav, duration: round(meta.duration), wordTimings: estimateTimings(String(textStr), meta.duration) };
    } catch (e) {
      log.activity('AUDIO', `Fish Speech synthesis failed (${e.message}). Falling back to SAPI.`, { level: 'warning' });
      const timingsPath = outWav + '.timings.json';
      await runSapi(String(textStr), outWav, timingsPath, { voice: sapiSafeVoice(voice), speed, style });
      const meta = await ff.probe(outWav);
      const wordTimings = buildTimingsFromSapi(timingsPath, meta.duration, String(textStr));
      cleanup(timingsPath);
      return { path: outWav, duration: round(meta.duration), wordTimings };
    }
  }
  const fallbackDur = await generateViaHttp(provider, String(textStr), outWav, { voice, speed, style });
  const meta = await ff.probe(outWav);
  const duration = meta.duration || fallbackDur;
  return { path: outWav, duration: round(duration), wordTimings: estimateTimings(String(textStr), duration) };
}

module.exports = { generate, synth, listVoices, getNarration, estimateTimings, sapiRate, hydrate };
