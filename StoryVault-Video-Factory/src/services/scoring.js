'use strict';
// Transparent StoryVault Quality Score (0–100). Eight weighted categories, each scored
// from REAL available signals + heuristic story analysis. A 100 is deliberately almost
// impossible (every category must be near-perfect). Engagement metrics are labelled
// verified / estimated / unavailable and NEVER fabricated.
//
//   1. Engagement quality   0–20   (real platform metrics, normalised per-community)
//   2. Story structure      0–20
//   3. Hook strength        0–15
//   4. Emotional tension    0–15
//   5. Narration suitability 0–10
//   6. Ending quality       0–10
//   7. Originality          0–5
//   8. Duration fit         0–5
//                          = 100
const text = require('../util/text');
const { analyze } = require('./analysis');

const MAX = { engagement: 20, structure: 20, hook: 15, emotional: 15, narration: 10, ending: 10, originality: 5, duration: 5 };
const GLOBAL_UPVOTE_REF = Math.log10(50000 + 1);
const GLOBAL_COMMENT_REF = Math.log10(8000 + 1);

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function r1(x) { return Math.round(x * 10) / 10; }

// Per-community normalisation context so a small sub isn't out-ranked by a huge one.
function buildContext(stories) {
  const byCommunity = {};
  for (const s of stories) {
    const key = (s.community || s.source_type || 'unknown').toLowerCase();
    const up = Math.log10((s.upvotes || 0) + 1);
    const com = Math.log10((s.num_comments || 0) + 1);
    if (!byCommunity[key]) byCommunity[key] = { maxUp: 0, maxCom: 0 };
    byCommunity[key].maxUp = Math.max(byCommunity[key].maxUp, up);
    byCommunity[key].maxCom = Math.max(byCommunity[key].maxCom, com);
  }
  return { byCommunity };
}

// Are this story's engagement metrics real (verified), guessable (estimated) or absent?
function metricProvenance(story) {
  const isReddit = /^reddit/.test(story.source_type || '');
  const up = isReddit ? 'verified' : (story.upvotes > 0 ? 'estimated' : 'unavailable');
  const com = isReddit ? 'verified' : (story.num_comments > 0 ? 'estimated' : 'unavailable');
  const views = story.views > 0 ? (isReddit ? 'estimated' : 'estimated') : 'unavailable';
  const engagement = (up === 'verified' || com === 'verified') ? 'verified'
    : (story.upvotes > 0 || story.num_comments > 0 ? 'estimated' : 'unavailable');
  return { upvotes: up, comments: com, views, engagement };
}

// 1. Engagement (0–20). Verified metrics only; unavailable → modest neutral baseline.
function engagementScore(story, ctx, prov) {
  if (prov.engagement === 'unavailable') {
    return { score: r1(0.28 * MAX.engagement), detail: 'No source engagement metrics available — neutral baseline.' };
  }
  const key = (story.community || story.source_type || 'unknown').toLowerCase();
  const up = Math.log10((story.upvotes || 0) + 1);
  const com = Math.log10((story.num_comments || 0) + 1);
  const cMaxUp = ctx?.byCommunity?.[key]?.maxUp || up || 1;
  const cMaxCom = ctx?.byCommunity?.[key]?.maxCom || com || 1;
  const relUp = cMaxUp > 0 ? up / cMaxUp : 0;
  const absUp = up / GLOBAL_UPVOTE_REF;
  const relCom = cMaxCom > 0 ? com / cMaxCom : 0;
  const absCom = com / GLOBAL_COMMENT_REF;
  const ratio = story.upvotes > 0 ? (story.num_comments || 0) / story.upvotes : 0;
  const ratioBonus = clamp01(ratio / 0.3) * 0.15;
  const awards = clamp01((story.awards || 0) / 5) * 0.1;
  const raw = clamp01(0.30 * relUp + 0.20 * absUp + 0.18 * relCom + 0.12 * absCom + ratioBonus + awards);
  const factor = prov.engagement === 'estimated' ? 0.75 : 1; // estimated can't reach the top
  return { score: r1(raw * factor * MAX.engagement), detail: `${story.upvotes || 0} upvotes · ${story.num_comments || 0} comments (${prov.engagement}).` };
}

