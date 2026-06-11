'use strict';
// Static reference data drawn directly from the spec. Centralised so the UI and
// the services agree on the exact same vocabulary.

const CATEGORIES = [
  'AITA', 'Relationships', 'Family drama', 'Friendship drama', 'Workplace drama',
  'Revenge', 'Confessions', 'Scary stories', 'Mystery', 'Embarrassing stories',
  'TIFU', 'Entitled people', 'Cheating', 'Money disputes', 'Wedding drama',
  'Roommate drama', 'School stories', 'Neighbor disputes', 'Customer service stories',
  'Moral dilemmas', 'Unpopular opinions', 'Funny stories', 'Emotional stories',
  'Inspirational stories',
];

// Maps common subreddits to a default category for ranking/preference filtering.
const SUBREDDIT_CATEGORY = {
  amitheasshole: 'AITA',
  aita: 'AITA',
  relationship_advice: 'Relationships',
  relationships: 'Relationships',
  trueoffmychest: 'Confessions',
  offmychest: 'Confessions',
  confession: 'Confessions',
  confessions: 'Confessions',
  pettyrevenge: 'Revenge',
  prorevenge: 'Revenge',
  nuclearrevenge: 'Revenge',
  maliciouscompliance: 'Revenge',
  tifu: 'TIFU',
  nosleep: 'Scary stories',
  shortscarystories: 'Scary stories',
  entitledpeople: 'Entitled people',
  entitledparents: 'Entitled people',
  choosingbeggars: 'Entitled people',
  askreddit: 'Funny stories',
  weddingshaming: 'Wedding drama',
  bridezillas: 'Wedding drama',
  badroommates: 'Roommate drama',
  talesfromretail: 'Customer service stories',
  talesfromtechsupport: 'Customer service stories',
};

const SUGGESTED_COMMUNITIES = [
  'AmItheAsshole', 'AskReddit', 'relationship_advice', 'TrueOffMyChest',
  'pettyrevenge', 'ProRevenge', 'MaliciousCompliance', 'confessions', 'tifu',
  'nosleep', 'EntitledPeople', 'ChoosingBeggars',
];

const SORT_OPTIONS = [
  { id: 'popular', label: 'Most popular' },
  { id: 'upvoted', label: 'Most upvoted' },
  { id: 'commented', label: 'Most commented' },
  { id: 'engaging', label: 'Most engaging' },
  { id: 'rising', label: 'New and rising' },
  { id: 'storytelling', label: 'Best storytelling' },
  { id: 'short_video', label: 'Best for short videos' },
  { id: 'controversy', label: 'Best controversy' },
  { id: 'emotional', label: 'Best emotional story' },
  { id: 'hidden_gems', label: 'Hidden gems' },
];

const SOURCE_TYPES = [
  'reddit', 'reddit_url', 'quora', 'quora_url', 'pasted', 'file', 'csv', 'collection',
  'website', 'rss', 'multiple',
];

const ENDING_PREFERENCES = [
  'Shocking ending', 'Satisfying ending', 'Open-ended question', 'Moral dilemma',
  'Funny ending', 'Emotional ending', 'Plot twist', 'Update included',
];

const HOOK_STYLES = [
  { id: 'conflict', label: 'Start with the conflict' },
  { id: 'craziest', label: 'Start with the craziest sentence' },
  { id: 'question', label: 'Ask a question' },
  { id: 'quote', label: 'Use a shocking quote' },
  { id: 'reveal', label: 'Reveal the ending partially' },
  { id: 'calm', label: 'Calm storytelling' },
  { id: 'suspense', label: 'Suspenseful storytelling' },
  { id: 'funny', label: 'Funny storytelling' },
];

const NARRATION_STYLES = [
  'Calm storyteller', 'Dramatic', 'Suspenseful', 'Funny', 'Serious',
  'Confessional', 'Documentary',
];

const CAPTION_STYLES = [
  { id: 'bold', label: 'Bold' },
  { id: 'clean', label: 'Clean' },
  { id: 'karaoke', label: 'Karaoke highlight' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'large_centered', label: 'Large centered' },
  { id: 'two_line', label: 'Two-line story captions' },
];

const SCRIPT_DURATIONS = [30, 45, 60, 90, 120, 180, 240, 300];

const BACKGROUND_TYPES = [
  'Minecraft parkour', 'Fortnite parkour', 'Rocket League', 'GTA', 'Nature', 'Driving',
  'Satisfying videos', 'Game footage', 'City footage', 'Custom',
];

const SEGMENT_LENGTHS = [5, 10, 15, 20, 30]; // plus 'auto'

const SEGMENT_TAGS = [
  'Fast movement', 'Slow movement', 'Bright', 'Dark', 'Indoor', 'Outdoor',
  'Nature', 'Water', 'Forest', 'Minecraft', 'Parkour', 'High action', 'Calm',
  'Seamless loop',
];

const VARIATION_OPTIONS = [
  'New story', 'Same category, different story', 'New hook', 'New script angle',
  'Different narrator', 'Different background sequence', 'Different caption style',
  'Different pacing', 'Different ending question', 'Completely new variation',
];

const BATCH_STATUSES = [
  'Waiting', 'Finding story', 'Analyzing', 'Writing script', 'Generating audio',
  'Selecting footage', 'Creating captions', 'Building preview', 'Ready for review',
  'Approved', 'Rendering', 'Complete', 'Failed',
];

const PLATFORMS = ['tiktok', 'shorts', 'reels'];

// Default user preferences object (spec §4).
const DEFAULT_PREFERENCES = {
  preferredCategories: ['AITA', 'Revenge', 'Relationships'],
  blockedCategories: [],
  minEngagement: 0,
  desiredEmotion: 'any',
  desiredStoryLength: 'medium',
  targetVideoLength: 60,
  preferredVoice: 'Microsoft Zira Desktop',
  voicePresetId: null,         // when set, a saved voice preset (Fish/cloned/SAPI) overrides preferredVoice
  preferredBackground: 'Minecraft parkour',
  preferredCaptionStyle: 'bold',
  preferredPlatforms: ['tiktok', 'shorts', 'reels'],
  profanity: 'allow',          // allow | censor
  violenceSensitivity: 'medium',
  adultTopicFilter: true,
  repetitionTolerance: 'low',  // low | medium | high
  endingPreference: 'Satisfying ending',
  useAi: true,                 // use the local LLM for script rewriting (falls back to the heuristic when offline)
  aiModel: '',                 // override the active LLM model for script generation ('' = use the selected model)
};

module.exports = {
  CATEGORIES, SUBREDDIT_CATEGORY, SUGGESTED_COMMUNITIES, SORT_OPTIONS, SOURCE_TYPES,
  ENDING_PREFERENCES, HOOK_STYLES, NARRATION_STYLES, CAPTION_STYLES, SCRIPT_DURATIONS,
  BACKGROUND_TYPES, SEGMENT_LENGTHS, SEGMENT_TAGS, VARIATION_OPTIONS, BATCH_STATUSES,
  PLATFORMS, DEFAULT_PREFERENCES,
};
