import * as fs from 'fs';
import * as path from 'path';
import {
  applyAudioFX, PostProcessOptions, concatWithPauses, probeAudioDurationSec, tmpAudioFile,
} from './audioPostProcess';
import { formatScript, truncateForPreview } from './scriptFormatter';
import { prepareString, DEFAULT_PAUSES, CINEMATIC_PAUSES, pauseConfigFromRoyalPace } from './textPreprocessor';
import {
  KokoroEngine, TtsEngine, TtsLogger, ChunkPlan, orchestrateScript, splitForKokoro, MIN_FINAL_DURATION_SEC,
  sanitizeAttempt1, sanitizeAttempt2, sanitizeAttempt3,
} from './ttsEngineManager';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const presetsRaw = require('./voicePresets.json') as unknown[];

const CUSTOM_PRESETS_PATH = path.resolve('./custom-presets.json');
function readCustomPresets(): VoicePreset[] {
  if (!fs.existsSync(CUSTOM_PRESETS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(CUSTOM_PRESETS_PATH, 'utf8')) as VoicePreset[]; }
  catch { return []; }
}

const DEBUG_DIR = path.resolve('./debug/tts');
function writeDebugDump(name: string, payload: unknown): void {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_DIR, name + '.json'), JSON.stringify(payload, null, 2));
  } catch { /* best-effort */ }
}

export interface VoicePreset {
  id: string; name: string; icon: string; description: string; edgeId: string;
  defaults: { pitch: number; rate: number; speed: number; volume: number; intensity: number; };
  eq: string; reverb: boolean; robot: boolean;
}

export const VOICE_PRESETS: VoicePreset[] = presetsRaw as VoicePreset[];

export type { TtsLogger };

export interface GenerateVoiceOptions {
  text: string; presetId: string;
  pitch?: number; rate?: number; speed?: number; volume?: number; intensity?: number;
  preview?: boolean;
  throatDepth?: number; ancientRasp?: number; royalPace?: number; chamberSpace?: number;
  logger?: TtsLogger; safeMode?: boolean;
}

export interface GenerateVoiceResult {
  buffer: Buffer; mimeType: string;
  engineUsed?: string; perChunkDurations?: number[]; finalDurationSec?: number;
}

function buildVoiceLadder(preset: VoicePreset, speed: number): TtsEngine[] {
  const engines: TtsEngine[] = [];
  engines.push(new KokoroEngine('Selected (' + preset.name + ' -> ' + preset.edgeId + ')', preset.edgeId, speed));
  const fallbacks: { label: string; voice: string }[] = [
    { label: 'Default Kokoro male (am_adam)', voice: 'am_adam' },
    { label: 'Default Kokoro female (af_bella)', voice: 'af_bella' },
    { label: 'Alt Kokoro male (am_michael)', voice: 'am_michael' },
  ];
  const selectedLower = preset.edgeId.toLowerCase();
  for (const fb of fallbacks) {
    if (selectedLower === fb.voice.toLowerCase()) continue;
    engines.push(new KokoroEngine(fb.label, fb.voice, speed));
  }
  return engines;
}

function buildChunkPlan(
  ttsChunks: { text: string; pauseAfterMs: number }[],
  formatter: (text: string) => string,
): ChunkPlan[] {
  const out: ChunkPlan[] = [];
  for (let li = 0; li < ttsChunks.length; li++) {
    const { text: rawText, pauseAfterMs } = ttsChunks[li];
    const cleaned = formatter(rawText);
    if (!cleaned || !cleaned.trim()) continue;
    const parts = splitForKokoro(cleaned);
    for (let pi = 0; pi < parts.length; pi++) {
      const isLastPart = pi === parts.length - 1;
      out.push({ originalLineIndex: li, text: parts[pi], pauseAfterMs: isLastPart ? pauseAfterMs : 60 });
    }
  }
  return out;
}

