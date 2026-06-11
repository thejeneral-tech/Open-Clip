'use strict';
// Word-level captions (spec §15). Groups word timings into 3-7 word, max-2-line
// caption cues and writes an ASS file (burned in by ffmpeg at render time) plus an
// SRT sidecar. Styles, position, sizing, outline and profanity censoring supported.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db/database');
const { id } = require('../util/ids');
const { PATHS } = require('../config');
const safety = require('./safety');
const log = require('./logger');

// ASS colours are &HAABBGGRR.
const WHITE = '&H00FFFFFF';
const BLACK = '&H00000000';
const YELLOW = '&H0000F0FF';
const BOXBG = '&H64000000'; // semi-transparent black

// Smallest on-screen time for a caption word. SAPI / Whisper word boundaries are
// occasionally zero-length or slightly out of order; without a floor, cues overlap
// and ffmpeg/libass stacks them vertically (the doubled-caption artifact).
const MIN_SEG_DUR = 0.10;
// A cue is held until the next begins (no blank flicker) but never longer than
// this past its last word, so it doesn't linger through a long pause / music.
const MAX_HOLD = 1.2;
// Reading-comfort thresholds used by the self-tuning audit (caption-learning.js).
const FAST_CPS = 30;            // characters/second a viewer can comfortably read
const MIN_COMFORTABLE_GROUP = 0.7; // a cue briefer than this can count as "too fast"

// Style presets → ASS V4+ style fields + behaviour flags.
function styleDef(styleId, opts = {}) {
  const size = opts.size || null;
  const presets = {
    bold:          { font: 'Arial', size: size || 92, bold: -1, outline: 6, shadow: 2, align: 2, marginV: 470, border: 1, primary: WHITE, box: false },
    clean:         { font: 'Arial', size: size || 80, bold: 0, outline: 4, shadow: 1, align: 2, marginV: 460, border: 1, primary: WHITE, box: false },
    karaoke:       { font: 'Arial', size: size || 92, bold: -1, outline: 6, shadow: 2, align: 2, marginV: 470, border: 1, primary: YELLOW, secondary: WHITE, karaoke: true, box: false },
    minimal:       { font: 'Arial', size: size || 68, bold: 0, outline: 3, shadow: 0, align: 2, marginV: 380, border: 1, primary: WHITE, box: false },
    large_centered:{ font: 'Arial', size: size || 108, bold: -1, outline: 7, shadow: 3, align: 5, marginV: 0, border: 1, primary: WHITE, box: false },
    two_line:      { font: 'Arial', size: size || 78, bold: -1, outline: 5, shadow: 2, align: 2, marginV: 450, border: 4, primary: WHITE, box: true },
  };
  const p = presets[styleId] || presets.bold;
  if (opts.position === 'top') { p.align = 8; p.marginV = 360; }
  if (opts.position === 'center') { p.align = 5; p.marginV = 0; }
  if (opts.position === 'bottom') { p.align = 2; if (!opts.size) p.marginV = Math.max(380, p.marginV); }
  if (opts.outline != null) p.outline = opts.outline;
  if (opts.box) { p.border = 4; p.box = true; }
  return p;
}

// Force word timings onto a strictly monotonic, non-overlapping timeline.
// Each word starts no earlier than the previous one ended and lasts ≥ MIN_SEG_DUR.
// Well-behaved input passes through unchanged (no drift); only genuinely
// out-of-order words get nudged forward. This is the root-cause fix for the
// stacked/overlapping captions — once words don't overlap, neither do the cues.
function sanitizeTimings(timings) {
  const round = (n) => Math.round(n * 1000) / 1000;
  const out = [];
  let prevEnd = 0;
  for (const w of timings || []) {
    let start = Number(w.start); if (!isFinite(start)) start = prevEnd;
    let end = Number(w.end); if (!isFinite(end)) end = start;
    start = Math.max(start, prevEnd);          // never travel backwards
    if (end <= start) end = start + MIN_SEG_DUR; // give zero-length words a frame
    out.push({ ...w, start: round(start), end: round(end) });
    prevEnd = round(end);
  }
  return out;
}

// Group words into caption cues: 3-7 words, ≤ ~22 chars/line, max 2 lines.
function groupWords(timings, { maxWords = 5, maxChars = 24 } = {}) {
  timings = sanitizeTimings(timings); // clean timeline first → cues can't overlap
  const groups = [];
  let cur = [];
  const flush = () => { if (cur.length) { groups.push(cur); cur = []; } };
  for (const w of timings) {
    cur.push(w);
    const words = cur.map((x) => x.word).join(' ');
    if (cur.length >= maxWords || words.length >= maxChars * 2) flush();
    else if (/[.!?]$/.test(w.word) && cur.length >= 3) flush(); // break on sentence end
  }
  flush();
  return groups.map((g) => ({
    start: g[0].start,
    end: g[g.length - 1].end,
    words: g,
  }));
}

function wrapTwoLines(words, maxChars) {
  // Greedy wrap into at most two balanced lines.
  const text = words.join(' ');
  if (text.length <= maxChars) return text;
  let line1 = '', line2 = '';
  for (const w of words) {
    if ((line1 + ' ' + w).trim().length <= maxChars || !line1) line1 = (line1 + ' ' + w).trim();
    else line2 = (line2 + ' ' + w).trim();
  }
  return line2 ? `${line1}\\N${line2}` : line1;
}

