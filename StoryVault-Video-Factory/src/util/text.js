'use strict';

const WORDS_PER_SECOND_NARRATION = 2.6; // ~156 wpm storytelling pace
const WORDS_PER_SECOND_READING = 3.5;   // ~210 wpm silent reading

function wordCount(text) {
  const m = String(text || '').trim().match(/\S+/g);
  return m ? m.length : 0;
}

function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function paragraphs(text) {
  return String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

function narrationSeconds(text) {
  return Math.round((wordCount(text) / WORDS_PER_SECOND_NARRATION) * 10) / 10;
}

function readingSeconds(text) {
  return Math.round(wordCount(text) / WORDS_PER_SECOND_READING);
}

function syllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 1;
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = word.match(/[aeiouy]{1,2}/g);
  return m ? Math.max(1, m.length) : 1;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function truncate(text, n) {
  const s = String(text || '');
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

function titleCase(s) {
  return String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = {
  WORDS_PER_SECOND_NARRATION, wordCount, sentences, paragraphs,
  narrationSeconds, readingSeconds, syllables, clamp, truncate, titleCase,
};