export async function generateVoice(opts: GenerateVoiceOptions): Promise<GenerateVoiceResult> {
  const log: TtsLogger = opts.logger || (() => {});
  const preset = VOICE_PRESETS.find(p => p.id === opts.presetId) || readCustomPresets().find(p => p.id === opts.presetId);
  if (!preset) throw new Error('Unknown preset: ' + opts.presetId);

  const isCinematic = /cave_oracle|dungeon_wizard|cosmic_monk|dark_story|forbidden|shadow_prophet|gravel_king|ancient_librarian|ethereal|mythic|raspy|ancient_king|medieval_oracle|cave_prophet|dungeon_storyteller|old_warlock|cathedral_monk|gravel_knight|shadow_bard|elder_dragon|royal_seer|night_watchman|stone_temple|wandering_sage|dark_cosmos|flamekeeper|quiet_giant|old_kingdom/i.test(preset.id);
  const pauseCfg = (opts.royalPace && opts.royalPace > 0) ? pauseConfigFromRoyalPace(opts.royalPace) : (isCinematic ? CINEMATIC_PAUSES : DEFAULT_PAUSES);
  const prepared = prepareString(opts.text, pauseCfg);
  const speed = opts.speed !== undefined ? opts.speed : preset.defaults.speed;

  let chunks: ChunkPlan[];
  if (opts.preview) {
    const joinedText = prepared.ttsChunks.map(c => c.text).join(' ');
    const truncated = truncateForPreview(joinedText, 12, speed);
    chunks = [{ originalLineIndex: 0, text: formatScript(truncated), pauseAfterMs: 0 }];
  } else {
    chunks = buildChunkPlan(prepared.ttsChunks, formatScript);
  }
  chunks = chunks.filter(c => c.text && c.text.trim().length > 0);
  if (chunks.length === 0) throw new Error('No non-empty text to synthesize.');

  log('Splitting script into ' + chunks.length + ' chunk(s)');
  const engines = buildVoiceLadder(preset, speed);
  log('Engine ladder (' + engines.length + ' engines):');
  engines.forEach((e, i) => log('  ' + (i + 1) + '. ' + e.name));

  const orchestration = await orchestrateScript(chunks, engines, log);
  if (!orchestration.ok) {
    const debugId = 'tts-fail-' + Date.now();
    writeDebugDump(debugId, {
      timestamp: new Date().toISOString(),
      presetId: opts.presetId, presetName: preset.name, presetEdgeId: preset.edgeId,
      chunkCount: chunks.length, chunkPreviews: chunks.map(c => c.text.slice(0, 80)),
      engineLadder: engines.map(e => e.name), reasons: orchestration.reasons,
    });
    throw new Error(
      'Every TTS engine failed. See debug/tts/' + debugId + '.json. ' +
      'Reasons: ' + orchestration.reasons.join(' || ')
    );
  }
  log('TTS engine selected: ' + orchestration.engineUsed);

  const cleanup: string[] = [...orchestration.chunkPaths];
  try {
    const concatPath = tmpAudioFile('.wav');
    cleanup.push(concatPath);
    await concatWithPauses(orchestration.chunkPaths, orchestration.pauseAfterMs, concatPath);
    const concatDur = await probeAudioDurationSec(concatPath);
    if (concatDur < MIN_FINAL_DURATION_SEC) {
      const debugId = 'tts-concat-fail-' + Date.now();
      writeDebugDump(debugId, {
        timestamp: new Date().toISOString(),
        concatDurationSec: concatDur,
        perChunkDurations: orchestration.perChunkDurations,
        pauseAfterMs: orchestration.pauseAfterMs,
        engineUsed: orchestration.engineUsed,
      });
      throw new Error('Concat produced ' + concatDur.toFixed(2) + 's. See debug/tts/' + debugId + '.json.');
    }
    log('Merged audio duration: ' + concatDur.toFixed(2) + 's');

    const presetSliders = (preset as { sliders?: { throatDepth?: number; ancientRasp?: number; royalPace?: number; chamberSpace?: number } }).sliders || {};
    const finalPath = tmpAudioFile('.mp3');
    cleanup.push(finalPath);

    if (opts.safeMode) {
      log('Safe mode: skipping FX chain');
      await applyAudioFX(concatPath, finalPath, {
        pitch: 0, rate: 0, speed: 1.0, volume: 0, intensity: 0,
        eq: 'none', reverb: false, robot: false,
        throatDepth: 0, ancientRasp: 0, royalPace: 0, chamberSpace: 0,
      });
    } else {
      const fxOpts: PostProcessOptions = {
        pitch: opts.pitch !== undefined ? opts.pitch : preset.defaults.pitch,
        rate: opts.rate !== undefined ? opts.rate : preset.defaults.rate,
        speed: opts.speed !== undefined ? opts.speed : preset.defaults.speed,
        volume: opts.volume !== undefined ? opts.volume : preset.defaults.volume,
        intensity: opts.intensity !== undefined ? opts.intensity : preset.defaults.intensity,
        eq: preset.eq, reverb: preset.reverb, robot: preset.robot,
        throatDepth: opts.throatDepth !== undefined ? opts.throatDepth : (presetSliders.throatDepth || 0),
        ancientRasp: opts.ancientRasp !== undefined ? opts.ancientRasp : (presetSliders.ancientRasp || 0),
        royalPace: opts.royalPace !== undefined ? opts.royalPace : (presetSliders.royalPace || 0),
        chamberSpace: opts.chamberSpace !== undefined ? opts.chamberSpace : (presetSliders.chamberSpace || 0),
      };
      await applyAudioFX(concatPath, finalPath, fxOpts);
    }

    const finalDur = await probeAudioDurationSec(finalPath);
    if (finalDur < MIN_FINAL_DURATION_SEC) {
      throw new Error('Final post-FX audio ' + finalDur.toFixed(2) + 's - FX chain destroyed audio. Use Force Working Voice Render.');
    }
    log('Final voice audio: ' + finalDur.toFixed(2) + 's via ' + orchestration.engineUsed + (opts.safeMode ? ' (safe mode)' : ''));

    const buffer = fs.readFileSync(finalPath);
    return {
      buffer, mimeType: 'audio/mpeg',
      engineUsed: orchestration.engineUsed,
      perChunkDurations: orchestration.perChunkDurations,
      finalDurationSec: finalDur,
    };
  } finally {
    for (const f of cleanup) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ } }
  }
}

