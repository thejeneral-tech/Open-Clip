import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as path from 'path';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export interface PostProcessOptions {
  pitch: number;      // semitones, -24 to +24
  rate: number;       // percent change, -20 to +20
  speed: number;      // 0.80 to 1.25
  volume: number;     // dB, -10 to +10
  intensity: number;  // 0-100, controls reverb/effect wetness
  eq: string;         // 'broadcast' | 'warm' | 'dark' | 'bright' | 'thin' | 'clear' | 'none'
  reverb: boolean;
  robot: boolean;
  // ── New cinematic narrator sliders (all 0-100, all optional) ──────────────
  // Throat Depth: pitch down + low-mid warmth + treble tame for ancient-king body
  throatDepth?:  number;
  // Ancient Rasp: presence boost + soft saturation for storyteller grit
  ancientRasp?:  number;
  // Royal Pace handled in textPreprocessor (timing) AND here (slight tempo nudge)
  royalPace?:    number;
  // Chamber Space: layered reverb / echo for cave / cathedral feel
  chamberSpace?: number;
}

function clampAtempo(value: number): string[] {
  // atempo must be 0.5–2.0; chain multiple filters for extremes
  const filters: string[] = [];
  let v = Math.max(0.25, Math.min(4.0, value));
  while (v > 2.0) {
    filters.push('atempo=2.0');
    v /= 2.0;
  }
  while (v < 0.5) {
    filters.push('atempo=0.5');
    v *= 2.0;
  }
  filters.push(`atempo=${v.toFixed(5)}`);
  return filters;
}

// Linear interpolation helper — slider 0-100 → output range
const lerp = (slider: number, atZero: number, atHundred: number): number =>
  atZero + (atHundred - atZero) * Math.max(0, Math.min(100, slider)) / 100;

