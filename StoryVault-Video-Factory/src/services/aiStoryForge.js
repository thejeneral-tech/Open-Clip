'use strict';
// AI-backed long-form story generator. This is what powers the Story Library
// "🔄 Refresh / Replenish" button: it asks the local LLM (Ollama / llama.cpp) to
// INVENT brand-new, original story premises on every call, then expands each one
// into a long, multi-act narrative (~targetMinutes of narration) that scores well
// and can be cut up into many short clips.
//
// Why a hybrid (AI premise + local expansion) instead of asking the model for the
// whole 4,500-word story directly:
//   • A small local model can reliably invent a dozen DIVERSE premises in one call,
//     but struggles to write twelve 30-minute stories without repeating itself or
//     timing out. So the model supplies the creative core (title, hook, conflict,
//     twist, decision, fallout, custom detail + update beats) and we deterministically
//     inflate that core to the target length. The premises are different every call
//     (high temperature + an avoid-list + a per-call salt), so the library stays fresh.
//   • If the LLM is unreachable or misbehaves, batch() throws and stories.replenish()
//     falls back to the offline storyForge, so the button never breaks.
const llm = require('./llm');
const aiProvider = require('./aiProvider');
const llmAdmin = require('./llmAdmin');
const categorizer = require('./categorizer');
const rng = require('../util/rng');
const text = require('../util/text');
const log = require('./logger');

// Narration pace the rest of the app assumes (text.narrationSeconds ≈ 2.6 w/s).
const WORDS_PER_SECOND = text.WORDS_PER_SECOND_NARRATION || 2.6;

// Categories the Library understands (must line up with storyForge / categorizer).
const POOL = ['AITA', 'ProRevenge', 'Neighbor disputes', 'Entitled people', 'TIFU', 'Family conflicts'];

// ── Connective banks (used only to inflate the AI premise to length) ──────────
const TENSION = [
  'For context, this had been building for a long time before it boiled over.',
  'You need the history here, because it changes how the whole thing reads.',
  'At first I told myself I was imagining it. I was not.',
  'Everyone fixates on the ending, but the slow build is the real story.',
  'I kept waiting for it to blow over on its own. It never did.',
  'I had let smaller versions of this slide for years, and that was my first mistake.',
  'Looking back, the warning signs were all there; I just did not want to read them.',
  'It started as something I could almost laugh off, right up until I could not.',
];
const ESCALATION = [
  'Then it got worse in a way I genuinely did not see coming.',
  'I tried to keep the peace, and that only seemed to make them bolder.',
  'When I gave them a chance to back down, they did not take a single one.',
  'What pushed me over the edge was how casual they were about all of it.',
  'After that, there was no pretending things could go back to normal.',
  'Every time I drew a line, they stepped over it just to see what I would do.',
  'The moment I stopped reacting was the moment they decided to push twice as hard.',
  'It stopped being about the principle and started being about whether I would fold.',
];
const REFLECT = [
  'I keep replaying it and wondering if a calmer person would have done the same.',
  'Part of me feels vindicated and part of me feels like the villain in someone else’s story.',
  'I did not want it to end like this, but I am not sure I had another move.',
  'People I trust are split almost down the middle, which is part of why I am posting.',
  'I am still angry, and I am still a little ashamed of how angry I am.',
  'I have stopped asking whether I was right and started asking whether I could have lived with staying quiet.',
  'Some nights I am sure I overreacted; most mornings I am sure I did not.',
  'If nothing else, I learned exactly how far I am willing to be pushed.',
];
const VOICED = [
  'When I confronted them, they just said it was "not a big deal" and walked off.',
  'My partner told me to let it go, but I could not stop turning it over.',
  'A friend asked me point blank what I was going to do about it.',
  'They looked me dead in the eye and said I was the one being unreasonable.',
  'My mother called me later, crying, asking how it had come to this.',
  'A coworker pulled me aside and quietly told me I was not imagining any of it.',
  'Someone who had watched the whole thing said they would have snapped weeks earlier.',
  'The one person I expected to back me just shrugged and changed the subject.',
];
const UPDATE_LEADS = [
  'Update: a lot has happened since I first posted this.',
  'Edit / Update: you all asked for details, so here is what came next.',
  'Small update, because some of you guessed exactly where this was going.',
  'Update: the fallout reached people I never expected it to.',
  'Update, because the situation moved faster than I thought it would.',
  'Final edit: I owe you the ending, even the part that does not flatter me.',
];
const CLOSERS = [
  'In the end, that is where things stand right now.',
  'Looking back, I am still not fully at peace with it.',
  'These days it is quieter, but nothing really went back to how it was.',
  'It is over now, mostly, and I am still figuring out what it cost me.',
  'That is the whole story, as honestly as I know how to tell it.',
];
// Premise-aware beats: unlike the static banks above, these weave the specific
// who/stake into the body. Because duplicate detection is set-based (MinHash over
// trigrams), interleaving these through the long padded section is what makes two
// DIFFERENT premises produce genuinely different bodies instead of ~80% shared
// boilerplate — so fresh stories stop tripping the "possible duplicate" flag.
const PREMISE_BEATS = [
  (s) => `By then ${s.who} had turned ${s.stake} into the center of everything, whether I wanted it there or not.`,
  (s) => `I keep coming back to how ${s.who} talked about ${s.stake}, as if it had never been mine to begin with.`,
  (s) => `Every reasonable thing I suggested about ${s.stake} somehow became more proof that I was the difficult one.`,
  (s) => `The hardest part was that ${s.who} genuinely seemed to believe ${s.stake} was theirs for the taking.`,
  (s) => `People kept telling me ${s.stake} was not worth the fight, but none of them were the ones living it.`,
  (s) => `Late at night I would replay every exchange with ${s.who} about ${s.stake}, hunting for the moment it broke.`,
  (s) => `What nobody around me understood was how long ${s.who} had been circling ${s.stake} before any of this surfaced.`,
  (s) => `By the time it was over I had written down enough about ${s.stake} that I stopped doubting my own memory of it.`,
  (s) => `There was a version of this where ${s.who} simply let ${s.stake} go, and I think about that version a lot.`,
  (s) => `I never wanted ${s.stake} to define how I felt about ${s.who}, but here we are.`,
];

