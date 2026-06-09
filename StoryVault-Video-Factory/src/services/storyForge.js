'use strict';
// Local long-form story generator — the workaround for not having live Reddit/Quora API
// access. Produces ORIGINAL, topic-matched, multi-act stories of a configurable target
// length (up to ~30 minutes of narration) that score well (clear hook → setup → escalation
// → decision → fallout → multiple updates → resolution). Fully deterministic per seed so the
// same seed reproduces the same story; randomised across calls so the library stays varied.
//
// If an LLM key is configured we could swap in a model later; today this is 100% local.
const rng = require('../util/rng');
const text = require('../util/text');

// ~150 spoken words per minute.
const WPM = 150;

// Scenario banks per category. Each scenario yields a long narrative by expanding its
// beats with varied connective prose so two generations rarely read alike.
const SCENARIOS = {
  AITA: [
    { title: 'AITA for refusing to give up the inheritance my grandmother left only to me?',
      who: 'my brother', stake: 'a house worth more than either of us makes in a decade',
      flash: 'He showed up with a lawyer and a folder of "fair-share" math.',
      decision: 'I told him the will was clear and I would not be guilted out of it',
      fallout: 'half the family stopped speaking to me and called me greedy at Thanksgiving' },
    { title: 'AITA for telling my sister her wedding date was selfish?',
      who: 'my sister', stake: 'the exact day of our late mother’s memorial',
      flash: 'She announced it in the family group chat with confetti emojis.',
      decision: 'I asked her to move it and said I would not attend if she did not',
      fallout: 'she accused me of trying to steal her moment and the cousins picked sides' },
    { title: 'AITA for charging my family an entrance fee to my own wedding?',
      who: 'my fiance', stake: 'twenty dollars a head at the door of our reception',
      flash: 'He printed actual tickets and set up a card reader by the coat check.',
      decision: 'I refused, pulled the table myself, and told him to choose me or the money',
      fallout: 'his mother called me ungrateful and my mother quietly left in tears' },
    { title: 'AITA for exposing the coworker who took credit for two years of my work?',
      who: 'a senior coworker', stake: 'a promotion that was built entirely on my reports',
      flash: 'He presented my deck to the board and never said my name once.',
      decision: 'I forwarded the original timestamped files to the whole leadership chain',
      fallout: 'he was walked out by Friday but half the office now calls me ruthless' },
  ],
  ProRevenge: [
    { title: 'My quiet, methodical revenge on the landlord who kept my deposit',
      who: 'my old landlord', stake: 'two thousand dollars he swore was "cleaning fees"',
      flash: 'He laughed and said good luck proving anything in court.',
      decision: 'I documented everything and took him to small-claims with photos and receipts',
      fallout: 'the judge tripled the award and the city opened a file on his other units' },
    { title: 'My petty revenge on the neighbor who stole my parking spot every single day',
      who: 'my neighbor', stake: 'the assigned spot I pay extra for every month',
      flash: 'He told me to "cry about it" and parked there again the next morning.',
      decision: 'I confirmed the rules in writing and had his car towed at six a.m.',
      fallout: 'he banged on my door furious, but the building office sided with me' },
  ],
  'Neighbor disputes': [
    { title: 'My neighbor built a fence two feet onto my land and dared me to do something',
      who: 'the neighbor', stake: 'a strip of yard I have mowed for eleven years',
      flash: 'He waved the survey he "lost" and told me possession is nine-tenths.',
      decision: 'I paid for a fresh survey and filed the encroachment with the county',
      fallout: 'he had to tear it down at his own cost and now glares from his porch' },
  ],
  'Entitled people': [
    { title: 'An entitled customer demanded I hand over my own lunch for free',
      who: 'a "loyal regular"', stake: 'the meal I brought from home on my unpaid break',
      flash: 'She said her loyalty entitled her to "whatever was in the back."',
      decision: 'I said no, kept eating, and asked my manager to handle her',
      fallout: 'she left a one-star review a week for a month until corporate flagged it' },
  ],
  TIFU: [
    { title: 'TIFU by hitting reply-all to five thousand coworkers with the wrong attachment',
      who: 'the entire company', stake: 'a meme meant for exactly one work friend',
      flash: 'My laptop fan spun up as the delivery receipts started rolling in.',
      decision: 'I owned it immediately and sent a short, honest apology to all',
      fallout: 'the CEO replied "this made my day" and now everyone calls me meme guy' },
  ],
  'Family conflicts': [
    { title: 'My best friend secretly recorded our private calls for a year',
      who: 'my closest friend', stake: 'every vulnerable thing I had ever told her',
      flash: 'I heard my own voice played back at a party I was not invited to.',
      decision: 'I confronted her with the proof and ended the friendship that night',
      fallout: 'she spun it as "just jokes" and tried to turn the group against me' },
  ],
};

