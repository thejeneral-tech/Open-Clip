'use strict';
// End-to-end verification of the REAL /videos pipeline producing a reference video
// (topic card -> author intro -> captions) for a story with a real author + metrics.
// Generates footage if the library is empty, runs pipeline.createVideoForStory with the
// default template, renders, then extracts one frame per intro stage.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const db = require('../src/db/database');
const { id } = require('../src/util/ids');
const { PATHS, FFMPEG } = require('../src/config');
const bgSvc = require('../src/services/backgrounds');
const segSvc = require('../src/services/segments');
const pipeline = require('../src/services/pipeline');
const composer = require('../src/services/composer');

function run(bin, args) {
  return new Promise((res, rej) => { const c = spawn(bin, args, { windowsHide: true }); let e = ''; c.stderr.on('data', (d) => e += d); c.on('close', (x) => x === 0 ? res() : rej(new Error(e.slice(-300)))); });
}

(async () => {
  db.getDb();

  // 1. Ensure footage exists.
  let usable = db.get('SELECT count(*) c FROM segments WHERE usable = 1').c;
  if (!usable) {
    console.log('Library empty — generating synthetic footage…');
    const clip = path.join(PATHS.tmp, 'verify_gameplay.mp4');
    await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'mandelbrot=size=1280x720:rate=30', '-t', '40', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
    const bg = await bgSvc.register(clip, 'verify_gameplay.mp4', { category: 'Minecraft parkour' });
    await segSvc.analyze(bg.id, { segmentLength: 8 });
    usable = db.get('SELECT count(*) c FROM segments WHERE usable = 1').c;
  }
  console.log('Usable segments available:', usable);

  // 2. Insert a story with a REAL author + metrics (so the author card + metrics show).
  const sid = id('story');
  db.insert('stories', {
    id: sid, source_type: 'reddit', external_id: 'verify_ref_' + Date.now(),
    url: 'https://www.reddit.com/r/AmItheAsshole/', community: 'r/AmItheAsshole', category: 'AITA',
    title: 'AITA for jumping out of the way when my niece and nephew tried to push me into a pool?',
    body: 'So this happened at my brother\'s barbecue last weekend. My niece and nephew love shoving people into the pool. I warned them twice to stop. When they charged at me, I simply stepped aside, and they went straight into the water. Everyone went quiet. My brother says I should have just let them push me in. Was I really the bad guy here?',
    author: 'Scared-Weakness-6250', upvotes: 18400, num_comments: 2300, upvote_ratio: 0.92,
    word_count: 70, reading_seconds: 28, est_video_seconds: 40, status: 'new', created_at: db.nowIso(),
  });

  // 3. Run the real pipeline with the default (reference) template.
  console.log('Running pipeline.createVideoForStory…');
  const video = await pipeline.createVideoForStory(sid, { durationSeconds: 60, voice: 'Microsoft Zira Desktop' });
  const v = composer.getVideo(video.id);
  const meta = JSON.parse(v.intro_meta || '{}');
  console.log('intro_meta:', meta, ' template:', v.template_id);
  if (!meta.topicEnd) throw new Error('Reference intro was NOT applied (intro_meta missing).');

  // 4. Render final + extract one frame per stage.
  console.log('Rendering final…');
  const r = await composer.render(video.id, { preset: 'tiktok' });
  const out = r.export.path;
  const work = path.join(PATHS.tmp, 'verify'); fs.mkdirSync(work, { recursive: true });
  const frame = (t, name) => run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', path.join(work, name)]);
  await frame(Math.max(0.3, meta.topicEnd / 2), 'p_stage1.png');
  await frame(meta.topicEnd + (meta.introEnd - meta.topicEnd) / 2, 'p_stage2.png');
  await frame(meta.introEnd + 1.0, 'p_stage3.png');

  console.log(JSON.stringify({
    output: out, width: r.export.width, height: r.export.height, duration: r.export.duration,
    stages: meta, frames: ['p_stage1.png', 'p_stage2.png', 'p_stage3.png'].map((f) => path.join(work, f)),
  }, null, 2));
  console.log('\n✓ Real pipeline produced a reference video.');
  process.exit(0);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
