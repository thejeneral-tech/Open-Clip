'use strict';
/**
 * AI provider — rewrites a story into a narration-ready script using the local
 * LLM (Ollama / llama.cpp). This is the `aiProvider.rewrite()` hook documented
 * in scriptGenerator.js. Returns a scriptObj in the SAME shape the heuristic
 * generator produces, so save()/composer/captions are unaffected. Any failure
 * throws so the caller can fall back to the offline heuristic.
 */
const llm = require('./llm');
const text = require('../util/text');
const safety = require('./safety');
const { AI } = require('../config');
const llmAdmin = require('./llmAdmin');

function isEnabled(prefs) { return !prefs || prefs.useAi !== false; }
function available() { return llm.probeReachable(); }

// ── JSON parsing (lenient, with one repair pass) ──────────────────────────────
function stripFences(s) {
  return String(s || '').replace(/```(?:json)?/gi, '').trim();
}
function extractJsonBlock(s) {
  const t = stripFences(s);
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  return a !== -1 && b > a ? t.slice(a, b + 1) : t;
}
function repairJson(s) {
  return String(s)
    .replace(/,\s*([}\]])/g, '$1')        // trailing commas
    .replace(/[“”]/g, '"')       // smart quotes
    .replace(/[‘’]/g, "'");
}
function parseJsonLenient(s) {
  const block = extractJsonBlock(s);
  try { return JSON.parse(block); } catch { /* try repair */ }
  return JSON.parse(repairJson(block));
}

function buildPrompts(story, opts, anonBody) {
  const seconds = opts.durationSeconds || 60;
  const wordBudget = Math.round(seconds * (text.WORDS_PER_SECOND_NARRATION || 2.6));
  const drama = opts.dramaLevel || 3;
  const hookStyle = opts.hookStyle || 'conflict';
  const system =
    'You are a senior short-form video scriptwriter for a faceless storytelling channel ' +
    '(TikTok / Reels / Shorts). You rewrite internet stories into ORIGINAL, punchy, ' +
    'spoken-word narration. Never copy the source verbatim. Anonymise all names and ' +
    'identifying details. Write for the ear: short sentences, vivid, first-person where ' +
    'natural. Output STRICT JSON only — no markdown, no commentary.';
  const user =
    `Rewrite the following story into a ~${seconds}s narration script (~${wordBudget} words total).\n` +
    `Hook style: ${hookStyle}. Drama level: ${drama}/5.\n` +
    `Structure it into these fields and return ONLY this JSON object:\n` +
    `{"hook":"one gripping opening line","setup":"...","conflict":"...","escalation":"...",` +
    `"ending":"the payoff/resolution","audienceQuestion":"a question that invites comments"}\n\n` +
    `STORY TITLE: ${story.title || '(untitled)'}\n` +
    `STORY:\n${String(anonBody || '').slice(0, 6000)}`;
  return { system, user };
}

const FIELDS = ['hook', 'setup', 'conflict', 'escalation', 'ending', 'audienceQuestion'];

async function callModel(system, user, model, temperature) {
  const raw = await llm.chat({ system, user, model, maxTokens: 1500, temperature, topP: 0.95 });
  try {
    return parseJsonLenient(raw);
  } catch {
    // One stricter retry at a lower temperature.
    const raw2 = await llm.chat({
      system,
      user: user + '\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object, nothing else.',
      model,
      maxTokens: 1500,
      temperature: Math.max(0.2, temperature - 0.4),
      topP: 0.9,
    });
    return parseJsonLenient(raw2);
  }
}

/**
 * Rewrite a story into a scriptObj using the local LLM.
 * @returns {Promise<object>} scriptObj compatible with scriptGenerator.save()
 */
async function rewriteScript(story, opts = {}) {
  const {
    durationSeconds = 60, hookStyle = 'conflict', dramaLevel = 3, safeMode = false, attribution = true,
  } = opts;

  const anon = safety.anonymize(story.body || '');
  const { system, user } = buildPrompts(story, opts, anon.text);
  const model = (opts.aiModel || '').trim() || llmAdmin.currentModel();

  const data = await callModel(system, user, model, 0.9);
  const get = (k) => {
    let v = String(data[k] || '').trim();
    if (safeMode) v = safety.censorText(v);
    return v.replace(/\s+/g, ' ').trim();
  };
  const parts = {};
  for (const f of FIELDS) parts[f] = get(f);
  if (!parts.hook && !parts.setup && !parts.conflict) throw new Error('LLM returned an empty script.');

  const fullText = [parts.hook, parts.setup, parts.conflict, parts.escalation, parts.ending, parts.audienceQuestion]
    .map((p) => p && p.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  const sourceAttribution = attribution && story.url
    ? `Story adapted from a user-submitted post: ${story.url}`
    : 'Based on a user-submitted internet story.';

  return {
    story_id: story.id,
    duration_target: durationSeconds,
    hook_style: hookStyle,
    hook: parts.hook,
    setup: parts.setup,
    conflict: parts.conflict,
    escalation: parts.escalation,
    ending: parts.ending,
    audience_question: parts.audienceQuestion,
    full_text: fullText,
    word_count: text.wordCount(fullText),
    est_seconds: text.narrationSeconds(fullText),
    drama_level: dramaLevel,
    safe_mode: safeMode ? 1 : 0,
    source_attribution: sourceAttribution,
    engine: 'local-llm',
  };
}

module.exports = { isEnabled, available, rewriteScript, parseJsonLenient };
