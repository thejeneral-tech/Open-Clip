/**
 * Trend Vault Script Generator
 * Uses Claude to generate cinematic emotional storytelling scripts
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  MOTIVATIONAL_SCRIPTS,
  getMotivationalScript,
  shouldUseMotivationalScript,
} from './motivational-scripts';

// Re-export so any caller (server, render script, future API endpoints) can
// pull the built-in library without needing a second import path.
export { MOTIVATIONAL_SCRIPTS, getMotivationalScript, shouldUseMotivationalScript };

export interface GeneratedLine {
  text: string;
  type: 'hook' | 'observation' | 'escalation' | 'truth' | 'twist' | 'ending';
  durationSeconds: number;
}

export interface GeneratedScript {
  lines: GeneratedLine[];
  totalDuration: number;
  title: string;
  hook: string;
  trendVaultSign: string;
  topic: string;
  emotionalTone: string;
}

const TONES = {
  mysterious:  'Create an atmosphere of mystery and psychological depth. Questions left unanswered. Truths revealed slowly.',
  emotional:   'Raw emotional honesty. Goes straight to the feeling. No metaphors — just reality.',
  dark:        'Dark psychology. The uncomfortable truths people know but never say out loud.',
  reflective:  'Meditative and introspective. Thoughtful pauses. Deep self-examination.',
  dramatic:    'High emotional stakes. Everything matters. Tension that builds.',
  intimate:    'Whispered truths. Close and personal. Feels like a private conversation.',
  melancholic: 'Beautiful sadness. Longing and loss. The ache of what was and what could have been.',
  calm:        'Steady and certain. Quiet authority. Truths delivered without performance.',
  // Cinematic motivational tone — when this is requested, the fallback path
  // serves a hand-written passionate script from the built-in library
  // (see scripts/motivational-scripts.ts). The AI generator can also use
  // this string as a style brief.
  motivational: 'Passionate, cinematic, and motivational. Slow narrator cadence. Hook → Observation → Energy Shift → Strength → Motivation → Deep Truth → Ending. Each sentence on its own line. Affirming, never fear-based. Honors patience, loyalty, discipline, resilience, timing, and growth.',
};

/**
 * Forces every generated line's display text to UPPERCASE for the TikTok caption
 * aesthetic the project targets. The TTS pipeline still receives the original
 * mixed-case text via textPreprocessor (see scripts/tts/textPreprocessor.ts) so
 * pronunciation is unaffected — this only changes what's drawn on screen.
 */
export function uppercaseScriptLines(script: GeneratedScript): GeneratedScript {
  return {
    ...script,
    hook:  script.hook?.toUpperCase() ?? '',
    title: script.title,
    lines: script.lines.map(l => ({ ...l, text: l.text.toUpperCase() })),
  };
}

// ── Recent-hook history (anti-repetition) ────────────────────────────────────
// Persist the last 30 hooks we generated to disk. On every new generation we
// inject them into the prompt with explicit "do not start like any of these"
// instructions, plus a fresh random seed in the user prompt. Together these
// kill the "Claude keeps using the same opener" failure mode without changing
// the structure or tone.
import * as fsRecent from 'fs';
import * as pathRecent from 'path';
const RECENT_HOOKS_PATH = pathRecent.resolve('data', 'recent-hooks.json');
const RECENT_HOOKS_KEEP = 30;

function readRecentHooks(): string[] {
  try { return JSON.parse(fsRecent.readFileSync(RECENT_HOOKS_PATH, 'utf8')); }
  catch { return []; }
}
function appendRecentHook(hook: string): void {
  if (!hook) return;
  const cur = readRecentHooks();
  cur.unshift(hook.trim());
  const next = cur.slice(0, RECENT_HOOKS_KEEP);
  try {
    fsRecent.mkdirSync(pathRecent.dirname(RECENT_HOOKS_PATH), { recursive: true });
    fsRecent.writeFileSync(RECENT_HOOKS_PATH, JSON.stringify(next, null, 2));
  } catch { /* non-fatal */ }
}

