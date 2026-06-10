'use strict';
/**
 * Local LLM client — talks to Ollama (native API, preferred) or any
 * OpenAI-compatible /v1 server (llama.cpp). Ported from TrendVault's
 * lib/local_llm.py. No API key; everything runs locally.
 *
 * Ollama's native /api/chat is preferred because "thinking" models (qwen3,
 * deepseek-r1, gpt-oss) burn their whole token budget on hidden reasoning and
 * return EMPTY content over /v1 — native accepts `think:false` to disable that.
 */
const PROBE_TIMEOUT_MS = 5000;
const READ_TIMEOUT_MS = 600000; // cold model loads can take minutes

let nativeOk = null; // cached backend probe (null = unknown)

function settings() {
  // Lazy require avoids a load-time cycle with llmAdmin.
  return require('./llmAdmin');
}
function currentUrl() { return settings().currentUrl(); }
function currentModel() { return settings().currentModel(); }

function v1Endpoint(url) { return String(url || '').replace(/\/+$/, '') + '/chat/completions'; }
function v1Base(url) { return String(url || '').replace(/\/+$/, ''); }
function ollamaBase(url) {
  // Host root for Ollama's native API — the config URL with a trailing /v1 removed.
  let u = String(url || '').replace(/\/+$/, '');
  if (u.toLowerCase().endsWith('/v1')) u = u.slice(0, -3).replace(/\/+$/, '');
  // localhost -> 127.0.0.1 avoids the Windows IPv6 (::1) connect stall.
  return u.replace('://localhost', '://127.0.0.1');
}

function resetBackendCache() { nativeOk = null; }

async function httpJson(url, { method = 'GET', body, timeoutMs = READ_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

// Cached probe: does the backend answer Ollama's native /api/tags?
async function detectNative() {
  if (nativeOk !== null) return nativeOk;
  try {
    const r = await httpJson(ollamaBase(currentUrl()) + '/api/tags', { timeoutMs: PROBE_TIMEOUT_MS });
    nativeOk = r.ok;
  } catch { nativeOk = false; }
  return nativeOk;
}

async function chatOllamaNative(model, messages, maxTokens, temperature, topP) {
  const base = ollamaBase(currentUrl());
  const url = base + '/api/chat';
  const payload = {
    model,
    messages,
    stream: false,
    options: { temperature, top_p: topP, num_predict: maxTokens },
  };
  let r = await httpJson(url, { method: 'POST', body: { ...payload, think: false } });
  // Some models reject the think flag ("does not support thinking") — retry plain.
  if (r.status === 400 && /think/i.test(r.text || '')) {
    r = await httpJson(url, { method: 'POST', body: payload });
  }
  if (!r.ok) throw new Error(`Local LLM error (${r.status}): ${(r.text || '').slice(0, 200)}`);
  const msg = (r.json && r.json.message) || {};
  const content = (msg.content || '').trim();
  if (!content) {
    if (msg.thinking && r.json && r.json.done_reason === 'length') {
      throw new Error('The model spent its whole budget on hidden reasoning. Pick a non-reasoning model (e.g. llama3.1:8b).');
    }
    throw new Error('Local LLM returned empty response.');
  }
  return content;
}

async function chatOpenAiV1(model, messages, maxTokens, temperature, topP) {
  const r = await httpJson(v1Endpoint(currentUrl()), {
    method: 'POST',
    body: { model, messages, max_tokens: maxTokens, temperature, top_p: topP, stream: false },
  });
  if (!r.ok) throw new Error(`Local LLM error (${r.status}): ${(r.text || '').slice(0, 200)}`);
  const content = ((((r.json || {}).choices || [{}])[0] || {}).message || {}).content;
  if (!content || !content.trim()) throw new Error('Local LLM returned empty response.');
  return content.trim();
}

/**
 * Single public entry point. Routes native-vs-/v1 based on a cached probe.
 * @returns {Promise<string>} the assistant text.
 */
async function chat({ user, system, model, maxTokens = 3500, temperature = 1.0, topP = 0.95 } = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const mdl = model || currentModel();
  if (await detectNative()) return chatOllamaNative(mdl, messages, maxTokens, temperature, topP);
  return chatOpenAiV1(mdl, messages, maxTokens, temperature, topP);
}

// Reachable if the backend answers either /api/tags (Ollama) or /models (/v1).
async function probeReachable() {
  try {
    const r = await httpJson(ollamaBase(currentUrl()) + '/api/tags', { timeoutMs: PROBE_TIMEOUT_MS });
    if (r.ok) return true;
  } catch { /* try v1 */ }
  try {
    const r = await httpJson(v1Base(currentUrl()) + '/models', { timeoutMs: PROBE_TIMEOUT_MS });
    return r.ok;
  } catch { return false; }
}

module.exports = { chat, probeReachable, detectNative, resetBackendCache, ollamaBase, v1Base, httpJson, PROBE_TIMEOUT_MS };