// ─── Debug / diagnostic helpers exposed via /api/tts/* routes ────────────────

/**
 * Real-synthesis preflight against a specific Kokoro voice id (or '' for
 * the default test voice). Returns {ok, reason?}. Useful for the
 * /api/tts/preflight route.
 */
export async function runKokoroRenderPreflight(
  edgeId: string,
  log: TtsLogger,
): Promise<{ ok: boolean; reason?: string; voice: string }> {
  const voice = edgeId || 'en-US-JennyNeural';
  log('Preflight using voice: ' + voice);
  const engine = new KokoroEngine('preflight (' + voice + ')', voice, 1.0);
  const r = await engine.probe();
  return { ok: r.ok, reason: r.reason, voice };
}

/**
 * Run the three sanitization variants against a single chunk of text and
 * report whether each produces real audio. Saves a debug bundle to
 * debug/tts/<id>.json. Used by /api/tts/debug-chunk.
 */
export async function debugChunkSynthesis(
  text: string,
  edgeId: string,
  log: TtsLogger,
): Promise<Array<{ attempt: number; sanitized: string; ok: boolean; bytes?: number; durationSec?: number; error?: string }>> {
  const voice = edgeId || 'en-US-JennyNeural';
  const engine = new KokoroEngine('debug (' + voice + ')', voice, 1.0);
  const probe = await engine.probe();
  if (!probe.ok) {
    log('Engine probe failed: ' + (probe.reason || 'unknown'));
    return [{ attempt: 0, sanitized: '(engine offline)', ok: false, error: probe.reason }];
  }
  const reports: Array<{ attempt: number; sanitized: string; ok: boolean; bytes?: number; durationSec?: number; error?: string }> = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const sanitized =
      attempt === 1 ? sanitizeAttempt1(text) :
      attempt === 2 ? sanitizeAttempt2(text) :
                      sanitizeAttempt3(text);
    if (!sanitized) {
      reports.push({ attempt, sanitized: '', ok: false, error: 'empty after sanitize' });
      continue;
    }
    const outPath = tmpAudioFile('.wav');
    try {
      const r = await engine.synthesizeChunk(sanitized, outPath);
      reports.push({ attempt, sanitized, ok: true, bytes: r.bytes, durationSec: r.durationSec });
      log('attempt ' + attempt + ' OK: ' + r.durationSec.toFixed(2) + 's');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reports.push({ attempt, sanitized, ok: false, error: msg });
      log('attempt ' + attempt + ' FAIL: ' + msg);
    } finally {
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
    }
  }
  writeDebugDump('debug-chunk-' + Date.now(), { voice, text, reports });
  return reports;
}

/**
 * Force a working voice render: same engine ladder + sanitization as the
 * normal render path, but always with safeMode=true (no FX) and a
 * generic default preset so even a broken custom preset can't sink it.
 * Used by /api/trend-vault/force-render-voice.
 */
export async function forceWorkingVoiceRender(
  text: string,
  log: TtsLogger,
): Promise<{ buffer: Buffer; mimeType: string; engine: string; durationSec: number }> {
  // Use the first built-in non-custom preset as a baseline. If none exists,
  // synthesize a minimal stand-in so generateVoice() always has a preset.
  const fallbackPreset = VOICE_PRESETS.find(p => !p.id.startsWith('custom_'));
  const presetId = fallbackPreset ? fallbackPreset.id : VOICE_PRESETS[0]?.id;
  if (!presetId) throw new Error('No built-in voice presets installed');
  log('Force render using built-in preset: ' + presetId);
  const r = await generateVoice({ text, presetId, safeMode: true, logger: log });
  return {
    buffer: r.buffer,
    mimeType: r.mimeType,
    engine: r.engineUsed || 'unknown',
    durationSec: r.finalDurationSec || 0,
  };
}