// ── Diversity dials picked at random each call ──────────────────────────────
// These force the model into a different corner of the space every call —
// not by rewriting the system prompt, but by parameterising the user prompt
// with values the model has to honor. This combined with the recent-hook
// blocklist is what kills the "same starters every time" complaint.
const HOOK_STYLES = [
  'a question that lands like an accusation',
  'a quiet statement that sounds like a memory',
  'a one-line scene (someone doing something specific)',
  'an indictment, no preamble',
  'a contradiction the viewer has felt but never named',
  'a direct address that doesn\'t feel preachy',
  'something a friend would whisper at 2am',
  'a single image — concrete, specific',
];
const STORY_ANGLES = [
  'the moment they almost left and didn\'t',
  'what they tell themselves vs what they actually do',
  'the version of themselves the public never sees',
  'how they protect people from their own intensity',
  'the contradiction at the center of who they are',
  'what looks like cruelty but is actually loyalty',
  'why they stayed when nobody else would have',
  'the small repeated act that tells you everything',
];
const ENDING_STYLES = [
  'a line they could screenshot and use against an ex',
  'a hushed, almost-spoken affirmation',
  'a single sentence that flips the whole video',
  'an open-ended question you keep thinking about',
  'a quiet truth, delivered without performance',
];

function pick<T>(list: T[], rnd: () => number): T {
  return list[Math.floor(rnd() * list.length)];
}
// Mulberry32 — small seedable PRNG; default seed = process.hrtime + Math.random
function makeRng(seed?: number): () => number {
  let a = (seed ?? (Date.now() ^ Math.floor(Math.random() * 1e9))) >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function generateTrendVaultScript(params: {
  trendVaultSign: string;
  category: string;
  prompt: string;
  angle: string;
  emotionalTone: string;
  targetDuration: number; // seconds, 90-120
}): Promise<GeneratedScript> {
  const { trendVaultSign, category, prompt, angle, emotionalTone, targetDuration } = params;

  const toneInstruction = TONES[emotionalTone as keyof typeof TONES] || TONES.mysterious;

  // Diversity dials — pick fresh for every call
  const rngSeed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
  const rng = makeRng(rngSeed);
  const hookStyle    = pick(HOOK_STYLES,    rng);
  const storyAngle   = pick(STORY_ANGLES,   rng);
  const endingStyle  = pick(ENDING_STYLES,  rng);
  const recentHooks  = readRecentHooks();

  const systemPrompt = `You are the creative force behind Trend Vault.Insight3 — a TikTok account with millions of views.
Your videos are famous because they feel:
- Emotionally real and psychologically accurate
- Personal — like the viewer is being seen for the first time
- Grounded in actual human behavior, not astrology clichés
- Cinematic in pacing, with tension that builds naturally

You NEVER write:
- Generic horoscope statements
- "Hey Scorpios, this is for you" type openers
- Spiritual platitudes or fortune-telling
- Repetitive astrology stereotypes
- Filler words or explanations of what you're about to say

TONE: ${toneInstruction}

Your scripts follow a specific emotional arc:
1. HOOK (4-6 sec) — Opens an emotional loop. One sentence that stops the scroll. No setup, no explanation.
2. OBSERVATION (12-18 sec) — A specific, relatable truth about this sign's behavior. Not generic.
3. ESCALATION (18-24 sec) — Deepen the psychological tension. Layer in a second truth.
4. DEEPER TRUTH (18-24 sec) — The real reason behind the behavior. Surprising but immediately recognized.
5. TWIST (12-18 sec) — Emotional reframe. Changes how they see everything said before.
6. ENDING (8-12 sec) — One or two unforgettable final lines. The kind people screenshot.

WRITING RULES:
- Sentences vary in length. Short sentences hit hard. Medium sentences build. Never use three long sentences in a row.
- No "And" at the start of every sentence. Vary openings.
- Speak directly: "You know exactly what you're doing." / "They don't leave because they stopped caring."
- Never explain the insight — just state it.
- Avoid "-ing" heavy construction. Be direct.
- Total word count: 200-280 words
- Total duration: ${targetDuration - 5} to ${targetDuration + 5} seconds

ANTI-REPETITION (CRITICAL):
- Do NOT start the script with any of these openers or close paraphrases — they have been used recently and would feel stale:
${recentHooks.length ? recentHooks.map(h => `  • "${h.replace(/"/g, '\\"')}"`).join('\n') : '  (no prior hooks yet)'}
- Do NOT reuse the cadence "${recentHooks[0] ?? ''}" — vary sentence rhythm.

