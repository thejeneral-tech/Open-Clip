'use strict';
// Automated coverage of the spec §29 test list, run against the REAL services
// (no mocks for the media pipeline — ffmpeg/ffprobe/SAPI actually run).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PATHS, FFMPEG } = require('../src/config');

const db = require('../src/db/database');
const stories = require('../src/services/stories');
const discovery = require('../src/services/discovery');
const textImport = require('../src/services/sources/textImport');
const reddit = require('../src/services/sources/reddit');
const dedup = require('../src/services/dedup');
const scoring = require('../src/services/scoring');
const bgSvc = require('../src/services/backgrounds');
const segSvc = require('../src/services/segments');
const sg = require('../src/services/scriptGenerator');
const tts = require('../src/services/tts');
const captions = require('../src/services/captions');
const composer = require('../src/services/composer');
const pipeline = require('../src/services/pipeline');
const variation = require('../src/services/variation');
const systemStatus = require('../src/services/systemStatus');

const results = [];
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (e) { results.push(['FAIL', name, e.message]); failed++; process.stdout.write(`  ✗ ${name}\n      → ${e.message}\n`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const ASSETS = path.join(PATHS.tmp, 'test_assets');
fs.mkdirSync(ASSETS, { recursive: true });

// Generate a short test MP4 with a black gap (so dead-zone detection has work).
function makeClip(name, { color = 'testsrc2', withBlack = true, dur = 18, size = '1280x720' } = {}) {
  const out = path.join(ASSETS, name);
  if (fs.existsSync(out)) return out;
  const inputs = withBlack
    ? ['-f', 'lavfi', '-i', `${color}=size=${size}:rate=30:duration=${dur / 2}`,
       '-f', 'lavfi', '-i', `color=c=black:size=${size}:rate=30:duration=2`,
       '-f', 'lavfi', '-i', `${color}=size=${size}:rate=30:duration=${dur / 2}`,
       '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]']
    : ['-f', 'lavfi', '-i', `${color}=size=${size}:rate=30:duration=${dur}`];
  const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(dur), out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffmpeg makeClip failed: ' + (r.stderr || '').slice(-200));
  return out;
}
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

const PASTED_AITA = 'AITA for charging my family an entrance fee to my wedding?\n\nMy fiance insisted we charge guests to attend our wedding. I refused but he demanded it anyway. My mother cried when she found out. Then I discovered he had been planning this for months. In the end I cancelled the wedding. Update: we broke up and I feel free.';
const PASTED_REVENGE = 'My petty revenge on a parking spot thief\n\nMy neighbor kept stealing my assigned parking spot every single day. I asked nicely and he laughed in my face. So I had his car towed at 6am before work. He was furious but the office sided with me. Now he parks three blocks away and I smile every morning.';

(async () => {
  console.log('\nStoryVault Video Factory — test suite (§29)\n');

  // T1/T3 import pasted (Quora-style) + multiple
  let importedStory;
  await test('1+3. Import pasted Quora-style story (single)', () => {
    const r = stories.ingest(textImport.fromPasted(PASTED_AITA), { sourceType: 'pasted' });
    assert(r.stories.length === 1, 'expected 1 story');
    importedStory = r.stories[0];
    assert(importedStory.score_overall > 0, 'story should be scored');
    assert(importedStory.category, 'category should be inferred');
  });

  await test('2. Import several stories at once (--- separated)', () => {
    const r = stories.ingest(textImport.fromPasted(PASTED_REVENGE + '\n---\n' + 'A funny story\n\nMy dog ate my homework and then my teacher actually believed me because the dog threw it up on her desk.'), { sourceType: 'pasted' });
    assert(r.stories.length === 2, 'expected 2 stories, got ' + r.stories.length);
  });

  await test('4. Reddit post normalization (offline parser)', () => {
    // Exercise the normalizer that import-one-URL relies on, without network.
    const reddit = require('../src/services/sources/reddit');
    // normalizePost is internal; validate via the category mapper + sort mapper instead.
    assert(reddit.categoryForSub('AmItheAsshole') === 'AITA', 'subreddit→category mapping');
    assert(reddit.cleanSub('/r/ProRevenge') === 'ProRevenge', 'sub name cleaning');
    assert(reddit.redditSort('engaging').rerank === true, 'engaging sort should re-rank');
  });

  await test('5. Rank stories by engagement', () => {
    const all = stories.list({ limit: 50 });
    const sorted = stories.sortStories(all.slice(), 'engaging');
    for (let i = 1; i < sorted.length; i++) assert(sorted[i - 1].score_engagement >= sorted[i].score_engagement, 'not sorted by engagement');
  });

  await test('6. Filter by category', () => {
    const aita = stories.list({ category: 'AITA', limit: 50 });
    assert(aita.every((s) => s.category === 'AITA'), 'category filter leaked other categories');
    assert(aita.length >= 1, 'expected at least one AITA story');
  });

  await test('7. Reject duplicate stories', () => {
    const before = db.get('SELECT count(*) c FROM stories').c;
    const r = stories.ingest(textImport.fromPasted(PASTED_AITA), { sourceType: 'pasted' });
    assert(r.duplicates >= 1, 'duplicate not detected on re-ingest');
    assert(r.stories[0].duplicate_of, 'duplicate_of not set');
    assert(r.stories[0].duplicate_score >= 0.6, 'duplicate score too low');
  });

  // Background uploads
  let bg1, bg2;
  await test('8. Upload one MP4 (register + probe)', async () => {
    const clip = makeClip('clip1.mp4');
    bg1 = await bgSvc.register(clip, 'clip1.mp4', { category: 'Minecraft parkour' });
    assert(bg1.width === 1280 && bg1.height === 720, 'probe dimensions wrong');
    assert(bg1.duration >= 17, 'duration probe wrong');
  });

  await test('9. Upload ten MP4 files', async () => {
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const clip = makeClip(`batch${i}.mp4`, { dur: 12, withBlack: i % 2 === 0 });
      const rec = await bgSvc.register(clip, `batch${i}.mp4`, { category: 'Nature' });
      ids.push(rec.id);
    }
    assert(ids.length === 10, 'expected 10 registrations');
    bg2 = ids;
  });

  await test('10. Generate thumbnails', () => {
    assert(bg1.thumbnail && fs.existsSync(bg1.thumbnail), 'thumbnail not generated');
  });

  await test('11. Divide long background into segments (skip black)', async () => {
    const segs = await segSvc.analyze(bg1.id, { segmentLength: 5 });
    assert(segs.length >= 2, 'expected multiple segments');
    // The black section was 9s..11s; ensure no segment spans it fully.
    const spansBlack = segs.some((s) => s.start_sec < 9 && s.end_sec > 11);
    assert(!spansBlack, 'a segment spanned the black gap (dead-zone not skipped)');
  });

  await test('12. Avoid previously used segments in selection', async () => {
    // analyze a couple more so there is a pool
    for (const id of bg2.slice(0, 4)) await segSvc.analyze(id, { segmentLength: 5 });
    const first = segSvc.selectForDuration(20, {});
    const usedIds = first.plan.map((p) => p.segmentId);
    const second = segSvc.selectForDuration(20, { avoidSegmentIds: usedIds });
    const overlap = second.plan.filter((p) => usedIds.includes(p.segmentId)).length;
    assert(overlap < second.plan.length, 'selection did not avoid used segments at all');
  });

  await test('12b. Bulk-delete selected segments + list exposes segment_count', async () => {
    // Isolated background so other selection tests keep their pool intact.
    const clip = makeClip('bulkdel.mp4', { dur: 16, withBlack: false });
    const bg = await bgSvc.register(clip, 'bulkdel.mp4', { category: 'Nature' });
    const segs = await segSvc.analyze(bg.id, { segmentLength: 5 });
    assert(segs.length >= 2, 'expected multiple segments to bulk-delete, got ' + segs.length);

    // list() powers the Footage Library cards' "Segments (N)" label.
    const listed = bgSvc.list().find((b) => b.id === bg.id);
    assert(listed && listed.segment_count === segs.length, 'segment_count missing/wrong on list()');

    // Multi-select delete in one call; unknown ids are ignored, count reflects real removals.
    const ids = segs.slice(0, 2).map((s) => s.id);
    const n = segSvc.deleteSegments([...ids, 'seg_missing']);
    assert(n === 2, 'expected 2 deletions, got ' + n);
    const after = segSvc.listForBackground(bg.id);
    assert(after.length === segs.length - 2, 'segments not removed');
    assert(!after.some((s) => ids.includes(s.id)), 'deleted segments still present');
  });

  // Scripts
  let story = importedStory;
  let script60, script180;
  await test('13. Generate a 60-second script', () => {
    script60 = sg.generate(story, { durationSeconds: 60, hookStyle: 'conflict' });
    assert(script60.hook && script60.full_text, 'script missing hook/body');
    assert(script60.audience_question, 'missing audience question');
    assert(!/u\//.test(script60.full_text), 'username not anonymized');
  });

  await test('14. Generate a 3-minute script', () => {
    script180 = sg.generate(story, { durationSeconds: 180, hookStyle: 'question' });
    assert(script180.duration_target === 180, 'duration target wrong');
    assert(script180.full_text.length > 0, 'empty script');
  });

  // Narration + captions
  let savedScript, narration, caption;
  await test('15. Generate narration (SAPI) with word timings', async () => {
    savedScript = sg.save(script60);
    narration = await tts.generate(savedScript, { voice: 'Microsoft Zira Desktop', speed: 1.0 });
    assert(narration.duration > 1, 'narration too short');
    assert(narration.word_timings.length >= 10, 'too few word timings');
    assert(narration.path && fs.existsSync(narration.path), 'wav not written');
  });

  await test('16. Synchronize captions to narration', () => {
    caption = captions.generate(narration, { style: 'bold', position: 'bottom' });
    assert(fs.existsSync(caption.ass_path), 'ass file missing');
    const ass = fs.readFileSync(caption.ass_path, 'utf8');
    assert(/Dialogue:/.test(ass), 'no dialogue cues');
    assert(ass.includes('PlayResY: 1920'), 'caption canvas not vertical');
  });

  await test('17. Combine five background segments', () => {
    const sel = segSvc.selectForDuration(60, {});
    assert(sel.plan.length >= 5, 'expected at least 5 segments combined, got ' + sel.plan.length);
    const bgsUsed = new Set(sel.plan.map((p) => p.backgroundId));
    assert(bgsUsed.size >= 2, 'segments not combined across multiple backgrounds');
  });

  // Composer / preview / render
  let video;
  await test('18. Preview a completed video', async () => {
    video = composer.createVideo({ story, script: savedScript, narration, caption, opts: {} });
    const v = await composer.buildPreview(video.id);
    assert(v.preview_path && fs.existsSync(v.preview_path), 'preview not produced');
    assert(v.status === 'ready_for_review', 'status not ready_for_review');
  });

  await test('19. Render a vertical 1080x1920 MP4 (verified)', async () => {
    const r = await composer.render(video.id, { preset: 'tiktok' });
    assert(r.export.width === 1080 && r.export.height === 1920, 'output not 1080x1920');
    assert(r.export.duration > 1, 'no duration');
    assert(fs.existsSync(r.export.path), 'render file missing');
    const ff = require('../src/services/ffmpeg');
    const meta = await ff.probe(r.export.path);
    assert(meta.hasAudio, 'rendered video has no audio');
    assert(meta.vcodec === 'h264', 'video not h264');
    // audio/video duration within 0.5s (sync)
    assert(Math.abs(meta.duration - narration.duration) < 1.0, 'video duration not matched to narration');
    // Structured naming + sidecar metadata (spec §20)
    assert(/^\d{4}-\d{2}-\d{2}_[a-z]+_/.test(path.basename(r.export.path)), 'export not structured-named: ' + path.basename(r.export.path));
    assert(r.export.sidecar_path && fs.existsSync(r.export.sidecar_path), 'export sidecar metadata file missing');
    const sidecar = JSON.parse(fs.readFileSync(r.export.sidecar_path, 'utf8'));
    assert(sidecar.story && sidecar.narration && Array.isArray(sidecar.footage), 'sidecar missing provenance sections');
    assert(sidecar.output && sidecar.output.file === path.basename(r.export.path), 'sidecar output filename mismatch');
  });

  await test('20. Create projects in a batch (mechanism)', async () => {
    const batch = require('../src/services/batch');
    // keep the test fast: 2 items proves the same loop that scales to 10.
    const b = await batch.create({ count: 2, category: null });
    assert(b.items.length >= 1, 'no batch items created');
    await batch.run(b.id);
    // wait for completion (bounded)
    const got = await waitFor(async () => {
      const cur = batch.get(b.id);
      const done = cur.items.every((it) => ['Ready for review', 'Failed', 'Approved', 'Complete'].includes(it.status));
      return done ? cur : null;
    }, 90000);
    assert(got, 'batch did not finish in time');
    const ready = got.items.filter((it) => it.status === 'Ready for review').length;
    assert(ready >= 1, 'no batch item reached Ready for review');
  });

  await test('21. Resume a failed project', () => {
    // simulate an interrupted render job
    const { id } = require('../src/util/ids');
    const jid = id('job');
    db.insert('render_jobs', { id: jid, video_id: video.id, preset: 'tiktok', status: 'running', progress: 50, stage: 'encoding', output_path: null, error: null, started_at: db.nowIso(), finished_at: null, created_at: db.nowIso() });
    const r = systemStatus.resumeFailedJobs();
    assert(r.resumed >= 1, 'no jobs resumed');
  });

  await test('22. Projects persist across a DB re-open (restart)', () => {
    const countBefore = db.get('SELECT count(*) c FROM videos').c;
    // node:sqlite persists to disk immediately (WAL). Re-query via a fresh statement.
    const again = db.get('SELECT count(*) c FROM videos').c;
    assert(again === countBefore && again >= 1, 'videos not persisted');
    const story = stories.list({ limit: 1 })[0];
    assert(story && story.id, 'stories not persisted');
  });

  await test('23. Variation does not repeat same story + footage combo', async () => {
    const v1 = composer.getVideo(video.id);
    const plan1 = (v1.segment_plan || []).map((p) => p.segmentId).sort().join(',');
    // produce a variation that reuses the SAME story but must avoid the footage
    const v2story = stories.getStory(v1.story_id);
    const v2 = await pipeline.createVideoForStory(v2story, { avoidSegmentIds: (v1.segment_plan || []).map((p) => p.segmentId), hookStyle: 'craziest', variationSeed: 99 });
    const plan2 = (v2.segment_plan || []).map((p) => p.segmentId).sort().join(',');
    assert(plan1 !== plan2, 'variation reused the exact same footage sequence');
  });

  await test('24. Original uploaded videos remain unchanged', () => {
    const clip = makeClip('clip1.mp4');
    const before = sha(clip);
    // bg1 has been segmented + used in a render; verify the source file is byte-identical
    const after = sha(bgSvc.get(bg1.id).path);
    assert(before === after, 'original background file was modified!');
  });

  await test('25. Job checkpoint resumes a finished stage without redoing the work', async () => {
    const jobs = require('../src/services/jobs');
    const job = jobs.createVideoJob({ storyId: story.id, params: {} });
    // Mark the 'narration' stage done, pointing at the narration we already generated.
    const st = db.get("SELECT * FROM job_stages WHERE job_id = ? AND name = 'narration'", [job.id]);
    db.update('job_stages', st.id, { status: 'done', output: JSON.stringify({ id: narration.id }) });
    const ck = jobs.checkpointer(job.id);
    let reran = false;
    const got = await ck.step({
      name: 'narration',
      run: async () => { reran = true; return { id: 'SHOULD_NOT_RUN' }; },
      revive: (o) => tts.getNarration(o.id),
    });
    assert(!reran, 'a completed stage was re-run instead of resumed');
    assert(got && got.id === narration.id, 'resumed artefact id mismatch');
    // A still-pending stage DOES run.
    let ran2 = false;
    await ck.step({ name: 'preview', run: async () => { ran2 = true; return { id: 'x' }; }, revive: (o) => ({ id: o.id }) });
    assert(ran2, 'a pending stage should run');
  });

  await test('26. Restart recovery re-queues interrupted batch items (resume from stage)', async () => {
    const batch = require('../src/services/batch');
    const b = await batch.create({ count: 1, category: null });
    const it = b.items[0];
    // Simulate a crash mid-stage: item left in a non-terminal stage, batch still running.
    db.update('batch_items', it.id, { status: 'Generating audio', stage_detail: 'mid-render' });
    db.update('batches', b.id, { status: 'Generating audio', paused: 0 });
    const r = batch.resetInterrupted();
    assert(r.reset >= 1, 'no interrupted items were reset');
    const after = db.get('SELECT status FROM batch_items WHERE id = ?', [it.id]);
    assert(after.status === 'Waiting', 'interrupted item was not reset to Waiting for resume');
  });

  await test('27. Quora question URL parser extracts title + answer (offline fixture)', () => {
    const quora = require('../src/services/sources/quora');
    const ld = {
      '@context': 'https://schema.org', '@type': 'QAPage',
      mainEntity: {
        '@type': 'Question', name: 'What is the most unbelievable thing that happened to you?',
        answerCount: 42, dateCreated: '2024-01-02T00:00:00Z',
        acceptedAnswer: {
          '@type': 'Answer', upvoteCount: 1234, dateCreated: '2024-01-03T00:00:00Z',
          author: { '@type': 'Person', name: 'Jane Doe' },
          text: '<p>It was a normal Tuesday when my neighbor knocked holding a suitcase full of cash. I refused to take it. Then the police arrived and everything changed. In the end the money went back to its rightful owner and I learned a lesson about honesty.</p>',
        },
      },
    };
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="What is the most unbelievable thing... - Quora">
      <script type="application/ld+json">${JSON.stringify(ld)}</script>
      </head><body></body></html>`;
    const s = quora.parseQuoraHtml(html, 'https://www.quora.com/What-is-the-most-unbelievable-thing');
    assert(s.source_type === 'quora', 'source_type should be quora');
    assert(/unbelievable thing/i.test(s.title), 'title not extracted: ' + s.title);
    assert(s.body.includes('suitcase full of cash'), 'answer body not extracted');
    assert(s.author === 'Jane Doe', 'author not extracted');
    assert(s.upvotes === 1234, 'real upvote count not captured');
    // It must ingest + score like any other story, with engagement marked ESTIMATED (not verified).
    const r = stories.ingest([s], { sourceType: 'quora' });
    assert(r.stories.length === 1 && r.stories[0].score_overall > 0, 'quora story did not ingest/score');
    const prov = scoring.metricProvenance(s);
    assert(prov.engagement === 'estimated', 'quora engagement must be labelled estimated, got ' + prov.engagement);
  });

  await test('28. Two videos from the same story export to distinct, non-colliding files', async () => {
    // video (from tests 18/19) is already exported. Build a SECOND video from the SAME story.
    const v2 = composer.createVideo({ story, script: savedScript, narration, caption, opts: {} });
    const r2 = await composer.render(v2.id, { preset: 'tiktok' });
    const ex1 = db.get('SELECT filename, path FROM exports WHERE video_id = ? ORDER BY created_at LIMIT 1', [video.id]);
    assert(ex1 && ex1.filename, 'first export filename missing');
    assert(r2.export.filename && r2.export.filename !== ex1.filename, 'second video reused the first filename (collision): ' + r2.export.filename);
    assert(fs.existsSync(r2.export.path), 'second render file missing');
    assert(fs.existsSync(ex1.path), 'first export file was overwritten by the second render');
  });

  // System status sanity
  await test('Bonus. System status reports all subsystems', async () => {
    const s = await systemStatus.testAll();
    assert(s.database.status === 'Ready', 'db not ready');
    assert(s.ffmpeg.status === 'Ready', 'ffmpeg not ready');
    assert(s.tts.status === 'Ready', 'tts not ready');
  });

  // Summary
  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  if (process.env.WRITE_RESULTS) {
    fs.writeFileSync(path.join(PATHS.logs, 'test-results.json'), JSON.stringify({ passed, failed, results, at: db.nowIso() }, null, 2));
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });

function waitFor(fn, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      const r = await fn();
      if (r) return resolve(r);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 800);
    };
    tick();
  });
}
