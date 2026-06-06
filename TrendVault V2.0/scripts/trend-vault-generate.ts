/**
 * Trend Vault Script Generator
 * Uses a local LLM (Ollama / llama.cpp) to generate cinematic emotional
 * storytelling scripts — no API keys.
 */

import { aiComplete } from './ai-completion';
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
  type: 'hook' | 'setup' | 'observation' | 'example' | 'escalation' | 'truth' | 'twist' | 'takeaway' | 'ending';
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
  estimatedWords?: number;
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
  motivational: 'Passionate, cinematic, and motivational. Slow narrator cadence. Hook → Observation → Energy Shift → Strength → Motivation → Deep Truth → Ending. Each sentence on its own line. Affirming, never fear-based. Honors patience, loyalty, discipline, resilience, timing, and growth.',
};

/**
 * Forces every generated line's display text to UPPERCASE for the TikTok caption
 * aesthetic the project targets. The TTS pipeline still receives the original
 * mixed-case text via textPreprocessor so pronunciation is unaffected.
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

// ── Diversity dials ──────────────────────────────────────────────────────────
const HOOK_STYLES = [
  'a question that lands like an accusation',
  'a quiet statement that sounds like a memory',
  'a one-line scene (someone doing something specific)',
  'an indictment, no preamble',
  'a contradiction the viewer has felt but never named',
  'a direct address that doesn\'t feel preachy',
  'something a friend would whisper at 2am',
  'a single image — concrete, specific',
  'a stat or number that reframes everything',
  'a "what if" that sounds dangerous',
];

const ENDING_STYLES = [
  'a line they could screenshot and use as a reminder',
  'a hushed, almost-spoken affirmation',
  'a single sentence that flips the whole video',
  'an open-ended question you keep thinking about',
  'a quiet truth, delivered without performance',
  'a call to action disguised as an observation',
];

// Creative angle pool — one is picked per call to force fresh framing
export const ANGLE_POOL = [
  'hidden truth',
  'common mistake',
  'dark side',
  'beginner trap',
  'expert secret',
  'unexpected contradiction',
  'storytime warning',
  'myth vs reality',
  'psychology breakdown',
  'things nobody tells you',
  'before you try this',
  'why people fail at this',
  'the expensive lesson',
  'the uncomfortable truth',
  'what actually works',
  'what they don\'t show you',
  'the question nobody asks',
  'the real reason why',
];

function pick<T>(list: T[], rnd: () => number): T {
  return list[Math.floor(rnd() * list.length)];
}

// Mulberry32 seedable PRNG
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
  niche: string;
  subject?: string;
  category: string;
  trendingTopic?: string;
  prompt: string;
  angle: string;
  emotionalTone: string;
  targetDuration: number; // always 90
  randomSeed?: string;
  randomAngle?: string;
}): Promise<GeneratedScript> {
  const { niche, subject, category, trendingTopic, prompt, angle, emotionalTone, targetDuration, randomSeed, randomAngle } = params;

  const toneInstruction = TONES[emotionalTone as keyof typeof TONES] || TONES.mysterious;

  // Always target 90s — 18-24 lines, 200-230 words
  const lineRange  = '18–24';
  const wordMin    = 200;
  const wordMax    = 230;

  // Diversity dials — fresh every call
  const rngSeed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
  const rng = makeRng(rngSeed);
  const hookStyle   = pick(HOOK_STYLES,   rng);
  const endingStyle = pick(ENDING_STYLES, rng);
  const recentHooks = readRecentHooks();

  // Final subject lock — priority order
  const finalSubject =
    (prompt && prompt.trim())          ? prompt.trim()         :
    (trendingTopic && trendingTopic.trim()) ? trendingTopic.trim() :
    (category && category.trim())      ? category.trim()       :
    niche.trim();

  const creativeAngle = randomAngle || pick(ANGLE_POOL, rng);
  const seedTag       = randomSeed  || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const systemPrompt = `You are generating a 1 minute 30 second short-form video narration script for Trend Vault.

Your scripts work for ANY niche: travel, crime, finance, fitness, psychology, food, history, relationships, tech, gaming, beauty, health, business — anything.
The subject is locked to the Story Prompt. You must write about that subject only.
You NEVER drift into relationships, love, heartbreak, zodiac signs, or generic emotional pain unless the Story Prompt explicitly asks for it.

TONE FOR THIS SCRIPT: ${toneInstruction}
The tone controls MOOD and DELIVERY only — not the subject. A "Mysterious" tone on budget travel still produces a script about budget travel.

SCRIPT ARC (must follow this order):
1. HOOK (1 line, 2–3 sec) — One punchy sentence. Stops the scroll. Names the contradiction or truth.
2. SETUP (1–2 lines) — Establish the world. Specific context about this niche/topic.
3. OBSERVATION (3–4 lines) — Real, specific details. Not generic self-help.
4. EXAMPLE (2–3 lines) — Concrete example or scenario from within the niche.
5. ESCALATION (2–3 lines) — Second layer of truth. Raise the stakes.
6. TRUTH (3–4 lines) — The core reframe. Surprising but immediately recognized.
7. TWIST (2–3 lines) — Changes how the viewer sees everything just said.
8. TAKEAWAY (1–2 lines) — The practical or psychological takeaway.
9. ENDING (1–2 lines) — Unforgettable final line(s). The kind people screenshot.

HARD RULES:
- Write EXACTLY ${lineRange} lines total.
- Write between ${wordMin} and ${wordMax} words total.
- Each line is 1–2 short sentences (8–20 words per line).
- Total duration must be 85–95 seconds.
- Do NOT write a 30 second or 55 second script.
- Vary sentence rhythm — short lines hit hard, medium lines build tension.
- Be specific to the actual niche and topic. Avoid vague filler.
- Never explain the insight — state it.

ANTI-REPETITION:
- Do NOT open with any of these recently used hooks:
${recentHooks.length ? recentHooks.map(h => `  • "${h.replace(/"/g, '\\"')}"`).join('\n') : '  (none yet)'}

DIVERSITY DIALS (honor these exactly):
- HOOK STYLE: ${hookStyle}
- CREATIVE ANGLE: ${creativeAngle}
- ENDING STYLE: ${endingStyle}`;

  const userPrompt = `Generate a 1:30 short-form video script using this exact context:

NICHE: ${niche}
CATEGORY: ${category}${trendingTopic ? `\nTRENDING TOPIC: ${trendingTopic}` : ''}${subject ? `\nSUBJECT: ${subject}` : ''}
STORY PROMPT (PRIMARY — this is what the script must be about): ${prompt}${angle ? `\nADDITIONAL ANGLE: ${angle}` : ''}
EMOTIONAL TONE: ${emotionalTone}
CREATIVE ANGLE: ${creativeAngle}

FINAL SUBJECT LOCK: "${finalSubject}"
You must stay locked to this subject for the entire script.
Do NOT write about love, relationships, heartbreak, zodiac, or generic motivation unless the Story Prompt explicitly asks for it.

LENGTH REQUIREMENT:
- 18 to 24 lines total
- 200 to 230 words total
- 85 to 95 seconds total duration
- Do NOT write a short 30s or 55s script

Random seed: ${seedTag} — use this to create a completely fresh angle, hook, structure, examples, and wording. Do not reuse any lines from previous scripts.

Return ONLY valid JSON, no markdown, no extra text:
{
  "title": "Short memorable title about the actual topic",
  "hook": "The exact opening line",
  "estimatedWords": 215,
  "totalDuration": 90,
  "lines": [
    {"text": "...", "type": "hook", "durationSeconds": 3},
    {"text": "...", "type": "setup", "durationSeconds": 4},
    {"text": "...", "type": "observation", "durationSeconds": 5},
    {"text": "...", "type": "observation", "durationSeconds": 5},
    {"text": "...", "type": "observation", "durationSeconds": 5},
    {"text": "...", "type": "example", "durationSeconds": 5},
    {"text": "...", "type": "example", "durationSeconds": 5},
    {"text": "...", "type": "escalation", "durationSeconds": 5},
    {"text": "...", "type": "escalation", "durationSeconds": 5},
    {"text": "...", "type": "truth", "durationSeconds": 4},
    {"text": "...", "type": "truth", "durationSeconds": 4},
    {"text": "...", "type": "truth", "durationSeconds": 4},
    {"text": "...", "type": "twist", "durationSeconds": 4},
    {"text": "...", "type": "twist", "durationSeconds": 4},
    {"text": "...", "type": "takeaway", "durationSeconds": 4},
    {"text": "...", "type": "ending", "durationSeconds": 4},
    {"text": "...", "type": "ending", "durationSeconds": 4}
  ]
}

Write all ${lineRange} lines. Hit ${wordMin}–${wordMax} words. Make every line specific to "${finalSubject}".`;

  const { text: responseText } = await aiComplete({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: 3500,
    temperature: 1.0,
    topP: 0.95,
  });

  // Extract JSON from response (handles markdown code blocks if present)
  let jsonText = responseText.trim();
  const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonText = jsonMatch[1].trim();

  const parsed = JSON.parse(jsonText) as GeneratedScript;
  parsed.trendVaultSign = niche;
  parsed.topic = finalSubject;
  parsed.emotionalTone = emotionalTone;

  // Clamp totalDuration to actual line sum if the AI over-estimated
  const lineSum = (parsed.lines || []).reduce((s, l) => s + (l.durationSeconds || 0), 0);
  if (lineSum > 0) parsed.totalDuration = lineSum;

  // Count words for the meta field
  parsed.estimatedWords = (parsed.lines || []).reduce((s, l) => s + (l.text || '').split(/\s+/).filter(Boolean).length, 0);

  // Remember this hook so next call's blocklist excludes it
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
  const FRAME_PADDING = 0;

  return lines.map((line, i) => {
    const startFrame = i === 0 ? 0 : currentFrame;
    const endFrame = startFrame + Math.ceil(line.durationSeconds * fps);
    currentFrame = endFrame - FRAME_PADDING;

    return { ...line, startFrame, endFrame };
  });
}

// ─── Fallback: generate script without API ────────────────────────────────────
// Used only when no API key is configured or all providers fail.
// Produces a niche-aware 90s / ~210-word script (18 lines).

export function generateFallbackScript(params: {
  niche: string;
  prompt: string;
  angle: string;
  emotionalTone?: string;
}): GeneratedScript {
  const { niche, prompt } = params;

  const fbSeed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
  const fbRng  = makeRng(fbSeed);
  const recent = new Set(readRecentHooks().map(h => h.toLowerCase().trim()));

  const finalSubject = (prompt && prompt.trim()) ? prompt.trim() : niche;

  // Niche-aware hooks — never relationship/zodiac
  const GENERIC_HOOKS = [
    `Nobody tells you the real truth about ${niche}.`,
    `Everyone gets ${niche} wrong — and the proof is in what they don't say.`,
    `The thing about ${niche} is that the obvious answer is never the right one.`,
    `Most people are doing ${niche} the expensive way.`,
    `The difference between people who win at ${niche} and people who don't isn't what you think.`,
    `${niche} rewards the people who understand one thing everyone else ignores.`,
    `You were never taught the real rules of ${niche}.`,
    `Everything you know about ${niche} was designed to keep you from the shortcut.`,
    `Here's what ${niche} actually costs — and nobody warns you.`,
    `The moment you understand this about ${niche}, everything changes.`,
  ];

  const eligibleHooks = GENERIC_HOOKS.filter(h => !recent.has(h.toLowerCase().trim()));
  const hookText = pick(eligibleHooks.length ? eligibleHooks : GENERIC_HOOKS, fbRng);
  const subjectShort = finalSubject.split(' ').slice(0, 6).join(' ');

  // 18-line fallback targeting ~90s
  const lines: GeneratedLine[] = [
    { text: hookText,                                                                                                                  type: 'hook',        durationSeconds: 3 },
    { text: `This is about ${subjectShort} — and it matters more than you think.`,                                                    type: 'setup',       durationSeconds: 4 },
    { text: `Most people approach ${niche} the same way. And most people get the same mediocre result.`,                              type: 'observation', durationSeconds: 6 },
    { text: `They follow the same advice. Read the same guides. And wonder why nothing sticks.`,                                       type: 'observation', durationSeconds: 5 },
    { text: `The problem isn't effort. The problem is the framework they're using.`,                                                   type: 'observation', durationSeconds: 5 },
    { text: `Someone who figures out ${niche} early isn't smarter. They just asked a different question.`,                            type: 'example',     durationSeconds: 5 },
    { text: `Instead of asking how to do more — they asked what to stop doing.`,                                                       type: 'example',     durationSeconds: 5 },
    { text: `The real edge in ${niche} isn't a secret resource. It's a shift in how you see the problem.`,                           type: 'escalation',  durationSeconds: 6 },
    { text: `${subjectShort} sounds simple until you realize the conventional approach is the trap.`,                                 type: 'escalation',  durationSeconds: 5 },
    { text: `The people who figured out ${niche} stopped optimizing for the thing everyone else chases.`,                             type: 'truth',       durationSeconds: 5 },
    { text: `They optimized for the thing underneath it.`,                                                                             type: 'truth',       durationSeconds: 3 },
    { text: `In ${niche}, the biggest wins come from choosing what not to spend — time, money, or attention.`,                        type: 'truth',       durationSeconds: 6 },
    { text: `That single choice separates the people who break through from the ones who stay stuck.`,                                 type: 'truth',       durationSeconds: 5 },
    { text: `The shortcut isn't a trick.`,                                                                                             type: 'twist',       durationSeconds: 2 },
    { text: `It's a different question entirely.`,                                                                                     type: 'twist',       durationSeconds: 3 },
    { text: `Once you see it, you can't unsee it.`,                                                                                    type: 'takeaway',    durationSeconds: 3 },
    { text: `That's when ${niche} finally starts working.`,                                                                            type: 'ending',      durationSeconds: 4 },
    { text: `And you'll wonder why it took you this long to ask.`,                                                                     type: 'ending',      durationSeconds: 4 },
  ];

  try { appendRecentHook(hookText); } catch { /* non-fatal */ }

  const totalDuration = lines.reduce((s, l) => s + l.durationSeconds, 0);
  const estimatedWords = lines.reduce((s, l) => s + l.text.split(/\s+/).filter(Boolean).length, 0);

  return uppercaseScriptLines({
    lines,
    totalDuration,
    title:          `${niche} — The Real Truth`,
    hook:           hookText,
    trendVaultSign: niche,
    topic:          finalSubject,
    emotionalTone:  params.emotionalTone || 'mysterious',
    estimatedWords,
  });
}
