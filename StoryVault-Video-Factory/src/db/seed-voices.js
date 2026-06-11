'use strict';
// Seed voice presets + clones shipped with the repo (data/seeds/voice-presets.json),
// so a fresh `git pull` / clone already has the saved voices. The presets live in the
// (gitignored) DB, so they can't be committed directly — this imports the committed
// seed instead. Idempotent: inserts only ids that don't already exist, never updates or
// deletes user data. Paths in the seed are relative to data/ and resolved to absolute
// here so they match the local install. Regenerate the seed with `npm run export-voices`.
const fs = require('node:fs');
const path = require('node:path');
const { DATA } = require('../config');

const SEED_FILE = path.join(DATA, 'seeds', 'voice-presets.json');

// Resolve a data-relative (forward-slash) path from the seed to an absolute local path.
function resolveRel(rel) {
  return rel ? path.join(DATA, ...String(rel).split('/')) : null;
}

function run(db, nowIso) {
  let seed;
  try {
    if (!fs.existsSync(SEED_FILE)) return;
    seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  } catch { return; } // a malformed/absent seed must never block boot
  const presets = Array.isArray(seed && seed.presets) ? seed.presets : [];
  const clones = Array.isArray(seed && seed.clones) ? seed.clones : [];

  const cloneExists = db.prepare('SELECT id FROM voice_clones WHERE id = ?');
  const insertClone = db.prepare(
    'INSERT INTO voice_clones (id, name, reference_path, transcript, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  // A clone is only usable once its reference audio is present on disk.
  const seededClones = new Set();
  for (const c of clones) {
    const ref = resolveRel(c.reference_path);
    if (!ref || !fs.existsSync(ref)) continue;        // reference clip didn't ship — skip
    if (!cloneExists.get(c.id)) {
      insertClone.run(c.id, c.name || 'Cloned voice', ref, c.transcript || null, c.status || 'ready', c.created_at || nowIso());
    }
    seededClones.add(c.id);
  }

  const presetExists = db.prepare('SELECT id FROM voice_presets WHERE id = ?');
  const insertPreset = db.prepare(
    `INSERT INTO voice_presets
       (id, name, engine, voice, icon, speed, temperature, pitch, style, clone_id, settings, preview_path, is_default, builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`
  );
  for (const p of presets) {
    if (presetExists.get(p.id)) continue;
    // Don't seed a clone-backed preset whose clone is unavailable on this machine.
    if (p.engine === 'fish-clone' && (!p.clone_id || (!seededClones.has(p.clone_id) && !cloneExists.get(p.clone_id)))) continue;
    const settings = typeof p.settings === 'string' ? p.settings : JSON.stringify(p.settings || {});
    insertPreset.run(
      p.id, p.name || 'Voice', p.engine || 'sapi', p.voice || null, p.icon || '🎙',
      p.speed != null ? p.speed : 1.0, p.temperature != null ? p.temperature : null, p.pitch || 0,
      p.style || 'Calm storyteller', p.clone_id || null, settings,
      p.is_default ? 1 : 0, p.created_at || nowIso(), p.updated_at || nowIso()
    );
  }
}

module.exports = { run, SEED_FILE };
