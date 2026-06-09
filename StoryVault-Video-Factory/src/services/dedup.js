'use strict';
// Originality & duplicate prevention (spec §9). Stores fingerprints of every
// meaningful artefact and detects near-duplicates with exact hashes + MinHash.
const db = require('../db/database');
const fp = require('./fingerprint');
const { id } = require('../util/ids');

const SEMANTIC_DUPLICATE_THRESHOLD = 0.62; // estimated Jaccard over trigrams

function addFingerprint(kind, refId, { hash, shingles, value } = {}) {
  return db.insert('fingerprints', {
    id: id('fp'),
    kind,
    ref_id: refId,
    hash: hash || null,
    shingles: shingles ? JSON.stringify(shingles) : null,
    value: value || null,
    created_at: db.nowIso(),
  });
}

// Register the full fingerprint set for a saved/used story.
function fingerprintStory(story) {
  if (story.url) addFingerprint('story_url', story.id, { hash: fp.sha256(story.url) });
  if (story.external_id) addFingerprint('post_id', story.id, { hash: fp.sha256(String(story.external_id)) });
  addFingerprint('title', story.id, { hash: fp.sha256(fp.normalizeText(story.title)) });
  addFingerprint('story_text', story.id, { hash: fp.sha256(fp.normalizeText(story.body)) });
  addFingerprint('semantic', story.id, { shingles: fp.minhash(story.title + ' ' + story.body) });
}

// Check a candidate story against the history. Returns the closest match (if any).
function checkStory(candidate) {
  // 1) exact reposts via url / post id / exact text
  const exactChecks = [
    candidate.url ? ['story_url', fp.sha256(candidate.url)] : null,
    candidate.external_id ? ['post_id', fp.sha256(String(candidate.external_id))] : null,
    ['story_text', fp.sha256(fp.normalizeText(candidate.body))],
    ['title', fp.sha256(fp.normalizeText(candidate.title))],
  ].filter(Boolean);

  for (const [kind, hash] of exactChecks) {
    const hit = db.get(
      'SELECT ref_id, created_at FROM fingerprints WHERE kind = ? AND hash = ? AND ref_id != ? LIMIT 1',
      [kind, hash, candidate.id || '']
    );
    if (hit) {
      return { isDuplicate: true, score: 1, ofId: hit.ref_id, date: hit.created_at, reason: `exact ${kind}` };
    }
  }

  // 2) semantic near-duplicate via MinHash signatures
  const sig = fp.minhash(candidate.title + ' ' + candidate.body);
  const rows = db.all(
    "SELECT ref_id, shingles, created_at FROM fingerprints WHERE kind = 'semantic' AND ref_id != ? ORDER BY created_at DESC LIMIT 1000",
    [candidate.id || '']
  );
  let best = { score: 0 };
  for (const r of rows) {
    let other;
    try { other = JSON.parse(r.shingles); } catch { continue; }
    const sim = fp.minhashSimilarity(sig, other);
    if (sim > best.score) best = { score: sim, ofId: r.ref_id, date: r.created_at };
  }
  if (best.score >= SEMANTIC_DUPLICATE_THRESHOLD) {
    return { isDuplicate: true, score: best.score, ofId: best.ofId, date: best.date, reason: 'semantic' };
  }
  return { isDuplicate: false, score: best.score, ofId: best.ofId || null, date: best.date || null };
}

// --- Video-component originality (avoid repeating hook / opening / bg sequence / voice) ---

function hookRecentlyUsed(hookText, withinLast = 50) {
  const norm = fp.normalizeText(hookText).split(' ').slice(0, 8).join(' ');
  const rows = db.all(
    "SELECT value FROM fingerprints WHERE kind = 'hook' ORDER BY created_at DESC LIMIT ?",
    [withinLast]
  );
  let count = 0;
  for (const r of rows) {
    if (!r.value) continue;
    if (fp.jaccard(norm, r.value) > 0.7) count++;
  }
  return count;
}

function sequenceUsed(segmentIds) {
  const hash = fp.sha256(segmentIds.slice().sort().join(','));
  const hit = db.get("SELECT ref_id FROM fingerprints WHERE kind = 'bg_sequence' AND hash = ? LIMIT 1", [hash]);
  return !!hit;
}

function fingerprintVideo(video, { hook, ending, segmentIds, voice, captionStyle, music, renderHash } = {}) {
  if (hook) addFingerprint('hook', video.id, { value: fp.normalizeText(hook).split(' ').slice(0, 8).join(' '), hash: fp.sha256(fp.normalizeText(hook)) });
  if (ending) addFingerprint('ending', video.id, { hash: fp.sha256(fp.normalizeText(ending)) });
  if (segmentIds && segmentIds.length) addFingerprint('bg_sequence', video.id, { hash: fp.sha256(segmentIds.slice().sort().join(',')), value: segmentIds.join(',') });
  if (voice) addFingerprint('voice', video.id, { value: voice });
  if (captionStyle) addFingerprint('caption_style', video.id, { value: captionStyle });
  if (music) addFingerprint('music', video.id, { value: music });
  if (renderHash) addFingerprint('render', video.id, { hash: renderHash });
}

function historyCount() {
  const stories = db.get("SELECT count(DISTINCT ref_id) c FROM fingerprints WHERE kind='semantic'")?.c || 0;
  const videos = db.get("SELECT count(*) c FROM videos")?.c || 0;
  return { stories, videos };
}

module.exports = {
  SEMANTIC_DUPLICATE_THRESHOLD, addFingerprint, fingerprintStory, checkStory,
  hookRecentlyUsed, sequenceUsed, fingerprintVideo, historyCount,
};
