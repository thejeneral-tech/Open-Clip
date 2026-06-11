'use strict';
// System Status checks (spec §26).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const db = require('../db/database');
const { PATHS, FFMPEG, FFPROBE, ROOT, ensureDirs } = require('../config');
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

// ── One-click Repair (spec §26) ───────────────────────────────────────────────
// Idempotent, non-destructive recovery for the whole app. Each step is safe to
// run repeatedly: it recreates the data folder layout, reinstalls only missing
// npm packages, re-applies DB migrations + verifies integrity, requeues
// interrupted renders, and reports on external tools (FFmpeg/FFprobe/Fish Speech)
// that can't be auto-installed. Returns a per-step report the UI renders.
const REQUIRED_DEPS = (() => {
  try { return Object.keys(require('../../package.json').dependencies || {}); }
  catch { return []; }
})();

function depInstalled(name) {
  return fs.existsSync(path.join(ROOT, 'node_modules', name, 'package.json'));
}

// Reinstall declared dependencies. `shell: true` lets Windows resolve npm.cmd;
// the command is fixed (no user input), so there is nothing to inject.
function npmInstall() {
  return new Promise((resolve) => {
    let out = '';
    let ps;
    try { ps = spawn('npm install --no-audit --no-fund', { cwd: ROOT, shell: true, windowsHide: true }); }
    catch (e) { return resolve({ code: -1, out: e.message }); }
    ps.stdout && ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.stderr && ps.stderr.on('data', (d) => { out += d.toString(); });
    ps.on('error', (e) => resolve({ code: -1, out: out + e.message }));
    ps.on('close', (code) => resolve({ code, out }));
  });
}

async function repair() {
  const steps = [];
  const add = (name, fixed, ok, detail) => steps.push({ name, fixed, ok, detail });

  // 1) Data folder layout (Storage) — always safe to (re)create.
  try { ensureDirs(); add('Directories', true, true, `Data folder layout verified at ${PATHS.data}`); }
  catch (e) { add('Directories', false, false, `Could not create data folders: ${e.message}`); }

  // 2) npm dependencies — reinstall only when something is actually missing.
  const missing = REQUIRED_DEPS.filter((d) => !depInstalled(d));
  if (!REQUIRED_DEPS.length) {
    add('Dependencies', false, true, 'No npm dependencies declared.');
  } else if (!missing.length) {
    add('Dependencies', false, true, `All packages present (${REQUIRED_DEPS.join(', ')}).`);
  } else {
    const r = await npmInstall();
    const still = REQUIRED_DEPS.filter((d) => !depInstalled(d));
    if (!still.length) add('Dependencies', true, true, `Installed missing package(s): ${missing.join(', ')}.`);
    else add('Dependencies', true, false, `npm install exited ${r.code}; still missing: ${still.join(', ')}. ${(r.out || '').trim().split('\n').slice(-2).join(' ')}`);
  }

  // 3) Database — any query forces schema + migrations + default seed; then verify.
  try {
    const n = db.get('SELECT count(*) c FROM stories').c;
    const chk = db.get('PRAGMA integrity_check');
    const integrity = chk && (chk.integrity_check || Object.values(chk)[0]);
    const okDb = integrity === 'ok';
    add('Database', true, okDb, okDb ? `Schema + migrations applied (${n} stories).` : `Integrity check returned: ${integrity}`);
  } catch (e) { add('Database', false, false, `Database error: ${e.message}`); }

  // 4) Interrupted renders — requeue so they finish instead of hanging at 'running'.
  try { const r = resumeFailedJobs(); add('Render jobs', true, true, r.resumed ? `Requeued ${r.resumed} interrupted render(s).` : 'No interrupted renders.'); }
  catch (e) { add('Render jobs', false, false, `Could not requeue renders: ${e.message}`); }

  // 5) FFmpeg / FFprobe — can't be auto-installed; report resolution + how to fix.
  const [ffm, ffp] = await Promise.all([checkFfmpeg(), checkFfprobe()]);
  const binHint = `set FFMPEG_PATH/FFPROBE_PATH or place the binaries in ${path.join(ROOT, 'bin')}`;
  add('FFmpeg', false, ffm.status === 'Ready', ffm.status === 'Ready' ? `${ffm.detail} (${FFMPEG})` : `${ffm.detail} — ${binHint}.`);
  add('FFprobe', false, ffp.status === 'Ready', ffp.status === 'Ready' ? `${ffp.detail} (${FFPROBE})` : `${ffp.detail} — ${binHint}.`);

  // 6) Fish Speech — optional (SAPI fallback). Report only; the multi-GB model
  //    download stays an explicit action on Voice Lab → Setup → Repair.
  try {
    const fishspeech = require('./fishspeech');
    const s = await fishspeech.status();
    add('Fish Speech (optional)', false, true, s.engineReady ? 'Engine ready.' : 'Not configured — using SAPI fallback. Install via Voice Lab → Setup → Repair.');
  } catch (e) { add('Fish Speech (optional)', false, true, `Optional — not configured (${e.message}).`); }

  const fixed = steps.filter((s) => s.fixed).length;
  const failures = steps.filter((s) => !s.ok).map((s) => s.name);
  return { ok: failures.length === 0, fixed, failures, steps, at: db.nowIso() };
}

module.exports = { testAll, repair, resumeFailedJobs, checkFfmpeg, checkFfprobe, checkDatabase };
