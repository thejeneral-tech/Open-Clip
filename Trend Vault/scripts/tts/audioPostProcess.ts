import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export interface PostProcessOptions {
  pitch: number;
  rate: number;
  speed: number;
  volume: number;
  intensity: number;
  eq: string;
  reverb: boolean;
  robot: boolean;
  throatDepth?:  number;
  ancientRasp?:  number;
  royalPace?:    number;
  chamberSpace?: number;
}

function clampAtempo(value: number): string[] {
  const filters: string[] = [];
  let v = Math.max(0.25, Math.min(4.0, value));
  while (v > 2.0) { filters.push('atempo=2.0'); v /= 2.0; }
  while (v < 0.5) { filters.push('atempo=0.5'); v *= 2.0; }
  filters.push('atempo=' + v.toFixed(5));
  return filters;
}

const lerp = (slider: number, atZero: number, atHundred: number): number =>
  atZero + (atHundred - atZero) * Math.max(0, Math.min(100, slider)) / 100;

export function buildFilterChain(opts: PostProcessOptions): string {
  const filters: string[] = [];
  const throat = opts.throatDepth ?? 0;
  const throatPitchOffset = -lerp(throat, 0, 4);
  const pace = opts.royalPace ?? 0;
  const paceSpeedMultiplier = lerp(pace, 1.0, 0.92);
  filters.push('aresample=44100');
  const totalPitch = opts.pitch + throatPitchOffset;
  if (Math.abs(totalPitch) > 0.05) {
    const ratio = Math.pow(2, totalPitch / 12);
    filters.push('asetrate=44100*' + ratio.toFixed(6));
    filters.push('aresample=44100');
    const compensation = 1 / ratio;
    filters.push(...clampAtempo(compensation));
  }
  const rateMultiplier = 1 + (opts.rate / 100);
  const finalSpeed = Math.max(0.5, Math.min(2.0, opts.speed * rateMultiplier * paceSpeedMultiplier));
  if (Math.abs(finalSpeed - 1.0) > 0.01) filters.push(...clampAtempo(finalSpeed));
  switch (opts.eq) {
    case 'broadcast':
      filters.push('equalizer=f=100:t=h:width=80:g=-2');
      filters.push('equalizer=f=2500:t=h:width=600:g=3');
      filters.push('equalizer=f=8000:t=h:width=2000:g=2');
      break;
    case 'warm':
      filters.push('equalizer=f=200:t=h:width=150:g=3');
      filters.push('equalizer=f=1200:t=h:width=400:g=1');
      filters.push('equalizer=f=5000:t=h:width=2000:g=-2');
      break;
    case 'dark':
      filters.push('equalizer=f=80:t=h:width=60:g=4');
      filters.push('equalizer=f=400:t=h:width=200:g=1');
      filters.push('equalizer=f=5000:t=h:width=3000:g=-5');
      break;
    case 'bright':
      filters.push('equalizer=f=200:t=h:width=100:g=-2');
      filters.push('equalizer=f=4000:t=h:width=2000:g=3');
      filters.push('equalizer=f=10000:t=h:width=3000:g=4');
      break;
    case 'thin':
      filters.push('equalizer=f=100:t=h:width=80:g=-6');
      filters.push('equalizer=f=800:t=h:width=300:g=2');
      break;
    case 'clear':
      filters.push('equalizer=f=250:t=h:width=100:g=-1');
      filters.push('equalizer=f=3000:t=h:width=500:g=2');
      break;
    case 'velvet':
      filters.push('equalizer=f=120:t=h:width=80:g=4');
      filters.push('equalizer=f=400:t=h:width=200:g=1');
      filters.push('equalizer=f=2700:t=h:width=600:g=2');
      filters.push('equalizer=f=6000:t=h:width=3000:g=-3');
      break;
  }
  filters.push('acompressor=threshold=-18dB:ratio=4:attack=5:release=50:makeup=3dB');
  if (throat > 1) {
    const lowMidGain = lerp(throat, 0, 6).toFixed(2);
    const bassGain   = lerp(throat, 0, 4).toFixed(2);
    const trebleCut  = lerp(throat, 0, 2.5).toFixed(2);
    filters.push('equalizer=f=180:t=h:width=120:g=' + lowMidGain);
    filters.push('bass=g=' + bassGain);
    filters.push('treble=g=-' + trebleCut);
  }
  const rasp = opts.ancientRasp ?? 0;
  if (rasp > 1) {
    const presenceGain = lerp(rasp, 0, 4.5).toFixed(2);
    const sterileCut   = lerp(rasp, 0, 2.0).toFixed(2);
    const knee         = lerp(rasp, 8, 1).toFixed(1);
    const makeup       = lerp(rasp, 0, 2.5).toFixed(1);
    filters.push('equalizer=f=2200:t=h:width=900:g=' + presenceGain);
    filters.push('equalizer=f=10000:t=h:width=3000:g=-' + sterileCut);
    filters.push('acompressor=threshold=-22dB:ratio=2.2:attack=8:release=120:knee=' + knee + ':makeup=' + makeup + 'dB');
  }
  if (Math.abs(opts.volume) > 0.1) {
    filters.push('volume=' + (opts.volume > 0 ? '+' : '') + opts.volume + 'dB');
  }
  if (opts.reverb && opts.intensity > 5) {
    const wet = (opts.intensity / 100 * 0.45).toFixed(3);
    const decay = (0.1 + opts.intensity / 100 * 0.5).toFixed(3);
    filters.push('aecho=0.85:' + wet + ':55:' + decay);
  }
  const chamber = opts.chamberSpace ?? 0;
  if (chamber > 1) {
    const earlyWet = lerp(chamber, 0, 0.32).toFixed(3);
    filters.push('aecho=0.8:' + earlyWet + ':35|55:0.18|0.14');
    if (chamber > 30) {
      const tailWet = lerp(chamber, 0, 0.28).toFixed(3);
      const tailDecay = lerp(chamber, 0.15, 0.42).toFixed(3);
      filters.push('aecho=0.7:' + tailWet + ':120|180|240:' + tailDecay + '|' + tailDecay + '|' + tailDecay);
    }
  }
  if (opts.robot) {
    const robotIntensity = opts.intensity / 100;
    const in_gain  = (0.4 + robotIntensity * 0.3).toFixed(2);
    const out_gain = (0.6 + robotIntensity * 0.3).toFixed(2);
    filters.push('chorus=' + in_gain + ':' + out_gain + ':45|55:0.4|0.32:0.25|0.4:2|1.5');
  }
  filters.push('loudnorm=I=-16:LRA=11:TP=-1.5');
  return filters.join(',');
}

