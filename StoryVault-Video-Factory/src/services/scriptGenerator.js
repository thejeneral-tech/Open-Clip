'use strict';
// Script generator (spec §8). Rewrites an approved story into an ORIGINAL,
// narration-ready short-video script — it does NOT copy the source verbatim.
// Transformations: anonymise, strip filler, compress to a duration word-budget,
// restructure into Hook→Setup→Conflict→Escalation→Ending→Question, and vary the
// result by a seed so regenerating yields a genuinely different script (§9/§16).
//
// If an AI provider is configured it can be swapped in via aiProvider.rewrite();
// the heuristic path below keeps the whole app working fully offline.
const db = require('../db/database');
const { id } = require('../util/ids');
const text = require('../util/text');
const { analyze } = require('./analysis');
const safety = require('./safety');
const rng = require('../util/rng');
const dedup = require('./dedup');
const aiProvider = require('./aiProvider');

const FILLER = [
  /\b(so basically|basically|to be honest|honestly|i guess|kind of|sort of|you know|like,|i mean|just to be clear|for context|a little background|long story short|tl;?dr:?)\b/gi,
  /\b(edit|update)\s*\d*\s*:/gi,
];

function stripFiller(s) {
  let t = s;
  for (const re of FILLER) t = t.replace(re, ' ');
  return t.replace(/\s+([.,!?])/g, '$1').replace(/\s+/g, ' ').trim();
}

// Seed-stable index pick: consecutive variationSeeds reliably land on different
// options even for short option lists (so regenerating changes the result).
function seededPick(arr, rand, seedOffset) {
  if (!arr.length) return '';
  const idx = (Math.floor(rand() * arr.length) + (seedOffset | 0)) % arr.length;
  return arr[idx];
}

// Build a SINGLE-sentence hook from the chosen style. Returns the hook plus the
// "source sentence" it was derived from, so the body can avoid repeating it.
function buildHook(style, analysis, story, rand, seedOffset) {
  const conflictSrc = firstSentence(analysis.conflict) || analysis.hookIdeas[0] || story.title;
  const crazySrc = analysis.hookIdeas[0] || conflictSrc;
  const tw = firstSentence(analysis.twist);
  const c = trimHook(conflictSrc);
  const z = trimHook(crazySrc);
  const openers = {
    conflict: [`Here's the situation. ${c}`, `It started when ${lower(c)}`, c],
    craziest: [z, `You won't believe this. ${z}`],
    question: [`${ensureStop(c)} Would you have done the same?`, `${ensureStop(c)} Be honest — was that wrong?`],
    quote: [`"${z.replace(/^["']|["']$/g, '')}"`, `They said it to my face: "${z.replace(/^["']|["']$/g, '')}"`],
    reveal: [tw ? `It ended with ${lower(trimHook(tw))} — but let me back up.` : `This does not end the way you'd think.`, `By the end, it all fell apart. Here's how it started.`],
    calm: [`Let me tell you what happened recently.`, c],
    suspense: [`I had no idea what was coming.`, `Something felt off from the start.`],
    funny: [`This is the most ridiculous thing that's happened to me.`, z],
  };
  const hook = seededPick(openers[style] || openers.conflict, rand, seedOffset);
  return { hook, source: conflictSrc };
}

