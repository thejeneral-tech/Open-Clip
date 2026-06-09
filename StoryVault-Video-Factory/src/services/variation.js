'use strict';
// Variation Engine (spec §16). Given the previous video's settings (or none) and a
// requested variation type, returns a NEW settings combination that deliberately
// differs — so the system "produces a genuinely different video each time" (§intro).
const rng = require('../util/rng');
const { HOOK_STYLES, CAPTION_STYLES, NARRATION_STYLES } = require('../constants');

const HOOKS = HOOK_STYLES.map((h) => h.id);
const CAPTIONS = CAPTION_STYLES.map((c) => c.id);
const VOICES = ['Microsoft Zira Desktop', 'Microsoft David Desktop'];
const PACING = [
  { name: 'snappy', speed: 1.12, durationSeconds: 45 },
  { name: 'standard', speed: 1.0, durationSeconds: 60 },
  { name: 'measured', speed: 0.95, durationSeconds: 90 },
];

function rotate(arr, current) {
  const i = Math.max(0, arr.indexOf(current));
  return arr[(i + 1) % arr.length];
}

// prev: { hookStyle, voice, captionStyle, narrationStyle, pacing, durationSeconds, storyId, category, segmentIds }
function plan(prev = {}, option = 'Completely new variation', prefs = {}, seed = 0) {
  const rand = rng.mulberry32(rng.seedFrom(`${option}|${prev.storyId || ''}|${seed}`));
  const base = {
    hookStyle: prev.hookStyle || 'conflict',
    voice: prev.voice || prefs.preferredVoice || VOICES[0],
    captionStyle: prev.captionStyle || prefs.preferredCaptionStyle || 'bold',
    narrationStyle: prev.narrationStyle || 'Calm storyteller',
    durationSeconds: prev.durationSeconds || prefs.targetVideoLength || 60,
    speed: prev.speed || 1.0,
    newStory: false,
    sameCategory: false,
    avoidSegmentIds: prev.segmentIds || [],
    variationSeed: (prev.variationSeed || 0) + 1,
  };

  switch (option) {
    case 'New story':
      base.newStory = true; break;
    case 'Same category, different story':
      base.newStory = true; base.sameCategory = true; base.category = prev.category; break;
    case 'New hook':
      base.hookStyle = rotate(HOOKS, prev.hookStyle); break;
    case 'New script angle':
      base.variationSeed += 5; base.hookStyle = rng.pick(rand, HOOKS); break;
    case 'Different narrator':
      base.voice = rotate(VOICES, prev.voice); base.narrationStyle = rotate(NARRATION_STYLES, prev.narrationStyle); break;
    case 'Different background sequence':
      // keep everything; composer just avoids prev segments
      break;
    case 'Different caption style':
      base.captionStyle = rotate(CAPTIONS, prev.captionStyle); break;
    case 'Different pacing': {
      const p = rotate(PACING.map((x) => x.name), prev.pacing);
      const conf = PACING.find((x) => x.name === p);
      base.pacing = p; base.speed = conf.speed; base.durationSeconds = conf.durationSeconds; break;
    }
    case 'Different ending question':
      base.variationSeed += 13; break;
    case 'Completely new variation':
    default:
      base.newStory = true;
      base.hookStyle = rng.pick(rand, HOOKS);
      base.captionStyle = rng.pick(rand, CAPTIONS);
      base.voice = rng.pick(rand, VOICES);
      base.narrationStyle = rng.pick(rand, NARRATION_STYLES);
      base.variationSeed += Math.floor(rand() * 1000);
      break;
  }
  if (!base.pacing) base.pacing = 'standard';
  return base;
}

module.exports = { plan, HOOKS, CAPTIONS, VOICES, PACING };
