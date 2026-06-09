'use strict';
// Reference-template proof render. Produces a real 1080x1920 MP4 that demonstrates the
// exact intro sequence (topic card -> author intro -> yellow-highlight captions) using:
//   * synthetic full-screen "gameplay" (ffmpeg mandelbrot) — the footage library is empty
//   * real Windows SAPI narration in 3 parts (title / "posted by" / body) so the cards
//     track the spoken audio precisely
//   * the production overlay engine in src/services/overlays.js
// Then it extracts 3 frames (one per stage) and ffprobes the output for verification.
//
// Run:  node scripts/render-reference-proof.js

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { PATHS, ROOT, FFMPEG, FFPROBE, ensureDirs } = require('../src/config');
const overlays = require('../src/services/overlays');

const PS = process.env.POWERSHELL_PATH || 'powershell';
const PS_SCRIPT = path.join(ROOT, 'scripts', 'sapi-tts.ps1');

const STORY = {
  platform: 'reddit',
  subreddit: 'r/AmItheAsshole',
  author: 'Scared-Weakness-6250',
  title: 'AITA for jumping out of the way when my niece and nephew tried to push me into a pool, resulting in natural selection taking place?',
  emphasis: 'Plus ten updates.',
  metrics: { upvotes: 18400, comments: 2300 },
  authorSpoken: 'Posted by, Scared Weakness.',
  body: 'So this happened last weekend at my brother\'s barbecue. My niece and nephew, who are eleven and nine, have a habit of shoving people into the pool. I told them twice to stop. When they came running at me, I simply stepped aside. They went straight into the water, and honestly, everyone just stared. My brother says I should have let them push me. Was I really the bad guy here?',
};

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, ...opts });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({ out, err })
      : reject(new Error(`${path.basename(bin)} exited ${code}: ${err.split('\n').slice(-4).join(' ').trim()}`)));
  });
}

async function sapi(text, wav, timings) {
  const txt = wav + '.txt';
  fs.writeFileSync(txt, text, 'utf8');
  await run(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT,
    '-TextFile', txt, '-Out', wav, '-Rate', '0', '-TimingsOut', timings]);
  try { fs.unlinkSync(txt); } catch {}
}

