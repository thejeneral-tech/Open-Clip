'use strict';
// Video Composer, Review Queue, Batch Studio, Exports, Voices (spec §13/§17/§18/§19).
const express = require('express');
const router = express.Router();
const path = require('node:path');
const { wrap, withMedia } = require('./helpers');
const db = require('../db/database');
const pipeline = require('../services/pipeline');
const composer = require('../services/composer');
const review = require('../services/review');
const batch = require('../services/batch');
const variation = require('../services/variation');
const tts = require('../services/tts');
const stories = require('../services/stories');

// --- Voices (spec §14) ---
router.get('/voices', wrap(async (req, res) => res.json(await tts.listVoices())));

// --- Create a single video from a story (Composer / "✦ Create Video") ---
router.post('/videos', wrap(async (req, res) => {
  const { storyId, ...settings } = req.body || {};
  if (!storyId) throw new Error('storyId is required.');
  const video = await pipeline.createVideoForStory(storyId, settings);
  res.json(withMedia(review.bundle(video.id)));
}));

router.get('/videos', wrap(async (req, res) => {
  let sql = 'SELECT * FROM videos'; const p = [];
  if (req.query.status) { sql += ' WHERE status = ?'; p.push(req.query.status); }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  res.json(withMedia(db.all(sql, p).map(composer.hydrate)));
}));

router.get('/videos/:id', wrap(async (req, res) => {
  const b = review.bundle(req.params.id);
  if (!b) throw new Error('Video not found.');
  res.json(withMedia(b));
}));

router.post('/videos/:id/preview', wrap(async (req, res) => res.json(withMedia(await composer.buildPreview(req.params.id)))));

router.post('/videos/:id/render', wrap(async (req, res) => {
  const result = await composer.render(req.params.id, { preset: req.body?.preset || 'tiktok' });
  res.json(withMedia(result));
}));

// Variation Engine (spec §16): make a new, deliberately-different video.
router.post('/videos/:id/variation', wrap(async (req, res) => {
  const v = composer.getVideo(req.params.id);
  if (!v) throw new Error('Video not found.');
  const option = req.body?.option || 'Completely new variation';
  const prev = { hookStyle: req.body?.hookStyle, voice: v.voice, captionStyle: v.caption_style, storyId: v.story_id, category: req.body?.category, segmentIds: (v.segment_plan || []).map((p) => p.segmentId), variationSeed: req.body?.variationSeed || 0 };
  const plan = variation.plan(prev, option, require('../services/preferences').get(), req.body?.seed || 1);

  let storyId = v.story_id;
  if (plan.newStory) {
    const pool = stories.pickBest(1, { category: plan.sameCategory ? prev.category || stories.getStory(v.story_id)?.category : null });
    if (pool[0]) storyId = pool[0].id;
  }
  const video = await pipeline.createVideoForStory(storyId, {
    // Keep the original's Fish/cloned preset when it had one (the plan's voice rotation only
    // knows SAPI names); otherwise use the planned SAPI voice as before.
    voicePresetId: v.voice_preset_id || undefined,
    hookStyle: plan.hookStyle, voice: v.voice_preset_id ? undefined : plan.voice, speed: plan.speed, narrationStyle: plan.narrationStyle,
    captionStyle: plan.captionStyle, variationSeed: plan.variationSeed, avoidSegmentIds: prev.segmentIds,
  });
  res.json(withMedia(review.bundle(video.id)));
}));

// --- Review Queue (spec §18) ---
router.get('/review/queue', wrap(async (req, res) => res.json(withMedia(review.queue()))));
router.post('/review/:id/approve', wrap(async (req, res) => res.json(withMedia(review.approve(req.params.id, { preset: req.body?.preset || 'tiktok' })))));
router.post('/review/:id/reject', wrap(async (req, res) => res.json(withMedia(review.reject(req.params.id, req.body?.reason)))));
router.post('/review/:id/regenerate', wrap(async (req, res) => res.json(withMedia(await review.regenerate(req.params.id, req.body?.component, req.body || {})))));
router.post('/review/:id/edit-script', wrap(async (req, res) => res.json(withMedia(await review.regenerate(req.params.id, 'script', { fullText: req.body?.fullText })))));

// --- Batch Studio (spec §17) ---
router.post('/batch', wrap(async (req, res) => res.json(await batch.create(req.body || {}))));
router.get('/batch', wrap(async (req, res) => res.json(batch.list())));
router.get('/batch/:id', wrap(async (req, res) => {
  const b = batch.get(req.params.id);
  if (!b) throw new Error('Batch not found.');
  res.json(withMedia(b));
}));
router.post('/batch/:id/run', wrap(async (req, res) => res.json(await batch.run(req.params.id))));
router.post('/batch/:id/pause', wrap(async (req, res) => res.json(batch.pause(req.params.id))));
router.post('/batch/:id/resume', wrap(async (req, res) => res.json(await batch.resume(req.params.id))));
router.post('/batch/:id/stop', wrap(async (req, res) => res.json(batch.stop(req.params.id))));
router.post('/batch/items/:itemId/cancel', wrap(async (req, res) => res.json(batch.cancelItem(req.params.itemId))));
router.post('/batch/items/:itemId/retry', wrap(async (req, res) => res.json(await batch.retryItem(req.params.itemId))));

// --- Exports (spec §19/§20) --- (trash view via ?trash=1)
router.get('/exports', wrap(async (req, res) => {
  const where = req.query.trash ? 'WHERE e.deleted_at IS NOT NULL' : 'WHERE e.deleted_at IS NULL';
  const rows = db.all(`SELECT e.*, v.title FROM exports e LEFT JOIN videos v ON v.id = e.video_id ${where} ORDER BY e.created_at DESC LIMIT 200`);
  res.json(withMedia(rows));
}));
router.get('/exports/:id/download', wrap(async (req, res) => {
  const ex = db.get('SELECT * FROM exports WHERE id = ?', [req.params.id]);
  if (!ex || !ex.path) throw new Error('Export not found.');
  res.download(ex.path, ex.filename || path.basename(ex.path));
}));
// Delete → trash by default; bulk delete/restore/purge (purge removes mp4 + sidecar).
router.delete('/exports/:id', wrap(async (req, res) => {
  const trash = require('../services/trash');
  if (req.query.permanent) return res.json({ ok: !!trash.purge('exports', [req.params.id], ['path', 'sidecar_path']) });
  return res.json({ ok: !!trash.softDelete('exports', [req.params.id]) });
}));
router.post('/exports/bulk', wrap(async (req, res) => {
  const { ids = [], action } = req.body || {};
  const trash = require('../services/trash');
  if (action === 'delete') return res.json({ ok: true, count: trash.softDelete('exports', ids) });
  if (action === 'restore') return res.json({ ok: true, count: trash.restore('exports', ids) });
  if (action === 'purge') return res.json({ ok: true, count: trash.purge('exports', ids, ['path', 'sidecar_path']) });
  if (action === 'empty') return res.json({ ok: true, count: trash.emptyTrash('exports', ['path', 'sidecar_path']) });
  throw new Error('Unknown action.');
}));

module.exports = router;
