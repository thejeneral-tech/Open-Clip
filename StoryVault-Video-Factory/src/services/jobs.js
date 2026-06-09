'use strict';
// Persistent, stage-checkpointed jobs (spec: HIGH-VOLUME ARCHITECTURE / Phase 5).
//
// A job owns an ordered list of job_stages. Each stage records the id of the artefact
// it produced (script/narration/caption/video). A RESUMED job therefore RELOADS finished
// work via that id instead of redoing it — so a job picks up from the last completed
// stage. Jobs + stages live in SQLite, so they survive an app restart.
//
// Borrowed from Odysseus' DB-backed, restart-safe job pattern (core/bg_jobs.py): the
// database is the single source of truth for job state, recovered on boot.
const db = require('../db/database');
const { id } = require('../util/ids');
const log = require('./logger');

// Ordered pipeline stages for a "video" job. `name` is a STABLE key — do not rename.
const VIDEO_STAGES = [
  { name: 'script', label: 'Writing script' },
  { name: 'narration', label: 'Generating audio' },
  { name: 'captions', label: 'Creating captions' },
  { name: 'footage', label: 'Selecting footage' },
  { name: 'intro', label: 'Creating intro' },
  { name: 'preview', label: 'Building preview' },
];

const TERMINAL = ['done', 'dead', 'cancelled'];

function nowIso() { return db.nowIso(); }
function get(jobId) { return db.get('SELECT * FROM jobs WHERE id = ?', [jobId]); }
function stagesOf(jobId) { return db.all('SELECT * FROM job_stages WHERE job_id = ? ORDER BY ordinal', [jobId]); }
function setJob(jobId, patch) { db.update('jobs', jobId, { ...patch, updated_at: nowIso() }); }
function setStage(stageId, patch) { db.update('job_stages', stageId, { ...patch, updated_at: nowIso() }); }

// Create a video job + its ordered stages. Idempotent on idempotency_key: an existing
// job with the same key is returned untouched (re-enqueues never duplicate work).
function createVideoJob({ batchId = null, storyId, params = {}, idempotencyKey = null } = {}) {
  if (idempotencyKey) {
    const existing = db.get('SELECT * FROM jobs WHERE idempotency_key = ?', [idempotencyKey]);
    if (existing) return existing;
  }
  const jobId = id('job');
  db.insert('jobs', {
    id: jobId, kind: 'video', batch_id: batchId, story_id: storyId, video_id: null,
    status: 'queued', stage: null, priority: 100, attempts: 0, max_attempts: 3,
    params: JSON.stringify(params || {}), state: '{}', idempotency_key: idempotencyKey,
    created_at: nowIso(), updated_at: nowIso(),
  });
  VIDEO_STAGES.forEach((st, i) => db.insert('job_stages', {
    id: id('jst'), job_id: jobId, name: st.name, ordinal: i, status: 'pending',
    attempts: 0, created_at: nowIso(), updated_at: nowIso(),
  }));
  return get(jobId);
}

function markRunning(jobId, owner) {
  const j = get(jobId);
  if (!j) return;
  setJob(jobId, { status: 'running', lease_owner: owner || String(process.pid), started_at: j.started_at || nowIso(), error: null });
}
function markDone(jobId, videoId) {
  const j = get(jobId);
  setJob(jobId, { status: 'done', video_id: videoId || (j && j.video_id) || null, finished_at: nowIso(), error: null, lease_owner: null });
}
// Exponential backoff with a dead-letter ceiling at max_attempts.
function markFailed(jobId, errMsg) {
  const j = get(jobId);
  const attempts = (j.attempts || 0) + 1;
  const dead = attempts >= (j.max_attempts || 3);
  const backoffSec = Math.min(600, 30 * Math.pow(2, attempts - 1));
  setJob(jobId, {
    status: dead ? 'dead' : 'failed', attempts, error: String(errMsg).slice(0, 500),
    lease_owner: null, next_run_at: dead ? null : new Date(Date.now() + backoffSec * 1000).toISOString(),
  });
  return { dead, attempts, backoffSec };
}
// Operator-initiated retry: clear failed stages + give the job a fresh attempt budget.
function manualRetry(jobId) {
  db.all("SELECT * FROM job_stages WHERE job_id = ? AND status = 'failed'", [jobId])
    .forEach((s) => setStage(s.id, { status: 'pending', error: null }));
  setJob(jobId, { status: 'queued', attempts: 0, error: null, next_run_at: null });
}

// Checkpointer: run a stage's work once, then reuse its artefact on every later resume.
function checkpointer(jobId) {
  return {
    // step({ name, run, idOf?, revive }) → artefact.
    //   • if the stage already finished, skip run() and reload via revive(savedOutput)
    //   • otherwise run(), persist the artefact id, and return it
    async step({ name, run, idOf = (x) => (x && x.id), revive }) {
      const row = db.get('SELECT * FROM job_stages WHERE job_id = ? AND name = ?', [jobId, name]);
      if (row && row.status === 'done' && row.output && revive) {
        let out = null; try { out = JSON.parse(row.output); } catch { /* fall through to re-run */ }
        if (out) {
          const revived = revive(out);
          if (revived) { setJob(jobId, { stage: name }); return revived; }
        }
      }
      if (row) setStage(row.id, { status: 'running', attempts: (row.attempts || 0) + 1, started_at: nowIso(), error: null });
      setJob(jobId, { stage: name });
      try {
        const artefact = await run();
        if (row) setStage(row.id, { status: 'done', output: JSON.stringify({ id: idOf(artefact) }), finished_at: nowIso() });
        return artefact;
      } catch (e) {
        if (row) setStage(row.id, { status: 'failed', error: String(e.message).slice(0, 500) });
        throw e;
      }
    },
  };
}
// Used when a caller opts out of checkpointing (e.g. single-shot create, tests).
const nullCheckpointer = { step: ({ run }) => run() };

// Boot-time recovery: a job left 'running' means the process died mid-flight. Reset its
// running stage(s) to pending and re-queue it; completed stages are preserved so it
// resumes from where it stopped.
function recoverOrphans() {
  const orphans = db.all("SELECT * FROM jobs WHERE status = 'running'");
  for (const j of orphans) {
    db.all("SELECT * FROM job_stages WHERE job_id = ? AND status = 'running'", [j.id])
      .forEach((s) => setStage(s.id, { status: 'pending', error: 'Interrupted by restart' }));
    setJob(j.id, { status: 'queued', lease_owner: null });
  }
  if (orphans.length) log.activity('SYSTEM', `Recovered ${orphans.length} interrupted job(s); each will resume from its last completed stage.`, { level: 'info' });
  return { recovered: orphans.length };
}

// Lightweight stats for the Job Monitor / Command Center.
function stats() {
  const rows = db.all('SELECT status, count(*) c FROM jobs GROUP BY status');
  const by = {};
  for (const r of rows) by[r.status] = r.c;
  return {
    queued: by.queued || 0, running: by.running || 0, done: by.done || 0,
    failed: by.failed || 0, dead: by.dead || 0, cancelled: by.cancelled || 0,
    total: rows.reduce((a, r) => a + r.c, 0),
  };
}

module.exports = {
  VIDEO_STAGES, TERMINAL, createVideoJob, get, stagesOf, checkpointer, nullCheckpointer,
  markRunning, markDone, markFailed, manualRetry, recoverOrphans, stats,
};
