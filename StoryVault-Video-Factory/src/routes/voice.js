'use strict';
// Voices (presets + cloning) and Fish Speech routes.
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const multer = require('multer');
const router = express.Router();
const { wrap } = require('./helpers');
const voices = require('../services/voices');
const fishspeech = require('../services/fishspeech');
const trash = require('../services/trash');
const tts = require('../services/tts');
const log = require('../services/logger');
const { id } = require('../util/ids');

// reference-audio upload for voice cloning
const refStorage = multer.diskStorage({
  destination: (req, file, cb) => { fs.mkdirSync(voices.refDir(), { recursive: true }); cb(null, voices.refDir()); },
  filename: (req, file, cb) => cb(null, `${id('ref')}${path.extname(file.originalname) || '.wav'}`),
});
const uploadRef = multer({ storage: refStorage, limits: { fileSize: 50 * 1024 * 1024 } });

// --- Voices ---------------------------------------------------------------
router.get('/voices/presets', wrap(async (req, res) => {
  res.json({
    presets: voices.listPresets({ trash: req.query.trash }),
    clones: voices.listClones(),
    sapiVoices: await tts.listVoices(),
    fish: await fishspeech.status(),
    defaultId: (voices.getDefault() || {}).id || null,
  });
}));
router.post('/voices/presets', wrap(async (req, res) => res.json(voices.createPreset(req.body || {}))));
router.put('/voices/presets/:id', wrap(async (req, res) => res.json(voices.updatePreset(req.params.id, req.body || {}))));
router.post('/voices/presets/:id/default', wrap(async (req, res) => res.json(voices.setDefault(req.params.id))));
router.post('/voices/presets/:id/preview', wrap(async (req, res) => res.json(await voices.preview(req.params.id, req.body && req.body.text))));
router.post('/voices/preview', wrap(async (req, res) => res.json(await voices.preview(req.body || {}, req.body && req.body.text))));
router.delete('/voices/presets/:id', wrap(async (req, res) => res.json({ ok: !!trash.softDelete('voice_presets', [req.params.id]) })));
router.post('/voices/presets/bulk', wrap(async (req, res) => {
  const { ids = [], action } = req.body || {};
  if (action === 'delete') return res.json({ ok: true, count: trash.softDelete('voice_presets', ids) });
  if (action === 'restore') return res.json({ ok: true, count: trash.restore('voice_presets', ids) });
  if (action === 'purge') return res.json({ ok: true, count: trash.purge('voice_presets', ids, ['preview_path']) });
  throw new Error('Unknown action.');
}));

// Voice cloning: upload a reference clip (+ optional transcript) → creates a clone + preset.
router.post('/voices/clone', uploadRef.single('reference'), wrap(async (req, res) => {
  if (!req.file) throw new Error('Upload a short, clean reference voice clip (WAV/MP3, 10–30s).');
  const r = voices.createClone({ name: req.body.name || 'Cloned voice', referencePath: req.file.path, transcript: req.body.transcript || '' });
  res.json(r);
}));

// --- Fish Speech ----------------------------------------------------------
router.get('/fishspeech/status', wrap(async (req, res) => res.json(await fishspeech.status())));
router.post('/fishspeech/download', wrap(async (req, res) => {
  res.json({ started: true });               // run in background, stream over the `fish` SSE channel
  log.activity('AUDIO', `Downloading Fish Speech model (${fishspeech.REPO})…`, { level: 'info' });
  log.progress('fish', { stage: 'downloading', percent: 0 });
  fishspeech.download({ onProgress: (line) => { const m = String(line).match(/(\d+)%/); log.progress('fish', { stage: 'downloading', line: String(line).trim().slice(0, 160), percent: m ? Number(m[1]) : undefined }); } })
    .then((r) => { log.progress('fish', { stage: 'done', files: r.files.length }); log.activity('AUDIO', `Fish Speech model downloaded (${r.files.length} files).`, { level: 'success' }); })
    .catch((e) => { log.progress('fish', { stage: 'error', error: e.message }); log.error('AUDIO', `Fish Speech download failed: ${e.message}`); });
}));
router.post('/fishspeech/server/start', wrap(async (req, res) => res.json(await fishspeech.startServer())));
router.post('/fishspeech/server/stop', wrap(async (req, res) => res.json(fishspeech.stopServer())));
router.post('/fishspeech/test', wrap(async (req, res) => {
  const out = path.join(voices.PREVIEW_DIR, `fishtest_${id('t')}.wav`);
  await fishspeech.synth(req.body && req.body.text || 'Fish Speech is online and ready.', out, {});
  res.json({ ok: true, url: '/media/' + path.relative(path.join(require('../config').ROOT, 'data'), out).split(path.sep).join('/') });
}));

module.exports = router;
