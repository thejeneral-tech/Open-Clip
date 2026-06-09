'use strict';
// Content safety + anonymisation (spec §27). Conservative, keyword-driven.
// Goal is to FLAG and CLEAN, never to silently pass risky material through.

const PROFANITY = ['fuck', 'fucking', 'fucked', 'shit', 'bitch', 'asshole', 'bastard',
  'dick', 'piss', 'cunt', 'damn', 'crap', 'slut', 'whore'];

const WARNING_RULES = [
  { tag: 'Strong language', re: /\b(fuck|shit|cunt|bitch|asshole)\b/i },
  { tag: 'Violence', re: /\b(kill(ed|ing)?|stab|gun|shot|blood|assault|attack|beat(en|ing)?|murder|punch)\b/i },
  { tag: 'Sexual content', re: /\b(sex|sexual|rape|molest|nude|naked|porn)\b/i },
  { tag: 'Involves minors', re: /\b(child|children|kid|kids|minor|underage|\d{1,2}[\s-]?(?:yo|year[\s-]?old))\b/i },
  { tag: 'Self-harm', re: /\b(suicide|suicidal|self[\s-]?harm|kill myself|cut myself|overdose)\b/i },
  { tag: 'Substance use', re: /\b(drunk|alcohol|cocaine|heroin|meth|weed|drugs?)\b/i },
  { tag: 'Private information', re: /\b(\d{3}[-.\s]\d{3}[-.\s]\d{4}|\b\d{16}\b|ssn|social security)\b/i },
];

function detectWarnings(text) {
  const t = String(text || '');
  const out = [];
  for (const r of WARNING_RULES) if (r.re.test(t)) out.push(r.tag);
  return [...new Set(out)];
}

// True when material should be blocked outright by the adult-topic / minors filter.
function blockedByFilters(text, prefs = {}) {
  const w = detectWarnings(text);
  const reasons = [];
  if (prefs.adultTopicFilter && w.includes('Sexual content')) reasons.push('Sexual content');
  // Minors + sexual/violent context is always blocked regardless of prefs.
  if (w.includes('Involves minors') && (w.includes('Sexual content'))) reasons.push('Minors in sexual context');
  if (prefs.violenceSensitivity === 'high' && w.includes('Violence')) reasons.push('Violence (high sensitivity)');
  return reasons;
}

// Replace reddit usernames, explicit "my name is X", and obvious PII (spec §27 default).
function anonymize(text) {
  let t = String(text || '');
  const removed = [];
  // reddit / quora handles
  t = t.replace(/\b(?:\/?u\/|u\/|@)([A-Za-z0-9_-]{3,})/g, (m) => { removed.push(m); return 'someone'; });
  // "my name is Jordan" / "I'm Jordan (28F)"
  t = t.replace(/\b(?:my name is|i am|i'm|named)\s+([A-Z][a-z]+)/g, (m, n) => { removed.push(n); return m.replace(n, '[name]'); });
  // phone numbers / long digit strings
  t = t.replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, () => { removed.push('phone'); return '[redacted]'; });
  t = t.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, () => { removed.push('email'); return '[redacted]'; });
  return { text: t, removed: [...new Set(removed)] };
}

// Detect capitalised first names that look like personal identifiers (best effort).
function detectNames(text) {
  const t = String(text || '');
  const names = new Set();
  const handle = t.match(/\b(?:\/?u\/|u\/|@)([A-Za-z0-9_-]{3,})/g) || [];
  for (const h of handle) names.add(h);
  const cap = t.match(/\b[A-Z][a-z]{2,}\b/g) || [];
  // crude stop-list of sentence-starting common words
  const common = new Set(['The', 'And', 'But', 'When', 'After', 'Before', 'They', 'She', 'His', 'Her',
    'This', 'That', 'There', 'Then', 'My', 'We', 'Our', 'He', 'It', 'So', 'Because', 'Reddit', 'AITA']);
  for (const c of cap) if (!common.has(c)) names.add(c);
  return [...names].slice(0, 20);
}

// Star out profanity in caption/script text.
function censorText(text) {
  let t = String(text || '');
  for (const w of PROFANITY) {
    const re = new RegExp(`\\b${w}\\b`, 'gi');
    t = t.replace(re, (m) => m[0] + '*'.repeat(Math.max(1, m.length - 1)));
  }
  return t;
}

function hasProfanity(text) {
  return PROFANITY.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(String(text || '')));
}

module.exports = {
  PROFANITY, detectWarnings, blockedByFilters, anonymize, detectNames, censorText, hasProfanity,
};
