'use strict';
// Background Library + Segment Editor routes (spec §10/§11/§12).
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const multer = require('multer');
const router = express.Router();
const { wrap, withMedia } = require('./helpers');
const { PATHS, UPLOAD } = require('../config');
const { id } = require('../util/ids');
const bgSvc = require('../services/backgrounds');
const segSvc = require('../services/segments');
const youtube = require('../services/sources/youtube');
const log = require('../services/logger');
const textImport = require('../services/sources/textImport');
const discovery = require('../services/discovery');
const stories = require('../services/stories');

// In-flight YouTube imports (importId → child process) so they can be cancelled.
const ACTIVE_IMPORTS = new Map();

// --- Background video upload (spec §10). Stores under the category folder; the
//     original file is written once and never overwritten. ---
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = bgSvc.categoryFolder(req.body.category || req.query.category);
    fs.mkdirSync(folder, { recursive: true });
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `${id('bgfile')}${ext}`); // unique → never clobbers an existing file
  },
});
const uploadVideo = multer({
  storage: videoStorage,
  limits: { fileSize: UPLOAD.maxFileBytes },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (UPLOAD.acceptedVideo.includes(ext)) cb(null, true);
    else cb(new Error(`Unsupported video type "${ext}". Accepted: ${UPLOAD.acceptedVideo.join(', ')}.`));
  },
});

router.post('/backgrounds/upload', uploadVideo.array('files', 20), wrap(async (req, res) => {
  if (!req.files || !req.files.length) throw new Error('No files received. Select one or more video files.');
  const category = req.body.category || 'Custom';
  const tags = req.body.tags ? String(req.body.tags).split(',').map((t) => t.trim()).filter(Boolean) : [];
  const out = [];
  for (const f of req.files) {
    try { out.push(await bgSvc.register(f.path, f.originalname, { category, tags })); }
    catch (e) { out.push({ error: e.message, file: f.originalname }); }
  }
  res.json({ uploaded: withMedia(out) });
}));

// Import gameplay from a public YouTube URL (downloaded via yt-dlp, then registered
// through the SAME pipeline as an upload). Runs in the BACKGROUND so a long gameplay
// video never blocks the request/UI; progress streams over the `youtube` SSE channel,
// keyed by importId. Originals are written once, never overwritten.
router.post('/backgrounds/import/youtube', wrap(async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  if (!url) throw new Error('Provide a YouTube video URL.');
  if (!youtube.isYouTubeUrl(url)) throw new Error('That does not look like a YouTube video URL (expected youtube.com/watch, youtu.be, or /shorts).');
  const category = req.body.category || 'Custom';
  const tags = req.body.tags ? String(req.body.tags).split(',').map((t) => t.trim()).filter(Boolean) : [];
  const autoSegment = req.body.autoSegment !== false;
  const folder = bgSvc.categoryFolder(category);
  const importId = id('ytimp');
  const emit = (p) => log.progress('youtube', { importId, ...p });

  // Hand off; respond immediately so the connection isn't held for the whole download.
  res.json({ importId });

  log.activity('VIDEO', `Importing gameplay from YouTube: ${url}`, { level: 'info' });
  emit({ stage: 'starting', percent: 0 });
  (async () => {
    let filePath = null;
    try {
      const dl = await youtube.download(url, folder, {
        onProgress: emit,
        onProc: (proc) => ACTIVE_IMPORTS.set(importId, proc),
      });
      filePath = dl.path;
      emit({ stage: 'registering' });
      const bg = await bgSvc.register(filePath, `${dl.title}.mp4`, { category, tags });
      if (autoSegment) {
        emit({ stage: 'segmenting' });
        try { await segSvc.analyze(bg.id, { segmentLength: 'auto' }); }
        catch (e) { log.error('VIDEO', `Auto-segment failed for imported video: ${e.message}`, null, bg.id); }
      }
      emit({ stage: 'done', percent: 100, backgroundId: bg.id, name: bg.original_name });
      log.activity('VIDEO', `Imported "${bg.original_name}" from YouTube.`, { level: 'success', refId: bg.id });
    } catch (e) {
      if (filePath) { try { fs.unlinkSync(filePath); } catch { /* may already be gone */ } }
      if (e.cancelled) { emit({ stage: 'cancelled' }); log.activity('VIDEO', 'YouTube import cancelled by user.', { level: 'warning' }); }
      else { emit({ stage: 'error', error: e.message }); log.error('VIDEO', `YouTube import failed: ${e.message}`); }
    } finally { ACTIVE_IMPORTS.delete(importId); }
  })();
}));

