'use strict';
// Live proof: download a short public YouTube video → register → segment.
const path = require('node:path');
const fs = require('node:fs');
const db = require('./../src/db/database');
const youtube = require('./../src/services/sources/youtube');
const bgSvc = require('./../src/services/backgrounds');
const segSvc = require('./../src/services/segments');
const { PATHS } = require('./../src/config');

(async () => {
  db.getDb();
  const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo", ~19s, public
  const folder = bgSvc.categoryFolder('Custom');
  console.log('Downloading', url, '→', folder);
  let last = -1;
  const { path: file, title } = await youtube.download(url, folder, {
    onProgress: (p) => { if (p - last >= 25) { last = p; process.stdout.write(`  …${Math.round(p)}%\n`); } },
  });
  console.log('Downloaded:', title, '→', path.basename(file), '(', (fs.statSync(file).size/1024).toFixed(0), 'KB )');
  const bg = await bgSvc.register(file, `${title}.mp4`, { category: 'Custom', tags: ['youtube','test'] });
  console.log('Registered bg', bg.id, `${bg.width}x${bg.height}`, Math.round(bg.duration)+'s', 'Q'+bg.quality_score, 'thumb:', !!bg.thumbnail);
  const segs = await segSvc.analyze(bg.id, { segmentLength: 'auto' });
  console.log('Segments created:', segs.length);
  const ok = bg.width > 0 && bg.duration > 5 && segs.length >= 1;
  console.log(ok ? '\n  ✓ PASS — YouTube import produced a usable, segmented background.' : '\n  ✗ FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('\n  ✗ ERROR:', e.message); process.exit(2); });
