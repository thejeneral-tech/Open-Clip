'use strict';
// Thin, promise-based wrappers around ffmpeg/ffprobe. All calls use spawn with an
// argv array (no shell) so paths with spaces/special chars are safe on Windows.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { FFMPEG, FFPROBE } = require('../config');

function run(bin, args, { onStderr, cwd, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let stdout = '', stderr = '';
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${bin} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; if (onStderr) onStderr(s); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(new Error(`Failed to launch ${bin}: ${e.message}. Is it installed and on PATH?`)); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited ${code}: ${stderr.split('\n').slice(-6).join('\n').trim()}`));
    });
  });
}

const ffmpeg = (args, opts) => run(FFMPEG, args, opts);
const ffprobe = (args, opts) => run(FFPROBE, args, opts);

// Full media metadata for a file (spec §10 stored fields).
async function probe(filePath) {
  const { stdout } = await ffprobe(['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
  const data = JSON.parse(stdout);
  const v = (data.streams || []).find((s) => s.codec_type === 'video') || {};
  const a = (data.streams || []).find((s) => s.codec_type === 'audio');
  const fmt = data.format || {};
  const fps = parseFps(v.avg_frame_rate || v.r_frame_rate);
  const width = v.width || 0, height = v.height || 0;
  const g = gcd(width, height) || 1;
  return {
    duration: parseFloat(fmt.duration || v.duration || 0) || 0,
    width, height, fps,
    aspect: width && height ? `${width / g}:${height / g}` : null,
    sizeBytes: parseInt(fmt.size || 0, 10) || 0,
    vcodec: v.codec_name || null,
    acodec: a ? a.codec_name : null,
    hasAudio: !!a,
  };
}

function parseFps(r) {
  if (!r) return 0;
  const [n, d] = String(r).split('/').map(Number);
  if (!d) return n || 0;
  return Math.round((n / d) * 100) / 100;
}
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; }

// Extract a single thumbnail frame.
async function thumbnail(filePath, atSec, outPath, width = 360) {
  await ffmpeg(['-y', '-ss', String(Math.max(0, atSec)), '-i', filePath, '-frames:v', '1',
    '-vf', `scale=${width}:-2`, '-q:v', '4', outPath], { timeoutMs: 60000 });
  return outPath;
}

// Detect black + frozen sections (used to skip menus/loading/death screens — §11).
async function detectDeadZones(filePath, { blackDur = 0.4, freezeDur = 2 } = {}) {
  const black = [], freeze = [];
  const vf = `blackdetect=d=${blackDur}:pix_th=0.10,freezedetect=n=-60dB:d=${freezeDur}`;
  await ffmpeg(['-i', filePath, '-vf', vf, '-an', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null'], {
    timeoutMs: 15 * 60000,
    onStderr: (s) => {
      let m;
      const bRe = /black_start:([\d.]+)\s+black_end:([\d.]+)/g;
      while ((m = bRe.exec(s))) black.push({ start: +m[1], end: +m[2] });
      const fStart = /freeze_start:\s*([\d.]+)/g; const fEnd = /freeze_end:\s*([\d.]+)/g;
      let fs1, fe1;
      while ((fs1 = fStart.exec(s))) freeze.push({ start: +fs1[1], end: null });
      while ((fe1 = fEnd.exec(s))) { const open = freeze.find((f) => f.end === null); if (open) open.end = +fe1[1]; }
    },
  });
  // close any unmatched freeze
  return { black, freeze: freeze.filter((f) => f.end != null) };
}

// Sample average brightness over a clip (0..1) to tag Bright/Dark and score quality.
async function sampleBrightness(filePath, startSec, durSec) {
  try {
    let sum = 0, count = 0;
    await ffmpeg(['-ss', String(startSec), '-t', String(Math.min(durSec, 6)), '-i', filePath,
      '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null',
      process.platform === 'win32' ? 'NUL' : '/dev/null'], {
      timeoutMs: 60000,
      onStderr: (s) => { let m; const re = /YAVG=([\d.]+)/g; while ((m = re.exec(s))) { sum += +m[1]; count++; } },
    });
    return count ? (sum / count) / 255 : 0.5;
  } catch { return 0.5; }
}

function fileExists(p) { try { return fs.existsSync(p); } catch { return false; } }

module.exports = { ffmpeg, ffprobe, probe, thumbnail, detectDeadZones, sampleBrightness, fileExists, parseFps };