// Cancel an in-flight YouTube import (kills the downloader + its ffmpeg child).
router.post('/backgrounds/import/youtube/:importId/cancel', wrap(async (req, res) => {
  const proc = ACTIVE_IMPORTS.get(req.params.importId);
  if (!proc) return res.json({ cancelled: false, reason: 'No active import with that id (it may have already finished).' });
  if (typeof proc._cancel === 'function') proc._cancel(); else { try { proc.kill(); } catch { /* gone */ } }
  res.json({ cancelled: true });
}));

router.get('/backgrounds', wrap(async (req, res) => res.json(withMedia(bgSvc.list(req.query)))));
router.get('/backgrounds/:id', wrap(async (req, res) => {
  const bg = bgSvc.get(req.params.id);
  if (!bg) throw new Error('Background not found.');
  res.json(withMedia({ ...bg, segments: segSvc.listForBackground(bg.id) }));
}));
router.patch('/backgrounds/:id', wrap(async (req, res) => res.json(withMedia(bgSvc.update(req.params.id, req.body || {})))));
// Delete → trash by default; ?permanent=1 hard-removes file + segments.
router.delete('/backgrounds/:id', wrap(async (req, res) => {
  if (req.query.permanent) return res.json({ ok: bgSvc.remove(req.params.id) });
  return res.json({ ok: !!require('../services/trash').softDelete('backgrounds', [req.params.id]) });
}));
// Bulk trash actions: delete (→trash) | restore | purge (file+segments removed).
router.post('/backgrounds/bulk', wrap(async (req, res) => {
  const { ids = [], action } = req.body || {};
  const trash = require('../services/trash');
  if (action === 'delete') return res.json({ ok: true, count: trash.softDelete('backgrounds', ids) });
  if (action === 'restore') return res.json({ ok: true, count: trash.restore('backgrounds', ids) });
  if (action === 'purge') { let n = 0; ids.forEach((id) => { if (bgSvc.remove(id)) n++; }); return res.json({ ok: true, count: n }); }
  throw new Error('Unknown action.');
}));

// Split a background into usable segments (spec §11).
router.post('/backgrounds/:id/segments', wrap(async (req, res) => {
  res.json(withMedia(await segSvc.analyze(req.params.id, { segmentLength: req.body?.segmentLength || 'auto' })));
}));

// --- Segment editor (spec §12) ---
router.get('/backgrounds/:id/segments/list', wrap(async (req, res) => res.json(withMedia(segSvc.listForBackground(req.params.id)))));
router.post('/segments', wrap(async (req, res) => {
  const { backgroundId, start, end, name, tags } = req.body;
  res.json(withMedia(segSvc.createSegment(backgroundId, Number(start), Number(end), { name, tags })));
}));
router.patch('/segments/:id', wrap(async (req, res) => res.json(withMedia(segSvc.updateSegment(req.params.id, req.body || {})))));
router.post('/segments/:id/split', wrap(async (req, res) => res.json(withMedia(segSvc.splitSegment(req.params.id, Number(req.body.at))))));
router.delete('/segments/:id', wrap(async (req, res) => res.json({ ok: segSvc.deleteSegment(req.params.id) })));
// Multi-select bulk action from the Footage Library. Only 'delete' for now (permanent — segments have no trash).
router.post('/segments/bulk', wrap(async (req, res) => {
  const { ids = [], action = 'delete' } = req.body || {};
  if (action !== 'delete') throw new Error('Unknown action.');
  res.json({ ok: true, count: segSvc.deleteSegments(ids) });
}));
router.post('/segments/select', wrap(async (req, res) => res.json(segSvc.selectForDuration(Number(req.body.duration) || 60, req.body || {}))));

// --- Text/CSV/JSON story file import (spec §2) — lives here as a library import ---
const importStorage = multer.diskStorage({
  destination: (req, file, cb) => { fs.mkdirSync(PATHS.imports, { recursive: true }); cb(null, PATHS.imports); },
  filename: (req, file, cb) => cb(null, `${id('imp')}${path.extname(file.originalname) || '.txt'}`),
});
const uploadImport = multer({
  storage: importStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(UPLOAD.acceptedImport.includes(ext) ? null : new Error(`Unsupported import type "${ext}".`), UPLOAD.acceptedImport.includes(ext));
  },
});
router.post('/import/file', uploadImport.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new Error('No import file received.');
  const candidates = textImport.fromFile(req.file.path, req.file.originalname, { category: req.body.category || null });
  if (!candidates.length) throw new Error('No stories could be read from that file.');
  const result = stories.ingest(candidates, { sourceType: 'file', sourceLabel: req.file.originalname, sort: 'popular' });
  res.json(result);
}));

module.exports = router;
