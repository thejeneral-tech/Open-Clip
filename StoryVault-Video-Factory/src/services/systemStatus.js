'use strict';
// System Status checks (spec §26).
const fs = require('node:fs');
const db = require('../db/database');
const { PATHS, FFMPEG, FFPROBE } = require('../config');
const ff = require('./ffmpeg');
const reddit = require('./sources/reddit');

async function checkFfmpeg() {
  try { await ff.ffmpeg(['-version']); return ok('FFmpeg available'); }
  catch (e) { return bad(`FFmpeg not found (${e.message})`); }
}
async function checkFfprobe() {
  try { await ff.ffprobe(['-version']); return ok('FFprobe available'); }
  catch (e) { return bad(`FFprobe not found (${e.message})`); }
}
function checkDatabase() {
  try { const n = db.get('SELECT count(*) c FROM stories').c; return ok(`Database OK (${n} stories)`); }
  catch (e) { return { status: 'Error', detail: e.message }; }
}
async function checkTts() {
  try {
    const tts = require('./tts');
    const voices = await tts.listVoices();
    return voices.length ? ok(`TTS ready (${voices.length} voice${voices.length > 1 ? 's' : ''})`) : { status: 'Missing', detail: 'No TTS voices found' };
  } catch (e) { return bad(`TTS error: ${e.message}`); }
}
async function checkAiProvider() {
  try {
    const llmAdmin = require('./llmAdmin');
    const s = await llmAdmin.getStatus();
    if (s.reachable) {
      const n = s.models ? s.models.length : 0;
      return ok(`Local AI online — ${s.backend}, ${n} model${n === 1 ? '' : 's'} (active: ${s.model || 'none'})`);
    }
    return { status: 'Limited', detail: 'Local AI offline — using the built-in heuristic rewriter (start Ollama or llama.cpp to enable AI)' };
  } catch (e) {
    return { status: 'Ready', detail: 'Using built-in heuristic rewriter (no external AI required)' };
  }
}
async function checkReddit() {
  if (reddit.hasOAuth()) {
    try { await reddit.fetchCommunity('AmItheAsshole', { limit: 1 }); return ok('Reddit OAuth connected'); }
    catch (e) { return { status: 'Error', detail: e.message }; }
  }
  // Anonymous mode is a real, working (if rate-limited) state — NOT a perpetual spinner.
  return { status: 'Limited', detail: 'Anonymous mode — set REDDIT_CLIENT_ID/SECRET for reliable access, or paste URLs/text' };
}
function checkStorage() {
  try {
    const test = require('node:path').join(PATHS.tmp, '.write_test');
    fs.writeFileSync(test, 'ok'); fs.unlinkSync(test);
    return ok(`Storage writable (${PATHS.data})`);
  } catch (e) { return bad(`Storage not writable: ${e.message}`); }
}
function checkRenderWorker() {
  const stuck = db.get("SELECT count(*) c FROM render_jobs WHERE status = 'running'").c;
  return { status: 'Ready', detail: stuck ? `${stuck} render(s) in progress` : 'Idle, ready' };
}
function checkBackgroundLibrary() {
  const n = db.get('SELECT count(*) c FROM backgrounds WHERE archived = 0').c;
  const segs = db.get('SELECT count(*) c FROM segments WHERE usable = 1').c;
  if (!n) return { status: 'Missing', detail: 'No background footage uploaded yet' };
  return ok(`${n} background${n > 1 ? 's' : ''}, ${segs} usable segments`);
}

function ok(detail) { return { status: 'Ready', detail }; }
function bad(detail) { return { status: 'Offline', detail }; }

async function testAll() {
  const [ffmpeg, ffprobe, tts, redditC, ai] = await Promise.all([checkFfmpeg(), checkFfprobe(), checkTts(), checkReddit(), checkAiProvider()]);
  return {
    database: checkDatabase(),
    ffmpeg, ffprobe, tts,
    aiProvider: ai,
    reddit: redditC,
    storage: checkStorage(),
    renderWorker: checkRenderWorker(),
    backgroundLibrary: checkBackgroundLibrary(),
    at: db.nowIso(),
  };
}

// Video ids with an in-flight resumed render — prevents starting a second concurrent
// render of the same video if resumeFailedJobs() is called more than once.
const rendering = new Set();

function resumeFailedJobs() {
  const composer = require('./composer');
  const log = require('./logger');
  // First clear any videos orphaned mid-render; the resumed renders below re-mark them.
  db.run("UPDATE videos SET status = 'ready_for_review' WHERE status = 'rendering'");
  // Re-queue render jobs that were interrupted (left 'running'), one per video.
  const stuck = db.all("SELECT * FROM render_jobs WHERE status = 'running'");
  let resumed = 0;
  const seen = new Set();
  for (const j of stuck) {
    if (seen.has(j.video_id) || rendering.has(j.video_id)) {
      // A render for this video is already (re)queued — supersede this duplicate job.
      db.update('render_jobs', j.id, { status: 'failed', error: 'Superseded by another resume for the same video.', finished_at: db.nowIso() });
      continue;
    }
    seen.add(j.video_id);
    db.update('render_jobs', j.id, { status: 'queued' });
    rendering.add(j.video_id);
    composer.render(j.video_id, { preset: j.preset })
      .then(() => { rendering.delete(j.video_id); })
      .catch((e) => {
        rendering.delete(j.video_id);
        log.error('RENDER', `Resumed render failed for ${j.video_id}: ${e.message}`, null, j.video_id);
        try { db.update('render_jobs', j.id, { status: 'failed', error: e.message, finished_at: db.nowIso() }); } catch { /* job row gone */ }
      });
    resumed++;
  }
  return { resumed };
}

module.exports = { testAll, resumeFailedJobs, checkFfmpeg, checkFfprobe, checkDatabase };
