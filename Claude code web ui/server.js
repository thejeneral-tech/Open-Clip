'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

const PORT = process.env.PORT || 7878;
const HOST = '127.0.0.1'; // always bound here for local access; also bound to the Tailscale IP if the tailnet is up
const OLLAMA_URL = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

const isWin = process.platform === 'win32';
const shell = isWin ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/bash');

// Tailscale hands out IPv4 addresses in the 100.64.0.0/10 CGNAT range. Returns this
// machine's Tailscale IP if the tailnet is up, else null. Prefers an interface whose
// name looks like Tailscale, then falls back to any address in that range.
function getTailscaleIPv4() {
  const ifaces = os.networkInterfaces();
  let named = null;
  let cgnat = null;
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const m = /^(\d+)\.(\d+)\./.exec(a.address);
      if (!m || Number(m[1]) !== 100 || Number(m[2]) < 64 || Number(m[2]) > 127) continue;
      if (/tailscale/i.test(name)) { if (!named) named = a.address; }
      else if (!cgnat) cgnat = a.address;
    }
  }
  return named || cgnat || null;
}

// --- auth: file-based accounts + in-memory sessions ---
// Accounts live in users.json (edit it to add users / change passwords).
// AUTH_USERNAME / AUTH_PASSWORD env vars only seed the file the first time.
const AUTH_USERNAME = process.env.AUTH_USERNAME || 'admin';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'admin';
const USERS_FILE = process.env.AUTH_USERS_FILE || path.join(__dirname, 'users.json');

// Read accounts fresh from disk so edits apply on the next sign-in (no restart).
// Falls back to the env-seeded default account if the file is missing or invalid.
function loadUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    const list = Array.isArray(data) ? data : (Array.isArray(data.users) ? data.users : []);
    const users = list
      .filter(u => u && typeof u.username === 'string' && u.username.length && typeof u.password === 'string')
      .map(u => ({ username: u.username, password: u.password }));
    if (users.length) return users;
  } catch (_) { /* missing or malformed — fall through to default */ }
  return [{ username: AUTH_USERNAME, password: AUTH_PASSWORD }];
}

// Create users.json on first run so there's a file to edit.
function ensureUsersFile() {
  if (fs.existsSync(USERS_FILE)) return;
  const seed = {
    _comment: 'Add or edit accounts below. Each entry needs a unique "username" and a "password". '
      + 'Changes take effect on the next sign-in — no server restart needed. '
      + 'Passwords are stored in plain text, so keep this file private.',
    users: [{ username: AUTH_USERNAME, password: AUTH_PASSWORD }],
  };
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(seed, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.warn(`  Could not create ${USERS_FILE}: ${(e && e.message) || e}`);
  }
}

const SESSION_COOKIE = 'claw_sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const sessions = new Map(); // token -> { username, createdAt }

function parseCookies(req) {
  const out = {};
  const header = req.headers && req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { sessions.delete(token); return null; }
  return { token, username: s.username };
}

// constant-time compare that doesn't throw on length mismatch
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

const app = express();
app.use(express.json());

// --- static assets ---
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/xterm.js', express.static(path.join(__dirname, 'node_modules/@xterm/xterm/lib/xterm.js')));
app.use('/vendor/xterm.css', express.static(path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css')));
app.use('/vendor/addon-fit.js', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit/lib/addon-fit.js')));

// --- auth endpoints (these stay open; everything else under /api is gated) ---
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Enter a username and password.' });
  }
  const match = loadUsers().find(u => safeEqual(username, u.username) && safeEqual(password, u.password));
  if (!match) {
    return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: match.username, createdAt: Date.now() });
  setSessionCookie(res, token);
  res.json({ ok: true, user: { username: match.username } });
});

app.get('/api/auth/me', (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: { username: s.username } });
});

app.post('/api/auth/logout', (req, res) => {
  const s = getSession(req);
  if (s) sessions.delete(s.token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// gate the rest of the API behind a valid session
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/api/auth/')) return next();
  if (getSession(req)) return next();
  res.status(401).json({ ok: false, error: 'Not authenticated' });
});

// --- list installed ollama models for the picker ---
app.get('/api/models', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    const models = (j.models || []).map(m => m.name).sort();
    res.json({ ok: true, models });
  } catch (e) {
    res.json({ ok: false, models: [], error: String(e && e.message || e) });
  }
});