const POOL = Object.keys(SCENARIOS);

// Connective prose banks used to inflate each beat into multiple natural paragraphs.
const OPENERS = [
  'I have gone back and forth about posting this, but I need outside eyes.',
  'This has been eating at me for weeks and my own family cannot agree on it.',
  'Throwaway because people I know read this sub. Here is the whole thing.',
  'I genuinely cannot tell if I overreacted, so I am laying it all out.',
];
const TENSION = [
  'For context, this was not a one-time thing; it had been building for months.',
  'You need to understand the history here, because it changes everything.',
  'At first I told myself I was imagining it. I was not.',
  'Everyone keeps focusing on the ending, but the lead-up is the real story.',
];
const ESCALATION = [
  'Then it got worse in a way I did not see coming.',
  'I tried to keep the peace. That only made them bolder.',
  'I gave them every chance to back down. They did not take a single one.',
  'What pushed me over the edge was not the act itself, but how casual they were about it.',
];
const REFLECT = [
  'I keep replaying it and wondering if a calmer person would have done the same.',
  'Part of me feels vindicated and part of me feels like the villain of someone’s story.',
  'I did not want it to end like this, but I am not sure I had another move.',
  'People I trust are split almost exactly down the middle, which is why I am here.',
];
const UPDATE_LEADS = [
  'Update: a lot has happened since I posted.',
  'Edit / Update: you all asked for details, so here is what came next.',
  'Small update because some of you guessed where this was going.',
  'Update: the fallout reached people I never expected it to.',
];

function pickFrom(arr, r) { return arr[Math.floor(r() * arr.length)]; }
function sentenceCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Expand one beat into N varied paragraphs of supporting detail.
function expandBeat(seedNoun, r, paragraphs, banks) {
  const out = [];
  for (let i = 0; i < paragraphs; i++) {
    const lead = pickFrom(banks, r);
    const detail = pickFrom([
      `When it came to ${seedNoun}, nothing was ever simple.`,
      `Every conversation about ${seedNoun} turned into a negotiation.`,
      `I kept notes, dates, and screenshots about ${seedNoun}, almost on instinct.`,
      `The thing about ${seedNoun} is that everyone had an opinion and none of them were mine.`,
      `I tried to be reasonable about ${seedNoun}, the way I was raised to be.`,
      `Looking back, ${seedNoun} was the thread that unravelled the whole thing.`,
      `My partner kept telling me to let ${seedNoun} go, but it was never that easy.`,
      `I lost real sleep over ${seedNoun}, replaying conversations word for word.`,
      `Friends who heard about ${seedNoun} could not believe it was happening to me.`,
      `There was a version of ${seedNoun} I could have lived with, and this was not it.`,
    ], r);
    const beat = pickFrom([
      'I said what I felt, plainly, and waited for the room to react.',
      'I asked one simple question and the silence told me everything.',
      'I offered a compromise that cost me more than it cost them.',
      'I walked the line between firm and cruel, and I am still not sure which side I landed on.',
      'I gave them the benefit of the doubt one more time than I should have.',
      'I wrote out exactly what I wanted to say and then said none of it.',
      'I let the quiet stretch until someone else finally broke it.',
      'I drew a line in the sand and watched them step right over it.',
    ], r);
    out.push(`${lead} ${detail} ${beat}`);
  }
  return out.join('\n\n');
}

