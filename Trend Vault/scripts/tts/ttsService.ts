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
  // Engine policy (UI-driven). 'auto' = local first, fall back to Edge TTS.
  // 'local' = local only, raise an error if no local server is running.
  // 'edge'  = always Microsoft Edge TTS.
  engine?: 'auto' | 'local' | 'edge';
  // ── Cinematic narrator sliders (0-100) ────────────────────────────────────
  throatDepth?:  number;
  ancientRasp?:  number;
  royalPace?:    number;
  chamberSpace?: number;
}

function tmpFile(ext: string): string {
  return path.join(os.tmpdir(), `trend-vault-tts-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

async function edgeTtsToFile(text: string, voiceId: string, outputPath: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EdgeTTS } = require('node-edge-tts');

  // node-edge-tts throws plain strings ("Timed out") on network errors instead
  // of Error objects — that's why server.ts logs showed
  // `(e as Error).message === undefined`. Wrap with retry + proper coercion.
  const attempt = async (): Promise<void> => {
    const tts = new EdgeTTS({
      voice: voiceId,
      outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
    });
    await tts.ttsPromise(text, outputPath);
  };

  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      await attempt();
      return;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 400));
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message
    : typeof lastErr === 'string' ? lastErr
    : JSON.stringify(lastErr);
  throw new Error(`Edge TTS failed for "${voiceId}": ${msg}. Check internet connection or try another preset.`);
}

export async function generateVoice(opts: GenerateVoiceOptions): Promise<{ buffer: Buffer; mimeType: string }> {
  // Look up in built-in presets first, then in user-saved custom presets on disk
  const preset =
    VOICE_PRESETS.find(p => p.id === opts.presetId) ||
    readCustomPresets().find(p => p.id === opts.presetId);
  if (!preset) throw new Error(`Unknown preset: ${opts.presetId}`);

  // Punctuation- + cadence-aware preprocessing — produces TTS-ready text with
  // intentional ellipsis pauses, cleaned em-dashes, and prosody cues. This is
  // the single biggest "less robotic" upgrade short of swapping engines.
  // The Royal Pace slider takes priority — when it's > 0 the dramatic-dwell
  // formula drives pause durations directly. Otherwise we use the per-preset
  // cinematic/default config (existing behavior).
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
    // Step 1: Engine selection driven by UI toggle.
    //   auto  → try local first, fall back to Edge TTS
    //   local → local only; throw a clear error if no local server is up
    //   edge  → skip local, use Edge TTS (current default)
    const engine = opts.engine ?? 'auto';
    let usedLocal = false;
    if (engine !== 'edge') {
      const local = await generateVoiceLocal({
        text,
        voice:   preset.edgeId,
        speed:   opts.speed ?? preset.defaults.speed,
        outPath: rawPath,
      });
      usedLocal = !!local;
      if (!usedLocal && engine === 'local') {
        throw new Error(
          'Voice engine set to LOCAL ONLY but no local TTS server reachable. ' +
          'Set LOCAL_TTS_URL in .env (e.g. http://localhost:5070 for Kokoro) and start the server. ' +
          'See scripts/tts/localTtsAdapter.ts for setup steps.'
        );
      }
    }
    if (!usedLocal) {
      await edgeTtsToFile(text, preset.edgeId, rawPath);
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