// default working directory suggestion
app.get('/api/defaults', (req, res) => {
  res.json({ cwd: activeCwd, home: os.homedir() });
});

// --- filesystem browsing for the folder picker (directories only) ---
// Gated by the /api/ auth check above. This exposes the same directory access the
// terminal already has (it launches a shell in any chosen folder), so it adds no new
// capability beyond what an authenticated session can already do.
app.get('/api/fs/home', (req, res) => {
  res.json({ home: os.homedir() });
});

app.get('/api/fs/list', (req, res) => {
  const raw = typeof req.query.path === 'string' ? req.query.path.trim() : '';

  // Windows root level (empty path): enumerate drive letters that respond.
  if (!raw && isWin) {
    const drives = [];
    for (let c = 67; c <= 90; c++) { // C..Z (skip A/B floppies)
      const root = `${String.fromCharCode(c)}:\\`;
      try { fs.accessSync(root); drives.push({ name: root, path: root }); } catch (_) {}
    }
    return res.json({ path: '', parent: null, isRoot: true, items: drives });
  }

  let abs;
  try {
    abs = path.resolve(raw || '/');
  } catch (_) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    return res.status(400).json({ error: (e && e.message) || 'Cannot read directory' });
  }

  const items = entries
    .filter(d => {
      if (d.isDirectory()) return true;
      if (d.isSymbolicLink()) {
        try { return fs.statSync(path.join(abs, d.name)).isDirectory(); } catch (_) { return false; }
      }
      return false;
    })
    .map(d => ({ name: d.name, path: path.join(abs, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const parent = path.dirname(abs);
  const atRoot = parent === abs; // dirname of a filesystem root returns itself
  res.json({
    path: abs,
    parent: atRoot ? (isWin ? '' : null) : parent,
    isRoot: false,
    items,
  });
});

// --- Ollama model management (proxied to the local Ollama API) ---

// models currently loaded in memory
app.get('/api/ollama/ps', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    res.json({ ok: true, models: j.models || [] });
  } catch (e) {
    res.json({ ok: false, models: [], error: String(e && e.message || e) });
  }
});

// installed models (full details, not just names)
app.get('/api/ollama/tags', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    res.json({ ok: true, models: j.models || [] });
  } catch (e) {
    res.json({ ok: false, models: [], error: String(e && e.message || e) });
  }
});

// unload a model from memory (keep_alive: 0 evicts it immediately)
app.post('/api/ollama/unload', async (req, res) => {
  const name = req.body && req.body.name;
  if (!name) return res.status(400).json({ ok: false, error: 'Missing model name' });
  try {
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, keep_alive: 0, stream: false }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({ ok: false, error: text || `Ollama HTTP ${r.status}` });
    }
    await r.text().catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e && e.message || e) });
  }
});

// delete an installed model from disk
app.post('/api/ollama/delete', async (req, res) => {
  const name = req.body && req.body.name;
  if (!name) return res.status(400).json({ ok: false, error: 'Missing model name' });
  try {
    const r = await fetch(`${OLLAMA_URL}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({ ok: false, error: text || `Ollama HTTP ${r.status}` });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e && e.message || e) });
  }
});

// pull a model — streams Ollama's NDJSON progress to the client as SSE
app.post('/api/ollama/pull', async (req, res) => {
  const name = req.body && req.body.name;
  if (!name) return res.status(400).json({ ok: false, error: 'Missing model name' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const ac = new AbortController();
  let finished = false;
  const finish = () => { finished = true; try { res.end(); } catch (_) {} };
  res.on('close', () => { if (!finished) ac.abort(); });

  try {
    const r = await fetch(`${OLLAMA_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
      signal: ac.signal,
    });
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => '');
      send('error', { message: text || `Ollama HTTP ${r.status}` });
      return finish();
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.error) { send('error', { message: obj.error }); return finish(); }
        send('progress', obj);
        if (obj.status === 'success') { send('done', {}); return finish(); }
      }
    }
    send('done', {});
    finish();
  } catch (e) {
    if (!e || e.name !== 'AbortError') send('error', { message: String(e && e.message || e) });
    finish();
  }
});

// --- pure Ollama chat (server keeps the conversation; client sends one prompt) ---
let chatModel = null;            // currently selected chat model
let chatHistory = [];            // [{ role, content }]
let activeCwd = process.env.CLAUDE_CWD || process.cwd(); // working dir new agents launch in

