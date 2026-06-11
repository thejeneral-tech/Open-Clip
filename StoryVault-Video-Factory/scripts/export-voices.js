'use strict';
// Export the saved voice presets + clones from the live DB into a committed seed
// file (data/seeds/voice-presets.json) so a fresh `git pull` / clone ships them.
//
// Voice presets live in the (gitignored) SQLite DB, and the DB stores absolute,
// machine-specific paths. This script snapshots them with paths made RELATIVE to
// data/, and copies any out-of-tree reference clips into data/voice-refs/ so the
// reference audio travels with the repo. On startup src/db/seed-voices.js re-imports
// the seed (idempotent by id) and resolves the paths against the local install.
//
// Re-run this whenever you save/clone new voices in the app, then commit the
// updated data/seeds/voice-presets.json (and any new data/voice-refs/*.wav).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DB_FILE, DATA } = require('../src/config');

const REFS_DIR = path.join(DATA, 'voice-refs');
const SEEDS_DIR = path.join(DATA, 'seeds');
const SEED_FILE = path.join(SEEDS_DIR, 'voice-presets.json');

// Store paths relative to data/ with forward slashes so the seed is OS-independent.
function toRel(abs) {
  return path.relative(DATA, abs).split(path.sep).join('/');
}

// Ensure a reference clip lives under data/voice-refs/ (copy it in if it doesn't),
// and return its data-relative path. Returns null if the source file is missing.
function stageRef(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  const within = path.relative(DATA, absPath);
  if (!within.startsWith('..') && !path.isAbsolute(within)) return toRel(absPath); // already under data/
  fs.mkdirSync(REFS_DIR, { recursive: true });
  const dest = path.join(REFS_DIR, path.basename(absPath));
  if (path.resolve(dest) !== path.resolve(absPath)) fs.copyFileSync(absPath, dest);
  return toRel(dest);
}

if (!fs.existsSync(DB_FILE)) {
  console.error(`No database found at ${DB_FILE}. Start the app once, save a voice, then re-run.`);
  process.exit(1);
}

const db = new DatabaseSync(DB_FILE, { readOnly: true });

// Only ship live (non-deleted) presets. Drop machine-specific fields; previews are
// regenerated on demand, so we don't ship them (preview_path is reset to null on import).
const presets = db.prepare('SELECT * FROM voice_presets WHERE deleted_at IS NULL ORDER BY created_at').all()
  .map((p) => ({
    id: p.id, name: p.name, engine: p.engine, voice: p.voice, icon: p.icon,
    speed: p.speed, temperature: p.temperature, pitch: p.pitch, style: p.style,
    clone_id: p.clone_id, settings: p.settings || '{}',
    is_default: p.is_default ? 1 : 0,
    created_at: p.created_at, updated_at: p.updated_at,
  }));

// Only ship clones whose reference clip still exists on disk — a clone without its
// reference WAV is useless and would seed a broken voice on the next machine.
const clones = [];
const skippedClones = [];
for (const c of db.prepare('SELECT * FROM voice_clones ORDER BY created_at').all()) {
  const rel = stageRef(c.reference_path);
  if (!rel) { skippedClones.push(c); continue; }
  clones.push({
    id: c.id, name: c.name, reference_path: rel,
    transcript: c.transcript, status: c.status || 'ready', created_at: c.created_at,
  });
}
db.close();

// Drop clone-backed presets whose clone got skipped (missing reference audio).
const cloneIds = new Set(clones.map((c) => c.id));
const usable = presets.filter((p) => p.engine !== 'fish-clone' || (p.clone_id && cloneIds.has(p.clone_id)));
const droppedPresets = presets.filter((p) => !usable.includes(p));

fs.mkdirSync(SEEDS_DIR, { recursive: true });
fs.writeFileSync(SEED_FILE, JSON.stringify({ version: 1, presets: usable, clones }, null, 2) + '\n');

console.log(`Wrote ${usable.length} preset(s) and ${clones.length} clone(s) to ${toRel(SEED_FILE)}`);
if (clones.length) console.log(`Reference clips staged under ${toRel(REFS_DIR)}/ — commit those too.`);
for (const c of skippedClones) console.warn(`  ! skipped clone "${c.name}" (${c.id}): reference audio missing (${c.reference_path})`);
for (const p of droppedPresets) console.warn(`  ! skipped preset "${p.name}" (${p.id}): its clone was unavailable`);
console.log('Commit data/seeds/voice-presets.json (and any new data/voice-refs/*) to ship these voices.');