DIVERSITY DIALS FOR THIS GENERATION (honor these — they steer the corner of style space):
- HOOK STYLE: ${hookStyle}.
- STORY ANGLE: ${storyAngle}.
- ENDING STYLE: ${endingStyle}.`;

  const userPrompt = `Create a trend-vault storytelling video script for:
- Sign: ${trendVaultSign}
- Topic Category: ${category}
- Core Premise: ${prompt}
- Emotional Angle: ${angle}

Return ONLY valid JSON, no other text, in this exact format:
{
  "lines": [
    {"text": "...", "type": "hook", "durationSeconds": 4},
    {"text": "...", "type": "observation", "durationSeconds": 5},
    ...more lines...
  ],
  "totalDuration": 95,
  "title": "Short memorable title",
  "hook": "The exact opening line"
}

Each line should be 1-2 sentences max. Include 12-18 lines total to fill ${targetDuration} seconds naturally.

Random seed for this generation: ${rngSeed}. Use this seed mentally to ensure your output is meaningfully different from prior runs — different vocabulary, different sentence shapes, different concrete details, different rhythm.`;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    // High temperature widens the sampling — combined with the recent-hooks
    // blocklist and the diversity dials, this is what stops Claude from
    // recycling its favorite openers.
    temperature: 1.0,
    top_p: 0.95,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Unexpected response type from Claude');

  // Extract JSON from response (handles markdown code blocks if present)
  let jsonText = content.text.trim();
  const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonText = jsonMatch[1].trim();

  const parsed = JSON.parse(jsonText) as GeneratedScript;
  parsed.trendVaultSign = trendVaultSign;
  parsed.topic = prompt;
  parsed.emotionalTone = emotionalTone;

  // Remember this hook so next call's recent-hook blocklist excludes it.
  try { appendRecentHook(parsed.hook || parsed.lines?.[0]?.text || ''); } catch { /* non-fatal */ }

  // Force all caption text to UPPERCASE — TikTok storycore aesthetic
  return uppercaseScriptLines(parsed);
}

// ─── Calculate frame timing from script lines ─────────────────────────────────

export function calculateFrameTiming(
  lines: GeneratedLine[],
  fps: number = 30
): Array<GeneratedLine & { startFrame: number; endFrame: number }> {
  let currentFrame = 0;
  // FRAME_PADDING was previously 2 (intended as "overlap for smooth
  // transitions"), but ScriptLineComp in src/TrendVaultVideo.tsx renders the
  // outgoing line's fade-out AND the incoming line's fade-in at the same
  // caption position. During those overlap frames both texts were visible
  // at low opacity, producing brief "ghost text" / flicker between lines —
  // exactly the symptom the smoothness check is targeting.
  //
  // Setting padding to 0 makes lines strictly sequential: line[i].endFrame
  // === line[i+1].startFrame. The fade-out and fade-in still produce a
  // visually smooth handoff via the interpolate() windows already in the
  // component, but the two strings never share the screen.
  const FRAME_PADDING = 0;

  return lines.map((line, i) => {
    const startFrame = i === 0 ? 0 : currentFrame;
    const endFrame = startFrame + Math.ceil(line.durationSeconds * fps);
    currentFrame = endFrame - FRAME_PADDING;

    return { ...line, startFrame, endFrame };
  });
}

// ─── Fallback: generate script without API ────────────────────────────────────

export function generateFallbackScript(params: {
  trendVaultSign: string;
  prompt: string;
  angle: string;
  emotionalTone?: string;
}): GeneratedScript {
  const { trendVaultSign, prompt, angle, emotionalTone } = params;

  // If the caller asked for a motivational tone OR has no real prompt to
  // work with, hand back the cinematic motivational script from the built-in
  // library. This is silent — no UI surfaces it; the existing fallback path
  // simply produces a far better script for these signs.
  if (shouldUseMotivationalScript({ trendVaultSign, emotionalTone, prompt })) {
    const motivational = getMotivationalScript(trendVaultSign);
    if (motivational) {
      return uppercaseScriptLines({
        ...motivational,
        title: prompt || motivational.title,
        topic: prompt || motivational.topic,
      });
    }
  }

  // ── Diverse template pools ────────────────────────────────────────────────
  // The fallback used to return the exact same 11 lines on every call — only
  // the sign name changed, which is why the hook "SCORPIOS DON'T DO THIS BY
  // ACCIDENT" kept reappearing. We now pick from pools per call, exclude
  // recently-used hooks via the same recent-hooks blocklist the AI path uses,
  // and roll a fresh seeded RNG so output rotates even on rapid repeats.
  // Same 11-line / ~55s shape is preserved so captions and timing still align.
  const signLower = trendVaultSign.toLowerCase();
  const signsLower = `${signLower}s`;

  const HOOK_POOL: string[] = [
    `${signsLower} don't do this by accident.`,
    `you didn't lose a ${signLower}. you lost their patience.`,
    `the quietest a ${signLower} ever gets is right before they're gone.`,
    `they noticed. they're just not telling you yet.`,
    `there's a version of them you only see once.`,
    `you mistook their composure for forgiveness.`,
    `a ${signLower} doesn't warn you twice.`,
    `they stayed longer than you deserved. they remember exactly when that stopped.`,
    `you keep waiting for them to react. they already did — months ago.`,
    `the way a ${signLower} loves you is rarely the way you'll be able to describe it.`,
    `everyone misreads the silence.`,
    `they don't go cold. they go quiet — and that's worse.`,
    `you weren't ignored. you were observed.`,
    `you'll know it was over the day you remember a thing you said two weeks ago.`,
    `a ${signLower} is never confused about how they feel. you are.`,
    `the moment they decided, the room changed. you just didn't catch it.`,
    `they're not difficult. you're new to being seen this clearly.`,
    `the most dangerous thing a ${signLower} can do is finally agree with you.`,
  ];

  const OBS_POOL: string[] = [
    `there's something specific about the way they love — and the way they protect themselves from it.`,
    `most of what they show you is the second draft. you never see the first.`,
    `they aren't holding back. they're holding something. you just can't tell the difference yet.`,
    `the part of them you got was earned, not given. nobody told you which.`,
    `they made it look easy on purpose. that's not the same as easy.`,
  ];

  const SURFACE_POOL: string[] = [
    `most people see the surface. the silence. the distance. the way they seem unmoved when everything is moving inside them.`,
    `from the outside it looks like indifference. from the inside it sounds like a countdown.`,
    `they read every room before they speak. people mistake that for shyness or arrogance — it's neither.`,
    `you saw composure and called it coldness. those are not the same thing.`,
    `they don't perform their feelings. that's not the same as not having any.`,
  ];

  const TRUTH_POOL: string[] = [
    `the people who seem the hardest to reach are usually the ones who felt things so deeply once — they built something around it.`,
    `the wall isn't there to keep you out. it's there because last time, nobody stopped them from giving everything.`,
    `they learned early that the loudest love in the room is rarely the one that stays.`,
    `it isn't trust they're protecting. it's the version of themselves that still believes in it.`,
    `behind every "i'm fine" from them is a sentence they've already decided you're not ready to hear.`,
  ];

  const TWIST_PAIR_POOL: Array<[string, string]> = [
    [`not to keep others out.`, `to keep themselves in.`],
    [`it isn't about you.`, `that's what makes it about you.`],
    [`they're not pulling away.`, `they're deciding whether to stay.`],
    [`it's not that they don't feel it.`, `it's that they felt it first, and alone.`],
    [`they didn't go quiet because you stopped mattering.`, `they went quiet because you started.`],
  ];

  const RELEASE_POOL: string[] = [
    `when a ${signLower} finally lowers that wall — even slightly — it's not weakness.`,
    `the day a ${signLower} stops measuring you is the day they've already chosen.`,
    `when a ${signLower} tells you something true, they've already decided you can carry it.`,
    `when a ${signLower} stays after seeing you at your worst, that wasn't tolerance — it was a verdict.`,
    `when a ${signLower} softens around you, you're not winning them. you're being trusted.`,
  ];

  const ENDING_PAIR_POOL: Array<[string, string]> = [
    [`it's the bravest thing they've ever done.`, `and most people never realize they were witnessing it.`],
    [`it cost them more than you'll ever know.`, `and they did it anyway.`],
    [`that wasn't a small thing.`, `you're just not going to be told that.`],
    [`it's the closest thing to a confession they have.`, `you only get it once.`],
    [`it's not the loud kind of love.`, `it's the kind people miss until it's gone.`],
  ];

  // Seeded RNG + recent-hooks blocklist so the same hook can't fire twice in
  // a row. Falls back gracefully if every hook is currently on the blocklist.
  const fbSeed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
  const fbRng = makeRng(fbSeed);
  const recent = new Set(readRecentHooks().map(h => h.toLowerCase().trim()));
  const eligibleHooks = HOOK_POOL.filter(h => !recent.has(h.toLowerCase().trim()));
  const hookText = pick(eligibleHooks.length ? eligibleHooks : HOOK_POOL, fbRng);

  const obsText           = pick(OBS_POOL,         fbRng);
  const surfaceText       = pick(SURFACE_POOL,     fbRng);
  const truthText         = pick(TRUTH_POOL,       fbRng);
  const [twistA, twistB]  = pick(TWIST_PAIR_POOL,  fbRng);
  const releaseText       = pick(RELEASE_POOL,     fbRng);
  const [endA, endB]      = pick(ENDING_PAIR_POOL, fbRng);

  const lines: GeneratedLine[] = [
    { text: hookText,                                              type: 'hook',        durationSeconds: 4 },
    { text: obsText,                                               type: 'observation', durationSeconds: 6 },
    { text: surfaceText,                                           type: 'observation', durationSeconds: 7 },
    { text: `but the reality is far more complicated than that.`, type: 'escalation',  durationSeconds: 4 },
    { text: angle,                                                 type: 'escalation',  durationSeconds: 6 },
    { text: truthText,                                             type: 'truth',       durationSeconds: 7 },
    { text: twistA,                                                type: 'truth',       durationSeconds: 3 },
    { text: twistB,                                                type: 'twist',       durationSeconds: 3 },
    { text: releaseText,                                           type: 'twist',       durationSeconds: 6 },
    { text: endA,                                                  type: 'ending',      durationSeconds: 4 },
    { text: endB,                                                  type: 'ending',      durationSeconds: 5 },
  ];

  // Record this hook so the next call's blocklist excludes it. Non-fatal on
  // failure (e.g. read-only filesystem in a worker).
  try { appendRecentHook(hookText); } catch { /* non-fatal */ }

  return uppercaseScriptLines({
    lines,
    totalDuration: lines.reduce((sum, l) => sum + l.durationSeconds, 0),
    title: prompt,
    hook: lines[0].text,
    trendVaultSign,
    topic: prompt,
    emotionalTone: 'mysterious',
  });
}