// pick a sensible default model from what's installed (prefer a coder model)
async function resolveDefaultModel() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    const names = (j.models || []).map(m => m.name).filter(Boolean);
    if (!names.length) return null;
    return names.find(n => /coder/i.test(n)) || names[0];
  } catch (_) {
    return null;
  }
}

app.get('/api/ollama/chat/info', async (req, res) => {
  if (!chatModel) chatModel = await resolveDefaultModel();
  res.json({ ok: true, model: chatModel, baseUrl: OLLAMA_URL });
});

app.post('/api/ollama/chat/model', (req, res) => {
  const model = req.body && req.body.model;
  if (model && typeof model === 'string') chatModel = model;
  res.json({ ok: true, model: chatModel });
});

app.post('/api/ollama/chat/clear', (req, res) => {
  chatHistory = [];
  res.json({ ok: true });
});

app.post('/api/ollama/chat', async (req, res) => {
  const prompt = req.body && req.body.prompt;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing prompt' });
  }
  const model = (req.body && req.body.model) || chatModel || await resolveDefaultModel();
  if (!model) {
    return res.status(400).json({ ok: false, error: 'No Ollama models installed — pull one from the Models tab first.' });
  }
  chatModel = model;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('meta', { model, baseUrl: OLLAMA_URL });

  const messages = chatHistory.concat([{ role: 'user', content: prompt }]);
  const ac = new AbortController();
  let finished = false;
  const finish = () => { finished = true; try { res.end(); } catch (_) {} };
  // abort the upstream request only if the client disconnects before we finish
  res.on('close', () => { if (!finished) ac.abort(); });

  let assistant = '';
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: ac.signal,
    });
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => '');
      send('error', { message: text || `Ollama HTTP ${r.status}` });
      return finish();
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.error) { send('error', { message: obj.error }); return finish(); }
        const piece = obj.message && obj.message.content;
        if (piece) { assistant += piece; send('delta', { text: piece }); }
        if (obj.done) {
          chatHistory.push({ role: 'user', content: prompt });
          chatHistory.push({ role: 'assistant', content: assistant });
          send('done', { text: assistant });
          return finish();
        }
      }
    }
    chatHistory.push({ role: 'user', content: prompt });
    chatHistory.push({ role: 'assistant', content: assistant });
    send('done', { text: assistant });
    finish();
  } catch (e) {
    if (!e || e.name !== 'AbortError') send('error', { message: String(e && e.message || e) });
    finish();
  }
});

// probe an Ollama instance for its installed models (used by the model picker)
app.get('/api/ollama/probe', async (req, res) => {
  let baseUrl = OLLAMA_URL;
  const q = req.query && req.query.baseUrl;
  if (typeof q === 'string' && q) {
    try {
      const u = new URL(q);
      if (u.protocol === 'http:' || u.protocol === 'https:') baseUrl = u.origin;
    } catch (_) { /* keep default */ }
  }
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    const models = (j.models || []).map(m => m.name).filter(Boolean).sort();
    res.json({ ok: true, models, baseUrl });
  } catch (e) {
    res.json({ ok: false, models: [], error: String(e && e.message || e) });
  }
});

// current selection for the composer/model button
app.get('/api/info', async (req, res) => {
  if (!chatModel) chatModel = await resolveDefaultModel();
  res.json({
    ok: true,
    ready: true,
    provider: 'ollama',
    model: chatModel,
    baseUrl: OLLAMA_URL,
    cwd: activeCwd,
    contextWindow: 32768,
    // The Code chat is backed by the real Claude Code CLI (launched through Ollama),
    // so it has the full tool set and slash-command support.
    chatMode: 'cli',
    agent: 'claude-code',
  });
});

// The Code chat always runs the bundled CLI; there is no lightweight fallback agent.
// This endpoint exists so the mode button in the UI has something to talk to.
app.post('/api/chat/mode', (req, res) => res.json({ ok: true, mode: 'cli', chatMode: 'cli' }));

// pick the active model and/or working directory (the picker + folder popover call this)
app.post('/api/config', (req, res) => {
  const model = req.body && req.body.model;
  if (model && typeof model === 'string') chatModel = model;
  const cwd = req.body && req.body.cwd;
  if (cwd && typeof cwd === 'string') {
    if (!fs.existsSync(cwd)) {
      return res.status(400).json({ ok: false, error: `Folder not found: ${cwd}` });
    }
    activeCwd = cwd;
  }
  res.json({ ok: true, provider: 'ollama', model: chatModel, baseUrl: OLLAMA_URL, cwd: activeCwd });
});

