'use strict';
// Proof that caption cues never overlap in time — the fix for stacked/doubled
// captions. Exercises both render paths (captions.buildAss + overlays karaoke /
// center-pop) with deliberately messy, out-of-order word timings. Run directly:
//   node tests/caption-overlap-proof.js
const captions = require('../src/services/captions');
const overlays = require('../src/services/overlays');
const { BUILTIN_TEMPLATES } = require('../src/templates-data');

let passed = 0, failed = 0;
function ok(name) { passed++; process.stdout.write(`  ✓ ${name}\n`); }
function bad(name, msg) { failed++; process.stdout.write(`  ✗ ${name}\n      → ${msg}\n`); }
function check(name, fn) { try { fn(); ok(name); } catch (e) { bad(name, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

function secs(t) { const [h, m, rest] = t.split(':'); return (+h) * 3600 + (+m) * 60 + parseFloat(rest); }

// (start, end) for Dialogue events, optionally filtered to given ASS styles.
function spans(ass, styles) {
  const out = [];
  for (const line of ass.split('\n')) {
    if (!line.startsWith('Dialogue:')) continue;
    const p = line.split(',');
    const style = (p[3] || '').trim();
    if (styles && !styles.includes(style)) continue;
    out.push([secs(p[1]), secs(p[2])]);
  }
  return out;
}

function assertNoOverlap(label, sp) {
  assert(sp.length > 0, `${label}: produced no caption cues`);
  for (let i = 0; i < sp.length - 1; i++) {
    assert(sp[i][1] <= sp[i + 1][0] + 1e-6,
      `${label}: cue ${i} ends at ${sp[i][1]} after cue ${i + 1} starts at ${sp[i + 1][0]}`);
    assert(sp[i][1] > sp[i][0], `${label}: cue ${i} has non-positive duration`);
  }
}

// Deliberately broken timings: overlaps, backwards jumps, zero-length words.
function messy(words) {
  const noise = [[0, 0.6], [0.4, 0.9], [0.3, 0.5], [0.9, 1.2], [1.1, 1.15], [1.5, 2.0], [1.8, 1.8]];
  return words.map((w, i) => {
    const [s, e] = noise[i % noise.length];
    const base = Math.floor(i / noise.length) * 2.0;
    return { word: w, start: base + s, end: base + e };
  });
}

console.log('\nStoryVault — caption overlap proof\n');

const BODY = 'brave bro the thing I was saying about that one crazy night really got me thinking hard now'.split(' ');

// 1. sanitizeTimings yields a clean monotonic timeline.
check('sanitizeTimings is monotonic & non-overlapping', () => {
  const clean = captions.sanitizeTimings(messy(BODY));
  for (let i = 0; i < clean.length - 1; i++) {
    assert(clean[i].end <= clean[i + 1].start + 1e-9, `word ${i} overlaps ${i + 1}`);
    assert(clean[i].end > clean[i].start, `word ${i} has no duration`);
  }
});

// 2. captions.buildAss: every preset stays overlap-free.
for (const style of ['bold', 'clean', 'karaoke', 'minimal', 'large_centered', 'two_line']) {
  check(`captions.buildAss '${style}' has no overlapping cues`, () => {
    assertNoOverlap(style, spans(captions.buildAss(messy(BODY), { style }), ['Default']));
  });
}

// 3. overlays (reference template): karaoke + center-pop body captions.
const refTpl = BUILTIN_TEMPLATES.find((t) => t.id === 'full_screen_story');
const popTpl = BUILTIN_TEMPLATES.find((t) => t.id === 'center_pop');
for (const [label, tpl] of [['reference/karaoke', refTpl], ['center_pop', popTpl]]) {
  check(`overlays ${label} body captions have no overlap`, () => {
    // Body words start after the 2s author-intro window; cards live earlier.
    const wt = messy(BODY).map((w) => ({ ...w, start: w.start + 3, end: w.end + 3 }));
    const ass = overlays.buildAss({
      platform: 'reddit', title: 'A wild story', author: 'someone',
      wordTimings: wt, topicEnd: 1.5, introEnd: 3.0, template: tpl,
    });
    assertNoOverlap(label, spans(ass, ['Caption', 'Pop']));
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
