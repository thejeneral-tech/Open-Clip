'use strict';
// Caption self-tuning ("learns off old videos").
//
// Every render is audited (captions.auditTimeline) and the result folded into a
// small JSON profile under data/. The profile remembers, per caption style, how
// often cues came out too fast to read and nudges that style's words-per-cue down
// (or back up) for the next generation — so captions get calmer and more readable
// the more videos you make, without touching the deterministic no-overlap fix.
//
// Best-effort throughout: every export swallows its own errors and degrades to
// "no opinion" (suggestMaxWords → null, recordRender → no-op) so caption
// generation can never be broken by the learning layer.
const fs = require('node:fs');
const path = require('node:path');
const { PATHS } = require('../config');

const PROFILE_VERSION = 1;
const EMA_ALPHA = 0.3;
const SLOW_DOWN_ABOVE = 0.35;  // too many cramped cues over time → fewer words
const SPEED_UP_BELOW = 0.10;   // consistently comfortable → allow the preset again
const MIN_DELTA = -2;          // never drop more than 2 words below the preset
const MAX_DELTA = 0;           // never exceed the preset's own words-per-cue

// Preset / mode → its baseline words-per-cue (matches captions.js + overlays.js).
const BASE_MAX_WORDS = {
  bold: 5, clean: 5, karaoke: 5, minimal: 5, large_centered: 4, two_line: 5,
  ref_karaoke: 4, ref_pop: 2,
};

function profilePath() { return path.join(PATHS.data, 'caption-profile.json'); }

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(profilePath(), 'utf8'));
    if (d && d.version === PROFILE_VERSION) { d.styles = d.styles || {}; return d; }
  } catch { /* missing or corrupt → fresh profile */ }
  return { version: PROFILE_VERSION, total_renders: 0, styles: {} };
}

function save(d) {
  try {
    const p = profilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(tmp, p); // atomic swap
  } catch { /* best-effort */ }
}

function entryFor(d, style) {
  if (!d.styles[style]) {
    d.styles[style] = { renders: 0, groups: 0, fast_groups: 0, overlaps: 0, fast_rate_ema: 0, max_words_delta: 0 };
  }
  return d.styles[style];
}

// Learned words-per-cue for a style, or null to use the preset (until learned).
function suggestMaxWords(style) {
  try {
    const e = load().styles[style];
    if (!e) return null;
    const delta = e.max_words_delta | 0;
    if (!delta) return null;
    const base = BASE_MAX_WORDS[style] || 5;
    return Math.max(2, base + delta);
  } catch { return null; }
}

// Fold one render's audit ({groups, fast_groups, overlaps}) into the profile.
function recordRender(style, audit) {
  try {
    const groups = (audit && audit.groups) | 0;
    if (groups <= 0) return;
    const fast = (audit.fast_groups | 0);
    const rate = fast / groups;

    const d = load();
    d.total_renders = (d.total_renders | 0) + 1;
    const e = entryFor(d, style);
    e.renders += 1;
    e.groups += groups;
    e.fast_groups += fast;
    e.overlaps += (audit.overlaps | 0);
    e.fast_rate_ema = e.renders === 1 ? rate : (1 - EMA_ALPHA) * e.fast_rate_ema + EMA_ALPHA * rate;

    let delta = e.max_words_delta | 0;
    if (e.fast_rate_ema > SLOW_DOWN_ABOVE && delta > MIN_DELTA) delta -= 1;
    else if (e.fast_rate_ema < SPEED_UP_BELOW && delta < MAX_DELTA) delta += 1;
    e.max_words_delta = Math.max(MIN_DELTA, Math.min(MAX_DELTA, delta));

    save(d);
  } catch { /* best-effort */ }
}

module.exports = { suggestMaxWords, recordRender };