// ===================================================================================
// Claude Code CLI agent — a chat-styled wrapper around the real CLI.
//
// Each chat session owns one long-lived `claude` process launched through Ollama in
// stream-json mode. We write user messages (and slash commands) to its stdin as JSON,
// and translate its stdout event stream into the SSE protocol the chat UI already
// speaks: meta / text / tool_use / tool_result / done / error. The process is kept
// alive across turns so context and slash-command state persist like the real CLI.
// ===================================================================================

const cliSessions = new Map(); // sessionId -> { child, res, turnActive, ... }

// `ollama launch claude` wires the local model into Claude Code; everything after the
// `--` is forwarded to the claude CLI. bypassPermissions makes tools run without
// prompts (a prompt is an effective block in headless mode), matching the Terminal
// tab, which already launches with -y.
//
// Built as a single shell command line (rather than spawn's args array) so we don't
// trip Node's DEP0190 warning about unescaped args under `shell: true`. This is safe:
// `model` is the only interpolated value and callers validate it against
// /^[\w.:\-\/]+$/ first, so it can carry no shell metacharacters.
function cliAgentCommand(model) {
  return [
    'ollama', 'launch', 'claude', '-y', '--model', model, '--',
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
  ].join(' ');
}

function sseSend(res, event, data) {
  if (!res) return;
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (_) { /* client went away */ }
}

function truncateStr(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n) + '…';
}

// Local models sometimes leak chat-template tokens (e.g. <|start_header_id|>assistant
// <|end_header_id|>) into the text. Strip them so the bubble reads cleanly.
function stripModelArtifacts(s) {
  return String(s == null ? '' : s)
    .replace(/<\|[^|>]*\|>/g, '')
    .replace(/^\s*assistant\s*\n?/i, '')
    .trim();
}

// A tool_result block's `content` may be a string, an array of text blocks, or richer
// structured content — flatten it to something printable for the result card.
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === 'string') return c;
      if (c && c.type === 'text' && typeof c.text === 'string') return c.text;
      try { return JSON.stringify(c); } catch (_) { return ''; }
    }).join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content, null, 2); } catch (_) { return String(content); }
}

function endTurn(sess) {
  if (sess.res) { try { sess.res.end(); } catch (_) {} }
  sess.res = null;
  sess.turnActive = false;
}

// Translate one Claude stream-json event into the chat UI's SSE events.
function routeCliEvent(sess, ev) {
  const res = sess.res; // may be null if the client disconnected mid-turn
  switch (ev && ev.type) {
    case 'system':
      if (ev.session_id) sess.claudeSessionId = ev.session_id;
      break;

    case 'assistant': {
      const content = (ev.message && ev.message.content) || [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          sess.assistantText += block.text;
          // The UI's `text` handler replaces the assistant bubble with the cumulative
          // text, so we always send the running total for this turn.
          sseSend(res, 'text', { text: stripModelArtifacts(sess.assistantText) });
        } else if (block.type === 'tool_use') {
          sseSend(res, 'tool_use', { id: block.id, name: block.name, input: block.input || {} });
        }
      }
      break;
    }

    case 'user': {
      // Tool results arrive as a synthetic user message carrying tool_result blocks.
      const content = (ev.message && ev.message.content) || [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          sseSend(res, 'tool_result', {
            id: block.tool_use_id,
            content: toolResultText(block.content),
            isError: !!block.is_error,
          });
        }
      }
      break;
    }

    case 'result': {
      if (ev.session_id) sess.claudeSessionId = ev.session_id;
      const text = stripModelArtifacts(sess.assistantText) || stripModelArtifacts(ev.result || '');
      const tokens = (ev.usage && (ev.usage.output_tokens || ev.usage.outputTokens)) || undefined;
      if (ev.subtype && ev.subtype !== 'success' && ev.is_error) {
        sseSend(res, 'error', { message: text || `Agent error (${ev.subtype})` });
      } else {
        sseSend(res, 'done', { text, tokens });
      }
      endTurn(sess);
      break;
    }
  }
}