async function probeDuration(file) {
  const { out } = await run(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', file]);
  return parseFloat(JSON.parse(out).format.duration) || 0;
}
async function probe(file) {
  const { out } = await run(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const d = JSON.parse(out);
  const v = (d.streams || []).find((s) => s.codec_type === 'video') || {};
  const a = (d.streams || []).find((s) => s.codec_type === 'audio');
  return { duration: parseFloat(d.format.duration) || 0, width: v.width, height: v.height, hasAudio: !!a, vcodec: v.codec_name, acodec: a && a.codec_name };
}

function readTimings(file, offsetSec, partDuration) {
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch {}
  if (!Array.isArray(raw)) raw = [raw];
  raw = raw.filter((r) => r && r.word && String(r.word).trim());
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const start = raw[i].audioMs / 1000;
    const end = i + 1 < raw.length ? raw[i + 1].audioMs / 1000 : partDuration;
    out.push({ word: String(raw[i].word).trim(), start: offsetSec + start, end: offsetSec + Math.max(start + 0.05, end) });
  }
  return out;
}

(async () => {
  ensureDirs();
  const work = path.join(PATHS.tmp, 'proof');
  fs.mkdirSync(work, { recursive: true });
  const p = (f) => path.join(work, f);

  const cached = process.env.PROOF_REUSE === '1' && fs.existsSync(p('t.wav')) && fs.existsSync(p('b.wav'));
  if (cached) {
    console.log('1/6  Reusing cached narration (PROOF_REUSE=1)…');
  } else {
    console.log('1/6  Narrating title / author / body via SAPI…');
    await sapi(STORY.title, p('t.wav'), p('t.json'));
    await sapi(STORY.authorSpoken, p('a.wav'), p('a.json'));
    await sapi(STORY.body, p('b.wav'), p('b.json'));
  }

  const dT = await probeDuration(p('t.wav'));
  const dA = await probeDuration(p('a.wav'));
  const dB = await probeDuration(p('b.wav'));
  const total = dT + dA + dB;
  const topicEnd = dT;
  const introEnd = dT + dA;
  console.log(`     title=${dT.toFixed(2)}s  author=${dA.toFixed(2)}s  body=${dB.toFixed(2)}s  total=${total.toFixed(2)}s`);

  const bodyTimings = readTimings(p('b.json'), introEnd, dB);

  console.log('2/6  Building combined overlay ASS (card + author + captions)…');
  const ass = overlays.buildAss({
    platform: STORY.platform, subreddit: STORY.subreddit, displayName: STORY.subreddit,
    author: STORY.author, title: STORY.title, emphasis: STORY.emphasis, metrics: STORY.metrics,
    wordTimings: bodyTimings, topicEnd, introEnd,
    // widen the clamp windows so the real audio boundaries are used verbatim for this proof
    template: { topicCard: { minSeconds: 0.5, maxSeconds: 10 }, authorIntro: { minSeconds: 0.5, maxSeconds: 10 } },
  });
  fs.writeFileSync(p('overlay.ass'), ass, 'utf8');

  console.log('3/6  Generating synthetic full-screen gameplay (horizontal -> cropped 9:16)…');
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `mandelbrot=size=1920x1080:rate=30`, '-t', String(Math.ceil(total) + 1),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', p('gameplay.mp4')]);

  console.log('4/6  Concatenating narration parts…');
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-i', p('t.wav'), '-i', p('a.wav'), '-i', p('b.wav'),
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]', '-map', '[a]', p('narration.wav')]);

  console.log('5/6  Rendering final 1080x1920 H.264/AAC (full-screen gameplay + burned overlays)…');
  const outName = 'reference-proof.mp4';
  const out = path.join(PATHS.renders, outName);
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-i', p('gameplay.mp4'), '-i', p('narration.wav'),
    '-filter_complex',
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p,ass=overlay.ass[v]`,
    '-map', '[v]', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-t', String(total), '-movflags', '+faststart', out],
    { cwd: work });

  console.log('6/6  Extracting one frame per stage + verifying…');
  const frame = async (t, name) => run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(t), '-i', out, '-frames:v', '1', path.join(work, name)]);
  await frame(Math.max(0.2, topicEnd / 2), 'stage1_topic.png');
  await frame(topicEnd + (introEnd - topicEnd) / 2, 'stage2_author.png');
  await frame(introEnd + Math.min(1.2, dB / 2), 'stage3_captions.png');

  const meta = await probe(out);
  const report = {
    output: out,
    durations: { title: +dT.toFixed(2), author: +dA.toFixed(2), body: +dB.toFixed(2), total: +total.toFixed(2) },
    stageBoundaries: { topicCardEnds: +topicEnd.toFixed(2), authorIntroEnds: +introEnd.toFixed(2) },
    probe: meta,
    frames: ['stage1_topic.png', 'stage2_author.png', 'stage3_captions.png'].map((f) => path.join(work, f)),
    checks: {
      is1080x1920: meta.width === 1080 && meta.height === 1920,
      hasAudio: meta.hasAudio,
      durationMatchesNarration: Math.abs(meta.duration - total) < 0.6,
      h264_aac: meta.vcodec === 'h264' && meta.acodec === 'aac',
    },
  };
  console.log('\n==== REFERENCE PROOF REPORT ====');
  console.log(JSON.stringify(report, null, 2));
  const allOk = Object.values(report.checks).every(Boolean);
  console.log(allOk ? '\n✓ All checks passed.' : '\n✗ Some checks failed.');
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error('\n✗ Proof failed:', e.message); process.exit(1); });
