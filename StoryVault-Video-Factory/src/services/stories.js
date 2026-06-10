'use strict';
// Central story service: ingest candidates from any source, analyse, score against
// the active normalisation context, run duplicate detection, apply preference
// filters, and persist. Also CRUD used by the Story Library + Discovery pages.
const db = require('../db/database');
const { id } = require('../util/ids');
const text = require('../util/text');
const scoring = require('./scoring');
const dedup = require('./dedup');
const safety = require('./safety');
const categorizer = require('./categorizer');
const prefsSvc = require('./preferences');
const log = require('./logger');

function ensureSource({ type, label, url, community }) {
  const sid = id('src');
  db.insert('sources', { id: sid, type, label: label || null, url: url || null, community: community || null, created_at: db.nowIso() });
  return sid;
}

// candidates: normalized objects from a source module. opts: { sort, applyPrefs, sourceLabel }
function ingest(candidates, opts = {}) {
  const prefs = prefsSvc.get();
  const ctxStories = candidates.map((c) => ({
    ...c,
    category: c.category || categorizer.infer(c.title, c.body),
    word_count: text.wordCount(c.body),
  }));
  // Long-form "clip source" stories carry their intended length (_targetMinutes);
  // score their duration-fit against that target so a 30-minute story isn't
  // penalised for not being a 90-second clip.
  const scored = scoring.scoreBatch(ctxStories, (s) => (s._targetMinutes ? { targetDuration: Math.round(s._targetMinutes * 60) } : {}));

  const sourceId = ensureSource({
    type: opts.sourceType || (candidates[0] && candidates[0].source_type) || 'pasted',
    label: opts.sourceLabel, url: opts.url, community: candidates[0] && candidates[0].community,
  });

  const saved = [];
  let dupCount = 0, filteredCount = 0;
  for (let i = 0; i < ctxStories.length; i++) {
    const c = ctxStories[i];
    const s = scored[i];

    // Preference filters (spec §4 — used during discovery + generation)
    if (opts.applyPrefs !== false) {
      const cat = c.category || '';
      if (prefs.blockedCategories && prefs.blockedCategories.includes(cat)) { filteredCount++; continue; }
      const blocked = safety.blockedByFilters(c.body, prefs);
      if (blocked.length) { filteredCount++; continue; }
      const engagement = s.legacy.engagement;
      if (prefs.minEngagement && engagement < prefs.minEngagement) { filteredCount++; continue; }
    }

    // Duplicate detection against stored history
    const dup = dedup.checkStory({ ...c, id: '' });
    // Strong duplicate of an already-stored story → do NOT create another row (this is
    // what caused duplicate cards in the Library). Return the existing original instead,
    // annotated so the UI can show it as a duplicate. Near-dupes (below the skip
    // threshold) are still inserted-and-flagged so they remain visible for review.
    const SKIP_THRESHOLD = 0.85;
    if (dup.isDuplicate && (dup.score || 0) >= SKIP_THRESHOLD && dup.ofId) {
      dupCount++;
      const orig = getStory(dup.ofId);
      if (orig) {
        orig.duplicate_of = dup.ofId;
        orig.duplicate_score = Math.round((dup.score || 0) * 100) / 100;
        saved.push(orig);
        continue;
      }
    }
    if (dup.isDuplicate) dupCount++;

    const storyId = id('story');
    const warnings = s.analysis.warnings || safety.detectWarnings(c.body);
    const row = {
      id: storyId,
      source_id: sourceId,
      source_type: c.source_type,
      external_id: c.external_id || null,
      url: c.url || null,
      title: c.title,
      body: c.body,
      author: c.author || null,
      community: c.community || null,
      category: c.category || null,
      created_utc: c.created_utc || null,
      upvotes: c.upvotes || 0,
      num_comments: c.num_comments || 0,
      upvote_ratio: c.upvote_ratio != null ? c.upvote_ratio : null,
      awards: c.awards || 0,
      word_count: c.word_count,
      reading_seconds: text.readingSeconds(c.body),
      est_video_seconds: s.estVideoSeconds,
      score_overall: s.overall,
      score_popularity: s.legacy.popularity,
      score_engagement: s.legacy.engagement,
      score_quality: s.legacy.quality,
      score_hook: s.legacy.hook,
      score_conflict: s.legacy.conflict,
      score_ending: s.legacy.ending,
      score_video: s.legacy.video,
      score_originality: s.legacy.originality,
      score_recency: s.legacy.recency,
      score_reasons: JSON.stringify(s.reasons),
      score_breakdown: JSON.stringify(s.breakdown),
      score_label: s.label,
      metrics_provenance: JSON.stringify(s.provenance),
      views: c.views != null ? c.views : null,
      warnings: JSON.stringify(warnings),
      analysis: JSON.stringify(s.analysis),
      duplicate_of: dup.isDuplicate ? dup.ofId : null,
      duplicate_score: Math.round((dup.score || 0) * 100) / 100,
      status: 'new',
      created_at: db.nowIso(),
    };
    db.insert('stories', row);
    // Register fingerprints so future ingests can detect reposts of THIS story.
    dedup.fingerprintStory(row);
    saved.push(hydrate(row));
  }

  // Sort the returned set by the requested sort id (default overall score).
  sortStories(saved, opts.sort);
  log.activity('STORIES', `${saved.length} stories ingested${dupCount ? `, ${dupCount} flagged as possible duplicates` : ''}${filteredCount ? `, ${filteredCount} filtered by preferences` : ''}.`, { level: 'success' });
  return { stories: saved, sourceId, duplicates: dupCount, filtered: filteredCount };
}