// Raised from 22050 → 44100 for consistent quality across all pipeline stages.
// All TTS chunk WAVs, silence pads, and the final concat now share one sample
// rate so no implicit resampling can distort pitch or timing.
const CONCAT_SAMPLE_RATE = 44100;

export function generateSilenceWav(durationSec: number, outputPath: string): Promise<void> {
  if (durationSec <= 0) return Promise.reject(new Error('generateSilenceWav: durationSec must be > 0'));
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input('anullsrc=channel_layout=mono:sample_rate=' + CONCAT_SAMPLE_RATE)
      .inputFormat('lavfi')
      .duration(durationSec)
      .audioCodec('pcm_s16le')
      .audioChannels(1)
      .audioFrequency(CONCAT_SAMPLE_RATE)
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(new Error('FFmpeg silence-gen error: ' + err.message)))
      .run();
  });
}

export function concatWavFiles(filePaths: string[], outputPath: string): Promise<void> {
  if (filePaths.length === 0) return Promise.reject(new Error('concatWavFiles: no inputs'));
  if (filePaths.length === 1) {
    return new Promise((resolve, reject) => {
      try { fs.copyFileSync(filePaths[0], outputPath); resolve(); }
      catch (e) { reject(e); }
    });
  }
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    filePaths.forEach(p => { cmd.input(p); });
    const inputLabels = filePaths.map((_, i) => '[' + i + ':a]').join('');
    const filter = inputLabels + 'concat=n=' + filePaths.length + ':v=0:a=1[out]';
    cmd
      .complexFilter(filter, ['out'])
      .audioCodec('pcm_s16le')
      .audioChannels(1)
      .audioFrequency(CONCAT_SAMPLE_RATE)
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(new Error('FFmpeg concat error: ' + err.message)))
      .run();
  });
}

export async function concatWithPauses(
  filePaths: string[],
  pauseAfterMs: number[],
  outputPath: string,
): Promise<void> {
  if (filePaths.length !== pauseAfterMs.length) {
    throw new Error('concatWithPauses: pauseAfterMs length must equal filePaths length');
  }
  if (filePaths.length === 0) throw new Error('concatWithPauses: no inputs');
  if (filePaths.length === 1) {
    fs.copyFileSync(filePaths[0], outputPath);
    return;
  }
  const silencePathByMs = new Map<number, string>();
  for (let i = 0; i < filePaths.length - 1; i++) {
    const ms = pauseAfterMs[i];
    if (ms > 1 && !silencePathByMs.has(ms)) {
      const silencePath = tmpAudioFile('.wav');
      await generateSilenceWav(ms / 1000, silencePath);
      silencePathByMs.set(ms, silencePath);
    }
  }
  const interleaved: string[] = [];
  for (let i = 0; i < filePaths.length; i++) {
    interleaved.push(filePaths[i]);
    if (i < filePaths.length - 1) {
      const ms = pauseAfterMs[i];
      const sp = silencePathByMs.get(ms);
      if (sp) interleaved.push(sp);
    }
  }
  try {
    await concatWavFiles(interleaved, outputPath);
  } finally {
    for (const sp of silencePathByMs.values()) {
      try { if (fs.existsSync(sp)) fs.unlinkSync(sp); } catch { /* ignore */ }
    }
  }
}

export function probeAudioDurationSec(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) { resolve(0); return; }
      const dur = data && data.format && data.format.duration;
      resolve(typeof dur === 'number' && isFinite(dur) ? dur : 0);
    });
  });
}

export function tmpAudioFile(ext: string): string {
  const safeExt = ext.startsWith('.') ? ext : '.' + ext;
  return path.join(os.tmpdir(), 'trend-vault-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2) + safeExt);
}

export function applyAudioFX(inputPath: string, outputPath: string, opts: PostProcessOptions): Promise<void> {
  const filterChain = buildFilterChain(opts);
  const ext = path.extname(outputPath).toLowerCase();
  const isWav = ext === '.wav';
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath)
      .audioFilters(filterChain)
      .audioChannels(1)
      .audioFrequency(44100);
    if (isWav) cmd.audioCodec('pcm_s16le');
    else cmd.audioCodec('libmp3lame').audioBitrate('192k');
    cmd.on('end',   () => resolve())
       .on('error', (err: Error) => reject(err))
       .save(outputPath);
  });
}
