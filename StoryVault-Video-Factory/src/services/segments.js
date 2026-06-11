'use strict';
// Background segmentation + selection (spec §11/§12). Splits long uploads into
// reusable clips, skipping black/menu/loading/frozen sections, and selects an
// unused/least-used combination to fill a narration's duration.
const path = require('node:path');
const db = require('../db/database');
const { id } = require('../util/ids');
const { PATHS } = require('../config');
const ff = require('./ffmpeg');
const bgSvc = require('./backgrounds');
const log = require('./logger');

const MARGIN = 0.4; // seconds trimmed around dead zones to avoid visible jumps

// Subtract dead zones from [0,duration] → list of usable [start,end] intervals.
function usableIntervals(duration, dead) {
  const blocks = [...dead.black, ...dead.freeze]
    .map((d) => ({ start: Math.max(0, d.start - MARGIN), end: Math.min(duration, d.end + MARGIN) }))
    .filter((d) => d.end > d.start)
    .sort((a, b) => a.start - b.start);
  // merge overlapping blocks
  const merged = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else merged.push({ ...b });
  }
  const usable = [];
  let cursor = 0;
  for (const b of merged) {
    if (b.start - cursor > 1.5) usable.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (duration - cursor > 1.5) usable.push({ start: cursor, end: duration });
  return usable;
}

function chunkLength(requested) {
  const n = Number(requested);
  return [5, 10, 15, 20, 30].includes(n) ? n : 0; // 0 = auto
}

// Analyse a background into stored segments. Idempotent: clears prior auto segments.
async function analyze(bgId, { segmentLength = 'auto', regenerate = true } = {}) {
  const bg = bgSvc.get(bgId);
  if (!bg) throw new Error('Background not found.');
  log.activity('VIDEO', `Analyzing "${bg.original_name}" for usable segments…`, { refId: bgId });

  let dead = { black: [], freeze: [] };
  try { dead = await ff.detectDeadZones(bg.path); }
  catch (e) { log.error('VIDEO', `Dead-zone detection failed for ${bg.original_name}: ${e.message}`, null, bgId); }

  const usable = usableIntervals(bg.duration, dead);
  const baseLen = chunkLength(segmentLength);

  if (regenerate) db.run('DELETE FROM segments WHERE background_id = ?', [bgId]);

  // One brightness reading per background → default Bright/Dark tag (cheap).
  let brightness = 0.5;
  try { brightness = await ff.sampleBrightness(bg.path, bg.duration * 0.3, 4); } catch { /* ignore */ }
  const brightTag = brightness > 0.55 ? 'Bright' : (brightness < 0.28 ? 'Dark' : null);
  const catTags = categoryTags(bg.category);

  const created = [];
  for (const iv of usable) {
    const span = iv.end - iv.start;
    const len = baseLen || autoLen(span);
    let t = iv.start;
    while (t + Math.min(len, 4) <= iv.end) {
      const end = Math.min(t + len, iv.end);
      if (end - t < 4) break;
      const segId = id('seg');
      const tags = [...catTags];
      if (brightTag) tags.push(brightTag);
      const row = {
        id: segId, background_id: bgId, start_sec: round(t), end_sec: round(end), duration: round(end - t),
        name: `${bg.original_name} ${fmt(t)}–${fmt(end)}`, tags: JSON.stringify(tags),
        usable: 1, quality_score: segQuality(end - t, brightness), times_used: 0, last_used: null,
        thumbnail: null, created_at: db.nowIso(),
      };
      db.insert('segments', row);
      created.push(row);
      t = end;
    }
  }

  // Thumbnails for the first handful only (keep analysis snappy).
  for (const s of created.slice(0, 12)) {
    const tp = path.join(PATHS.thumbnails, `${s.id}.jpg`);
    try { await ff.thumbnail(bg.path, s.start_sec + 0.5, tp, 240); db.update('segments', s.id, { thumbnail: tp }); }
    catch { /* ignore */ }
  }

  db.update('backgrounds', bgId, { analyzed: 1 });
  log.activity('VIDEO', `Created ${created.length} usable segments from "${bg.original_name}" (skipped ${dead.black.length} black / ${dead.freeze.length} frozen sections).`, { level: 'success', refId: bgId });
  return listForBackground(bgId);
}