// Build one long story. opts: { category, targetMinutes, seed }
function generate(opts = {}) {
  const category = SCENARIOS[opts.category] ? opts.category : pickFrom(POOL, rng.mulberry32(rng.seedFrom(String(opts.seed || Math.floor((opts.salt || 1) * 1e6)))));
  const seedStr = `forge|${category}|${opts.seed != null ? opts.seed : ''}|${opts.salt != null ? opts.salt : ''}`;
  const r = rng.mulberry32(rng.seedFrom(seedStr));
  const bank = SCENARIOS[category];
  const sc = bank[Math.floor(r() * bank.length)];

  const targetMinutes = Math.max(0.5, Math.min(45, Number(opts.targetMinutes) || 3));
  const targetWords = Math.round(targetMinutes * WPM);

  // How many supporting paragraphs/updates to reach the target length.
  const extraDetail = Math.max(0, Math.round((targetWords - 300) / 52));
  const updates = Math.max(1, Math.min(12, Math.round(targetMinutes / 2.6)));

  const parts = [];
  parts.push(`${pickFrom(OPENERS, r)}`);
  parts.push(`This is about ${sc.who} and ${sc.stake}.`);
  parts.push(expandBeat(sc.stake, r, 1 + Math.ceil(extraDetail * 0.33), TENSION));
  parts.push(`${sc.flash}`);
  parts.push(expandBeat(sc.who, r, 1 + Math.ceil(extraDetail * 0.40), ESCALATION));
  parts.push(`So I made a decision: ${sc.decision}.`);
  parts.push(expandBeat('the fallout', r, 1 + Math.ceil(extraDetail * 0.30), REFLECT));
  parts.push(`The immediate fallout was simple and brutal: ${sc.fallout}.`);

  // Updates extend length and add the "multiple updates" reviewers love.
  for (let u = 0; u < updates; u++) {
    parts.push(`${pickFrom(UPDATE_LEADS, r)} ${pickFrom([
      'The people who said I went too far have gone very quiet.',
      'New information came out that made me look a lot less unreasonable.',
      'Someone involved reached out to apologize, and I am still deciding how to respond.',
      'It turns out I was not the only one this had happened to.',
      'There were consequences I genuinely did not intend, and some of them I do regret.',
    ], r)} ${pickFrom(REFLECT, r)}`);
  }
  parts.push(`${pickFrom([
    'So that is where things stand.', 'That is the whole story, ending and all.',
    'I am posting the resolution because you all deserve the full picture.',
  ], r)} ${pickFrom(REFLECT, r)} So… was I wrong?`);

  const body = parts.join('\n\n');
  const isQuora = /quora/i.test(opts.source || '');
  return {
    source_type: opts.source || 'pasted',
    external_id: null,
    url: null,
    title: sentenceCase(sc.title),
    body,
    author: null,                      // a believable handle is generated at render time
    community: isQuora ? 'Quora' : 'User submitted',
    category,
    created_utc: Math.floor(Date.now() / 1000),
    upvotes: 0, num_comments: 0, upvote_ratio: null, awards: 0,
    _forged: true, _targetMinutes: targetMinutes,
  };
}

// Generate `count` varied stories. Optional category filter + target length.
function batch(count, opts = {}) {
  const n = Math.max(1, Math.min(200, Number(count) || 10));
  const out = [];
  // base offset keeps successive calls from repeating; salt jitters within a call.
  const base = (opts.seedBase != null ? opts.seedBase : Math.floor((Date.now() % 1e7))) || 1;
  for (let i = 0; i < n; i++) {
    out.push(generate({
      category: opts.category || null,
      targetMinutes: opts.targetMinutes,
      source: opts.source,
      seed: base + i * 7919,
      salt: i + 1,
    }));
  }
  return out;
}

module.exports = { generate, batch, categories: POOL, estimateMinutes: (words) => words / WPM };
