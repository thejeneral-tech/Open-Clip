'use strict';
// Story Discovery, Story Library, and Script generation routes (spec §3/§6/§8).
const express = require('express');
const router = express.Router();
const { wrap, withMedia } = require('./helpers');
const discovery = require('../services/discovery');
const stories = require('../services/stories');
const sg = require('../services/scriptGenerator');
const analysis = require('../services/analysis');
const constants = require('../constants');
const db = require('../db/database');

// --- Discovery (spec §3 buttons) ---
router.post('/discovery/search', wrap(async (req, res) => res.json(await discovery.search(req.body || {}))));

router.post('/discovery/trending', wrap(async (req, res) => {
  const communities = (req.body && req.body.communities) || constants.SUGGESTED_COMMUNITIES.slice(0, 4);
  res.json(await discovery.search({ source: 'reddit', communities, sort: 'engaging', dateRange: 'day', limit: req.body?.limit || 25, ...req.body }));
}));

router.post('/discovery/related/:storyId', wrap(async (req, res) => {
  const base = stories.getStory(req.params.storyId);
  if (!base) throw new Error('Story not found.');
  // "Find something related" = same category from the library, ranked.
  const related = stories.list({ category: base.category, limit: 50 }).filter((s) => s.id !== base.id);
  res.json({ stories: related, basedOn: base.title, category: base.category });
}));

router.post('/discovery/import-urls', wrap(async (req, res) => {
  const urls = (req.body.urls || []).filter(Boolean);
  if (!urls.length) throw new Error('Provide one or more URLs to import.');
  res.json(await discovery.search({ source: 'multiple', urls: urls.filter((u) => /reddit\.com/i.test(u)), feedUrls: urls.filter((u) => /\.(rss|xml)$|\/feed/i.test(u)), sort: 'popular', limit: urls.length }));
}));

router.post('/discovery/save/:searchId', wrap(async (req, res) => res.json(discovery.saveSearch(req.params.searchId, req.body?.name))));
router.get('/discovery/searches', wrap(async (req, res) => res.json(discovery.listSearches())));

// --- Story library (spec §6) ---
router.get('/stories', wrap(async (req, res) => res.json(stories.list(req.query))));
router.get('/stories/:id', wrap(async (req, res) => {
  const s = stories.getStory(req.params.id);
  if (!s) throw new Error('Story not found.');
  res.json(s);
}));

router.post('/stories/:id/status', wrap(async (req, res) => {
  const valid = ['new', 'saved', 'approved', 'excluded', 'used'];
  const status = req.body.status;
  if (!valid.includes(status)) throw new Error('Invalid status.');
  res.json(stories.setStatus(req.params.id, status));
}));

// Re-run analysis on demand (spec §7 "🧠 Analyze").
router.post('/stories/:id/analyze', wrap(async (req, res) => {
  const s = stories.getStory(req.params.id);
  if (!s) throw new Error('Story not found.');
  const a = analysis.analyze(s);
  db.update('stories', s.id, { analysis: JSON.stringify(a) });
  res.json(a);
}));

// Bulk actions (spec §6).
router.post('/stories/bulk', wrap(async (req, res) => {
  const { ids = [], action } = req.body;
  const map = { approve: 'approved', save: 'saved', exclude: 'excluded' };
  if (action === 'export') {
    const rows = ids.map((id) => stories.getStory(id)).filter(Boolean);
    return res.json({ csv: toCsv(rows) });
  }
  if (!map[action]) throw new Error('Unknown bulk action.');
  ids.forEach((id) => stories.setStatus(id, map[action]));
  res.json({ ok: true, count: ids.length });
}));

router.get('/stories/export/csv', wrap(async (req, res) => {
  const rows = stories.list({ ...req.query, limit: 1000 });
  res.set('Content-Type', 'text/csv').set('Content-Disposition', 'attachment; filename="stories.csv"').send(toCsv(rows));
}));

// --- Scripts (spec §8) ---
router.post('/stories/:id/script', wrap(async (req, res) => {
  const s = stories.getStory(req.params.id);
  if (!s) throw new Error('Story not found.');
  res.json(sg.generateAndSave(s, req.body || {}));
}));
router.get('/stories/:id/scripts', wrap(async (req, res) => res.json(sg.listForStory(req.params.id))));
router.post('/scripts/:id/remix', wrap(async (req, res) => {
  const script = sg.getScript(req.params.id);
  if (!script) throw new Error('Script not found.');
  const story = stories.getStory(script.story_id);
  res.json(sg.remix(story, { durationSeconds: script.duration_target, hookStyle: script.hook_style, dramaLevel: script.drama_level }, req.body?.modifier || 'another_angle'));
}));

function toCsv(rows) {
  const cols = ['id', 'title', 'community', 'category', 'source_type', 'upvotes', 'num_comments', 'score_overall', 'est_video_seconds', 'url'];
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  return [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n');
}

module.exports = router;
