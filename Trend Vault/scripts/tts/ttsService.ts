import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { applyAudioFX, PostProcessOptions } from './audioPostProcess';
import { formatScript, truncateForPreview } from './scriptFormatter';
import { prepareString, DEFAULT_PAUSES, CINEMATIC_PAUSES, pauseConfigFromRoyalPace } from './textPreprocessor';
import { generateVoiceLocal } from './localTtsAdapter';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const presetsRaw = require('./voicePresets.json') as unknown[];

// Custom presets created via the MP3 Voice Editor live in custom-presets.json
// at the project root. We re-read on every call so newly-saved presets are
// available immediately without server restart.
const CUSTOM_PRESETS_PATH = path.resolve('./custom-presets.json');
function readCustomPresets(): VoicePreset[] {
  if (!fs.existsSync(CUSTOM_PRESETS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(CUSTOM_PRESETS_PATH, 'utf8')) as VoicePreset[]; }
  catch { return []; }
}

export interface VoicePreset {
  id: string;
  name: string;
  icon: string;
  description: string;
  // Legacy Edge Neural voice id (e.g. "en-US-DavisNeural") — still carried in
  // voicePresets.json because the Kokoro server uses it as the lookup key in
  // its VOICE_MAP. Don't rename or drop it.
  edgeId: string;
  defaults: {
    pitch: number;
    rate: number;
    speed: number;
    volume: number;
    intensity: number;
  };
  eq: string;
  reverb: boolean;
  robot: boolean;
}

export const VOICE_PRESETS: VoicePreset[] = presetsRaw as VoicePreset[];

export interface GenerateVoiceOptions {
  text: string;
  presetId: string;
  pitch?: number;
  rate?: number;
  speed?: number;
  volume?: number;
  intensity?: number;
  preview?: boolean; // truncate to ~12s
  // ── Cinematic narrator sliders (0-100) ────────────────────────────────────
  throatDepth?:  number;
  ancientRasp?:  number;
  royalPace?:    number;
  chamberSpace?: number;
}

function tmpFile(ext: string): string {
  return path.join(os.tmpdir(), `trend-vault-tts-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

export async function generateVoice(opts: GenerateVoiceOptions): Promise<{ buffer: Buffer; mimeType: string }> {
  // Look up in built-in presets first, then in user-saved custom presets on disk
  const preset =
    VOICE_PRESETS.find(p => p.id === opts.presetId) ||
    readCustomPresets().find(p => p.id === opts.presetId);
  if (!preset) throw new Error(`Unknown preset: ${opts.presetId}`);

  // Punctuation- + cadence-aware preprocessing — produces TTS-ready text with
  // intentional ellipsis pauses, cleaned em-dashes, and prosody cues.
  // The Royal Pace slider takes priority — when it's > 0 the dramatic-dwell
  // formula drives pause durations directly. Otherwise we use the per-preset
  // cinematic/default config.
  const isCinematic = /cave_oracle|dungeon_wizard|cosmic_monk|dark_story|forbidden|shadow_prophet|gravel_king|ancient_librarian|ethereal|mythic|raspy|ancient_king|medieval_oracle|cave_prophet|dungeon_storyteller|old_warlock|cathedral_monk|gravel_knight|shadow_bard|elder_dragon|royal_seer|night_watchman|stone_temple|wandering_sage|dark_cosmos|flamekeeper|quiet_giant|old_kingdom/i.test(preset.id);
  const pauseCfg = (opts.royalPace && opts.royalPace > 0)
    ? pauseConfigFromRoyalPace(opts.royalPace)
    : (isCinematic ? CINEMATIC_PAUSES : DEFAULT_PAUSES);
  const prepared = prepareString(opts.text, pauseCfg);
  let text = prepared.ttsText;
  // Belt-and-suspenders: legacy formatter handles a few edge cases the
  // preprocessor doesn't cover (multiple consecutive punctuation, etc.)
  text = formatScript(text);
  if (opts.preview) {
    const speedEst = opts.speed ?? preset.defaults.speed;
    text = truncateForPreview(text, 12, speedEst);
  }

  const rawPath = tmpFile('.mp3');
  const outPath = tmpFile('.mp3');

  try {
    // Step 1: Synthesize via the local Kokoro server (only supported engine).
    const local = await generateVoiceLocal({
      text,
      voice:   preset.edgeId,
      speed:   opts.speed ?? preset.defaults.speed,
      outPath: rawPath,
    });
    if (!local) {
      throw new Error(
        'Kokoro TTS server is not reachable. Start it with start-kokoro.bat ' +
        '(the launcher\'s Kokoro card does the same thing) and try again.'
      );
    }

    // Step 2: Apply FFmpeg post-processing (pitch, speed, EQ, reverb, etc.)
    // Cinematic-narrator sliders fall through preset defaults if the preset
    // declares them, else default to 0 (no effect).
    const presetSliders = (preset as { sliders?: { throatDepth?: number; ancientRasp?: number; royalPace?: number; chamberSpace?: number } }).sliders || {};
    const fxOpts: PostProcessOptions = {
      pitch:     opts.pitch     ?? preset.defaults.pitch,
      rate:      opts.rate      ?? preset.defaults.rate,
      speed:     opts.speed     ?? preset.defaults.speed,
      volume:    opts.volume    ?? preset.defaults.volume,
      intensity: opts.intensity ?? preset.defaults.intensity,
      eq:        preset.eq,
      reverb:    preset.reverb,
      robot:     preset.robot,
      throatDepth:  opts.throatDepth  ?? presetSliders.throatDepth  ?? 0,
      ancientRasp:  opts.ancientRasp  ?? presetSliders.ancientRasp  ?? 0,
      royalPace:    opts.royalPace    ?? presetSliders.royalPace    ?? 0,
      chamberSpace: opts.chamberSpace ?? presetSliders.chamberSpace ?? 0,
    };

    await applyAudioFX(rawPath, outPath, fxOpts);

    const buffer = fs.readFileSync(outPath);
    return { buffer, mimeType: 'audio/mpeg' };

  } finally {
    for (const f of [rawPath, outPath]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}
