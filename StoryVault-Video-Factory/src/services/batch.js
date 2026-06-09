'use strict';
// Batch Studio (spec §17). Runs "find/pick N stories → script → narration →
// footage → captions → preview", STOPPING before export so the user approves each
// video. Items are processed one at a time (one ffmpeg at a time) with diversity
// enforced across the batch so no two videos share story+footage+hook+voice.
const db = require('../db/database');
const { id } = require('../util/ids');
const stories = require('./stories');
const discovery = require('./discovery');
const pipeline = require('./pipeline');
const jobs = require('./jobs');
const variation = require('./variation');
const prefsSvc = require('./preferences');
const log = require('./logger');

const running = new Set();
// Statuses from which an item never needs reprocessing.
const TERMINAL_ITEM = ['Ready for review', 'Approved', 'Complete', 'Failed', 'Cancelled'];

// Pick the stories that will seed the batch.
async function chooseStories(params) {
  if (params.storyIds && params.storyIds.length) {
    return params.storyIds.map((sid) => stories.getStory(sid)).filter(Boolean);
  }
  // Optionally discover fresh stories first (e.g. "find 50, pick best 10").
  if (params.discover && (params.communities?.length || params.feedUrls?.length || params.pastedText)) {
    await discovery.search({
      source: params.source || 'reddit', communities: params.communities || [], feedUrls: params.feedUrls || [],
      pastedText: params.pastedText || '', sort: params.sort || 'engaging', dateRange: params.dateRange || 'month',
      limit: params.findCount || Math.max(50, params.count * 3), category: params.category,
    });
  }
  // Pick the best N from the library, filtered by category if requested.
  const pool = stories.pickBest(params.count || 10, {
    category: params.category || null, status: undefined,
  });
  return pool;
}