// 2. Structure (0–20): setup, conflict, escalation, decision, consequence, ending, timeline.
function structureScore(story, a) {
  const sents = text.sentences(story.body);
  const paras = text.paragraphs(story.body).length;
  const has = {
    setup: sents.length >= 2 ? 1 : 0.3,
    conflict: a.conflict && a.conflict.length > 12 ? 1 : 0.2,
    escalation: clamp01((a.keyEvents?.length || 0) / 4),
    decision: /\b(decided|chose|refused|told them|confronted|i said no|i left|i stayed)\b/i.test(story.body) ? 1 : 0.3,
    consequence: (a.ending && a.ending.length > 12) ? 1 : 0.3,
    ending: a.ending && a.ending.length > 20 ? 1 : 0.4,
    timeline: clamp01(paras / 4) * 0.6 + clamp01(1 - Math.abs(avgSentenceLen(story.body) - 17) / 30) * 0.4,
  };
  const raw = (has.setup + has.conflict + has.escalation + has.decision + has.consequence + has.ending + has.timeline) / 7;
  return { score: r1(clamp01(raw) * MAX.structure), detail: `${paras} paragraphs · ${sents.length} sentences · clear arc ${Math.round(raw * 100)}%.` };
}

// 3. Hook (0–15).
function hookScore(story, a) {
  const first = (story.title || '') + ' ' + (text.sentences(story.body)[0] || '');
  let s = clamp01((a.hookIdeas?.length || 0) / 3) * 0.4;
  if (/[?!]/.test(first)) s += 0.18;
  if (/\b(never|always|everyone|nobody|worst|best|crazy|insane|unbelievable|caught|refused)\b/i.test(first)) s += 0.22;
  if (a.twist) s += 0.2;
  return { score: r1(clamp01(s) * MAX.hook), detail: 'Opening curiosity + stakes in the first lines.' };
}

// 4. Emotional tension (0–15).
function emotionalScore(story, a) {
  const moments = clamp01((a.emotionalMoments?.length || 0) / 3) * 0.5;
  const conflict = a.conflict && a.conflict.length > 12 ? 0.3 : 0.05;
  const controversy = story.upvote_ratio != null ? clamp01((0.95 - story.upvote_ratio) / 0.25) * 0.2 : 0.08;
  return { score: r1(clamp01(moments + conflict + controversy) * MAX.emotional), detail: `${a.emotionalMoments?.length || 0} emotional beat(s).` };
}