function handleCliStdout(sess, buf) {
  sess.stdoutBuf += buf.toString('utf8');
  let idx;
  while ((idx = sess.stdoutBuf.indexOf('\n')) !== -1) {
    const line = sess.stdoutBuf.slice(0, idx).trim();
    sess.stdoutBuf = sess.stdoutBuf.slice(idx + 1);
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (_) { continue; }
    routeCliEvent(sess, ev);
  }
}

// Kill the whole child tree (ollama -> claude -> node) so no orphans linger.
function killCliTree(child) {
  if (!child || child.killed) return;
  if (isWin) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {}
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
  }
}

function spawnCliSession(id, { model, cwd }) {
  const child = spawn(cliAgentCommand(model), {
    cwd,
    env: process.env,
    shell: true,            // resolve `ollama` on PATH (and .exe on Windows)
    windowsHide: true,
    detached: !isWin,       // own process group on POSIX so killCliTree can reap it
  });

  const sess = {
    id, child, model, cwd,
    claudeSessionId: null,
    res: null,
    turnActive: false,
    assistantText: '',
    stdoutBuf: '',
    lastStderr: '',
    exited: false,
    createdAt: Date.now(),
  };
  cliSessions.set(id, sess);

  child.stdout.on('data', (buf) => handleCliStdout(sess, buf));
  child.stderr.on('data', (buf) => {
    // Keep only the tail — useful for surfacing a startup failure to the client.
    sess.lastStderr = (sess.lastStderr + buf.toString('utf8')).slice(-2000);
  });
  child.on('exit', (code) => {
    sess.exited = true;
    if (sess.turnActive) {
      const why = sess.lastStderr ? ` ${truncateStr(sess.lastStderr.trim(), 400)}` : '';
      sseSend(sess.res, 'error', { message: `Agent process exited (code ${code}).${why}` });
      endTurn(sess);
    }
    cliSessions.delete(id);
  });
  child.on('error', (e) => {
    sess.exited = true;
    if (sess.turnActive) {
      sseSend(sess.res, 'error', { message: `Failed to start agent: ${(e && e.message) || e}` });
      endTurn(sess);
    }
    cliSessions.delete(id);
  });

  return sess;
}

// POST /api/chat — run one turn for a session and stream the result back as SSE.
// Body: { prompt, sessionId, model?, cwd? }. The child persists across turns; model
// and cwd are honoured only when the session is first created (like launching a shell).
app.post('/api/chat', (req, res) => {
  const body = req.body || {};
  const prompt = body.prompt;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing prompt' });
  }

  const sessionId = (typeof body.sessionId === 'string' && body.sessionId.trim()) || 'default';
  const model = (typeof body.model === 'string' && body.model.trim()) || chatModel || 'qwen2.5-coder:7b';
  if (!/^[\w.:\-\/]+$/.test(model)) {
    return res.status(400).json({ ok: false, error: `Invalid model name: ${model}` });
  }
  let cwd = (typeof body.cwd === 'string' && body.cwd.trim()) || process.env.CLAUDE_CWD || process.cwd();
  if (!cwd || !fs.existsSync(cwd)) cwd = os.homedir();

  let sess = cliSessions.get(sessionId);
  if (sess && sess.exited) { cliSessions.delete(sessionId); sess = null; }
  if (!sess) {
    try { sess = spawnCliSession(sessionId, { model, cwd }); }
    catch (e) { return res.status(500).json({ ok: false, error: String((e && e.message) || e) }); }
  }
  if (sess.turnActive) {
    return res.status(409).json({ ok: false, error: 'A turn is already running for this session.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  sess.res = res;
  sess.turnActive = true;
  sess.assistantText = '';
  sseSend(res, 'meta', { model: sess.model, cwd: sess.cwd, session: sess.id });

  // If the client disconnects mid-turn, detach the response but leave the child
  // running — the turn completes server-side and turnActive clears on its `result`.
  res.on('close', () => { if (sess.res === res) sess.res = null; });

  const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } };
  try {
    sess.child.stdin.write(JSON.stringify(msg) + '\n');
  } catch (e) {
    sseSend(res, 'error', { message: `Could not send to agent: ${(e && e.message) || e}` });
    endTurn(sess);
  }
});

