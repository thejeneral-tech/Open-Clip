'use strict';
// Story analysis (spec §7). Produces the structured JSON the UI shows and the
// script generator consumes. Heuristic — no external AI required, but designed
// so an AI provider could replace any single extractor later.
const text = require('../util/text');
const safety = require('./safety');

const CONFLICT_WORDS = ['but', 'however', 'refused', 'argued', 'fight', 'angry', 'upset', 'betrayed',
  'cheated', 'lied', 'stole', 'demanded', 'confronted', 'screamed', 'yelled', 'broke up', 'divorce',
  'revenge', 'caught', 'accused', 'threatened', 'banned', 'fired', 'kicked out'];

const EMOTION_WORDS = ['cried', 'crying', 'heartbroken', 'devastated', 'shocked', 'furious', 'terrified',
  'humiliated', 'embarrassed', 'guilty', 'ashamed', 'relieved', 'happy', 'proud', 'scared', 'anxious',
  'betrayed', 'hurt', 'love', 'hate'];

const TWIST_WORDS = ['turns out', 'turned out', 'plot twist', 'little did', 'what i didn\'t know',
  'unbeknownst', 'suddenly', 'then i found out', 'i discovered', 'revealed', 'it was actually'];

const ENDING_WORDS = ['in the end', 'eventually', 'finally', 'now', 'these days', 'looking back',
  'update', 'edit:', 'tl;dr', 'so now', 'ever since'];

function pickSentences(sents, words, max = 3) {
  const scored = sents.map((s) => {
    const low = s.toLowerCase();
    let hits = 0;
    for (const w of words) if (low.includes(w)) hits++;
    return { s, hits };
  }).filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits);
  return scored.slice(0, max).map((x) => x.s);
}

function detectMainCharacter(body) {
  if (/\b(I|I'm|I've|my|me)\b/.test(body)) return 'The narrator (first person)';
  const names = safety.detectNames(body);
  return names[0] || 'Unknown';
}

function buildAudienceQuestion(category, body) {
  const c = (category || '').toLowerCase();
  if (c.includes('aita')) return 'Am I the asshole here?';
  if (c.includes('revenge')) return 'Did they get what they deserved?';
  if (c.includes('relationship') || c.includes('cheat')) return 'Should they stay or walk away?';
  if (c.includes('moral')) return 'What would you have done?';
  if (c.includes('entitled')) return 'Was this person out of line?';
  if (/\bwrong\b/i.test(body)) return 'Was I wrong for what I did?';
  return 'What would you have done in this situation?';
}

function analyze(story) {
  const body = story.body || '';
  const sents = text.sentences(body);
  const lowBody = body.toLowerCase();

  const keyEvents = [];
  // First meaningful sentence as setup, plus action sentences.
  for (const s of sents) {
    if (/\b(then|after|next|so|because|when|once|the next day|later)\b/i.test(s) && s.length > 30) {
      keyEvents.push(text.truncate(s, 160));
    }
    if (keyEvents.length >= 6) break;
  }

  const conflictSents = pickSentences(sents, CONFLICT_WORDS, 2);
  const emotionalMoments = pickSentences(sents, EMOTION_WORDS, 3).map((s) => text.truncate(s, 160));

  let twist = '';
  for (const s of sents) {
    if (TWIST_WORDS.some((w) => s.toLowerCase().includes(w))) { twist = text.truncate(s, 180); break; }
  }

  // Ending = last sentence(s), preferring an explicit closer.
  let ending = '';
  for (let i = sents.length - 1; i >= 0 && i >= sents.length - 4; i--) {
    if (ENDING_WORDS.some((w) => sents[i].toLowerCase().includes(w))) { ending = sents[i]; break; }
  }
  if (!ending && sents.length) ending = sents[sents.length - 1];

  const anon = safety.anonymize(body);
  const warnings = safety.detectWarnings(body);
  const names = safety.detectNames(body);

  const estSeconds = Math.max(15, text.narrationSeconds(body));

  // Hook idea candidates pulled from the punchiest sentences.
  const hookIdeas = sents
    .filter((s) => s.length > 25 && s.length < 140)
    .sort((a, b) => scoreHookSentence(b) - scoreHookSentence(a))
    .slice(0, 3)
    .map((s) => text.truncate(s.trim(), 130));

  return {
    mainCharacter: detectMainCharacter(body),
    otherPeople: names.slice(0, 6),
    relationship: detectRelationship(lowBody),
    conflict: conflictSents.map((s) => text.truncate(s, 180)).join(' ') || (sents[1] ? text.truncate(sents[1], 180) : ''),
    keyEvents,
    emotionalMoments,
    twist,
    ending: text.truncate(ending, 200),
    audienceQuestion: buildAudienceQuestion(story.category, body),
    warnings,
    namesToAnonymize: names,
    detailsToRemove: anon.removed,
    hookIdeas,
    hasUpdate: /\b(update|edit:)\b/i.test(body),
    hasDialogue: /["“][^"”]{8,}["”]/.test(body) || /\bsaid\b|\btold\b|\basked\b/i.test(body),
    estimatedDurationSeconds: Math.round(estSeconds),
  };
}

function detectRelationship(low) {
  const rels = ['boyfriend', 'girlfriend', 'husband', 'wife', 'partner', 'mother', 'father', 'mom',
    'dad', 'sister', 'brother', 'friend', 'roommate', 'boss', 'coworker', 'neighbor', 'mil', 'sil',
    'in-law', 'ex', 'fiancé', 'fiance'];
  const found = rels.filter((r) => new RegExp(`\\b${r}\\b`).test(low));
  return found.slice(0, 4).join(', ') || 'Unspecified';
}

function scoreHookSentence(s) {
  let score = 0;
  const low = s.toLowerCase();
  if (/[?!]/.test(s)) score += 2;
  for (const w of CONFLICT_WORDS) if (low.includes(w)) score += 2;
  for (const w of EMOTION_WORDS) if (low.includes(w)) score += 1.5;
  if (/\b(never|always|every|everyone|nobody)\b/.test(low)) score += 1;
  if (s.length > 40 && s.length < 110) score += 1;
  return score;
}

module.exports = { analyze };
