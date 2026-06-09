'use strict';
// Voice presets + voice cloning. Presets wrap an engine (SAPI or Fish Speech) + settings,
// can be previewed (auto-synthesised test phrase), saved, set as the default for the next run,
// soft-deleted (trash), and used by the pipeline. Cloning stores a reference WAV that Fish
// Speech uses as the prompt voice.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db/database');
const { id } = require('../util/ids');
const { ROOT } = require('../config');
const tts = require('./tts');
const fishspeech = require('./fishspeech');
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
    if (spec.engine === 'fish-clone' && spec.clone_id) {
      const clone = db.get('SELECT * FROM voice_clones WHERE id = ?', [spec.clone_id]);
      refPath = clone && clone.reference_path;
    }
    return fishspeech.synth(phrase, out, { temperature: spec.temperature, refPath, voice: spec.voice });
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

module.exports = {
  listPresets, getPreset, getDefault, createPreset, updatePreset, setDefault, preview, synthForPreset,
  listClones, createClone, refDir, PREVIEW_DIR, REFS_DIR, TEST_PHRASE,
};
