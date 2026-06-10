'use strict';
// Voice presets + voice cloning. Presets wrap an engine (SAPI or Fish Speech) + settings,
// can be previewed (auto-synthesised test phrase), saved, set as the default for the next run,
// soft-deleted (trash), and used by the pipeline. Cloning stores a reference WAV that Fish
// Speech uses as the prompt voice.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const db = require('../db/database');
const { id } = require('../util/ids');
const { ROOT } = require('../config');
const tts = require('./tts');
const fishspeech = require('./fishspeech');
const ffmpeg = require('./ffmpeg');
const log = require('./logger');

const PREVIEW_DIR = path.join(ROOT, 'data', 'voice-previews');
const REFS_DIR = path.join(ROOT, 'data', 'voice-refs');
const TEST_PHRASE = 'This is how my voice sounds. So, was I the one in the wrong here?';
fs.mkdirSync(PREVIEW_DIR, { recursive: true });
fs.mkdirSync(REFS_DIR, { recursive: true });

function hydrate(row) {
  if (!row) return row;
  const o = { ...row };
  try { o.settings = JSON.parse(row.settings || '{}'); } catch { o.settings = {}; }
  o.is_default = !!row.is_default; o.builtin = !!row.builtin;
  if (o.preview_path) o.preview_url = '/media/' + path.relative(path.join(ROOT, 'data'), o.preview_path).split(path.sep).join('/');
  return o;
}

function listPresets({ trash } = {}) {
  const where = trash ? 'WHERE deleted_at IS NOT NULL' : 'WHERE deleted_at IS NULL';
  return db.all(`SELECT * FROM voice_presets ${where} ORDER BY is_default DESC, created_at DESC`).map(hydrate);
}
function getPreset(pid) { return hydrate(db.get('SELECT * FROM voice_presets WHERE id = ?', [pid])); }
function getDefault() { return hydrate(db.get('SELECT * FROM voice_presets WHERE is_default = 1 AND deleted_at IS NULL LIMIT 1')); }

function createPreset(data = {}) {
  const pid = id('vp');
  const now = db.nowIso();
  const row = {
    id: pid, name: data.name || 'New voice', engine: data.engine || 'sapi',
    voice: data.voice || null, icon: data.icon || '🎙', speed: data.speed != null ? data.speed : 1.0,
    temperature: data.temperature != null ? data.temperature : null, pitch: data.pitch || 0,
    style: data.style || 'Calm storyteller', clone_id: data.clone_id || null,
    settings: JSON.stringify(data.settings || {}), preview_path: null,
    is_default: 0, builtin: 0, created_at: now, updated_at: now,
  };
  db.insert('voice_presets', row);
  return getPreset(pid);
}
function updatePreset(pid, patch = {}) {
  const allowed = {};
  for (const k of ['name', 'engine', 'voice', 'icon', 'speed', 'temperature', 'pitch', 'style', 'clone_id']) if (patch[k] !== undefined) allowed[k] = patch[k];
  if (patch.settings !== undefined) allowed.settings = JSON.stringify(patch.settings);
  allowed.updated_at = db.nowIso();
  db.update('voice_presets', pid, allowed);
  return getPreset(pid);
}
function setDefault(pid) {
  if (!db.get('SELECT id FROM voice_presets WHERE id = ?', [pid])) throw new Error('Preset not found.');
  db.run('UPDATE voice_presets SET is_default = 0');
  db.update('voice_presets', pid, { is_default: 1, updated_at: db.nowIso() });
  return getPreset(pid);
}

// Synthesise the test phrase for a preset (or ad-hoc spec) and cache it as the preview.
async function preview(pidOrSpec, text) {
  const spec = typeof pidOrSpec === 'string' ? getPreset(pidOrSpec) : pidOrSpec;
  if (!spec) throw new Error('Preset not found.');
  const phrase = text || TEST_PHRASE;
  const out = path.join(PREVIEW_DIR, `${spec.id || 'adhoc'}_${id('pv')}.wav`);
  await synthForPreset(spec, phrase, out);
  if (spec.id) db.update('voice_presets', spec.id, { preview_path: out, updated_at: db.nowIso() });
  return { path: out, url: '/media/' + path.relative(path.join(ROOT, 'data'), out).split(path.sep).join('/') };
}

