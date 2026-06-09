'use strict';
// Built-in video templates (spec "REFERENCE-BASED TEMPLATE SYSTEM").
// PURE DATA — this module requires nothing, so it is safe to load during DB init
// (overlays.js + templates.js both read from here; nothing here reads them back).
//
// Every template stores the full set of knobs the spec lists: canvas, safe zones,
// topic-card geometry/duration, author-card font/colour, caption font/size/outline/
// placement/highlight, transition timing, audio mix, branding, fps, export settings.

// ASS colours are &HAABBGGRR.
const C = {
  white: '&H00FFFFFF', black: '&H00000000', yellow: '&H0000F0FF',
  cardFill: '&H00FFFFFF', cardTitle: '&H00141414', cardMeta: '&H00777777',
  cardRed: '&H002430E0', shadow: '&HA0000000',
};

// The reference default — "Full-Screen Story Gameplay".
const REFERENCE_TEMPLATE = {
  id: 'full_screen_story',
  name: 'Full-Screen Story Gameplay',
  builtin: true,
  isDefault: true,
  canvas: { width: 1080, height: 1920, fps: 30 },
  safe: { top: 230, bottom: 320, side: 60 },
  gameplay: { mode: 'fill_crop', cropProfile: 'center', audioVolume: 0 }, // muted gameplay, full-screen
  audio: { narrationVolume: 1.0, gameplayVolume: 0, musicVolume: 0, sfxVolume: 0 }, // no music by default
  branding: { enabled: false, position: 'none', text: '' },
  topicCard: {
    enabled: true, minSeconds: 2.2, maxSeconds: 5.0,
    centerY: 760, width: 820, radius: 46, titleSize: 50, metaSize: 34, avatar: true, fade: 180,
  },
  authorIntro: {
    enabled: true, minSeconds: 1.5, maxSeconds: 3.0,
    prefixReddit: 'Posted by', prefixQuora: 'Written by',
    maxSize: 138, minSize: 60, outline: 9, fade: 160, popScale: 108,
  },
  captions: {
    enabled: true, style: 'reference', size: 80, outline: 7, marginV: 520,
    centerY: 1150, // captions are positioned dead-centre horizontally at this Y (≈60% height)
    maxWords: 4, maxChars: 18, highlight: C.yellow, primary: C.white,
  },
  transition: { type: 'fade', seconds: 0.35 }, // seamless crossfade between footage clips
  export: { vcodec: 'libx264', acodec: 'aac', crf: 20, audioBitrate: '160k' },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function variant(id, name, patch) {
  const t = clone(REFERENCE_TEMPLATE);
  t.id = id; t.name = name; t.isDefault = false; t.builtin = true;
  return deepMerge(t, patch);
}
function deepMerge(base, patch) {
  for (const k of Object.keys(patch || {})) {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) base[k] = deepMerge(base[k] || {}, patch[k]);
    else base[k] = patch[k];
  }
  return base;
}

const BUILTIN_TEMPLATES = [
  REFERENCE_TEMPLATE,
  variant('minimal_story', 'Minimal Story', {
    topicCard: { width: 760, titleSize: 46, avatar: false, maxSeconds: 4 },
    captions: { size: 72, maxWords: 3 },
  }),
  variant('large_captions', 'Large Captions', {
    captions: { size: 104, maxWords: 3, outline: 8, marginV: 560 },
  }),
  variant('reddit_card_focus', 'Reddit Card Focus', {
    topicCard: { minSeconds: 3.0, maxSeconds: 6.0, width: 860 },
    authorIntro: { minSeconds: 1.2, maxSeconds: 2.4 },
  }),
  variant('quora_card_focus', 'Quora Card Focus', {
    topicCard: { minSeconds: 3.0, maxSeconds: 6.0, width: 860, avatar: true },
    authorIntro: { prefixReddit: 'Written by', minSeconds: 1.2, maxSeconds: 2.4 },
  }),
  variant('clean_cinematic', 'Clean Cinematic', {
    topicCard: { fade: 300 }, authorIntro: { fade: 280, popScale: 104 },
    captions: { size: 78, outline: 5, marginV: 600 },
  }),
  variant('split_screen', 'Split Screen', {
    gameplay: { mode: 'split_bottom' }, // gameplay bottom half, card top (render support: future)
    captions: { marginV: 480 },
  }),
  variant('custom_template', 'Custom Template', {}),
];

module.exports = { REFERENCE_TEMPLATE, BUILTIN_TEMPLATES, COLORS: C };
