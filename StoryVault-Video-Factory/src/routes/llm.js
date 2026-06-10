'use strict';
// Local-LLM admin endpoints — backend/model selection, status and model pulling.
const express = require('express');
const { wrap } = require('./helpers');
const llmAdmin = require('../services/llmAdmin');

const router = express.Router();

// Backend status: { url, model, backend, reachable, pullable, models, roles }.
router.get('/llm/status', wrap(async (req, res) => res.json(await llmAdmin.getStatus())));

// Set the active model.
router.post('/llm/select', wrap(async (req, res) => {
  const model = (req.body && req.body.model || '').trim();
  if (!model) { res.status(400); throw new Error('Model name required.'); }
  res.json(llmAdmin.saveSettings({ model }));
}));

// Switch the backend URL (e.g. Ollama ↔ llama.cpp, or a custom host).
router.post('/llm/backend', wrap(async (req, res) => {
  const url = (req.body && req.body.url || '').trim();
  if (!url) { res.status(400); throw new Error('Backend URL required.'); }
  res.json(llmAdmin.saveSettings({ url }));
}));

// Pull a model into Ollama, streaming ndjson progress lines straight through.
router.post('/llm/pull', async (req, res) => {
  const name = (req.body && (req.body.model || req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Model name required.' });
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  try {
    await llmAdmin.pullStream(name, (line) => res.write(line + '\n'));
    res.end();
  } catch (e) {
    res.write(JSON.stringify({ error: e.message || 'Pull failed' }) + '\n');
    res.end();
  }
});

module.exports = router;
