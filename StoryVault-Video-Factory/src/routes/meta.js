'use strict';
// Meta, preferences, system status, dashboard, activity log + SSE stream.
const express = require('express');
const router = express.Router();
const { wrap, withMedia } = require('./helpers');
const constants = require('../constants');
const prefsSvc = require('../services/preferences');
const sys = require('../services/systemStatus');
const dashboard = require('../services/dashboard');
const tts = require('../services/tts');
const templates = require('../services/templates');
const accounts = require('../services/accounts');
const log = require('../services/logger');
const db = require('../db/database');

// --- Reference data the UI needs to render its controls (spec §3/§4/§8/§15) ---
router.get('/meta', wrap(async (req, res) => {
  res.json({
    categories: constants.CATEGORIES,
    customCategories: db.all("SELECT name FROM categories WHERE custom = 1").map((c) => c.name),
    sources: constants.SOURCE_TYPES,
    sortOptions: constants.SORT_OPTIONS,
    suggestedCommunities: constants.SUGGESTED_COMMUNITIES,
    endingPreferences: constants.ENDING_PREFERENCES,
    hookStyles: constants.HOOK_STYLES,
    narrationStyles: constants.NARRATION_STYLES,
    captionStyles: constants.CAPTION_STYLES,
    scriptDurations: constants.SCRIPT_DURATIONS,
    backgroundTypes: constants.BACKGROUND_TYPES,
    segmentLengths: constants.SEGMENT_LENGTHS,
    segmentTags: constants.SEGMENT_TAGS,
    variationOptions: constants.VARIATION_OPTIONS,
    batchStatuses: constants.BATCH_STATUSES,
    platforms: constants.PLATFORMS,
    gameplayCategories: constants.BACKGROUND_TYPES,
    voices: await tts.listVoices(),
    voicePresets: require('../services/voices').listPresets().map((p) => ({ id: p.id, name: p.name, engine: p.engine, icon: p.icon, is_default: p.is_default })),
    templates: templates.list().map((t) => ({ id: t.id, name: t.name, builtin: t.builtin, isDefault: t.isDefault })),
  });
}));

// --- Version (settings About tab) ---
router.get('/version', wrap(async (req, res) => {
  let version = '1.0.0';
  try { version = require('../../package.json').version || version; } catch { /* ignore */ }
  res.json({ version, name: 'StoryVault Video Factory' });
}));

// --- Templates (REFERENCE-BASED TEMPLATE SYSTEM) ---
router.get('/templates', wrap(async (req, res) => res.json(templates.list(req.query))));
router.get('/templates/:id', wrap(async (req, res) => {
  const t = templates.get(req.params.id);
  if (!t) throw new Error('Template not found.');
  res.json(t);
}));
router.post('/templates', wrap(async (req, res) => res.json(templates.create(req.body?.name, req.body?.data || {}))));
router.put('/templates/:id', wrap(async (req, res) => res.json(templates.update(req.params.id, req.body || {}))));
router.post('/templates/:id/default', wrap(async (req, res) => res.json(templates.setDefault(req.params.id))));
router.post('/templates/:id/duplicate', wrap(async (req, res) => res.json(templates.duplicate(req.params.id, req.body?.name))));
router.post('/templates/bulk', wrap(async (req, res) => {
  const { ids = [], action } = req.body || {};
  const trash = require('../services/trash');
  if (action === 'delete') { let n = 0; ids.forEach((id) => { try { templates.softRemove(id); n++; } catch { /* skip missing */ } }); return res.json({ ok: true, count: n }); }
  if (action === 'restore') return res.json({ ok: true, count: trash.restore('templates', ids) });
  if (action === 'purge') return res.json({ ok: true, count: trash.purge('templates', ids) });
  throw new Error('Unknown action.');
}));
// Delete → trash (any template, built-ins included); ?permanent=1 hard-removes.
router.delete('/templates/:id', wrap(async (req, res) => {
  if (req.query.permanent) return res.json(templates.remove(req.params.id));
  return res.json(templates.softRemove(req.params.id));
}));

// --- Accounts (Reddit/Quora) — secrets encrypted at rest, never returned ---
router.get('/accounts', wrap(async (req, res) => res.json(accounts.list())));
router.post('/accounts/reddit/connect', wrap(async (req, res) => res.json(accounts.connectReddit(req.body || {}))));
router.post('/accounts/reddit/test', wrap(async (req, res) => res.json(await accounts.testReddit())));
router.post('/accounts/quora/connect', wrap(async (req, res) => res.json(accounts.connectQuoraManual())));
router.post('/accounts/:platform/disconnect', wrap(async (req, res) => res.json(accounts.disconnect(req.params.platform))));

router.post('/categories', wrap(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) throw new Error('Category name required.');
  const id = 'cat_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  db.run('INSERT OR IGNORE INTO categories (id, name, custom, created_at) VALUES (?, ?, 1, ?)', [id, name, db.nowIso()]);
  res.json({ ok: true, name });
}));

// --- Preferences (spec §4) ---
router.get('/preferences', (req, res) => res.json(prefsSvc.get()));
router.put('/preferences', (req, res) => res.json(prefsSvc.update(req.body || {})));

// --- System status (spec §26) ---
router.get('/system/status', wrap(async (req, res) => res.json(await sys.testAll())));
router.post('/system/test', wrap(async (req, res) => res.json(await sys.testAll())));
router.post('/system/resume-failed', wrap(async (req, res) => res.json(sys.resumeFailedJobs())));
router.post('/system/repair', wrap(async (req, res) => res.json(await sys.repair())));
router.get('/system/logs', (req, res) => res.json(log.recent(Number(req.query.limit) || 300)));

// --- Dashboard (spec §24) ---
router.get('/dashboard', wrap(async (req, res) => res.json(withMedia(dashboard.summary()))));

// --- Activity log + live SSE stream (spec §23) ---
router.get('/activity', (req, res) => res.json(log.recent(Number(req.query.limit) || 200)));

router.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write(`event: hello\ndata: {"ok":true}\n\n`);
  const onActivity = (row) => res.write(`event: activity\ndata: ${JSON.stringify(row)}\n\n`);
  const onProgress = (p) => res.write(`event: progress\ndata: ${JSON.stringify(p)}\n\n`);
  log.bus.on('activity', onActivity);
  log.bus.on('progress', onProgress);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); log.bus.off('activity', onActivity); log.bus.off('progress', onProgress); });
});

module.exports = router;
