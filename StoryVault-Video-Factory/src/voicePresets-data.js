'use strict';
// Built-in Fish Speech S2 Pro style presets (the voice preset cards).
// Ported from TrendVault's FISH_VOICE_PRESETS. Each card maps a persona to Fish
// model params (speed/temperature/pitchSemitones) used when generating speech.
const FISH_VOICE_PRESETS = [
  { id: 'fish_default', name: 'Default', icon: '🎤', category: 'general',
    description: 'Neutral • Clean • Versatile', tags: ['neutral', 'clean'],
    exampleLine: 'This is the default Fish Speech voice.',
    fishDefaults: { speed: 1.0, temperature: 0.7, pitchSemitones: 0 } },
  { id: 'fish_tiktok_male_natural', name: 'TikTok Male Natural', icon: '🎙', category: 'tiktok',
    description: 'Natural • Conversational • TikTok-Ready', tags: ['male', 'natural', 'tiktok'],
    exampleLine: "You won't believe what happened next.",
    fishDefaults: { speed: 1.0, temperature: 0.7, pitchSemitones: 0 } },
  { id: 'fish_tiktok_male_cinematic', name: 'TikTok Male Cinematic', icon: '🎬', category: 'tiktok',
    description: 'Deep • Cinematic • Dark', tags: ['male', 'cinematic', 'deep'],
    exampleLine: 'In the silence — the truth always finds a way out.',
    fishDefaults: { speed: 0.92, temperature: 0.65, pitchSemitones: -2 } },
  { id: 'fish_tiktok_male_raspy', name: 'TikTok Male Raspy', icon: '🪨', category: 'tiktok',
    description: 'Raspy • Gritty • Edge', tags: ['male', 'raspy', 'gritty'],
    exampleLine: "Some stories aren't meant to be told softly.",
    fishDefaults: { speed: 0.94, temperature: 0.8, pitchSemitones: -1 } },
  { id: 'fish_tiktok_female_natural', name: 'TikTok Female Natural', icon: '🧑‍🎤', category: 'tiktok',
    description: 'Natural • Warm • Approachable', tags: ['female', 'natural', 'warm'],
    exampleLine: 'And this is the part nobody tells you about.',
    fishDefaults: { speed: 1.0, temperature: 0.7, pitchSemitones: 0 } },
  { id: 'fish_tiktok_female_cinematic', name: 'TikTok Female Cinematic', icon: '✨', category: 'tiktok',
    description: 'Soft • Mysterious', tags: ['female', 'cinematic', 'soft'],
    exampleLine: 'You can feel the moment things change.',
    fishDefaults: { speed: 0.92, temperature: 0.65, pitchSemitones: -1 } },
  { id: 'fish_documentary_narrator', name: 'Documentary Narrator', icon: '🎞', category: 'documentary',
    description: 'Measured • Authoritative', tags: ['documentary', 'narration'],
    exampleLine: 'In the years that followed — everything changed.',
    fishDefaults: { speed: 0.95, temperature: 0.55, pitchSemitones: -1 } },
  { id: 'fish_horror_whisper', name: 'Horror Whisper', icon: '👻', category: 'horror',
    description: 'Whisper • Haunting', tags: ['horror', 'whisper'],
    exampleLine: "Don't turn around. Not yet.",
    fishDefaults: { speed: 0.86, temperature: 0.85, pitchSemitones: -3 } },
  { id: 'fish_reddit_storyteller', name: 'Reddit Storyteller', icon: '💬', category: 'storytelling',
    description: 'Relatable • Engaging', tags: ['reddit', 'storytelling'],
    exampleLine: "So this happened last week — I still can't believe it.",
    fishDefaults: { speed: 0.98, temperature: 0.75, pitchSemitones: 0 } },
];

function findFishPreset(id) { return FISH_VOICE_PRESETS.find((p) => p.id === id) || null; }
function categories() { return [...new Set(FISH_VOICE_PRESETS.map((p) => p.category))]; }

module.exports = { FISH_VOICE_PRESETS, findFishPreset, categories };