// Stop (and forget) a chat session's agent process. Used by the composer Stop button
// and when the user deletes a chat from the sidebar. Note: this ends the live context;
// the next message starts a fresh agent.
app.post('/api/chat/:id/stop', (req, res) => {
  const sess = cliSessions.get(req.params.id);
  if (!sess) return res.json({ ok: true, stopped: false });
  if (sess.turnActive) { sseSend(sess.res, 'error', { message: 'Stopped.' }); endTurn(sess); }
  killCliTree(sess.child);
  cliSessions.delete(sess.id);
  res.json({ ok: true, stopped: true });
});

// Which chat sessions currently have a live agent (so the UI can show status).
app.get('/api/chat/sessions', (req, res) => {
  const items = [];
  for (const s of cliSessions.values()) {
    items.push({ id: s.id, model: s.model, cwd: s.cwd, busy: s.turnActive, createdAt: s.createdAt });
  }
  res.json({ ok: true, sessions: items });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/pty' });

function buildArgs(model) {
  const cmd = `ollama launch claude --model ${model} -y`;
  return isWin ? ['/c', cmd] : ['-lc', cmd];
}

// Live PTY sessions keyed by the client-supplied session id. The PTY (and the agent
// process running in it) is kept alive across WebSocket disconnects so a browser
// refresh doesn't lose the running session — the client reattaches by the same id.
const ptySessions = new Map();
const PTY_BUFFER_LIMIT = 256 * 1024; // bytes of recent output replayed on reattach

function bufferOutput(sess, data) {
  sess.buffer.push(data);
  sess.bufferBytes += Buffer.byteLength(data, 'utf8');
  while (sess.bufferBytes > PTY_BUFFER_LIMIT && sess.buffer.length > 1) {
    const dropped = sess.buffer.shift();
    sess.bufferBytes -= Buffer.byteLength(dropped, 'utf8');
  }
}

function disposeSession(sess) {
  try { sess.onData && sess.onData.dispose(); } catch (_) {}
  try { sess.onExit && sess.onExit.dispose(); } catch (_) {}
  ptySessions.delete(sess.id);
}

// Bind a socket to a session: stream output to it and accept its input. The PTY is
// shared — closing the socket only detaches it, leaving the process running.
function attachSocket(sess, ws, { cols, rows, reattached }) {
  // Replace any previous socket on this session (e.g. a stale tab) so only one drives it.
  if (sess.ws && sess.ws !== ws && sess.ws.readyState === sess.ws.OPEN) {
    try { sess.ws.close(); } catch (_) {}
  }
  sess.ws = ws;

  ws.send(JSON.stringify({
    type: 'status', state: 'running',
    session: sess.id, model: sess.model, cwd: sess.cwd, reattached: !!reattached,
  }));

  // Replay recent output so a refreshed client gets its scrollback back.
  if (reattached && sess.buffer.length) {
    const replay = sess.buffer.join('');
    if (replay) ws.send(Buffer.from(replay, 'utf8'));
  }

  // Match the PTY to the (possibly new) viewport.
  if (cols && rows) { try { sess.term.resize(cols, rows); } catch (_) {} }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      try { sess.term.write(msg.data); } catch (_) {}
    } else if (msg.type === 'resize' && msg.cols && msg.rows) {
      try { sess.term.resize(msg.cols, msg.rows); } catch (_) {}
    }
  });

  ws.on('close', () => {
    // Keep the PTY alive across refreshes — only detach this socket.
    if (sess.ws === ws) sess.ws = null;
  });
}

function spawnSession(id, { model, cwd, cols, rows }) {
  const term = pty.spawn(shell, buildArgs(model), {
    name: 'xterm-256color', cols, rows, cwd, env: process.env,
  });
  const sess = {
    id, term, model, cwd, ws: null,
    buffer: [], bufferBytes: 0,
    createdAt: Date.now(),
  };
  ptySessions.set(id, sess);

  sess.onData = term.onData(d => {
    bufferOutput(sess, d);
    if (sess.ws && sess.ws.readyState === sess.ws.OPEN) sess.ws.send(Buffer.from(d, 'utf8'));
  });
  sess.onExit = term.onExit(({ exitCode }) => {
    if (sess.ws && sess.ws.readyState === sess.ws.OPEN) {
      sess.ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
    }
    disposeSession(sess);
  });
  return sess;
}