// Route a preset to the right engine. Returns { path }.
async function synthForPreset(spec, phrase, out) {
  if (spec.engine === 'fish' || spec.engine === 'fish-clone') {
    let refPath = null;
    let promptText = null;
    if (spec.engine === 'fish-clone' && spec.clone_id) {
      const clone = db.get('SELECT * FROM voice_clones WHERE id = ?', [spec.clone_id]);
      refPath = clone && clone.reference_path;
      promptText = clone && clone.transcript; // engine needs the reference transcript to clone
    }
    return fishspeech.synth(phrase, out, { temperature: spec.temperature, refPath, promptText, voice: spec.voice });
  }
  // SAPI (always-available local engine)
  return tts.synth(phrase, { voice: spec.voice, speed: spec.speed, style: spec.style, out });
}

// --- Voice cloning ---------------------------------------------------------
function listClones() { return db.all('SELECT * FROM voice_clones ORDER BY created_at DESC'); }
function createClone({ name, referencePath, transcript }) {
  if (!referencePath || !fs.existsSync(referencePath)) throw new Error('Reference audio file is missing.');
  const cid = id('clone');
  db.insert('voice_clones', { id: cid, name: name || 'Cloned voice', reference_path: referencePath, transcript: transcript || null, status: 'ready', created_at: db.nowIso() });
  // Create a matching preset so the clone is immediately usable.
  const preset = createPreset({ name: name || 'Cloned voice', engine: 'fish-clone', clone_id: cid, icon: '🧬', temperature: 0.3 });
  log.activity('AUDIO', `Voice clone "${name}" created from reference audio.`, { level: 'success', refId: cid });
  return { clone: db.get('SELECT * FROM voice_clones WHERE id = ?', [cid]), preset };
}
function refDir() { return REFS_DIR; }

// Register an uploaded reference clip WITHOUT creating a preset (voice-lab flow).
// The clone row IS the reusable reference; a preset is created later via "Save as Preset".
function addReference({ name, referencePath, transcript }) {
  if (!referencePath || !fs.existsSync(referencePath)) throw new Error('Reference audio file is missing.');
  const cid = id('clone');
  db.insert('voice_clones', { id: cid, name: name || 'Reference voice', reference_path: referencePath, transcript: transcript || null, status: 'ready', created_at: db.nowIso() });
  log.activity('AUDIO', `Reference voice "${name || 'Reference'}" uploaded.`, { level: 'success', refId: cid });
  return db.get('SELECT * FROM voice_clones WHERE id = ?', [cid]);
}

