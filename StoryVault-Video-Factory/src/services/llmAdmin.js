'use strict';
/**
 * LLM admin — lists/selects/switches/pulls models and persists the backend URL,
 * active model and per-role overrides to data/llm-settings.json. Ported from
 * TrendVault's services/llm/model_admin.py. Dual-backend: Ollama native
 * (richest — includes size) falling back to OpenAI-compatible /v1/models.
 */
const path = require('node:path');
const { PATHS, AI } = require('../config');
const { atomicWriteJson, readJson } = require('../util/atomicIo');
const llm = require('./llm');

const SETTINGS_FILE = path.join(PATHS.data, 'llm-settings.json');

const state = { url: AI.llmUrl, model: AI.llmModel, roles: {} };

// Load persisted overrides over the config defaults (applied at boot).
(function loadOverrides() {
  const saved = readJson(SETTINGS_FILE, null);
  if (saved && typeof saved === 'object') {
    if (saved.url) state.url = String(saved.url);
    if (saved.model) state.model = String(saved.model);
    if (saved.roles && typeof saved.roles === 'object') state.roles = saved.roles;
  }
})();

function currentUrl() { return state.url; }
function currentModel() { return state.model; }
function getRoleModel(role) { return (role && state.roles[role]) || null; }

function persist() {
  try { atomicWriteJson(SETTINGS_FILE, { url: state.url, model: state.model, roles: state.roles }); } catch { /* ignore */ }
}

function saveSettings({ url, model } = {}) {
  if (url != null) {
    const u = String(url).trim();
    if (u) { state.url = u; llm.resetBackendCache(); } // re-probe native vs /v1
  }
  if (model != null) {
    const m = String(model).trim();
    if (m) state.model = m;
  }
  persist();
  return getStatusShallow();
}

function setRoleModel(role, model) {
  if (!role) return;
  if (model) state.roles[role] = String(model); else delete state.roles[role];
  persist();
}

// List installed models. Returns { backend, models:[{name,size}] }.
async function listModels() {
  // Ollama native — richest (name + size in bytes).
  try {
    const r = await llm.httpJson(llm.ollamaBase(state.url) + '/api/tags', { timeoutMs: llm.PROBE_TIMEOUT_MS });
    if (r.ok && r.json) {
      const tags = r.json.models || [];
      return { backend: 'ollama', models: tags.filter((m) => m.name).map((m) => ({ name: m.name, size: m.size ?? null })) };
    }
  } catch { /* fall through */ }
  // OpenAI-compatible /v1/models (llama.cpp or any compatible server).
  try {
    const r = await llm.httpJson(llm.v1Base(state.url) + '/models', { timeoutMs: llm.PROBE_TIMEOUT_MS });
    if (r.ok && r.json) {
      const data = r.json.data || [];
      return { backend: 'llamacpp', models: data.filter((m) => m.id).map((m) => ({ name: m.id, size: null })) };
    }
  } catch { /* fall through */ }
  return { backend: 'unknown', models: [] };
}

function getStatusShallow() {
  return { url: state.url, model: state.model, roles: state.roles };
}

async function getStatus() {
  const { backend, models } = await listModels();
  return {
    url: state.url,
    model: state.model,
    backend,
    reachable: backend !== 'unknown',
    pullable: backend === 'ollama',
    models,
    roles: state.roles,
  };
}

/**
 * Pull a model into Ollama, streaming ndjson progress lines to onLine(lineStr).
 * Resolves when the stream ends. Throws if the backend isn't Ollama-compatible.
 */
async function pullStream(name, onLine) {
  const url = llm.ollamaBase(state.url) + '/api/pull';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`Pull failed (HTTP ${res.status}). Is Ollama running?`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) { if (line.trim()) onLine(line); }
  }
  if (buf.trim()) onLine(buf);
}

module.exports = { currentUrl, currentModel, getRoleModel, setRoleModel, saveSettings, listModels, getStatus, pullStream, SETTINGS_FILE };