function ts(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function maybeCensor(word, censor) { return censor ? safety.censorText(word) : word; }

function buildAss(timings, opts = {}) {
  const def = styleDef(opts.style || 'bold', opts);
  const maxWords = opts.maxWords || (opts.style === 'large_centered' ? 4 : 5);
  const groups = groupWords(timings, { maxWords });
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${def.font},${def.size},${def.primary},${def.secondary || WHITE},${BLACK},${def.box ? BOXBG : BLACK},${def.bold},0,0,0,100,100,0,0,${def.border},${def.outline},${def.shadow},${def.align},80,80,${def.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const lines = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    // Hold each cue until the next begins (so the screen is never momentarily
    // blank and two cues can't coexist), capped so it can't linger through a pause.
    const end = (i + 1 < groups.length) ? Math.min(groups[i + 1].start, g.end + MAX_HOLD) : g.end;
    let textField;
    if (def.karaoke) {
      // cumulative karaoke highlight per word (\k in centiseconds)
      textField = g.words.map((w) => {
        const durCs = Math.max(1, Math.round((w.end - w.start) * 100));
        return `{\\k${durCs}}${esc(maybeCensor(w.word, opts.censor))} `;
      }).join('').trim();
    } else {
      textField = wrapTwoLines(g.words.map((w) => esc(maybeCensor(w.word, opts.censor))), 22);
    }
    lines.push(`Dialogue: 0,${ts(g.start)},${ts(end)},Default,,0,0,0,,${textField}`);
  }
  return header.concat(lines).join('\n') + '\n';
}

function buildSrt(timings, opts = {}) {
  const groups = groupWords(timings, {});
  return groups.map((g, i) => {
    const txt = g.words.map((w) => maybeCensor(w.word, opts.censor)).join(' ');
    return `${i + 1}\n${srtTs(g.start)} --> ${srtTs(g.end)}\n${txt}\n`;
  }).join('\n');
}
function srtTs(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60), ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}
function esc(s) { return String(s).replace(/[{}]/g, '').replace(/\n/g, ' '); }

// Read-only quality metrics for a set of word timings (used by caption-learning).
// Reports cue count, how many cues read uncomfortably fast, and any residual
// overlaps (always 0 after sanitize — kept as a guard/telemetry signal).
function auditTimeline(timings, opts = {}) {
  const maxWords = opts.maxWords || (opts.style === 'large_centered' ? 4 : 5);
  const groups = groupWords(timings, { maxWords });
  let fast = 0, overlaps = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const end = (i + 1 < groups.length) ? Math.min(groups[i + 1].start, g.end + MAX_HOLD) : g.end;
    const window = Math.max(0.001, end - g.start);
    const chars = g.words.reduce((a, w) => a + String(w.word).length, 0) + Math.max(0, g.words.length - 1);
    if (window < MIN_COMFORTABLE_GROUP && chars / window > FAST_CPS) fast++;
    if (i + 1 < groups.length && g.end > groups[i + 1].start + 1e-6) overlaps++;
  }
  return { groups: groups.length, fast_groups: fast, overlaps };
}

// Generate + persist caption files for a narration.
function generate(narration, opts = {}) {
  if (!narration || !narration.word_timings || !narration.word_timings.length) {
    throw new Error('Narration has no word timings; cannot build synchronized captions.');
  }
  const capId = id('cap');
  const assPath = path.join(PATHS.captions, `${capId}.ass`);
  const srtPath = path.join(PATHS.captions, `${capId}.srt`);
  const censor = !!opts.censor;
  const style = opts.style || 'bold';
  // Best-effort self-tuning: a learned words-per-cue (slower for content that has
  // historically read too fast), then feed this render's quality back in. Never
  // blocks caption generation — the no-overlap guarantee is independent of it.
  let learning = null, maxWords;
  try { learning = require('./caption-learning'); maxWords = learning.suggestMaxWords(style); }
  catch { learning = null; }
  const buildOpts = { ...opts, censor };
  if (maxWords) buildOpts.maxWords = maxWords;
  fs.writeFileSync(assPath, buildAss(narration.word_timings, buildOpts), 'utf8');
  fs.writeFileSync(srtPath, buildSrt(narration.word_timings, { censor }), 'utf8');
  if (learning) {
    try { learning.recordRender(style, auditTimeline(narration.word_timings, buildOpts)); }
    catch { /* learning is optional */ }
  }
  const row = {
    id: capId, narration_id: narration.id, style: opts.style || 'bold', position: opts.position || 'bottom',
    size: opts.size || null, ass_path: assPath, srt_path: srtPath, censored: censor ? 1 : 0, created_at: db.nowIso(),
  };
  db.insert('captions', row);
  log.activity('CAPTIONS', `Created word-level captions (${narration.word_timings.length} words, ${opts.style || 'bold'} style).`, { level: 'success', refId: narration.id });
  return row;
}

function getCaption(capId) { return db.get('SELECT * FROM captions WHERE id = ?', [capId]); }

module.exports = { generate, buildAss, buildSrt, groupWords, sanitizeTimings, auditTimeline, styleDef, getCaption };