// Convert any uploaded clip (mp4/mp3/m4a/…) to a clean mono 24 kHz PCM WAV the
// engine can use as a reference prompt. Returns the WAV path; removes the original.
async function convertToWav(inputPath) {
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error('Uploaded file is missing.');
  const out = path.join(REFS_DIR, id('refwav') + '.wav');
  await ffmpeg.ffmpeg(['-y', '-i', inputPath, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', out], { timeoutMs: 120000 });
  try { if (path.resolve(inputPath) !== path.resolve(out)) fs.unlinkSync(inputPath); } catch { /* keep original on failure */ }
  return out;
}

// Reference sources the Voice Lab can clone from (uploaded clips + saved clones).
function listReferenceSources() {
  return listClones().map((c) => ({
    id: c.id,
    name: c.name,
    type: 'clone',
    transcript: c.transcript || '',
    displayPath: c.reference_path ? path.basename(c.reference_path) : '',
    sizeBytes: (() => { try { return fs.statSync(c.reference_path).size; } catch { return 0; } })(),
  }));
}

function resolveReference(sourceId) {
  if (!sourceId) return null;
  const cid = String(sourceId).replace(/^(profile:|clone:)/, '');
  const clone = db.get('SELECT * FROM voice_clones WHERE id = ?', [cid]);
  return clone ? clone.reference_path : null;
}

// Best-effort transcription of a reference clip. Returns the stored transcript if
// present; otherwise tries a local Whisper (set WHISPER_CMD), else a friendly note.
// Speech-to-text for a reference clip (~maxWords) via faster-whisper (CTranslate2,
// no torch). scripts/transcribe.py auto-installs the package + a small model on
// first use, then is fast. Returns the stored transcript first if one exists.
async function transcribe({ voiceId, refPath, maxWords = 80 } = {}) {
  let ref = refPath;
  if (!ref && voiceId) {
    const clone = db.get('SELECT * FROM voice_clones WHERE id = ?', [String(voiceId).replace(/^(profile:|clone:)/, '')]);
    if (clone) { if (clone.transcript) return { ok: true, transcript: clone.transcript }; ref = clone.reference_path; }
  }
  if (!ref || !fs.existsSync(ref)) return { ok: false, transcript: '', note: 'Reference audio not found.' };
  const PYTHON = process.env.PYTHON_PATH || 'python';
  const script = path.join(ROOT, 'scripts', 'transcribe.py');
  return new Promise((resolve) => {
    let out = '', err = '';
    let ps;
    try { ps = spawn(PYTHON, [script, ref, String(maxWords)], { windowsHide: true }); }
    catch (e) { return resolve({ ok: false, transcript: '', note: 'Could not run transcription (Python not found).' }); }
    const timer = setTimeout(() => { try { ps.kill(); } catch { /* */ } }, 300000); // first run installs + downloads a model
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('error', () => { clearTimeout(timer); resolve({ ok: false, transcript: '', note: 'Could not run transcription (Python not found). Install Python + faster-whisper.' }); });
    ps.on('close', (code) => {
      clearTimeout(timer);
      const txt = out.trim().split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ');
      if (code === 0 && txt) {
        // Persist so re-asking is instant and the clone carries its transcript.
        try { if (voiceId) db.run('UPDATE voice_clones SET transcript = ? WHERE id = ?', [txt, String(voiceId).replace(/^(profile:|clone:)/, '')]); } catch { /* */ }
        resolve({ ok: true, transcript: txt });
      } else {
        const tail = (err.split('\n').filter(Boolean).slice(-1)[0] || 'no output').slice(0, 140);
        resolve({ ok: false, transcript: '', note: 'Auto-transcription unavailable — clone from audio alone, or paste the transcript. (' + tail + ')' });
      }
    });
  });
}

// --- Async voice-clone jobs (Voice Lab) ------------------------------------
// Stages mirror the s2.cpp pipeline so the UI can show meaningful progress.
const CLONE_STAGES = ['queued', 'starting', 'encoding_reference', 'building_prompt', 'generating', 'decoding', 'finalizing', 'complete'];
const cloneJobs = new Map();
let lastCompletedClone = null;

function emitJob(job) {
  try { log.progress('fish', { jobId: job.jobId, stage: job.stage, percent: job.percent, status: job.status, error: job.error }); } catch { /* ignore */ }
}
function getCloneJob(jobId) { return cloneJobs.get(jobId) || null; }
function activeCloneJob() { return [...cloneJobs.values()].find((j) => j.status === 'running') || null; }
function latestCloneJob() { return lastCompletedClone; }

function startCloneJob({ sourceId, text, temperature, promptText, voiceName } = {}) {
  if (!text || !text.trim()) throw new Error('Enter the text you want spoken.');
  const jobId = id('cjob');
  const job = {
    jobId, status: 'running', stage: 'queued', percent: 0, text, sourceId: sourceId || null,
    voiceName: voiceName || 'Cloned voice', transcript: promptText || '', audioUrl: null, audioPath: null,
    bytes: 0, generation_time: 0, error: null, createdAt: db.nowIso(),
  };
  cloneJobs.set(jobId, job);
  // Cap the map so it can't grow unbounded across a long session.
  if (cloneJobs.size > 40) { const oldest = [...cloneJobs.keys()][0]; cloneJobs.delete(oldest); }
  runCloneJob(job).catch((e) => {
    job.status = 'error'; job.stage = 'error'; job.error = e.message; emitJob(job);
    log.error('AUDIO', `Voice clone job failed: ${e.message}`, null, jobId);
  });
  return { ok: true, jobId };
}

async function runCloneJob(job) {
  const stage = (s, p) => { job.stage = s; if (p != null) job.percent = p; emitJob(job); };
  const refPath = resolveReference(job.sourceId);
  stage('starting', 5);
  if (!fishspeech.engineReady()) throw new Error('Fish Speech engine is not ready. Open Voice Lab → Setup: download the model and build/select the s2 engine.');
  // The engine clones from reference audio + its transcript; it cannot clone from
  // audio alone. If a reference was chosen but no transcript was given, transcribe
  // it automatically (this also recovers a transcript already stored on the clone).
  let promptText = (job.transcript || '').trim();
  if (refPath && !promptText) {
    stage('encoding_reference', 15);
    try {
      const tr = await transcribe({ voiceId: job.sourceId, refPath, maxWords: 80 });
      if (tr && tr.ok && tr.transcript) promptText = tr.transcript.trim();
    } catch { /* fall through to the actionable error below */ }
    if (!promptText) {
      throw new Error('This voice needs a transcript of the reference audio to clone it, and auto-transcription was unavailable. Paste the words spoken in the sample into the Transcript box, then generate again.');
    }
    job.transcript = promptText;
  }
  stage(refPath ? 'encoding_reference' : 'building_prompt', 22);
  stage('building_prompt', 38);
  stage('generating', 55);
  const out = path.join(PREVIEW_DIR, `clone_${job.jobId}.wav`);
  const t0 = Date.now();
  await fishspeech.synth(job.text, out, { refPath, promptText });
  stage('decoding', 85);
  stage('finalizing', 95);
  let bytes = 0;
  try { bytes = fs.statSync(out).size; } catch { /* ignore */ }
  job.audioPath = out;
  job.audioUrl = '/media/' + path.relative(path.join(ROOT, 'data'), out).split(path.sep).join('/');
  job.bytes = bytes;
  job.generation_time = (Date.now() - t0) / 1000;
  job.status = 'complete';
  stage('complete', 100);
  lastCompletedClone = job;
  log.activity('AUDIO', `Voice clone generated (${(bytes / 1024).toFixed(0)} KB in ${job.generation_time.toFixed(1)}s).`, { level: 'success', refId: job.jobId });
}

// Save a finished clone job as a reusable preset, keeping the audio it just
// generated as the preset's preview — so "▶ Preview" plays it back instantly
// instead of re-synthesising. Returns the new preset.
function savePresetFromCloneJob(jobId, { name, icon } = {}) {
  const job = getCloneJob(jobId) || (lastCompletedClone && lastCompletedClone.jobId === jobId ? lastCompletedClone : null);
  if (!job || !job.audioPath) throw new Error('No generated audio for this job — generate speech first, then save.');
  const cloneId = job.sourceId ? String(job.sourceId).replace(/^(profile:|clone:)/, '') : null;
  const preset = createPreset({
    name: name || job.voiceName || 'Cloned voice',
    engine: cloneId ? 'fish-clone' : 'fish',
    clone_id: cloneId, icon: icon || '🧬', temperature: 0.3,
  });
  // Copy the generated clip into a preset-owned preview file so it survives
  // independently of the (capped) in-memory job map.
  let previewPath = job.audioPath;
  try {
    if (fs.existsSync(job.audioPath)) {
      const dest = path.join(PREVIEW_DIR, `${preset.id}_${id('pv')}.wav`);
      fs.copyFileSync(job.audioPath, dest);
      previewPath = dest;
    }
  } catch { /* fall back to the job's audio path */ }
  db.update('voice_presets', preset.id, { preview_path: previewPath, updated_at: db.nowIso() });
  return getPreset(preset.id);
}

module.exports = {
  listPresets, getPreset, getDefault, createPreset, updatePreset, setDefault, preview, synthForPreset,
  listClones, createClone, addReference, convertToWav, listReferenceSources, resolveReference, transcribe, refDir,
  startCloneJob, getCloneJob, activeCloneJob, latestCloneJob, savePresetFromCloneJob, CLONE_STAGES,
  PREVIEW_DIR, REFS_DIR, TEST_PHRASE,
};