// 5. Narration suitability (0–10): readability, sentence length, formatting noise, names.
function narrationScore(story, a) {
  const body = story.body || '';
  const asl = avgSentenceLen(body);
  const lenOk = clamp01(1 - Math.abs(asl - 16) / 26);                 // ideal ~16 words/sentence
  const urlNoise = (body.match(/https?:\/\/|\bwww\./gi) || []).length;
  const fmtNoise = (body.match(/[*_`>#]|\bEDIT\b|\bTL;DR\b/gi) || []).length;
  const allCaps = (body.match(/\b[A-Z]{4,}\b/g) || []).length;
  const noise = clamp01((urlNoise * 2 + fmtNoise + allCaps) / 12);
  const nameLoad = clamp01((a.namesToAnonymize?.length || 0) / 8);
  const raw = lenOk * 0.55 + (1 - noise) * 0.30 + (1 - nameLoad) * 0.15;
  return { score: r1(clamp01(raw) * MAX.narration), detail: `~${Math.round(asl)} words/sentence · ${urlNoise + fmtNoise} formatting issue(s).` };
}

// 6. Ending quality (0–10).
function endingScore(a) {
  let s = 0.2;
  if (a.ending && a.ending.length > 18) s += 0.3;
  if (a.hasUpdate) s += 0.28;
  if (a.twist) s += 0.22;
  return { score: r1(clamp01(s) * MAX.ending), detail: a.hasUpdate ? 'Includes an update/resolution.' : 'Has a closing beat.' };
}

// 7. Originality (0–5): 1 − duplicate similarity.
function originalityScore(story, opts) {
  const orig = clamp01(opts.originality != null ? opts.originality : 1 - (story.duplicate_score || 0));
  return { score: r1(orig * MAX.originality), detail: orig >= 0.99 ? 'No similar story found.' : `${Math.round((1 - orig) * 100)}% similar to an existing story.` };
}

// 8. Duration fit (0–5): usable words vs the selected 1–3 min target.
function durationScore(story, a, opts) {
  const targetSec = opts.targetDuration || 90;
  const estSec = a.estimatedDurationSeconds || text.narrationSeconds(story.body);
  const ratio = estSec / targetSec;
  // best when the story can comfortably fill (or slightly exceed) the target
  let fit;
  if (ratio < 0.4) fit = 0.25;
  else if (ratio < 0.7) fit = 0.6;
  else if (ratio <= 1.6) fit = 1.0;
  else if (ratio <= 3) fit = 0.6;
  else fit = 0.35;
  return { score: r1(fit * MAX.duration), detail: `~${Math.round(estSec)}s of narration vs ${targetSec}s target.` };
}

function avgSentenceLen(body) {
  const sents = text.sentences(body);
  if (!sents.length) return 18;
  return text.wordCount(body) / sents.length;
}

const LABELS = [[90, 'Exceptional'], [80, 'Strong'], [70, 'Usable'], [60, 'Weak'], [0, 'Reject']];
function labelFor(overall) { return (LABELS.find(([t]) => overall >= t) || [0, 'Reject'])[1]; }

function scoreStory(story, ctx, opts = {}) {
  const a = story.analysis && typeof story.analysis === 'object' ? story.analysis : analyze(story);
  const prov = metricProvenance(story);

  const parts = {
    engagement: engagementScore(story, ctx, prov),
    structure: structureScore(story, a),
    hook: hookScore(story, a),
    emotional: emotionalScore(story, a),
    narration: narrationScore(story, a),
    ending: endingScore(a),
    originality: originalityScore(story, opts),
    duration: durationScore(story, a, opts),
  };

  const overall = Math.round(Object.values(parts).reduce((sum, p) => sum + p.score, 0));
  const breakdown = [
    { key: 'engagement', label: 'Engagement', score: parts.engagement.score, max: MAX.engagement, provenance: prov.engagement, detail: parts.engagement.detail },
    { key: 'structure', label: 'Story structure', score: parts.structure.score, max: MAX.structure, detail: parts.structure.detail },
    { key: 'hook', label: 'Hook strength', score: parts.hook.score, max: MAX.hook, detail: parts.hook.detail },
    { key: 'emotional', label: 'Emotional tension', score: parts.emotional.score, max: MAX.emotional, detail: parts.emotional.detail },
    { key: 'narration', label: 'Narration fit', score: parts.narration.score, max: MAX.narration, detail: parts.narration.detail },
    { key: 'ending', label: 'Ending quality', score: parts.ending.score, max: MAX.ending, detail: parts.ending.detail },
    { key: 'originality', label: 'Originality', score: parts.originality.score, max: MAX.originality, detail: parts.originality.detail },
    { key: 'duration', label: 'Duration fit', score: parts.duration.score, max: MAX.duration, detail: parts.duration.detail },
  ];

  // Legacy 0–100 sub-scores so existing DB columns + UI bars stay meaningful.
  const pctOf = (p) => Math.round((p.score / p.max) * 100);
  const legacy = {
    popularity: Math.round(popularity01(story) * 100),
    engagement: pctOf(parts.engagement),
    quality: pctOf(parts.structure),
    hook: pctOf(parts.hook),
    conflict: pctOf(parts.emotional),
    ending: pctOf(parts.ending),
    video: pctOf(parts.duration),
    originality: pctOf(parts.originality),
    recency: Math.round(recency01(story) * 100),
  };

  return {
    analysis: a, overall, label: labelFor(overall), breakdown, legacy, provenance: prov,
    estVideoSeconds: a.estimatedDurationSeconds, reasons: buildReasons(breakdown, a, story, prov),
  };
}

function popularity01(story) {
  const up = Math.log10((story.upvotes || 0) + 1);
  return clamp01(up / GLOBAL_UPVOTE_REF);
}
function recency01(story) {
  if (!story.created_utc) return 0.5;
  const ageDays = (Date.now() / 1000 - story.created_utc) / 86400;
  if (ageDays < 2) return 1; if (ageDays < 7) return 0.85; if (ageDays < 30) return 0.65;
  if (ageDays < 180) return 0.45; if (ageDays < 365) return 0.3; return 0.2;
}

function buildReasons(breakdown, a, story, prov) {
  const r = [];
  const get = (k) => breakdown.find((b) => b.key === k);
  if (get('engagement').score / get('engagement').max > 0.7 && prov.engagement === 'verified') r.push(`Strong verified engagement (${story.num_comments || 0} comments)`);
  if (get('structure').score / get('structure').max > 0.75) r.push('Clear story arc');
  if (get('hook').score / get('hook').max > 0.7) r.push('Punchy opening hook');
  if (get('emotional').score / get('emotional').max > 0.7) r.push('High emotional tension');
  if (a.hasUpdate) r.push('Includes an update / resolution');
  if (a.twist) r.push('Contains a twist');
  if (get('duration').score / get('duration').max > 0.85) r.push(`Good length (~${a.estimatedDurationSeconds}s)`);
  if (prov.engagement !== 'verified') r.push(`Engagement ${prov.engagement} — scored conservatively`);
  if (!r.length) r.push('Meets baseline quality for a short video');
  return r;
}

function scoreBatch(stories, optsFn) {
  const ctx = buildContext(stories);
  return stories.map((s) => scoreStory(s, ctx, optsFn ? optsFn(s) : {}));
}

module.exports = { MAX, scoreStory, scoreBatch, buildContext, labelFor, metricProvenance };