function sortStories(arr, sortId) {
  const by = {
    popular: (a, b) => b.score_popularity - a.score_popularity || b.score_overall - a.score_overall,
    upvoted: (a, b) => b.upvotes - a.upvotes,
    commented: (a, b) => b.num_comments - a.num_comments,
    engaging: (a, b) => b.score_engagement - a.score_engagement,
    rising: (a, b) => (b.created_utc || 0) - (a.created_utc || 0),
    storytelling: (a, b) => b.score_quality - a.score_quality,
    short_video: (a, b) => b.score_video - a.score_video,
    controversy: (a, b) => b.score_conflict - a.score_conflict,
    emotional: (a, b) => b.score_conflict - a.score_conflict,
    hidden_gems: (a, b) => (b.score_overall - b.score_popularity) - (a.score_overall - a.score_popularity),
  };
  arr.sort(by[sortId] || ((a, b) => b.score_overall - a.score_overall));
  return arr;
}

// Re-attach parsed JSON fields for API responses.
function hydrate(row) {
  if (!row) return row;
  const out = { ...row };
  for (const k of ['score_reasons', 'warnings', 'analysis', 'score_breakdown', 'metrics_provenance']) {
    if (typeof out[k] === 'string') { try { out[k] = JSON.parse(out[k]); } catch { /* leave */ } }
  }
  out.preview = text.truncate(row.body, 280);
  return out;
}

// --- CRUD --------------------------------------------------------------------
function getStory(storyId) { return hydrate(db.get('SELECT * FROM stories WHERE id = ?', [storyId])); }

function list({ status, category, source_type, minScore, limit = 200, search, trash } = {}) {
  let sql = 'SELECT * FROM stories WHERE 1=1';
  const p = [];
  sql += trash ? ' AND deleted_at IS NOT NULL' : ' AND deleted_at IS NULL';
  if (status) { sql += ' AND status = ?'; p.push(status); }
  if (category) { sql += ' AND category = ?'; p.push(category); }
  if (source_type) { sql += ' AND source_type = ?'; p.push(source_type); }
  if (minScore) { sql += ' AND score_overall >= ?'; p.push(minScore); }
  if (search) { sql += ' AND (title LIKE ? OR body LIKE ?)'; p.push('%' + search + '%', '%' + search + '%'); }
  sql += ' ORDER BY score_overall DESC, created_at DESC LIMIT ?'; p.push(Number(limit) || 200);
  return db.all(sql, p).map(hydrate);
}

// How many usable (unused, non-duplicate, non-deleted) stories are available.
function availableCount(filter = {}) {
  return list({ ...filter, limit: 1000 }).filter((s) => s.status !== 'excluded' && s.status !== 'used' && !s.duplicate_of).length;
}

// Generate fresh long-form stories and ingest them. Used by the Story Library
// "🔄 Refresh / Replenish" button + auto-replenish.
//
// Primary path: the local AI (aiStoryForge) INVENTS brand-new premises on every
// call, so the user gets genuinely different, well-rated, ~30-minute stories each
// time. If the LLM is unreachable or returns too few, we transparently top up /
// fall back to the offline storyForge so the button always works.
async function replenish(count = 12, opts = {}) {
  const storyForge = require('./storyForge');
  const aiStoryForge = require('./aiStoryForge');
  const targetMinutes = Number(opts.targetMinutes) || 30;
  const forgeOpts = { category: opts.category || null, targetMinutes, source: opts.source || 'pasted' };

  // Avoid repeating ANY story already in the library so every refresh is new.
  // (Covers the whole library, not just the top 80, and — crucially — is now also
  // honoured by the procedural generator, not only the AI path.)
  const avoidTitles = list({ limit: 1000 }).map((s) => s.title).filter(Boolean);
  const genOpts = { ...forgeOpts, avoidTitles };

  let candidates = [];
  try {
    candidates = await aiStoryForge.batch(count, genOpts);
  } catch (e) {
    log.activity('STORIES', `Story generator error (${e.message}); using the legacy offline generator.`, { level: 'warn' });
  }
  // Last-ditch fallback if the generator threw or came up short.
  if (candidates.length < count) {
    candidates = candidates.concat(storyForge.batch(count - candidates.length, genOpts));
  }
  const usedAi = candidates.some((c) => c && c._ai);

  const r = ingest(candidates, { sourceType: usedAi ? 'ai-forge' : 'forge', applyPrefs: false });
  return { added: r.stories.length, duplicates: r.duplicates, stories: r.stories, usedAi };
}

function setStatus(storyId, status) {
  db.update('stories', storyId, { status });
  return getStory(storyId);
}

function pickBest(n, filter = {}) {
  const candidates = list({ ...filter, limit: 500 }).filter((s) => s.status !== 'excluded' && !s.duplicate_of);
  return candidates.slice(0, n);
}

module.exports = { ingest, getStory, list, setStatus, pickBest, hydrate, sortStories, ensureSource, replenish, availableCount };