function handlePtyConnection(ws, req) {
  // require a valid session — the browser sends the cookie on the handshake
  if (!getSession(req)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
    ws.close();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const sessionId = (url.searchParams.get('session') || '').trim();
  const mode = (url.searchParams.get('mode') || 'create').trim(); // 'create' | 'attach'
  const cols = parseInt(url.searchParams.get('cols'), 10) || 100;
  const rows = parseInt(url.searchParams.get('rows'), 10) || 30;

  // Reattach to a process that's still running for this id (the refresh case).
  if (sessionId && ptySessions.has(sessionId)) {
    if (mode === 'create') {
      // An explicit (re)launch for a live id replaces the old process.
      const old = ptySessions.get(sessionId);
      try { old.term.kill(); } catch (_) {}
      if (old.ws && old.ws !== ws) { try { old.ws.close(); } catch (_) {} }
      disposeSession(old);
    } else {
      attachSocket(ptySessions.get(sessionId), ws, { cols, rows, reattached: true });
      return;
    }
  }

  // Attach-only, but nothing is running — tell the client so it can offer a relaunch.
  if (mode === 'attach') {
    ws.send(JSON.stringify({ type: 'gone', message: 'Session is no longer running' }));
    ws.close();
    return;
  }

  // Create a fresh session.
  const model = (url.searchParams.get('model') || 'qwen2.5-coder:7b').trim();
  let cwd = url.searchParams.get('cwd') || os.homedir();
  if (!cwd || !fs.existsSync(cwd)) cwd = os.homedir();

  // basic guard against absurd model strings going onto a shell line
  if (!/^[\w.:\-\/]+$/.test(model)) {
    ws.send(JSON.stringify({ type: 'error', message: `Invalid model name: ${model}` }));
    ws.close();
    return;
  }

  const id = sessionId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  let sess;
  try {
    sess = spawnSession(id, { model, cwd, cols, rows });
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: String(e && e.message || e) }));
    ws.close();
    return;
  }
  attachSocket(sess, ws, { cols, rows, reattached: false });
}

wss.on('connection', handlePtyConnection);

// List the PTY sessions that are still running, so the client can tell which saved
// sidebar entries can be reattached versus relaunched.
app.get('/api/pty/sessions', (req, res) => {
  const items = [];
  for (const s of ptySessions.values()) {
    items.push({ id: s.id, model: s.model, cwd: s.cwd, createdAt: s.createdAt });
  }
  res.json({ ok: true, sessions: items });
});

// Kill a running session (terminate the agent process) and forget it. Used when the
// user removes a session from the sidebar.
app.post('/api/pty/:id/kill', (req, res) => {
  const sess = ptySessions.get(req.params.id);
  if (!sess) return res.json({ ok: true, killed: false });
  try { sess.term.kill(); } catch (_) {}
  if (sess.ws) { try { sess.ws.close(); } catch (_) {} }
  disposeSession(sess);
  res.json({ ok: true, killed: true });
});

ensureUsersFile();

const tailscaleIP = getTailscaleIPv4();

// Bind a second listener on the Tailscale IP so devices on the tailnet can reach the
// UI, while localhost stays bound for the local GUI. Reuses the same app + PTY handler.
if (tailscaleIP && tailscaleIP !== HOST) {
  const tsServer = http.createServer(app);
  const tsWss = new WebSocketServer({ server: tsServer, path: '/pty' });
  tsWss.on('connection', handlePtyConnection);
  tsServer.on('error', (e) => {
    console.warn(`  ⚠  Could not bind Tailscale address ${tailscaleIP}:${PORT} — ${(e && e.message) || e}`);
  });
  tsServer.listen(PORT, tailscaleIP);
}

server.listen(PORT, HOST, () => {
  const users = loadUsers();
  console.log(`\n  Claude Code Web UI  →  http://${HOST}:${PORT}\n`);
  console.log(`  Backend: ollama launch claude   |   Ollama API: ${OLLAMA_URL}`);
  if (tailscaleIP && tailscaleIP !== HOST) {
    console.log(`  Also on Tailscale  →  http://${tailscaleIP}:${PORT}  (reachable by devices on your tailnet)`);
  } else {
    console.log(`  Bound to ${HOST} only (Tailscale not detected — not exposed to your network).`);
  }
  console.log(`  Accounts (${users.length}): ${users.map(u => u.username).join(', ')}`);
  console.log(`  Edit ${USERS_FILE} to add users or change passwords.`);
  if (users.some(u => u.password === 'admin')) {
    console.log(`  ⚠  An account still uses the password "admin" — change it in users.json.`);
  }
  console.log('');
});