export function buildFilterChain(opts: PostProcessOptions): string {
  const filters: string[] = [];

  // ── Cinematic narrator slider mappings ──────────────────────────────────
  // Throat Depth (0-100): pitch down 0→4 semitones in addition to opts.pitch
  const throat = opts.throatDepth ?? 0;
  const throatPitchOffset = -lerp(throat, 0, 4); // negative = lower
  // Royal Pace (0-100): slight tempo reduction 1.0→0.92 stacked on opts.speed
  // (The big pacing comes from text-side ellipsis insertion in textPreprocessor.)
  const pace = opts.royalPace ?? 0;
  const paceSpeedMultiplier = lerp(pace, 1.0, 0.92);

  // 0. CRITICAL: Force input to 44.1kHz BEFORE asetrate.
  //    Edge TTS outputs at 24kHz; without this normalization, asetrate=44100
  //    plays the 24kHz audio at 1.84x speed (= ~+11 semitones up), making every
  //    voice sound chipmunked regardless of the pitch setting.
  filters.push('aresample=44100');

  // 1. Pitch shift (asetrate trick — independent of speed). Throat depth
  //    pitch offset stacks on top of the user's pitch slider.
  const totalPitch = opts.pitch + throatPitchOffset;
  if (Math.abs(totalPitch) > 0.05) {
    const ratio = Math.pow(2, totalPitch / 12);
    filters.push(`asetrate=44100*${ratio.toFixed(6)}`);
    filters.push(`aresample=44100`);
    // Compensate speed so pitch shift doesn't affect tempo
    const compensation = 1 / ratio;
    filters.push(...clampAtempo(compensation));
  }

  // 2. Speed (rate from slider applies additional %, royalPace adds slight slow)
  const rateMultiplier = 1 + (opts.rate / 100);
  const finalSpeed = Math.max(0.5, Math.min(2.0, opts.speed * rateMultiplier * paceSpeedMultiplier));
  if (Math.abs(finalSpeed - 1.0) > 0.01) {
    filters.push(...clampAtempo(finalSpeed));
  }

  // 3. EQ
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
      // Velvet Static: boost chest resonance (120Hz), add presence (2.7kHz), soften harshness (6kHz cut)
      filters.push('equalizer=f=120:t=h:width=80:g=4');
      filters.push('equalizer=f=400:t=h:width=200:g=1');
      filters.push('equalizer=f=2700:t=h:width=600:g=2');
      filters.push('equalizer=f=6000:t=h:width=3000:g=-3');
      break;
  }

  // 4. Compression (always — tightens dynamic range for TikTok)
  filters.push('acompressor=threshold=-18dB:ratio=4:attack=5:release=50:makeup=3dB');

  // 4a. Throat Depth — low-mid warmth + slight high tame for "ancient king" body
  if (throat > 1) {
    const lowMidGain = lerp(throat, 0, 6).toFixed(2);   // up to +6dB at 180Hz
    const bassGain   = lerp(throat, 0, 4).toFixed(2);   // up to +4dB sub
    const trebleCut  = lerp(throat, 0, 2.5).toFixed(2); // up to -2.5dB at 8kHz
    filters.push(`equalizer=f=180:t=h:width=120:g=${lowMidGain}`);
    filters.push(`bass=g=${bassGain}`);
    filters.push(`treble=g=-${trebleCut}`);
  }

  // 4b. Ancient Rasp — presence boost + soft saturation via compressor
  //     Real "rasp" requires harmonic distortion. We approximate it with a
  //     hard-knee compressor + a 2.2kHz presence band. We DO NOT add aphaser
  //     or aexciter (FFmpeg builds vary), and we keep saturation subtle so
  //     consonants stay clear.
  const rasp = opts.ancientRasp ?? 0;
  if (rasp > 1) {
    const presenceGain = lerp(rasp, 0, 4.5).toFixed(2);  // 0→+4.5dB at 2.2kHz
    const sterileCut   = lerp(rasp, 0, 2.0).toFixed(2);  // 0→-2dB at 10kHz
    const knee         = lerp(rasp, 8, 1).toFixed(1);    // softer→harder knee = more grit
    const makeup       = lerp(rasp, 0, 2.5).toFixed(1);
    filters.push(`equalizer=f=2200:t=h:width=900:g=${presenceGain}`);
    filters.push(`equalizer=f=10000:t=h:width=3000:g=-${sterileCut}`);
    filters.push(`acompressor=threshold=-22dB:ratio=2.2:attack=8:release=120:knee=${knee}:makeup=${makeup}dB`);
  }

  // 5. Volume adjustment
  if (Math.abs(opts.volume) > 0.1) {
    filters.push(`volume=${opts.volume > 0 ? '+' : ''}${opts.volume}dB`);
  }

  // 6. Reverb / Chamber Space — preset reverb + slider-driven chamber layer.
  //    The preset's reverb:true continues to work via opts.intensity. The new
  //    Chamber Space slider stacks two aecho passes (early reflections + tail)
  //    to simulate a stone-walled room. We cap the wet level so consonants
  //    stay readable, even at slider=100.
  if (opts.reverb && opts.intensity > 5) {
    const wet = (opts.intensity / 100 * 0.45).toFixed(3);
    const decay = (0.1 + opts.intensity / 100 * 0.5).toFixed(3);
    filters.push(`aecho=0.85:${wet}:55:${decay}`);
  }
  const chamber = opts.chamberSpace ?? 0;
  if (chamber > 1) {
    // Early reflections — short, tight, simulates first wall bounce
    const earlyWet = lerp(chamber, 0, 0.32).toFixed(3);
    filters.push(`aecho=0.8:${earlyWet}:35|55:0.18|0.14`);
    // Long tail — only kicks in past slider 30, capped to avoid wash-out
    if (chamber > 30) {
      const tailWet = lerp(chamber, 0, 0.28).toFixed(3);
      const tailDecay = lerp(chamber, 0.15, 0.42).toFixed(3);
      filters.push(`aecho=0.7:${tailWet}:120|180|240:${tailDecay}|${tailDecay}|${tailDecay}`);
    }
  }

  // 7. Robot chorus effect
  if (opts.robot) {
    const robotIntensity = opts.intensity / 100;
    const in_gain  = (0.4 + robotIntensity * 0.3).toFixed(2);
    const out_gain = (0.6 + robotIntensity * 0.3).toFixed(2);
    filters.push(`chorus=${in_gain}:${out_gain}:45|55:0.4|0.32:0.25|0.4:2|1.5`);
  }

  // 8. Loudness normalization (final polish)
  filters.push('loudnorm=I=-16:LRA=11:TP=-1.5');

  return filters.join(',');
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

    if (isWav) {
      cmd.audioCodec('pcm_s16le');
    } else {
      cmd.audioCodec('libmp3lame').audioBitrate(128);
    }

    cmd
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(new Error(`FFmpeg error: ${err.message}`)))
      .run();
  });
}
