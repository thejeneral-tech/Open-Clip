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

// Deterministic avatar colour from the handle (ASS &HAABBGGRR).
function avatarColor(seed) {
  const palette = ['&H00B36B3A&', '&H003A6BB3&', '&H003AB36B&', '&H00A33AB3&', '&H00B33A6B&', '&H003AB3B3&', '&H00B3953A&', '&H005A3AB3&'];
  let h = 0; const s = String(seed || 'x');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
// The display username for the card — the real author, else the display name, never blank.
function displayHandle(opts, isQuora) {
  if (opts.author && !/^\[?deleted\]?$/i.test(opts.author)) return String(opts.author).replace(/^u\//i, '');
  if (opts.displayName) return String(opts.displayName).replace(/^(r\/|u\/)/i, '');
  return isQuora ? 'Quora User' : 'reddit_user';
}

// Fit a single line to a target pixel width by choosing an Arial-Black font size.
function fitSize(text, targetPx, min, max) {
  const len = Math.max(1, esc(text).length);
  const size = Math.floor(targetPx / (len * 0.60));   // ~0.60·size avg glyph width for Arial Black caps
  return Math.max(min, Math.min(max, size));
}

// --- body captions (Stage 3) ----------------------------------------------
// Two modes, both dead-centre horizontally via \an5 + \pos(W/2, centerY):
//   default ('reference')  cumulative \k karaoke — already-spoken words yellow, upcoming white.
//   'pop'                  one short cue (1-2 words) at a time, white rounded fill + heavy
//                          outline, scaling in with a slight overshoot — the "popping words"
//                          look from the reference clip. Each cue holds until the next begins.
function captionEvents(bodyTimings, tpl, censor, W, centerY) {
  if (!bodyTimings || !bodyTimings.length) return [];
  const pop = tpl.style === 'pop';
  // Self-tuning words-per-cue per reference caption mode (best-effort).
  const styleKey = pop ? 'ref_pop' : 'ref_karaoke';
  let learning = null, learnedMax;
  try { learning = require('./caption-learning'); learnedMax = learning.suggestMaxWords(styleKey); }
  catch { learning = null; }
  const maxWords = learnedMax || tpl.maxWords || (pop ? 2 : 4);
  const groups = captions.groupWords(bodyTimings, {
    maxWords,
    maxChars: Math.round((tpl.maxChars || (pop ? 12 : 18)) / 2),
  });
  const cx = Math.round((W || 1080) / 2);
  const cy = Math.round(centerY || 1150);
  const censorFn = censor ? require('./safety').censorText : null;
  const MAX_HOLD = 1.2; // cap how long a cue lingers past its last word (s)
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    // Hold each cue until the next begins (centre never blank, two cues never
    // coexist), capped so a cue can't linger through a long pause.
    const end = (i + 1 < groups.length) ? Math.min(groups[i + 1].start, g.end + MAX_HOLD) : g.end;
    if (pop) {
      const word = esc(g.words.map((w) => (censorFn ? censorFn(w.word) : w.word)).join(' '));
      const anim = '\\fad(50,40)\\fscx70\\fscy70\\t(0,110,\\fscx106\\fscy106)\\t(110,190,\\fscx100\\fscy100)';
      out.push(`Dialogue: 0,${assTime(g.start)},${assTime(end)},Pop,,0,0,0,,{\\an5\\pos(${cx},${cy})${anim}}${word}`);
    } else {
      const text = g.words.map((w) => {
        const cs = Math.max(1, Math.round((w.end - w.start) * 100));
        const word = censorFn ? censorFn(w.word) : w.word;
        return `{\\k${cs}}${esc(word)} `;
      }).join('').trim();
      out.push(`Dialogue: 0,${assTime(g.start)},${assTime(end)},Caption,,0,0,0,,{\\an5\\pos(${cx},${cy})}${text}`);
    }
  }
  if (learning) {
    try { learning.recordRender(styleKey, captions.auditTimeline(bodyTimings, { maxWords })); }
    catch { /* learning is optional */ }
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

  // ---- Stage 1: topic card (X / "ScalingStories"-style) --------------------
  if (tpl.topicCard.enabled) {
    const cw = tpl.topicCard.width;
    const cx = Math.round((W - cw) / 2);
    const pad = 44;
    const innerLeft = cx + pad;
    const innerW = cw - pad * 2;
    const fa = `\\fad(${tpl.topicCard.fade},${tpl.topicCard.fade})`;
    const t0 = assTime(0), t1 = assTime(topicEnd);

    // Identity: a real username + avatar (never "User submitted").
    const handle = displayHandle(opts, isQuora);
    const initial = esc(handle).replace(/^(u\/|@)/i, '').slice(0, 1).toUpperCase() || (isQuora ? 'Q' : 'R');
    const nameTxt = esc(handle.replace(/^u\//i, ''));

    // Title wrap.
    const titleSize = tpl.topicCard.titleSize;
    const maxChars = Math.floor(innerW / (titleSize * 0.52));
    const title = wrap(opts.title || 'Untitled story', maxChars, 5);
    const lineH = Math.round(titleSize * 1.16);

    // Engagement: real values where present, else stylised 99+ (matches the reference card).
    let likeStr = '99+', cmtStr = '99+';
    if (opts.metrics && opts.metrics.upvotes != null) likeStr = compact(opts.metrics.upvotes);
    if (opts.metrics && opts.metrics.comments != null) cmtStr = compact(opts.metrics.comments);

    // Top-down layout cursor (nothing overlaps).
    const padTop = 34, avR = 38, headH = 86, awardsH = 30, gapAfterHead = 16, gapAfterAwards = 18,
      gapAfterTitle = 14, emphH = opts.emphasis ? lineH : 0, metricsH = 44, padBottom = 34;
    const ch = padTop + headH + gapAfterHead + awardsH + gapAfterAwards
      + title.lineCount * lineH + (emphH ? gapAfterTitle + emphH : 0)
      + gapAfterTitle + metricsH + padBottom;
    const cy = Math.round(tpl.topicCard.centerY - ch / 2);

    // Card background + a SUBTLE drop shadow. NOTE: libass shadows are NOT blurred — \shad
    // draws a solid offset copy of the shape. A large offset (was 14) reads as a second box
    // behind the card ("double box"), so keep it small for a single, clean card.
    events.push(`Dialogue: 0,${t0},${t1},Card,,0,0,0,,{${fa}\\p1\\pos(0,0)\\1c${C.cardFill}\\bord0\\shad5\\4c${C.shadow}}${roundedRect(cx, cy, cw, ch, tpl.topicCard.radius)}{\\p0}`);

    // Avatar circle + initial.
    const y = cy + padTop;
    const ax = innerLeft + avR, ay = y + avR;
    events.push(`Dialogue: 1,${t0},${t1},Card,,0,0,0,,{${fa}\\p1\\pos(0,0)\\1c${avatarColor(handle)}\\bord0}${roundedRect(ax - avR, ay - avR, avR * 2, avR * 2, avR)}{\\p0}`);
    events.push(`Dialogue: 2,${t0},${t1},Card,,0,0,0,,{${fa}\\an5\\pos(${ax},${ay})\\fs44\\b1\\1c${C.white}}${initial}`);

    // Name + verified badge.
    const nameSize = 42;
    const nameX = innerLeft + avR * 2 + 22;
    const nameMidY = ay - 8;
    events.push(`Dialogue: 2,${t0},${t1},Card,,0,0,0,,{${fa}\\an4\\pos(${nameX},${nameMidY})\\fs${nameSize}\\b1\\1c${C.cardTitle}}${nameTxt}`);
    const bx = nameX + Math.round(nameTxt.length * nameSize * 0.56) + 24, by = nameMidY, br = 17;
    events.push(`Dialogue: 1,${t0},${t1},Card,,0,0,0,,{${fa}\\p1\\pos(0,0)\\1c&H00E8961D&\\bord0}${roundedRect(bx - br, by - br, br * 2, br * 2, br)}{\\p0}`);
    events.push(`Dialogue: 3,${t0},${t1},Card,,0,0,0,,{${fa}\\an5\\pos(${bx},${by})\\fs22\\b1\\1c${C.white}}✓`);
    // Sub-handle line under the name.
    const sub = isQuora ? 'Quora' : ('u/' + handle.replace(/^u\//i, ''));
    events.push(`Dialogue: 2,${t0},${t1},Card,,0,0,0,,{${fa}\\an4\\pos(${nameX},${ay + 26})\\fs${tpl.topicCard.metaSize}\\1c${C.cardMeta}}${esc(sub)}`);

    // Awards row (stylised colored chips).
    const awY = y + headH + gapAfterHead + Math.round(awardsH / 2);
    ['&H0024B6FF&', '&H00C8C8C8&', '&H003E84CC&', '&H0066D06B&', '&H00E0A6F0&', '&H00F0C040&'].forEach((col, i) => {
      const acx = innerLeft + 14 + i * 38, acr = 13;
      events.push(`Dialogue: 1,${t0},${t1},Card,,0,0,0,,{${fa}\\p1\\pos(0,0)\\1c${col}\\bord3\\3c${C.cardFill}}${roundedRect(acx - acr, awY - acr, acr * 2, acr * 2, acr)}{\\p0}`);
    });

    // Title (bold, near-black).
    const titleY = y + headH + gapAfterHead + awardsH + gapAfterAwards;
    events.push(`Dialogue: 2,${t0},${t1},Card,,0,0,0,,{${fa}\\an7\\pos(${innerLeft},${titleY})\\fs${titleSize}\\b1\\1c${C.cardTitle}}${title.text}`);

    let after = titleY + title.lineCount * lineH;
    if (emphH) {
      const emphY = after + gapAfterTitle;
      events.push(`Dialogue: 2,${t0},${t1},Card,,0,0,0,,{${fa}\\an7\\pos(${innerLeft},${emphY})\\fs${titleSize}\\b1\\1c${C.cardRed}}${esc(opts.emphasis)}`);
      after = emphY + emphH;
    }
    // Engagement row: ♥ likes   🗨 comments.
    const metY = after + gapAfterTitle + 18;
    events.push(`Dialogue: 2,${t0},${t1},Card,,0,0,0,,{${fa}\\an4\\pos(${innerLeft},${metY})\\fs36\\1c${C.cardRed}}♥ {\\1c${C.cardMeta}}${esc(likeStr)}      {\\1c${C.cardMeta}}🗨 ${esc(cmtStr)}`);
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
  const capCenterY = tpl.captions.centerY || (tpl.canvas.height - tpl.captions.marginV);
  const capEvents = captionEvents(bodyTimings, tpl.captions, opts.censor, W, capCenterY);

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
    // Pop: dead-centre "popping word" captions — white rounded fill, heavy black outline (reference replica)
    `Style: Pop,${cap.font || 'Arial Rounded MT Bold'},${cap.size},${C.white},${C.white},${C.black},${C.black},-1,0,0,0,100,100,0,0,1,${cap.outline},2,5,${tpl.safe.side},${tpl.safe.side},0,1`,
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
