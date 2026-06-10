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
const { FISH_VOICE_PRESETS } = require('../voicePresets-data');

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

// --- Voice Lab: built-in style presets + async clone flow -----------------
router.get('/voices/fish-presets', wrap(async (req, res) => res.json({ presets: FISH_VOICE_PRESETS })));

// Upload a reference clip (no preset yet) → convert to WAV → reusable reference source.
router.post('/voices/clone/upload', uploadRef.single('reference'), wrap(async (req, res) => {
  if (!req.file) throw new Error('Upload a short, clean reference voice clip (WAV/MP3/MP4, 5–30s).');
  const wavPath = await voices.convertToWav(req.file.path); // mp4/mp3/… → clean mono PCM WAV
  const clone = voices.addReference({ name: req.body.name || 'Reference voice', referencePath: wavPath, transcript: req.body.transcript || '' });
  res.json({ id: clone.id, name: clone.name });
}));

router.get('/voices/clone/reference-sources', wrap(async (req, res) => res.json({ sources: voices.listReferenceSources() })));
router.post('/voices/clone/transcribe', wrap(async (req, res) => res.json(await voices.transcribe(req.body || {}))));

// Async clone job: enqueue → poll. Stages mirror the s2.cpp pipeline.
router.post('/voices/clone/jobs', wrap(async (req, res) => res.json(voices.startCloneJob(req.body || {}))));
router.get('/voices/clone/jobs/active', wrap(async (req, res) => res.json(voices.activeCloneJob() || {})));
router.get('/voices/clone/latest', wrap(async (req, res) => res.json(voices.latestCloneJob() || {})));
router.get('/voices/clone/jobs/:id', wrap(async (req, res) => {
  const job = voices.getCloneJob(req.params.id);
  if (!job) throw new Error('Job not found.');
  res.json(job);
}));
// Save a finished clone job as a preset, keeping its generated audio as the preview.
router.post('/voices/clone/jobs/:id/save-preset', wrap(async (req, res) => res.json(voices.savePresetFromCloneJob(req.params.id, req.body || {}))));

// --- Fish Speech ----------------------------------------------------------
router.get('/fishspeech/status', wrap(async (req, res) => res.json(await fishspeech.status())));
// The "connection pill" = whether the engine can synthesize right now.
router.get('/fishspeech/check/server', wrap(async (req, res) => res.json({ reachable: fishspeech.engineReady() })));
router.get('/fishspeech/logs', wrap(async (req, res) => res.json({ logs: fishspeech.getLogs() })));
router.post('/fishspeech/repair', wrap(async (req, res) => res.json(await fishspeech.repair())));
router.post('/fishspeech/model-folder', wrap(async (req, res) => {
  const dir = (req.body && req.body.dir || '').trim();
  if (!dir) throw new Error('Provide the path to an existing model folder.');
  res.json(fishspeech.setModelDir(dir));
}));
router.post('/fishspeech/set-bin', wrap(async (req, res) => {
  const bin = (req.body && req.body.bin || '').trim();
  res.json(fishspeech.setBin(bin));
}));
router.post('/fishspeech/quant', wrap(async (req, res) => res.json({ quant: fishspeech.setQuant((req.body && req.body.quant) || '') })));
// Build the s2.cpp engine from source (best-effort) — streams over the `fish` SSE channel.
router.post('/fishspeech/build', wrap(async (req, res) => {
  res.json({ started: true });
  log.activity('AUDIO', 'Building Fish Speech engine (s2.cpp)…', { level: 'info' });
  log.progress('fish', { stage: 'building', line: 'Starting build…' });
  fishspeech.buildEngine({ onProgress: (line) => log.progress('fish', { stage: 'building', line: String(line).trim().slice(0, 200) }) })
    .then((r) => { log.progress('fish', { stage: 'built' }); log.activity('AUDIO', `Fish Speech engine built: ${r.bin}`, { level: 'success' }); })
    .catch((e) => { log.progress('fish', { stage: 'error', error: e.message }); log.error('AUDIO', `Engine build failed: ${e.message}`); });
}));
router.post('/fishspeech/download', wrap(async (req, res) => {
  const quant = (req.body && req.body.quant) || undefined; // one quant (~2.4–9.3 GB), NOT the whole 30 GB repo
  res.json({ started: true });               // run in background, stream over the `fish` SSE channel
  log.activity('AUDIO', `Downloading Fish Speech model (${fishspeech.REPO}, quant ${quant || 'default'})…`, { level: 'info' });
  log.progress('fish', { stage: 'downloading', percent: 0 });
  fishspeech.download({ quant, onProgress: (line) => { const m = String(line).match(/(\d+)%/); log.progress('fish', { stage: 'downloading', line: String(line).trim().slice(0, 160), percent: m ? Number(m[1]) : undefined }); } })
    .then((r) => { log.progress('fish', { stage: 'done', files: r.files.length }); log.activity('AUDIO', `Fish Speech model downloaded (quant ${r.quant}).`, { level: 'success' }); })
    .catch((e) => { log.progress('fish', { stage: 'error', error: e.message }); log.error('AUDIO', `Fish Speech download failed: ${e.message}`); });
}));
router.post('/fishspeech/test', wrap(async (req, res) => {
  const out = path.join(voices.PREVIEW_DIR, `fishtest_${id('t')}.wav`);
  await fishspeech.synth(req.body && req.body.text || 'Fish Speech is online and ready.', out, {});
  res.json({ ok: true, url: '/media/' + path.relative(path.join(require('../config').ROOT, 'data'), out).split(path.sep).join('/') });
}));

module.exports = router;