function firstSentence(s) { return text.sentences(String(s || ''))[0] || String(s || ''); }
function stripPunct(s) { return String(s || '').replace(/[.!?]+$/, ''); }
function ensureStop(s) { s = String(s || '').trim(); return /[.!?]$/.test(s) ? s : s + '.'; }
function trimHook(s) {
  // Drop a leading conjunction so the hook never opens mid-thought ("But my wife is upset…"),
  // then re-capitalise so it reads as a clean standalone opening line.
  const h = stripFiller(firstSentence(s)).replace(/\s+/g, ' ')
    .replace(/^(but|and|so|because|then|also|however|yet|still|anyway|plus)[,]?\s+/i, '').trim();
  return text.truncate(cap(h), 120);
}
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
// True when two normalised sentences share a long common prefix (same sentence).
function overlaps(a, b) {
  if (!a || !b) return false;
  const pa = a.slice(0, 40), pb = b.slice(0, 40);
  return pa === pb || a.includes(b.slice(0, 30)) || b.includes(a.slice(0, 30));
}
function lower(s) { return s.charAt(0).toLowerCase() + s.slice(1); }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Rank sentences by narrative importance for greedy compression.
function rankSentences(sents, analysis) {
  const key = new Set((analysis.keyEvents || []).map((s) => s.slice(0, 30)));
  const emo = new Set((analysis.emotionalMoments || []).map((s) => s.slice(0, 30)));
  return sents.map((s, i) => {
    let w = 1;
    const low = s.toLowerCase();
    if (key.has(s.slice(0, 30))) w += 3;
    if (emo.has(s.slice(0, 30))) w += 2;
    if (/\b(but|then|so|because|refused|demanded|caught|discovered|finally|until)\b/.test(low)) w += 1.5;
    if (/["“]/.test(s)) w += 1; // dialogue
    if (i === 0) w += 1.5;      // opening context
    if (s.length < 25) w -= 1;
    return { s, i, w };
  });
}

function dramatize(s, level, rand) {
  if (level >= 4) {
    s = s.replace(/\bsaid\b/gi, () => rng.pick(rand, ['snapped', 'insisted', 'shot back']));
    s = s.replace(/\bangry\b/gi, 'furious').replace(/\bsurprised\b/gi, 'stunned');
    if (rand() < 0.3 && /[.]$/.test(s)) s = s.replace(/\.$/, '…');
  } else if (level <= 2) {
    s = s.replace(/!+/g, '.').replace(/…/g, '.');
  }
  return s;
}

function generate(story, opts = {}) {
  const {
    durationSeconds = 60, hookStyle = 'conflict', dramaLevel = 3, safeMode = false,
    variationSeed = 0, attribution = true, audienceQuestionOverride = null,
  } = opts;

  const analysis = story.analysis && typeof story.analysis === 'object' ? story.analysis : analyze(story);
  const rand = rng.mulberry32(rng.seedFrom(`${story.id}|${hookStyle}|${durationSeconds}|${variationSeed}`));

  // 1) anonymise, then split into sentences BEFORE stripping filler. Filler words
  //    like "Update:" used to merge two sentences (lowercase follow-on broke the
  //    splitter), so we split first, then clean + re-capitalise each sentence.
  const anon = safety.anonymize(story.body);
  const sents = text.sentences(anon.text)
    .map((s) => {
      let c = stripFiller(s);
      if (safeMode) c = safety.censorText(c);
      return cap(c.trim());
    })
    .filter((s) => s && text.wordCount(s) >= 2);

  // 2) word budget for the body (reserve words for hook + question)
  const totalBudget = Math.round(durationSeconds * text.WORDS_PER_SECOND_NARRATION);
  const bodyBudget = Math.max(20, totalBudget - 26);

  // 3) build hook (single sentence) and note its source so we don't repeat it
  const built = buildHook(hookStyle, analysis, story, rand, variationSeed);
  const hook = cap(dramatize(built.hook, dramaLevel, rand));
  const hookKey = norm(built.source);

  // 4) reserve an ending sentence (cleaned the same way), then pull it (and the
  //    hook source) OUT of the body pool so no sentence is narrated twice.
  const endingSentence = cap(stripFiller(firstSentence(analysis.ending) || sents[sents.length - 1] || ''));
  const endingKey = norm(endingSentence);
  const pool = sents.filter((s) => {
    const k = norm(s);
    return k && !overlaps(k, hookKey) && !overlaps(k, endingKey);
  });

  // 5) greedy-select body sentences by importance, then restore chronological order
  const ranked = rankSentences(pool, analysis).sort((a, b) => b.w - a.w);
  const chosen = [];
  let used = 0;
  for (const r of ranked) {
    const wc = text.wordCount(r.s);
    if (used + wc > bodyBudget && chosen.length >= 2) continue;
    chosen.push(r); used += wc;
    if (used >= bodyBudget) break;
  }
  chosen.sort((a, b) => a.i - b.i);
  // Final dedup pass: no sentence may appear in more than one place, and nothing
  // in the body may echo the hook or the reserved ending.
  const seenKeys = new Set([hookKey, endingKey]);
  const bodySents = [];
  for (const c of chosen) {
    const cleaned = dramatize(stripFiller(c.s), dramaLevel, rand);
    const k = norm(cleaned);
    if (!k || seenKeys.has(k) || overlaps(k, hookKey) || overlaps(k, endingKey)) continue;
    seenKeys.add(k); bodySents.push(cleaned);
  }

  // 6) split into narrative sections for the structured view
  const n = bodySents.length;
  const setup = bodySents.slice(0, Math.max(1, Math.round(n * 0.3)));
  const conflict = bodySents.slice(setup.length, Math.max(setup.length + 1, Math.round(n * 0.7)));
  const escalation = bodySents.slice(setup.length + conflict.length);

  let ending = dramatize(stripFiller(endingSentence), dramaLevel, rand);

  // 7) audience question (seed-varied so regenerating changes it)
  const qVariants = [
    analysis.audienceQuestion,
    `So tell me — ${lower(analysis.audienceQuestion)}`,
    `Comment below: ${lower(analysis.audienceQuestion)}`,
    `Be honest — ${lower(analysis.audienceQuestion)}`,
    `What's the verdict? ${analysis.audienceQuestion}`,
  ];
  const audienceQuestion = audienceQuestionOverride || seededPick(qVariants, rand, variationSeed);

  // 7) narration-ready full text
  const parts = [hook, setup.join(' '), conflict.join(' '), escalation.join(' '), ending, audienceQuestion]
    .map((p) => p && p.trim()).filter(Boolean);
  const fullText = sanitizeForNarration(parts.join(' '));

  const wordCount = text.wordCount(fullText);
  const estSeconds = text.narrationSeconds(fullText);
  const sourceAttribution = attribution && story.url
    ? `Story adapted from a user-submitted post: ${story.url}`
    : 'Based on a user-submitted internet story.';

  return {
    story_id: story.id,
    duration_target: durationSeconds,
    hook_style: hookStyle,
    hook,
    setup: setup.join(' '),
    conflict: conflict.join(' '),
    escalation: escalation.join(' '),
    ending,
    audience_question: audienceQuestion,
    full_text: fullText,
    word_count: wordCount,
    est_seconds: estSeconds,
    drama_level: dramaLevel,
    safe_mode: safeMode ? 1 : 0,
    source_attribution: sourceAttribution,
  };
}

// Anonymisation leaves spoken-unfriendly placeholders ("named [name]", "[redacted]"); strip
// them so narration never reads a bracketed token aloud, then tidy spacing/punctuation.
// Idempotent — safe to apply both at generate() time and again in save() (covers AI rewrites).
function sanitizeForNarration(s) {
  return String(s || '')
    .replace(/\b(?:my name is|i am|i'm|named)\s+\[name\]\s*[,]?/gi, '')
    .replace(/\[name\]/gi, 'them')
    .replace(/\s*\[redacted\]/gi, '')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

// Persist a generated script and register hook/ending fingerprints (§9).
function save(scriptObj) {
  const sid = id('script');
  const row = { id: sid, ...scriptObj, created_at: db.nowIso() };
  // Single chokepoint for narration-text hygiene: heuristic AND AI-rewritten scripts both pass
  // through save(), so placeholders can never reach TTS regardless of which generator ran.
  if (row.full_text) {
    row.full_text = sanitizeForNarration(row.full_text);
    row.word_count = text.wordCount(row.full_text);
    row.est_seconds = text.narrationSeconds(row.full_text);
  }
  db.insert('scripts', row);
  return getScript(sid);
}

function getScript(scriptId) { return db.get('SELECT * FROM scripts WHERE id = ?', [scriptId]); }
function listForStory(storyId) { return db.all('SELECT * FROM scripts WHERE story_id = ? ORDER BY created_at DESC', [storyId]); }

// Generate + save in one call, auto-bumping the variation seed if the produced
// hook was used very recently (keeps openings fresh — spec §9).
function generateAndSave(story, opts = {}) {
  let attempt = 0; let scriptObj;
  do {
    scriptObj = generate(story, { ...opts, variationSeed: (opts.variationSeed || 0) + attempt });
    attempt++;
  } while (attempt < 4 && dedup.hookRecentlyUsed(scriptObj.hook, 30) > 2);
  return save(scriptObj);
}

// AI-first generate + save: rewrite the story with the local LLM when enabled
// and reachable, otherwise fall back to the offline heuristic. Never throws on
// LLM problems — the heuristic always produces a usable script.
async function generateAndSaveAI(story, opts = {}) {
  let useAi = opts.useAi;
  if (useAi === undefined) {
    try { useAi = require('./preferences').get().useAi !== false; } catch { useAi = true; }
  }
  if (useAi && aiProvider.isEnabled({ useAi: true })) {
    try {
      if (await aiProvider.available()) {
        const obj = await aiProvider.rewriteScript(story, opts);
        return save(obj);
      }
    } catch (e) {
      try { require('./logger').activity('SCRIPT', `AI rewrite failed, using heuristic: ${e.message}`, { level: 'warn' }); } catch { /* ignore */ }
    }
  }
  return generateAndSave(story, opts);
}

// Modifier helpers used by the §8 buttons (shorter/longer/dramatic/etc).
function remix(story, baseOpts, modifier) {
  const o = { ...baseOpts };
  switch (modifier) {
    case 'shorter': o.durationSeconds = Math.max(30, (o.durationSeconds || 60) - 15); break;
    case 'longer': o.durationSeconds = Math.min(300, (o.durationSeconds || 60) + 30); break;
    case 'more_dramatic': o.dramaLevel = Math.min(5, (o.dramaLevel || 3) + 1); break;
    case 'less_dramatic': o.dramaLevel = Math.max(1, (o.dramaLevel || 3) - 1); break;
    case 'safer': o.safeMode = true; break;
    case 'improve_hook': o.hookStyle = 'craziest'; o.variationSeed = (o.variationSeed || 0) + 7; break;
    case 'regenerate_ending': o.variationSeed = (o.variationSeed || 0) + 13; break;
    case 'another_angle': o.variationSeed = (o.variationSeed || 0) + 1; o.hookStyle = nextHook(o.hookStyle); break;
    default: o.variationSeed = (o.variationSeed || 0) + 1;
  }
  return generateAndSave(story, o);
}

function nextHook(style) {
  const order = ['conflict', 'craziest', 'question', 'quote', 'reveal', 'suspense', 'funny', 'calm'];
  const i = order.indexOf(style);
  return order[(i + 1) % order.length];
}

module.exports = { generate, save, getScript, listForStory, generateAndSave, generateAndSaveAI, remix, stripFiller };
