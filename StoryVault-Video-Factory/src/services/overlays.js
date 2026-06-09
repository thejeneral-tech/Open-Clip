'use strict';
// Reference-template overlay engine ("Full-Screen Story Gameplay").
//
// Produces a SINGLE ASS subtitle file that, burned over the full-screen gameplay,
// renders the exact 3-stage intro sequence the reference video uses:
//   Stage 1  Topic card     — white rounded Reddit/Quora card (title + source + metrics)
//   Stage 2  Author intro    — big bold yellow "Posted by u/username" w/ thick black outline
//   Stage 3  Story captions  — white bold karaoke captions, current words highlighted yellow
//
// Everything is drawn with ASS (vector card + positioned text + \k karaoke), so it needs
// NO extra binaries (no headless browser, no canvas, no PNG step) and reuses the existing
// `subtitles=`/`ass=` burn path in composer.js. Colours are ASS &HAABBGGRR.
//
// The three stages are time-driven by the real narration word timings so audio, cards and
// captions stay in sync: the topic card spans the spoken title, the author card spans the
// spoken "Posted by …" line, and captions cover the body from there on.

const captions = require('./captions');
const { REFERENCE_TEMPLATE, COLORS: C } = require('../templates-data');

// --- helpers ---------------------------------------------------------------
function assTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(Math.min(99, cs)).padStart(2, '0')}`;
}

// Strip characters that would break ASS override blocks; caller adds \N for line breaks.
function esc(s) { return String(s == null ? '' : s).replace(/[\\{}]/g, '').replace(/\r?\n+/g, ' ').trim(); }

// Greedy word-wrap to a max characters-per-line; returns ASS text with \N breaks.
function wrap(text, maxChars, maxLines = 4) {
  const words = esc(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) line = w;
    else if ((line + ' ' + w).length <= maxChars) line += ' ' + w;
    else { lines.push(line); line = w; if (lines.length >= maxLines - 1) break; }
  }
  if (line && lines.length < maxLines) lines.push(line);
  // absorb any overflow into the last line
  const used = lines.join(' ').split(/\s+/).length;
  if (used < words.length) lines[lines.length - 1] += ' ' + words.slice(used).join(' ');
  return { text: lines.join('\\N'), lineCount: lines.length };
}

// Rounded-rectangle vector path for an ASS {\p1} drawing (top-left origin via \an7 \pos(0,0)).
function roundedRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const x2 = x + w, y2 = y + h;
  return [
    `m ${x + r} ${y}`,
    `l ${x2 - r} ${y}`, `b ${x2} ${y} ${x2} ${y} ${x2} ${y + r}`,
    `l ${x2} ${y2 - r}`, `b ${x2} ${y2} ${x2} ${y2} ${x2 - r} ${y2}`,
    `l ${x + r} ${y2}`, `b ${x} ${y2} ${x} ${y2} ${x} ${y2 - r}`,
    `l ${x} ${y + r}`, `b ${x} ${y} ${x} ${y} ${x + r} ${y}`,
  ].join(' ');
}

// Fit a single line to a target pixel width by choosing an Arial-Black font size.
function fitSize(text, targetPx, min, max) {
  const len = Math.max(1, esc(text).length);
  const size = Math.floor(targetPx / (len * 0.60));   // ~0.60·size avg glyph width for Arial Black caps
  return Math.max(min, Math.min(max, size));
}

// --- karaoke body captions (Stage 3) --------------------------------------
// Reuses the proven word-grouping from captions.js; emits cumulative \k cues so already-
// spoken words are yellow and upcoming words white (current-word highlight effect).
function captionEvents(bodyTimings, tpl, censor) {
  if (!bodyTimings || !bodyTimings.length) return [];
  const groups = captions.groupWords(bodyTimings, { maxWords: tpl.maxWords, maxChars: Math.round((tpl.maxChars || 18) / 2) });
  const out = [];
  for (const g of groups) {
    const text = g.words.map((w) => {
      const cs = Math.max(1, Math.round((w.end - w.start) * 100));
      const word = censor ? require('./safety').censorText(w.word) : w.word;
      return `{\\k${cs}}${esc(word)} `;
    }).join('').trim();
    out.push(`Dialogue: 0,${assTime(g.start)},${assTime(g.end)},Caption,,0,0,0,,${text}`);
  }
  return out;
}

// --- main build ------------------------------------------------------------
// opts: { platform, displayName, author, title, subreddit, metrics:{upvotes,comments,views},
//         emphasis, wordTimings, topicEnd, introEnd, template, censor }
// topicEnd/introEnd are seconds into the narration where the title / "posted by" lines finish.
function buildAss(opts = {}) {
  const tpl = mergeTemplate(opts.template);
  const platform = (opts.platform || 'reddit').toLowerCase();
  const isQuora = platform === 'quora';

  const topicEnd = clampWindow(opts.topicEnd, tpl.topicCard.minSeconds, tpl.topicCard.maxSeconds);
  const introEnd = Math.max(topicEnd + tpl.authorIntro.minSeconds,
    clampWindow(opts.introEnd, topicEnd + tpl.authorIntro.minSeconds, topicEnd + tpl.authorIntro.maxSeconds));

  const W = tpl.canvas.width;
  const events = [];

  // ---- Stage 1: topic card --------------------------------------------------
  if (tpl.topicCard.enabled) {
    const cw = tpl.topicCard.width;
    const cx = Math.round((W - cw) / 2);
    const pad = 46;
    const avatar = tpl.topicCard.avatar;
    const titleLeft = cx + pad;
    const metaLeft = cx + pad + (avatar ? 84 : 0);
    const innerW = cw - pad * 2;
    const maxChars = Math.floor(innerW / (tpl.topicCard.titleSize * 0.50));
    const title = wrap(opts.title || 'Untitled story', maxChars, 5);
    const lineH = Math.round(tpl.topicCard.titleSize * 1.18);
    const fa = `\\fad(${tpl.topicCard.fade},${tpl.topicCard.fade})`;
    const t0 = assTime(0), t1 = assTime(topicEnd);

    const sourceLabel = isQuora
      ? (opts.subreddit || 'Quora') + (opts.author ? '  •  ' + opts.author : '')
      : (opts.subreddit || opts.displayName || 'r/AskReddit') + (opts.author ? '  •  u/' + opts.author : '');

    const metricParts = [];
    if (opts.metrics) {                                       // only real values — never fabricated
      if (opts.metrics.upvotes != null) metricParts.push('▲ ' + compact(opts.metrics.upvotes));
      if (opts.metrics.comments != null) metricParts.push('🗨 ' + compact(opts.metrics.comments));
      if (opts.metrics.views != null) metricParts.push('👁 ' + compact(opts.metrics.views));
    }

    // Lay the card out top-down with a running cursor so nothing overlaps.
    const padTop = 36, gapAfterMeta = 30, gapAfterTitle = 14, gapAfterEmph = 16, padBottom = 38;
    const metaH = 40;
    const emphH = opts.emphasis ? lineH : 0;
    const metricsH = metricParts.length ? 44 : 0;
    const ch = padTop + metaH + gapAfterMeta + title.lineCount * lineH
      + (emphH ? gapAfterTitle + emphH : 0)
      + (metricsH ? gapAfterTitle + metricsH : 0) + padBottom;
    const cy = Math.round(tpl.topicCard.centerY - ch / 2);

    let y = cy + padTop;
    const metaY = y;
    const titleY = metaY + metaH + gapAfterMeta;
    let emphY = null, metricsY = null;
    let after = titleY + title.lineCount * lineH;
    if (emphH) { emphY = after + gapAfterTitle; after = emphY + emphH; }
    if (metricsH) { metricsY = after + (emphH ? gapAfterEmph : gapAfterTitle); }

    // shadow + white rounded card
    events.push(`Dialogue: 0,${t0},${t1},Card,,0,0,0,,{${fa}\\p1\\pos(0,0)\\1c${C.cardFill}\\bord0\\shad10\\4c${C.shadow}}${roundedRect(cx, cy, cw, ch, tpl.topicCard.radius)}{\\p0}`);
    // optional avatar (filled circle with initial)
    if (avatar) {
      const ar = 28, ax = cx + pad + ar, ay = metaY + 14;
      events.push(`Dialogue: 1,${t0},${t1},Card,,0,0,0,,{${fa}\\p1\\pos(0,0)\\1c&H00B36B3A&\\bord0}${roundedRect(ax - ar, ay - ar, ar * 2, ar * 2, ar)}{\\p0}`);
      const initial = esc((opts.displayName || opts.subreddit || (isQuora ? 'Q' : 'r')).replace(/^(r\/|u\/)/i, '')).slice(0, 1).toUpperCase() || (isQuora ? 'Q' : 'R');
      events.push(`Dialogue: 2,${t0},${t1},Card,,0,0,0,,{${fa}\\an5\\pos(${ax},${ay})\\fs32\\b1\\1c${C.white}}${initial}`);
    }
    // meta line
    events.push(`Dialogue: 2,${t0},${t1},Card,,0,0,0,,{${fa}\\an4\\pos(${metaLeft},${metaY + 20})\\fs${tpl.topicCard.metaSize}\\1c${C.cardMeta}}${esc(sourceLabel)}`);
    // title (bold, near-black)
    events.push(`Dialogue: 2,${t0},${t1},Card,,0,0,0,,{${fa}\\an7\\pos(${titleLeft},${titleY})\\fs${tpl.topicCard.titleSize}\\b1\\1c${C.cardTitle}}${title.text}`);
    // optional emphasis line in red (e.g. "Plus ten updates.")
    if (emphY != null) {
      events.push(`Dialogue: 2,${t0},${t1},Card,,0,0,0,,{${fa}\\an7\\pos(${titleLeft},${emphY})\\fs${tpl.topicCard.titleSize}\\b1\\1c${C.cardRed}}${esc(opts.emphasis)}`);
    }
    // metrics row (only when real values are provided)
    if (metricsY != null) {
      events.push(`Dialogue: 2,${t0},${t1},Card,,0,0,0,,{${fa}\\an7\\pos(${titleLeft},${metricsY})\\fs34\\1c${C.cardMeta}}${esc(metricParts.join('     '))}`);
    }
  }

  // ---- Stage 2: author intro -----------------------------------------------
  if (tpl.authorIntro.enabled) {
    const prefix = isQuora ? tpl.authorIntro.prefixQuora : tpl.authorIntro.prefixReddit;
    const handle = isQuora
      ? (opts.author || opts.displayName || 'Anonymous')
      : 'u/' + (opts.author || (opts.displayName || '').replace(/^u\//, '') || 'anonymous');
    const targetPx = W - 80;
    const size = Math.min(
      fitSize(handle, targetPx, tpl.authorIntro.minSize, tpl.authorIntro.maxSize),
      fitSize(prefix, targetPx, tpl.authorIntro.minSize, tpl.authorIntro.maxSize)
    );
    const a0 = assTime(topicEnd + 0.05), a1 = assTime(introEnd);
    const pop = tpl.authorIntro.popScale;
    events.push(`Dialogue: 0,${a0},${a1},Author,,0,0,0,,{\\fad(${tpl.authorIntro.fade},${tpl.authorIntro.fade})\\fs${size}\\fscx${pop}\\fscy${pop}\\t(0,180,\\fscx100\\fscy100)}${esc(prefix)}\\N${esc(handle)}`);
  }

  // ---- Stage 3: body captions ----------------------------------------------
  const bodyTimings = (opts.wordTimings || []).filter((w) => w.start >= introEnd - 0.001);
  const capEvents = captionEvents(bodyTimings, tpl.captions, opts.censor);

  return header(tpl) + '\n' + events.concat(capEvents).join('\n') + '\n';
}

function header(tpl) {
  const ai = tpl.authorIntro, cap = tpl.captions;
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${tpl.canvas.width}`,
    `PlayResY: ${tpl.canvas.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Card: top-left origin, no outline (we draw fills + positioned text)
    `Style: Card,Arial,40,${C.cardTitle},${C.cardTitle},${C.black},${C.black},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    // Author: centered, bold, thick black outline, yellow fill
    `Style: Author,Arial Black,${ai.maxSize},${C.yellow},${C.yellow},${C.black},${C.black},-1,0,0,0,100,100,0,0,1,${ai.outline},0,5,40,40,0,1`,
    // Caption: bottom-centre, bold, thick outline; primary=yellow secondary=white for \k sweep
    `Style: Caption,Arial,${cap.size},${cap.highlight},${cap.primary},${C.black},${C.black},-1,0,0,0,100,100,0,0,1,${cap.outline},2,2,${tpl.safe.side},${tpl.safe.side},${cap.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
}

function mergeTemplate(t) {
  if (!t) return REFERENCE_TEMPLATE;
  return {
    ...REFERENCE_TEMPLATE, ...t,
    canvas: { ...REFERENCE_TEMPLATE.canvas, ...(t.canvas || {}) },
    safe: { ...REFERENCE_TEMPLATE.safe, ...(t.safe || {}) },
    topicCard: { ...REFERENCE_TEMPLATE.topicCard, ...(t.topicCard || {}) },
    authorIntro: { ...REFERENCE_TEMPLATE.authorIntro, ...(t.authorIntro || {}) },
    captions: { ...REFERENCE_TEMPLATE.captions, ...(t.captions || {}) },
  };
}

function clampWindow(v, min, max) {
  if (v == null || isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}
function compact(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// Given full word timings + word counts of the title / "posted by" lines, find the seconds
// where the topic card and author intro should end (so cards track the spoken audio).
function boundariesFromTimings(wordTimings, titleWordCount, authorLineWordCount) {
  const wt = wordTimings || [];
  const topicEnd = wt[titleWordCount - 1] ? wt[titleWordCount - 1].end : null;
  const introIdx = titleWordCount + authorLineWordCount - 1;
  const introEnd = wt[introIdx] ? wt[introIdx].end : null;
  return { topicEnd, introEnd };
}

module.exports = { buildAss, boundariesFromTimings, REFERENCE_TEMPLATE, mergeTemplate, roundedRect, wrap, assTime };
