'use strict';
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Text normalisation + hashing + MinHash-based semantic similarity.
// Used by both the scoring engine (originality) and duplicate prevention (§9).
// ---------------------------------------------------------------------------

const STOP = new Set(('a an the and or but so to of in on at for with from by as is are was were be been ' +
  'being have has had do does did will would can could should i me my we our you your he him his she her ' +
  'it its they them their this that these those not no yes if then than too very just about into out up down ' +
  'over under again more most some any all').split(' '));

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function tokens(text) {
  return normalizeText(text).split(' ').filter((w) => w && !STOP.has(w));
}

// Word-level k-shingles (default trigrams) capture phrasing, not just bag-of-words.
function shingles(text, k = 3) {
  const t = tokens(text);
  if (t.length < k) return t.length ? [t.join(' ')] : [];
  const out = new Set();
  for (let i = 0; i <= t.length - k; i++) out.add(t.slice(i, i + k).join(' '));
  return [...out];
}

// 32 hashed permutations → a compact signature that approximates Jaccard
// similarity without storing the full shingle set.
const NUM_HASHES = 32;
const SEEDS = Array.from({ length: NUM_HASHES }, (_, i) => i * 0x9e3779b1 + 1);

function hashShingle(s, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function minhash(text, k = 3) {
  const sh = shingles(text, k);
  if (!sh.length) return new Array(NUM_HASHES).fill(0);
  const sig = new Array(NUM_HASHES).fill(0xffffffff);
  for (const s of sh) {
    for (let i = 0; i < NUM_HASHES; i++) {
      const h = hashShingle(s, SEEDS[i]);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

// Estimated Jaccard similarity from two minhash signatures (0..1).
function minhashSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

// Exact Jaccard over shingle sets (used for short text where it's cheap).
function jaccard(textA, textB, k = 3) {
  const A = new Set(shingles(textA, k));
  const B = new Set(shingles(textB, k));
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

module.exports = {
  normalizeText, sha256, tokens, shingles, minhash, minhashSimilarity, jaccard, NUM_HASHES,
};