function autoLen(span) { if (span <= 16) return Math.max(5, Math.floor(span)); if (span <= 40) return 12; return 15; }
function round(n) { return Math.round(n * 100) / 100; }
function fmt(s) { const m = Math.floor(s / 60); const sec = Math.floor(s % 60); return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`; }
function segQuality(dur, brightness) {
  let q = 60;
  if (dur >= 8 && dur <= 20) q += 20; else if (dur >= 5) q += 10;
  if (brightness > 0.3 && brightness < 0.85) q += 20; else q += 5;
  return Math.min(100, q);
}
function categoryTags(category) {
  const c = (category || '').toLowerCase();
  const t = [];
  if (c.includes('minecraft')) t.push('Minecraft', 'Parkour', 'High action');
  if (c.includes('nature')) t.push('Nature', 'Outdoor', 'Calm');
  if (c.includes('driving') || c.includes('city')) t.push('Outdoor', 'Fast movement');
  if (c.includes('satisfying')) t.push('Calm', 'Seamless loop');
  return t;
}

function hydrate(s) { if (!s) return s; const o = { ...s }; try { o.tags = JSON.parse(s.tags || '[]'); } catch { o.tags = []; } return o; }
function listForBackground(bgId) { return db.all('SELECT * FROM segments WHERE background_id = ? ORDER BY start_sec', [bgId]).map(hydrate); }
function getSegment(segId) { return hydrate(db.get('SELECT * FROM segments WHERE id = ?', [segId])); }

function createSegment(bgId, startSec, endSec, opts = {}) {
  const bg = bgSvc.get(bgId); if (!bg) throw new Error('Background not found.');
  if (endSec <= startSec) throw new Error('Segment end must be after start.');
  const segId = id('seg');
  const row = {
    id: segId, background_id: bgId, start_sec: round(startSec), end_sec: round(endSec), duration: round(endSec - startSec),
    name: opts.name || `${bg.original_name} ${fmt(startSec)}–${fmt(endSec)}`, tags: JSON.stringify(opts.tags || []),
    usable: opts.usable === false ? 0 : 1, quality_score: opts.quality || 70, times_used: 0, last_used: null,
    thumbnail: null, created_at: db.nowIso(),
  };
  db.insert('segments', row);
  return getSegment(segId);
}

function updateSegment(segId, patch) {
  const allowed = {};
  for (const k of ['name', 'usable', 'quality_score']) if (patch[k] != null) allowed[k] = k === 'usable' ? (patch[k] ? 1 : 0) : patch[k];
  if (patch.tags != null) allowed.tags = JSON.stringify(patch.tags);
  if (patch.start_sec != null) allowed.start_sec = round(patch.start_sec);
  if (patch.end_sec != null) allowed.end_sec = round(patch.end_sec);
  if (allowed.start_sec != null || allowed.end_sec != null) {
    const cur = getSegment(segId);
    const s = allowed.start_sec != null ? allowed.start_sec : cur.start_sec;
    const e = allowed.end_sec != null ? allowed.end_sec : cur.end_sec;
    allowed.duration = round(e - s);
  }
  db.update('segments', segId, allowed);
  return getSegment(segId);
}

function splitSegment(segId, atSec) {
  const s = getSegment(segId); if (!s) throw new Error('Segment not found.');
  if (atSec <= s.start_sec || atSec >= s.end_sec) throw new Error('Split point must be inside the segment.');
  updateSegment(segId, { end_sec: atSec });
  return createSegment(s.background_id, atSec, s.end_sec, { tags: s.tags, quality: s.quality_score });
}

function deleteSegment(segId) {
  const s = getSegment(segId); if (s && s.thumbnail) { try { require('node:fs').unlinkSync(s.thumbnail); } catch { /* */ } }
  db.run('DELETE FROM segments WHERE id = ?', [segId]);
  return true;
}

// Permanently delete many segments at once (multi-select in the Footage Library).
// Returns the number of rows that actually existed and were removed.
function deleteSegments(ids) {
  let n = 0;
  for (const sid of [].concat(ids || [])) {
    if (!getSegment(sid)) continue;
    deleteSegment(sid);
    n++;
  }
  return n;
}

// -------- Selection (spec §11 steps 6-10) -----------------------------------
// Choose an ordered list of segments whose total length covers targetSeconds,
// preferring least-used + unused, mixing different backgrounds, and avoiding the
// caller's previous sequence. The final segment is trimmed by the composer.
function selectForDuration(targetSeconds, opts = {}) {
  const { avoidSegmentIds = [], backgroundIds = null, category = null, seedRng = Math.random, minClip = 4, transition = 0 } = opts;
  let pool = db.all('SELECT * FROM segments WHERE usable = 1').map(hydrate)
    .filter((s) => s.duration >= minClip);
  if (backgroundIds && backgroundIds.length) pool = pool.filter((s) => backgroundIds.includes(s.background_id));
  if (category) {
    const ok = new Set(db.all('SELECT id FROM backgrounds WHERE category = ?', [category]).map((b) => b.id));
    pool = pool.filter((s) => ok.has(s.background_id));
  }
  if (!pool.length) throw new Error('No usable background segments available. Upload footage and run "Create Segments" first.');

  const avoid = new Set(avoidSegmentIds);
  // Sort by: not-avoided, fewer prior uses, then randomised within tier.
  pool.sort((a, b) =>
    (avoid.has(a.id) - avoid.has(b.id)) ||
    (a.times_used - b.times_used) ||
    (seedRng() - 0.5));

  const plan = [];
  let total = 0;
  let lastBg = null;
  const usedIds = new Set();
  // Greedy fill, alternating backgrounds to avoid repetitive sequences (§11.7/§13).
  let guard = 0;
  while (total < targetSeconds && guard++ < 500) {
    let next = pool.find((s) => !usedIds.has(s.id) && s.background_id !== lastBg);
    if (!next) next = pool.find((s) => !usedIds.has(s.id));
    if (!next) {
      // Ran out of distinct segments — allow reuse of least-used to fill remainder.
      next = pool.slice().sort((a, b) => a.times_used - b.times_used)[0];
      if (!next) break;
      usedIds.clear();
    }
    usedIds.add(next.id);
    lastBg = next.background_id;
    const take = Math.min(next.duration, targetSeconds - total + 2);
    plan.push({
      segmentId: next.id, backgroundId: next.background_id, start: next.start_sec,
      end: round(next.start_sec + take), duration: round(take), name: next.name,
    });
    // Each crossfade overlaps the previous clip by `transition` seconds, so every clip after
    // the first contributes (take - transition) of effective timeline — count it that way, or
    // a long video built from short clips ends before the narration does.
    total += (plan.length === 1) ? take : take - transition;
  }
  return { plan, totalSeconds: round(total) };
}

function markSequenceUsed(segmentIds, videoId) {
  const now = db.nowIso();
  for (const sid of segmentIds) {
    const s = getSegment(sid); if (!s) continue;
    db.update('segments', sid, { times_used: (s.times_used || 0) + 1, last_used: now });
    db.insert('segment_usage', { id: id('use'), segment_id: sid, video_id: videoId || null, used_at: now });
    bgSvc.markUsed(s.background_id);
  }
}

function reuseStats() {
  const total = db.get('SELECT count(*) c FROM segments WHERE usable=1')?.c || 0;
  const used = db.get('SELECT count(*) c FROM segments WHERE times_used > 0')?.c || 0;
  return { total, used, reusePercent: total ? Math.round((used / total) * 100) : 0 };
}

module.exports = {
  analyze, listForBackground, getSegment, createSegment, updateSegment, splitSegment,
  deleteSegment, deleteSegments, selectForDuration, markSequenceUsed, usableIntervals, reuseStats, hydrate,
};
