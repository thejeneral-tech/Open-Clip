'use strict';
// Background video library (spec §10). Registers user-uploaded footage, probes
// metadata, generates a thumbnail. ORIGINAL files are never modified or overwritten.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db/database');
const { id } = require('../util/ids');
const { PATHS } = require('../config');
const ff = require('./ffmpeg');
const log = require('./logger');

function categoryFolder(category) {
  const c = (category || '').toLowerCase();
  if (c.includes('minecraft')) return PATHS.backgroundsMinecraft;
  if (c.includes('nature')) return PATHS.backgroundsNature;
  return PATHS.backgroundsCustom;
}

function qualityScore(meta) {
  let s = 0;
  const shortSide = Math.min(meta.width || 0, meta.height || 0);
  if (shortSide >= 1080) s += 45; else if (shortSide >= 720) s += 32; else if (shortSide >= 480) s += 18; else s += 6;
  if (meta.fps >= 50) s += 20; else if (meta.fps >= 30) s += 16; else if (meta.fps >= 24) s += 10; else s += 4;
  if (meta.duration >= 120) s += 25; else if (meta.duration >= 30) s += 18; else if (meta.duration >= 8) s += 10; else s += 3;
  if (meta.vcodec === 'h264' || meta.vcodec === 'hevc') s += 10;
  return Math.min(100, s);
}

// Register an already-saved upload file. Returns the stored record.
async function register(filePath, originalName, opts = {}) {
  let meta;
  try { meta = await ff.probe(filePath); }
  catch (e) { throw new Error(`The background video could not be decoded (${e.message}). Try converting it to H.264 MP4.`); }
  if (!meta.duration || !meta.width) throw new Error('The background video could not be decoded. Try converting it to H.264 MP4.');

  const bgId = id('bg');
  const thumbPath = path.join(PATHS.thumbnails, `${bgId}.jpg`);
  try { await ff.thumbnail(filePath, Math.min(3, meta.duration * 0.1), thumbPath); }
  catch (e) { log.error('VIDEO', `Thumbnail generation failed for ${originalName}: ${e.message}`); }

  const row = {
    id: bgId,
    filename: path.basename(filePath),
    original_name: originalName || path.basename(filePath),
    path: filePath,
    category: opts.category || 'Custom',
    tags: JSON.stringify(opts.tags || []),
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    aspect: meta.aspect,
    size_bytes: meta.sizeBytes || (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0),
    thumbnail: ff.fileExists(thumbPath) ? thumbPath : null,
    favorite: 0, archived: 0, times_used: 0, last_used: null,
    quality_score: qualityScore(meta),
    analyzed: 0,
    created_at: db.nowIso(),
  };
  db.insert('backgrounds', row);
  log.activity('VIDEO', `Registered background "${row.original_name}" (${meta.width}x${meta.height}, ${Math.round(meta.duration)}s).`, { level: 'success', refId: bgId });
  return hydrate(row);
}

function hydrate(row) {
  if (!row) return row;
  const out = { ...row };
  try { out.tags = JSON.parse(row.tags || '[]'); } catch { out.tags = []; }
  return out;
}

function get(bgId) { return hydrate(db.get('SELECT * FROM backgrounds WHERE id = ?', [bgId])); }

function list({ category, archived = 0, favorite, trash } = {}) {
  // Include a per-background segment count so the library can show "Segments (N)"
  // without an extra round-trip per card.
  let sql = 'SELECT b.*, (SELECT COUNT(*) FROM segments s WHERE s.background_id = b.id) AS segment_count'
    + ' FROM backgrounds b WHERE b.archived = ?'; const p = [archived ? 1 : 0];
  sql += trash ? ' AND b.deleted_at IS NOT NULL' : ' AND b.deleted_at IS NULL';
  if (category) { sql += ' AND b.category = ?'; p.push(category); }
  if (favorite != null) { sql += ' AND b.favorite = ?'; p.push(favorite ? 1 : 0); }
  sql += ' ORDER BY b.created_at DESC';
  return db.all(sql, p).map(hydrate);
}

function update(bgId, patch) {
  const allowed = {};
  if (patch.category != null) allowed.category = patch.category;
  if (patch.tags != null) allowed.tags = JSON.stringify(patch.tags);
  if (patch.favorite != null) allowed.favorite = patch.favorite ? 1 : 0;
  if (patch.archived != null) allowed.archived = patch.archived ? 1 : 0;
  if (patch.original_name != null) allowed.original_name = patch.original_name;
  db.update('backgrounds', bgId, allowed);
  return get(bgId);
}

function markUsed(bgId) {
  const bg = get(bgId); if (!bg) return;
  db.update('backgrounds', bgId, { times_used: (bg.times_used || 0) + 1, last_used: db.nowIso() });
}

// Delete the DB row + derived files. The original upload is also removed (explicit
// user action via the Delete button), but we never silently overwrite originals.
function remove(bgId, { deleteFile = true } = {}) {
  const bg = get(bgId); if (!bg) return false;
  const segs = db.all('SELECT thumbnail FROM segments WHERE background_id = ?', [bgId]);
  for (const s of segs) safeUnlink(s.thumbnail);
  safeUnlink(bg.thumbnail);
  if (deleteFile) safeUnlink(bg.path);
  db.run('DELETE FROM backgrounds WHERE id = ?', [bgId]); // cascades to segments
  log.activity('VIDEO', `Deleted background "${bg.original_name}".`, { refId: bgId });
  return true;
}

function safeUnlink(p) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ } }

module.exports = { register, get, list, update, markUsed, remove, hydrate, categoryFolder, qualityScore };