async function create(params) {
  const chosen = await chooseStories(params);
  if (!chosen.length) throw new Error('No stories available for the batch. Search/import stories first or pick a category that has stories.');
  const list = chosen.slice(0, params.count || chosen.length);

  const batchId = id('batch');
  db.insert('batches', {
    id: batchId, name: params.name || `Batch ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    params: JSON.stringify(params), status: 'Waiting', total: list.length, completed: 0, failed: 0, paused: 0,
    created_at: db.nowIso(), updated_at: db.nowIso(),
  });
  list.forEach((story, i) => {
    db.insert('batch_items', {
      id: id('bi'), batch_id: batchId, position: i, story_id: story.id, video_id: null,
      status: 'Waiting', stage_detail: null, error: null, created_at: db.nowIso(), updated_at: db.nowIso(),
    });
  });
  log.activity('SYSTEM', `Batch created with ${list.length} stories.`, { level: 'success', refId: batchId });
  return get(batchId);
}

function get(batchId) {
  const batch = db.get('SELECT * FROM batches WHERE id = ?', [batchId]);
  if (!batch) return null;
  const items = db.all('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY position', [batchId]);
  return { ...batch, params: safeParse(batch.params), items };
}
function list() { return db.all('SELECT * FROM batches ORDER BY created_at DESC LIMIT 50').map((b) => ({ ...b, params: safeParse(b.params) })); }
function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

function setItem(itemId, patch) { db.update('batch_items', itemId, { ...patch, updated_at: db.nowIso() }); }
function setBatch(batchId, patch) { db.update('batches', batchId, { ...patch, updated_at: db.nowIso() }); }

// Start (or resume) processing. Fire-and-forget; progress via the activity stream.
async function run(batchId) {
  if (running.has(batchId)) return get(batchId);
  running.add(batchId);
  setBatch(batchId, { status: 'Finding story', paused: 0 });
  const prefs = prefsSvc.get();
  const params = safeParse(db.get('SELECT params FROM batches WHERE id = ?', [batchId]).params);

  (async () => {
    try {
      const usedSegmentIds = [];
      let prevSettings = {};
      const variationOrder = ['New hook', 'Different caption style', 'Different narrator', 'New script angle', 'Different pacing'];
      let vi = 0;

      while (true) {
        const batch = db.get('SELECT * FROM batches WHERE id = ?', [batchId]);
        if (!batch || batch.paused) break;
        const item = db.get("SELECT * FROM batch_items WHERE batch_id = ? AND status IN ('Waiting') ORDER BY position LIMIT 1", [batchId]);
        if (!item) break;

        const story = stories.getStory(item.story_id);
        if (!story) { setItem(item.id, { status: 'Failed', error: 'Story missing' }); continue; }

        // Diversify each item from the previous one (spec §16 + test #23).
        const plan = variation.plan({ ...prevSettings, storyId: story.id, segmentIds: usedSegmentIds }, variationOrder[vi % variationOrder.length], prefs, vi);
        vi++;
        const overrides = {
          batchId,
          durationSeconds: pickDuration(params),
          hookStyle: plan.hookStyle,
          voice: params.voice || plan.voice,
          speed: plan.speed,
          narrationStyle: plan.narrationStyle,
          captionStyle: params.captionStyle || plan.captionStyle,
          backgroundCategory: params.background || prefs.preferredBackground,
          templateId: params.templateId || prefs.templateId || null,
          avoidSegmentIds: usedSegmentIds.slice(),
          variationSeed: plan.variationSeed,
        };

        // Persistent job per item: survives restart + resumes from the last completed
        // stage. Reuse the item's existing job (a retry/resume) or create one.
        let jobId = item.job_id;
        if (jobId) {
          // Respect the dead-letter ceiling across restarts: never reprocess an exhausted job.
          const existing = jobs.get(jobId);
          if (existing && existing.status === 'dead') {
            setItem(item.id, { status: 'Failed', stage_detail: null, error: existing.error || 'Job exhausted all retry attempts.' });
            setBatch(batchId, { failed: countStatus(batchId, ['Failed']) });
            continue;
          }
        } else {
          const job = jobs.createVideoJob({ batchId, storyId: story.id, params: overrides, idempotencyKey: `bi:${item.id}` });
          jobId = job.id;
          setItem(item.id, { job_id: jobId });
        }
        jobs.markRunning(jobId);

        try {
          setItem(item.id, { status: 'Writing script', stage_detail: 'Rewriting story' });
          log.progress('batch', { batchId, itemId: item.id, status: 'Writing script' });
          const video = await pipeline.createVideoForStory(story, overrides, {
            jobId,
            stage: (st, detail) => { setItem(item.id, { status: st, stage_detail: detail }); log.progress('batch', { batchId, itemId: item.id, status: st, detail }); },
          });
          jobs.markDone(jobId, video.id);
          // Record this item's footage so later items avoid it.
          const segs = (composerPlan(video)).map((p) => p.segmentId);
          usedSegmentIds.push(...segs);
          prevSettings = { hookStyle: plan.hookStyle, voice: plan.voice, captionStyle: overrides.captionStyle, narrationStyle: plan.narrationStyle, pacing: plan.pacing, category: story.category, variationSeed: plan.variationSeed };
          setItem(item.id, { status: 'Ready for review', stage_detail: null, video_id: video.id, error: null });
          setBatch(batchId, { completed: countStatus(batchId, ['Ready for review', 'Approved', 'Complete']) });
          log.progress('batch', { batchId, itemId: item.id, status: 'Ready for review', videoId: video.id });
        } catch (e) {
          // Backoff + dead-letter handled by the job. Below the attempt ceiling the item
          // returns to Waiting (the loop retries it, resuming from the failed stage).
          const res = jobs.markFailed(jobId, e.message);
          if (res.dead) {
            setItem(item.id, { status: 'Failed', stage_detail: null, error: e.message, attempts: res.attempts });
            setBatch(batchId, { failed: countStatus(batchId, ['Failed']) });
            log.error('SYSTEM', `Batch item failed permanently after ${res.attempts} attempt(s): ${e.message}`, null, batchId);
          } else {
            setItem(item.id, { status: 'Waiting', stage_detail: `Retry ${res.attempts}/3 queued`, error: `Attempt ${res.attempts} failed: ${e.message}`, attempts: res.attempts });
            log.activity('SYSTEM', `Batch item retry ${res.attempts}/3 (resumes from failed stage): ${e.message}`, { level: 'warning', refId: batchId });
          }
        }
      }
      const stillWaiting = db.get("SELECT count(*) c FROM batch_items WHERE batch_id = ? AND status = 'Waiting'", [batchId]).c;
      setBatch(batchId, { status: stillWaiting ? 'Paused' : 'Ready for review' });
    } finally {
      running.delete(batchId);
    }
  })();

  return get(batchId);
}

function composerPlan(video) { return Array.isArray(video.segment_plan) ? video.segment_plan : safeParse(video.segment_plan); }
function pickDuration(params) {
  if (params.duration) return params.duration;
  if (params.durationMin && params.durationMax) {
    const opts = [30, 45, 60, 90, 120, 180].filter((d) => d >= params.durationMin && d <= params.durationMax);
    return opts.length ? opts[Math.floor(opts.length / 2)] : params.durationMin;
  }
  return 60;
}
function countStatus(batchId, statuses) {
  const qs = statuses.map(() => '?').join(',');
  return db.get(`SELECT count(*) c FROM batch_items WHERE batch_id = ? AND status IN (${qs})`, [batchId, ...statuses]).c;
}

function pause(batchId) { setBatch(batchId, { paused: 1, status: 'Paused' }); return get(batchId); }
function resume(batchId) { return run(batchId); }
function cancelItem(itemId) { setItem(itemId, { status: 'Cancelled', error: 'Cancelled by user' }); return db.get('SELECT * FROM batch_items WHERE id = ?', [itemId]); }
function retryItem(itemId) {
  const it = db.get('SELECT * FROM batch_items WHERE id = ?', [itemId]);
  if (!it) return null;
  // Keep the job: manualRetry clears failed stages so the run resumes from where it
  // stopped (completed stages are reused) rather than restarting from scratch.
  if (it.job_id) jobs.manualRetry(it.job_id);
  setItem(itemId, { status: 'Waiting', error: null, stage_detail: 'Retrying from last completed stage', attempts: 0 });
  run(it.batch_id);
  return get(it.batch_id);
}

// Stop a batch entirely: cancel any non-terminal items and detach the runner.
function stop(batchId) {
  setBatch(batchId, { status: 'Cancelled', paused: 1 });
  const qs = TERMINAL_ITEM.map(() => '?').join(',');
  db.all(`SELECT id FROM batch_items WHERE batch_id = ? AND status NOT IN (${qs})`, [batchId, ...TERMINAL_ITEM])
    .forEach((it) => setItem(it.id, { status: 'Cancelled', stage_detail: null, error: 'Batch stopped by user' }));
  running.delete(batchId);
  log.activity('SYSTEM', 'Batch stopped by user.', { level: 'warning', refId: batchId });
  return get(batchId);
}

// Reset items left mid-stage by a crash/restart back to Waiting. Their job keeps its
// completed stages, so reprocessing resumes from the last completed stage. (Pure: no run.)
function resetInterrupted() {
  const qs = TERMINAL_ITEM.map(() => '?').join(',');
  const stuck = db.all(
    `SELECT * FROM batch_items WHERE status NOT IN (${qs},'Waiting')`, [...TERMINAL_ITEM]
  );
  for (const it of stuck) setItem(it.id, { status: 'Waiting', stage_detail: 'Resuming after restart' });
  return { reset: stuck.length };
}

// Boot-time recovery (spec §17/§22): re-queue interrupted jobs + batches so production
// survives an app restart with no manual repair.
function recoverInterrupted() {
  const { reset } = resetInterrupted();
  jobs.recoverOrphans();
  const batches = db.all(
    `SELECT DISTINCT b.id AS id FROM batches b JOIN batch_items bi ON bi.batch_id = b.id
     WHERE bi.status = 'Waiting' AND COALESCE(b.paused, 0) = 0 AND b.status <> 'Cancelled'`
  );
  let requeued = 0;
  for (const b of batches) { if (!running.has(b.id)) { run(b.id); requeued++; } }
  if (reset || requeued) log.activity('SYSTEM', `Restart recovery: reset ${reset} interrupted item(s), resumed ${requeued} batch(es).`, { level: 'info' });
  return { reset, requeued };
}

module.exports = { create, get, list, run, pause, resume, stop, cancelItem, retryItem, chooseStories, resetInterrupted, recoverInterrupted };