function pickFrom(arr, r) { return arr[Math.floor(r() * arr.length)]; }
function sentenceCase(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }
function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, ''); }
// Loose title key for the avoid-list: lowercase, alphanumerics only. Lines up
// closely with fingerprint.normalizeText so "AITA for keeping the inheritance my
// cousin insists should be split?" reliably matches its stored counterpart.
function normTitle(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Pick a model that is ACTUALLY installed. Respect an explicit/configured model when
// it exists, otherwise auto-select a capable, small, non-vision, non-reasoning text
// model so the feature works even when the configured default isn't pulled. Reasoning
// models (deepseek-r1) and vision models (moondream / llava) are de-prioritised — the
// former burns its budget on hidden thinking and is RAM-heavy here, the latter can't write.
const PREFERRED_MODELS = [
  'llama3.1:8b', 'llama3:8b', 'qwen2.5:7b', 'mistral:7b', 'gemma2:9b',
  'llama3.2:3b', 'qwen2.5:3b', 'phi3:mini', 'llama3.2:1b', 'qwen2.5:1.5b', 'qwen2.5:0.5b',
];
const AVOID_RE = /moondream|llava|bakllava|vision|clip|embed|deepseek-r1|reasoning/i;

async function pickModel(opts) {
  const explicit = (opts.aiModel || '').trim();
  if (explicit) return explicit;
  let installed = [];
  try { installed = ((await llmAdmin.listModels()).models || []).map((m) => m.name).filter(Boolean); } catch { /* ignore */ }
  if (!installed.length) return llmAdmin.currentModel();
  const configured = llmAdmin.currentModel();
  if (configured && installed.includes(configured)) return configured;
  for (const p of PREFERRED_MODELS) {
    const hit = installed.find((m) => m === p || m.split(':')[0] === p.split(':')[0]);
    if (hit) return hit;
  }
  return installed.find((m) => !AVOID_RE.test(m)) || installed[0];
}

// Ask the model for `count` ORIGINAL premises. Returns { seeds, model }.
async function requestSeeds(count, opts, model) {
  const seedToken = `${opts.salt || 1}-${(opts.avoidTitles || []).length}-${count}`;
  const avoid = (opts.avoidTitles || []).slice(0, 40).map((t) => `• ${t}`).join('\n');
  const catLine = opts.category && POOL.includes(opts.category)
    ? `Every story must fit the category "${opts.category}".`
    : `Spread the stories across these categories: ${POOL.join(', ')}.`;

  const system =
    'You are a viral Reddit-style story writer who INVENTS original, dramatic, first-person ' +
    'stories for a faceless storytelling channel (YouTube / TikTok / Reels). Every story has a ' +
    'scroll-stopping hook, an escalating conflict, a genuine surprise twist, a decisive turning ' +
    'point, real fallout, and several follow-up updates. You never reuse premises. Fill every ' +
    'field with concrete, specific, invented content — NEVER restate the instructions or the ' +
    'field names. Output STRICT JSON only — no markdown, no commentary.';

  // Two complete worked examples. Small models imitate this real content instead of
  // echoing field descriptions back (which breaks plain schema prompts). We keep the
  // schema deliberately small — title + hook + who + stake + twist — because weak
  // local models drop fields when asked for too many; the long body is built from
  // these plus the optional details/updates when the model is strong enough to add them.
  const examples = [
    { category: 'Entitled people',
      title: 'AITA for refusing to give a stranger my hotel room because she had kids?',
      hook: 'A woman I had never met cornered me in the lobby and demanded I hand over the room I booked six months ago.',
      who: 'an entitled mother of three', stake: 'the last ocean-view room during peak season',
      twist: 'the front desk had watched her pull the same scam on two other guests that week',
      details: ['I had saved for a year to afford three nights at this resort.', 'The manager pulled up the system and confirmed the booking was mine.'],
      updates: ['The hotel comped my last night for the trouble.', 'She tried to friend-request me afterward as if nothing had happened.'] },
    { category: 'ProRevenge',
      title: 'My manager stole my overtime for two years, so I quietly built the case that ended him',
      hook: 'For two years my boss erased my overtime hours and pocketed the budget, and he was sure I would never notice.',
      who: 'my shift manager', stake: 'thousands of dollars in hours I had actually worked',
      twist: 'payroll had been flagging his edits the whole time and just needed someone to file a complaint',
      details: ['I started screenshotting every timesheet before he could touch it.', 'HR asked me to keep quiet until the audit was finished.'],
      updates: ['He was walked out two weeks later.', 'Three other coworkers came forward once they heard.'] },
  ];
  const exampleText = examples.map((e) => JSON.stringify(e)).join('\n');

  const user =
    `Here are TWO examples of the exact format and quality I want (do NOT reuse them):\n${exampleText}\n\n` +
    `Now invent ${count} COMPLETELY DIFFERENT, original stories in that same JSON format. Make them ` +
    `genuinely varied — different people, settings, jobs, relationships, stakes and conflicts. ` +
    `Avoid tired clichés. ${catLine}\n` +
    `Each story is one JSON object with these keys: "category" (one of: ${POOL.join(', ')}), ` +
    `"title", "hook", "who", "stake", "twist", "details" (2-5 short sentences), "updates" (2-4 short sentences).\n` +
    (avoid ? `Do NOT reuse or closely resemble any of these existing titles:\n${avoid}\n` : '') +
    `Randomness key: ${seedToken} (use it to push toward unexpected, fresh scenarios).\n\n` +
    `Return ONLY JSON: {"stories":[ ... ${count} story objects ... ]}. ` +
    `Fill every field with real invented content — never echo these instructions.`;

  // Single high-temperature attempt for variety. We intentionally do NOT retry: the
  // procedural generator backfills anything the model fails to produce, so a slow
  // second call would only add latency on weak hardware for little gain.
  const raw = await llm.chat({ system, user, model, maxTokens: 2000, temperature: 1.0, topP: 0.97 });
  return extractSeeds(raw);
}

// Tolerant seed extraction. Weak local models often emit a bare sequence of JSON
// objects (NDJSON-style) instead of one {"stories":[...]} array, or wrap commentary
// around it. We first try a clean parse, then fall back to scanning out every
// balanced top-level {...} block and parsing each independently, so one malformed
// object never discards the rest of the batch.
function extractSeeds(raw) {
  try {
    const d = aiProvider.parseJsonLenient(raw);
    const arr = Array.isArray(d) ? d : (d && Array.isArray(d.stories) ? d.stories : (d && typeof d === 'object' ? [d] : null));
    if (arr && arr.length && arr.some((o) => o && o.title)) return arr.filter((o) => o && typeof o === 'object');
  } catch { /* fall through to block scan */ }

  const s = String(raw || '').replace(/```(?:json)?/gi, '');
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { const blk = s.slice(start, i + 1); try { objs.push(JSON.parse(repairJson(blk))); } catch { /* skip */ } start = -1; } }
  }
  // Flatten any {"stories":[...]} wrappers we may have captured.
  const flat = [];
  for (const o of objs) { if (o && Array.isArray(o.stories)) flat.push(...o.stories); else if (o && o.title) flat.push(o); }
  return flat;
}

function repairJson(s) {
  return String(s).replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

// Tell-tale phrases a weak model echoes when it parrots the schema instead of
// inventing content. A field containing any of these is treated as not-real.
const PARROT_RE = /\b(e\.?g\.?|one of \[|gripping|scroll[- ]?stopping|punchy|first[- ]person|the other party|the core thing|the decisive|the immediate consequence|opening sentence|short follow|advance the story|start with a verb|want to know more|a sentence|array of)\b/i;

function realText(v) {
  const s = clean(v);
  return s && s.length >= 8 && !PARROT_RE.test(s) ? s : '';
}

// A raw seed is usable when the AI supplied a real, specific title AND hook — those
// are what make each refresh feel new and drive the hook score. Everything else has a
// sensible fallback, so a weak model that only manages title+hook still yields a
// fresh, well-structured story rather than being discarded.
function isValidSeed(raw) {
  if (!raw || typeof raw !== 'object') return false;
  return !!(realText(raw.title) && realText(raw.hook));
}

// Resolve a category: the model's value if it is one of ours, otherwise infer it
// from the title/hook (same categorizer the rest of the pipeline uses).
function resolveCategory(raw, r) {
  if (POOL.includes(raw.category)) return raw.category;
  const inferred = categorizer.infer(clean(raw.title), clean(raw.hook));
  return POOL.includes(inferred) ? inferred : pickFrom(POOL, r);
}

// Normalise one raw seed object, supplying sane fallbacks for any missing field.
function normalizeSeed(raw, r) {
  const category = resolveCategory(raw, r);
  const who = realText(raw.who) || 'someone I trusted';
  const stake = realText(raw.stake) || 'something I could not just walk away from';
  const title = sentenceCase(clean(raw.title));
  const hook = sentenceCase(String(raw.hook || '').replace(/\s+/g, ' ').trim()); // keep its ? / !
  const flash = clean(raw.flash) || `${sentenceCase(who)} pushed it further than I thought anyone would.`;
  const twist = clean(raw.twist) || 'none of it had happened the way I was told';
  const decision = clean(raw.decision) || 'I refused to back down and made my position clear';
  const fallout = clean(raw.fallout) || 'half the people around us picked a side overnight';
  const keepReal = (a) => (Array.isArray(a) ? a : []).map(clean).filter((d) => d && !PARROT_RE.test(d));
  const details = keepReal(raw.details);
  const updates = keepReal(raw.updates);
  return { category, who, stake, title, hook, flash, twist, decision, fallout, details, updates };
}

// Expand one premise into a long, well-structured body of ~targetWords words.
function buildBody(seed, targetWords, r) {
  const details = seed.details.length ? seed.details : [
    `Every conversation about ${seed.stake} turned into a negotiation I never agreed to.`,
    `I kept notes and dates about ${seed.who}, almost on instinct.`,
    `I tried to be reasonable about ${seed.stake}, the way I was raised to be.`,
  ];
  let di = 0;
  const nextDetail = () => { const d = details[di % details.length]; di++; return /[.?!]$/.test(d) ? d : d + '.'; };

  const parts = [];
  parts.push(seed.hook.endsWith('?') || seed.hook.endsWith('!') ? seed.hook : seed.hook + '.');
  parts.push(`This is about ${seed.who} and ${seed.stake}.`);
  parts.push(`${pickFrom(TENSION, r)} ${nextDetail()}`);

  // Each padded beat alternates between a generic connective (conflict / emotion /
  // dialogue words the scorer rewards) and a premise-aware beat that names the
  // who/stake — the latter is what keeps two different premises from collapsing into
  // near-identical, duplicate-flagged bodies.
  const beatBanks = [ESCALATION, VOICED, REFLECT, TENSION];
  let bi = 0;
  const nextBeat = () => {
    bi++;
    return bi % 2 === 0 ? pickFrom(PREMISE_BEATS, r)(seed) : pickFrom(beatBanks[bi % beatBanks.length], r);
  };

  // Body grows until we reach the target length: detail (on-topic, from the AI) + beat.
  let guard = 0;
  while (text.wordCount(parts.join(' ')) < targetWords * 0.6 && guard < 400) {
    parts.push(`${nextBeat()} ${nextDetail()}`);
    guard++;
  }

  parts.push(seed.flash.endsWith('.') ? seed.flash : seed.flash + '.');
  // Twist line — phrased to trip the analysis twist-detector ("i discovered" / "turned out").
  parts.push(`Then I discovered something that changed everything, and it turned out ${seed.twist}.`);
  // Decision line — contains a decision verb the structure scorer looks for.
  parts.push(`So I made a decision: I ${/^i\s/i.test(seed.decision) ? clean(seed.decision).replace(/^i\s/i, '') : clean(seed.decision)}.`);
  parts.push(`The immediate fallout was simple and brutal: ${clean(seed.fallout)}.`);
  parts.push(pickFrom(REFLECT, r));

  // Multiple "Update:" beats — reviewers (and the scorer) love a resolution arc.
  const updates = seed.updates.length ? seed.updates : [
    'the people who said I went too far have gone very quiet',
    'new information came out that made me look a lot less unreasonable',
    'it turned out I was not the only one this had happened to',
  ];
  for (const u of updates) {
    parts.push(`${pickFrom(UPDATE_LEADS, r)} ${sentenceCase(clean(u))}. ${pickFrom(REFLECT, r)}`);
    // Pad between updates if we are still short of the target length.
    while (text.wordCount(parts.join(' ')) < targetWords * 0.92 && guard < 800) {
      parts.push(`${nextBeat()} ${nextDetail()}`);
      guard++;
    }
  }

  parts.push(`${pickFrom(CLOSERS, r)} ${pickFrom(REFLECT, r)} So… was I wrong?`);
  return parts.join('\n\n');
}

// ── Procedural premise generator ─────────────────────────────────────────────
// Slotted scenario templates. Each template's slots combine independently, so a
// handful of templates yields tens of thousands of distinct, coherent premises —
// enough that "Refresh" returns genuinely new stories every time even with no AI.
const PROCEDURAL = [
  { category: 'AITA',
    whos: ['my older brother', 'my younger sister', 'my stepmother', 'my cousin'],
    stakes: ['the house our grandmother left to me alone', 'the savings account she put only in my name', 'the family cabin willed entirely to me', 'the heirloom ring promised to me since I was a child'],
    flashes: ['He showed up with a lawyer and a binder of "fair-share" math.', 'She announced at dinner that I was tearing the family apart.', 'They changed the locks while I was at work and dared me to do something.', 'He started a group chat just to vote on what I "owed" everyone.'],
    twists: ['the will had a clause they were praying I would never actually read', 'they had already quietly sold two other things behind everyone\'s back', 'a cousin had recorded them admitting the whole guilt trip was planned', 'the lawyer they hired had already warned them they had no case'],
    decisions: ['produced the signed will and refused to be guilted out of a single thing', 'filed to enforce the estate exactly as it was written', 'let the documents do the talking and stopped explaining myself', 'told them I would see them in court before handing over a cent'],
    fallouts: ['half the family stopped speaking to me and called me greedy at the holidays', 'they tried to turn the group chat against me until the receipts came out', 'they folded the moment a real attorney looked at the paperwork', 'I was uninvited from three events and honestly slept better for it'],
    titles: ['AITA for keeping the inheritance {who} insists should be split?', 'AITA for refusing to give {who} a share of what was left only to me?', 'AITA for enforcing a will {who} hates?'] },
  { category: 'AITA',
    whos: ['my future mother-in-law', 'my maid of honor', 'my own sister', 'my fiancé\'s best friend'],
    stakes: ['the guest list I was told I had no say in', 'the wedding date that landed on my late mom\'s birthday', 'the budget everyone kept spending without asking me', 'the venue I paid for being handed to someone else\'s vision'],
    flashes: ['She sent out save-the-dates with a date I had never agreed to.', 'She tried to invite forty extra people on my dime.', 'He stood up mid-dinner and "corrected" how I was doing my own wedding.', 'She booked a different venue and told me to just be grateful.'],
    twists: ['she had been planning this version for months without telling me', 'the vendors had her name on the contract, not mine', 'my partner had quietly known the whole time and said nothing', 'the "small favor" was actually a deposit I was now liable for'],
    decisions: ['cancelled the parts I never approved and took back control of my own day', 'told them the wedding was mine and the checkbook was closing', 'postponed everything until people remembered whose day it was', 'quietly rebooked the original plan and stopped asking permission'],
    fallouts: ['I was called a bridezilla in a family chat I was not even in', 'two people threatened not to come and then showed up anyway', 'my partner finally backed me and the drama mostly evaporated', 'her side went cold for a month, which honestly made planning easier'],
    titles: ['AITA for taking back control of my own wedding from {who}?', 'AITA for telling {who} the wedding is not theirs to plan?', 'AITA for cancelling the plans {who} made behind my back?'] },
  { category: 'AITA',
    whos: ['my best friend', 'my brother-in-law', 'an old college roommate', 'my own parents'],
    stakes: ['the money I lent that was never coming back', 'the rent I had been quietly covering for almost a year', 'the car I co-signed and never got to drive', 'the deposit I fronted for a trip nobody else paid for'],
    flashes: ['He posted vacation photos the same week he "couldn\'t" pay me back.', 'She laughed and said I should just let it go as a gift.', 'They asked to borrow more before clearing the first loan.', 'He blocked me the day the repayment was due.'],
    twists: ['he had borrowed the exact same way from three other friends already', 'there were texts where they admitted they never intended to repay', 'the "emergency" I funded had been a down payment on something fun', 'my own family had been quietly covering for them the whole time'],
    decisions: ['sent one final invoice and then took them to small-claims', 'stopped covering anything and let the consequences land where they fell', 'laid out every receipt in front of the people they had lied to', 'cut off the money and the access at the same time'],
    fallouts: ['I was painted as the villain for wanting my own money back', 'they paid within a week once a court date was real', 'the mutual friends quietly sided with me once they saw the texts', 'we do not talk now, and my bank account has never been healthier'],
    titles: ['AITA for taking {who} to court over money they swore they\'d repay?', 'AITA for cutting off {who} after they refused to pay me back?', 'AITA for asking {who} for my money in front of everyone?'] },
  { category: 'ProRevenge',
    whos: ['my old landlord', 'the property manager', 'my slumlord of three years'],
    stakes: ['the deposit he swore was "cleaning fees"', 'the months of repairs he was legally required to make', 'the illegal fee he tacked onto every rent check', 'the heat he shut off in the middle of winter'],
    flashes: ['He laughed and said good luck proving anything in court.', 'He told me to just move out if I didn\'t like it.', 'He ignored every email until the day rent was late.', 'He bragged that no tenant had ever beaten him.'],
    twists: ['the city already had an open file on him I knew nothing about', 'he had done the exact same thing to a dozen other units', 'every "lost" repair request had actually been logged with the city', 'his own paperwork proved the fee was illegal'],
    decisions: ['documented everything and took him to small-claims with photos and receipts', 'reported every code violation to the city in one organized packet', 'organized the other tenants and we filed together', 'handed the whole timeline to a housing lawyer for free'],
    fallouts: ['the judge tripled the award and the city opened an investigation', 'he had to refund every tenant he had ever skimmed', 'he settled within a week once the inspector showed up', 'I got every cent back plus damages, and he lost three units'],
    titles: ['My quiet, methodical revenge on {who} who kept my deposit', 'How I made {who} pay for years of illegal fees', '{who} dared me to take it to court, so I did'] },
  { category: 'ProRevenge',
    whos: ['my shift manager', 'a senior coworker', 'my boss', 'a coworker on my team'],
    stakes: ['two years of overtime he quietly erased', 'the project I built that he presented as his own', 'the promotion that was based entirely on my work', 'the bonus pool he was skimming from the team'],
    flashes: ['He presented my deck to the board and never said my name.', 'He edited my hours down every single pay period.', 'She smiled and told me to be a team player about it.', 'He bragged that nobody ever checked the numbers.'],
    twists: ['payroll had been flagging his edits the entire time', 'I still had every original file, timestamped to the minute', 'HR had already opened a quiet file and just needed a complaint', 'three other people had the exact same story about him'],
    decisions: ['forwarded the timestamped originals to the whole leadership chain', 'filed one clean, documented complaint with HR', 'waited for the audit and handed them everything', 'let the other people he did this to come forward with me'],
    fallouts: ['he was walked out by Friday and I got the back pay', 'the promotion came to me once the truth was on paper', 'he quietly "left to pursue other opportunities" within a month', 'the whole team got their skimmed bonuses returned'],
    titles: ['{who} stole my work for years, so I built the case that ended it', 'My patient revenge on {who} who took credit for everything', 'How I exposed {who} without raising my voice once'] },
  { category: 'Neighbor disputes',
    whos: ['my back-fence neighbor', 'the new guy next door', 'the neighbor who hates my guts'],
    stakes: ['a strip of yard I have mowed for eleven years', 'the fence he built two feet onto my land', 'the tree he kept "accidentally" poisoning', 'the driveway he decided was suddenly shared'],
    flashes: ['He waved a survey he "lost" and told me possession is nine-tenths.', 'He dared me to call someone about it.', 'He moved the property stakes when he thought I wasn\'t looking.', 'He told me his lawyer would bury me.'],
    twists: ['the county survey put the line exactly where I always said it was', 'he had pulled this on the previous owner too', 'there was a permit violation that voided his whole project', 'the HOA already had a stack of complaints against him'],
    decisions: ['paid for a fresh survey and filed the encroachment with the county', 'pulled every permit record and reported the violations', 'put up my own correct line and let the county enforce it', 'took the documented timeline to the HOA board'],
    fallouts: ['he had to tear it down at his own cost and now glares from his porch', 'the county fined him and made him move it back', 'he sold within a year and the new neighbors are lovely', 'I won every point and he stopped speaking to me, which is bliss'],
    titles: ['{who} built a fence onto my land and dared me to do something', 'How I won the boundary war {who} started', '{who} thought he could take my yard. He could not.'] },
  { category: 'Neighbor disputes',
    whos: ['the neighbor upstairs', 'the people who moved in next door', 'the couple behind me'],
    stakes: ['the all-night noise that was wrecking my sleep', 'the dog they left barking for twelve hours a day', 'the parties that ran until four every weekend', 'the security light they aimed straight into my bedroom'],
    flashes: ['They told me to get used to it and slammed the door.', 'They turned it up the moment I asked them to stop.', 'They denied it until I started keeping a log.', 'They swore no one had ever complained, which I knew was a lie.'],
    twists: ['the lease they signed banned exactly what they were doing', 'every other neighbor had been quietly suffering too', 'the landlord had already warned them once before', 'my log lined up perfectly with the city noise ordinance'],
    decisions: ['kept a dated log and brought the whole building to the landlord', 'filed the noise complaints by the book, every single time', 'organized the neighbors so it was not just my word', 'sent the documented timeline straight to the property manager'],
    fallouts: ['they got a final warning and the nights went quiet', 'they were not renewed and the new tenants are wonderful', 'the fines finally got their attention', 'I sleep through the night now for the first time in months'],
    titles: ['How I finally shut down {who} and their endless noise', '{who} told me to get used to it. I did not.', 'My patient, by-the-book win against {who}'] },
  { category: 'Entitled people',
    whos: ['a "loyal regular"', 'an entitled customer', 'a self-described VIP', 'a guy at the counter'],
    stakes: ['the lunch I brought from home on my unpaid break', 'a refund on something she had clearly used for months', 'the front-of-line spot everyone else had waited for', 'the free upgrade he insisted he was owed'],
    flashes: ['She said her loyalty entitled her to whatever was in the back.', 'He started filming me to "expose" the store.', 'She demanded my manager and then demanded his manager.', 'He announced to the whole line that I was discriminating against him.'],
    twists: ['the cameras had caught the entire thing, start to finish', 'she had pulled the same stunt at three other locations', 'corporate already had a file on him from other stores', 'her "receipt" was for a completely different shop'],
    decisions: ['said no, kept my lunch, and let my manager handle her', 'followed policy to the letter and documented every word', 'offered the one thing policy allowed and nothing more', 'let the security footage answer for me'],
    fallouts: ['she left a one-star review a week until corporate flagged it', 'he was trespassed from the store that same afternoon', 'corporate sided with me once they watched the tape', 'she is banned now and the regulars actually thanked me'],
    titles: ['{who} demanded I hand over my own lunch for free', 'AITA for refusing {who} the "free" thing they demanded?', '{who} tried to bully me at work. It did not go how they planned.'] },
  { category: 'Entitled people',
    whos: ['a stranger on the plane', 'an entitled mom at the pool', 'a man in line behind me', 'a woman in the parking lot'],
    stakes: ['the seat I had paid extra to choose', 'the table I had reserved hours in advance', 'the accessible spot I actually need', 'the equipment I had been using the whole time'],
    flashes: ['She told the whole row I was stealing a seat from a child.', 'He sat down in my spot and pretended not to hear me.', 'She filmed herself demanding I move and posted it.', 'He told staff I was the one causing a scene.'],
    twists: ['the staff had watched her try this on someone else that morning', 'my reservation was right there in the system', 'the footage showed exactly who started it', 'three other people backed me up without being asked'],
    decisions: ['kept my seat and asked the staff to step in', 'showed my booking and refused to move', 'let the staff and the cameras sort it out', 'stood my ground and stayed calm while they melted down'],
    fallouts: ['she was the one asked to leave, in front of everyone', 'he was moved and grumbled the entire flight', 'staff comped me for the hassle', 'the video she posted ended up making her the villain'],
    titles: ['{who} demanded my seat and tried to make me the bad guy', 'How I kept my spot when {who} tried to bully me out of it', '{who} thought they could push me around in public. Nope.'] },
  { category: 'TIFU',
    whos: ['the entire company', 'my whole department', 'five thousand coworkers', 'my brand-new boss'],
    stakes: ['a meme meant for exactly one work friend', 'a rant I thought was a private message', 'an attachment that was very much not for everyone', 'a reply-all I will never live down'],
    flashes: ['My laptop fan spun up as the delivery receipts rolled in.', 'I watched the read-receipts climb in real time.', 'The recall-message button did absolutely nothing.', 'My phone started buzzing before I had even let go of the mouse.'],
    twists: ['the CEO was the very first one to reply', 'half the company had apparently done something similar', 'the thing I sent accidentally got me noticed for a good reason', 'my "mistake" fixed a problem nobody had been willing to name'],
    decisions: ['owned it immediately with a short, honest apology to everyone', 'got ahead of it before the rumor mill could', 'laughed at myself publicly so no one else had to', 'explained, apologized, and moved on fast'],
    fallouts: ['the CEO replied "this made my day" and now I am meme guy', 'it became an inside joke that somehow made me popular', 'my honesty actually earned me some respect', 'I cringe daily but my job was never in danger'],
    titles: ['TIFU by reply-all-ing {who} with the wrong thing', 'TIFU by sending {who} something meant for one person', 'How one click sent {who} the worst possible message'],
    hooks: ['I had one job: send the message to a single person. I failed spectacularly.', 'It took exactly one click to turn a normal Tuesday into the worst day of my career.', 'I have made mistakes before, but nothing that lit up this many phones at once.'] },
  { category: 'Family conflicts',
    whos: ['my closest friend', 'my own sister', 'someone I trusted completely', 'my college best friend'],
    stakes: ['every private thing I had ever told her', 'a secret that could have stayed buried', 'the trust I spent a decade building', 'the one part of my life I kept off the internet'],
    flashes: ['I heard my own words played back at a party I was not invited to.', 'She used it against me the second it was useful.', 'I found the screenshots in a group I was never part of.', 'She denied it until I showed her the proof.'],
    twists: ['she had been doing it for far longer than I realized', 'other people had tried to warn me and I had not listened', 'she had recorded far more than I ever imagined', 'the friend who told me had proof of everything'],
    decisions: ['confronted her with the proof and ended it that night', 'walked away cleanly instead of giving her a fight to spin', 'laid out the evidence and let the friendship end on facts', 'cut contact and kept the receipts, just in case'],
    fallouts: ['she spun it as "just jokes" and tried to turn the group on me', 'most people quietly took my side once they saw it', 'she apologized far too late and far too publicly', 'I lost a friend but kept my peace, and it was worth it'],
    titles: ['{who} betrayed every secret I ever told them', 'How I found out {who} was never really my friend', '{who} sold me out, and the proof spoke for itself'],
    hooks: ['I told this person everything, and they had been quietly weaponising all of it.', 'The worst part was not the betrayal — it was how long it had been going on.', 'I trusted them with the things I told no one else. That was the mistake.'] },
];

const PROC_HOOKS = [
  (w, s) => `${sentenceCase(w)} decided that ${s} belonged to them, and they were ready to burn it all down to win.`,
  (w, s) => `For a long time I told myself ${w} would never actually go this far over ${s}. I was wrong.`,
  (w, s) => `Nobody believed how far ${w} would go over ${s} — until I finally had the proof.`,
  (w, s) => `I still cannot believe ${s} is what turned ${w} into someone I no longer recognise.`,
];

function fillTitle(tpl, who, stake) { return String(tpl).replace(/\{who\}/g, who).replace(/\{stake\}/g, stake); }

// Build one random, coherent premise from the templates. `r` is a seeded PRNG, so a
// given (seedBase, index) is reproducible but every refresh uses a fresh seedBase.
function proceduralSeed(opts, r) {
  let pool = PROCEDURAL;
  if (opts.category && POOL.includes(opts.category)) {
    const f = PROCEDURAL.filter((t) => t.category === opts.category);
    if (f.length) pool = f;
  }
  const t = pickFrom(pool, r);
  const who = pickFrom(t.whos, r);
  const stake = pickFrom(t.stakes, r);
  const flash = pickFrom(t.flashes, r);
  const twist = pickFrom(t.twists, r);
  const decision = pickFrom(t.decisions, r);
  const fallout = pickFrom(t.fallouts, r);
  const title = fillTitle(pickFrom(t.titles, r), who, stake);
  const hook = t.hooks ? pickFrom(t.hooks, r) : pickFrom(PROC_HOOKS, r)(who, stake);
  const details = [
    flash,
    `The whole thing came down to ${stake}, and I could not stop turning it over.`,
    `Everyone had an opinion about ${stake}; almost none of them had to live it.`,
    `I started keeping track of everything, dates and details, almost on instinct.`,
  ];
  const updates = [
    fallout,
    'Looking back, the part everyone fixates on is not even the part that mattered most.',
    'The people who were so sure I was overreacting have mostly gone quiet since.',
  ];
  return { category: t.category, title, hook, who, stake, flash, twist, decision, fallout, details, updates };
}

// Build one full candidate (storyForge-compatible shape) from a raw seed.
function buildCandidate(rawSeed, opts, salt, isAi) {
  const r = rng.mulberry32(rng.seedFrom(`${isAi ? 'ai' : 'proc'}|${rawSeed && rawSeed.title || ''}|${salt}`));
  const seed = normalizeSeed(rawSeed || {}, r);
  const targetMinutes = Math.max(0.5, Math.min(45, Number(opts.targetMinutes) || 30));
  const targetWords = Math.round(targetMinutes * 60 * WORDS_PER_SECOND);
  const body = buildBody(seed, targetWords, r);
  const isQuora = /quora/i.test(opts.source || '');
  return {
    source_type: opts.source || 'pasted',
    external_id: null,
    url: null,
    title: seed.title,
    body,
    author: null,
    community: isQuora ? 'Quora' : 'User submitted',
    category: seed.category,
    created_utc: Math.floor(Date.now() / 1000),
    upvotes: 0, num_comments: 0, upvote_ratio: null, awards: 0,
    _forged: true, _ai: !!isAi, _targetMinutes: targetMinutes,
  };
}

// Auto-selected models this small never produce usable structured premises; calling
// them just adds ~10s of latency before the procedural backfill runs. We skip them
// (an explicitly chosen model is always honoured) — the AI engages automatically as
// soon as a more capable model (e.g. llama3.1:8b) is installed.
const WEAK_MODEL_RE = /(?:^|[:\-_/ ])(0\.5b|1b|1\.5b)\b|moondream|llava|tinyllama|qwen2\.5:0\.5b/i;

// Ask the LLM for creative premises, returning only the usable ones (never throws).
async function aiSeeds(count, opts) {
  try {
    if (!(await llm.probeReachable())) return { seeds: [], model: null };
    const model = await pickModel(opts);
    if (!(opts.aiModel || '').trim() && WEAK_MODEL_RE.test(model || '')) {
      log.activity('STORIES', `Skipping AI premises — "${model}" is too small for this; using the procedural generator. Install a larger model (e.g. llama3.1:8b) for AI-written stories.`, { level: 'info' });
      return { seeds: [], model: null, weak: model };
    }
    const seeds = await requestSeeds(count, opts, model);
    const good = seeds.filter(isValidSeed);
    return { seeds: good, model, skipped: seeds.length - good.length };
  } catch (e) {
    log.activity('STORIES', `AI story generation unavailable (${e.message}).`, { level: 'warn' });
    return { seeds: [], model: null };
  }
}

// Generate `count` fresh, fully expanded, ~30-minute candidates. The local AI invents
// as many original premises as it reliably can; the rest are filled by the procedural
// generator (large combinatorial banks → effectively unlimited unique stories), so a
// refresh ALWAYS returns new, well-structured stories — with or without a strong model.
async function batch(count, opts = {}) {
  const n = Math.max(1, Math.min(50, Number(count) || 12));
  const { seeds, model, skipped } = await aiSeeds(n, opts);

  const out = [];
  // Pre-seed with the library's existing titles so neither the AI nor the procedural
  // backfill reproduces a premise the user already has — this is what makes every
  // press of "Replenish" return genuinely new stories rather than re-rolls.
  const usedTitles = new Set((opts.avoidTitles || []).map(normTitle));
  const add = (cand) => {
    if (!cand) return false;
    const key = normTitle(cand.title);
    if (usedTitles.has(key)) return false;
    usedTitles.add(key); out.push(cand); return true;
  };

  let salt = 0;
  for (const raw of seeds) {
    if (out.length >= n) break;
    try { add(buildCandidate(raw, opts, ++salt, true)); } catch { /* skip */ }
  }
  const aiCount = out.length;

  // Procedural backfill — unique every call (rng seeded by the clock + index). The
  // generous attempt budget lets it re-roll past any combinations already in the
  // library before giving up, so a thin category still yields fresh premises.
  const seedBase = (opts.seedBase != null ? opts.seedBase : Math.floor(Date.now() % 1e7)) || 1;
  while (out.length < n && salt < n + 800) {
    const pr = rng.mulberry32(rng.seedFrom(`proc|${seedBase}|${salt}`));
    salt++;
    try { add(buildCandidate(proceduralSeed(opts, pr), opts, salt, false)); } catch { /* skip */ }
  }

  if (aiCount) {
    log.activity('STORIES', `AI (${model}) invented ${aiCount} premise(s)${skipped ? ` (skipped ${skipped} weak)` : ''}; ${out.length - aiCount} procedurally generated.`, { level: 'success' });
  } else {
    log.activity('STORIES', `Procedurally generated ${out.length} fresh story premise(s).`, { level: 'info' });
  }
  return out;
}

module.exports = { batch, aiSeeds, proceduralSeed, categories: POOL };
