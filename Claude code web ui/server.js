'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

const PORT = process.env.PORT || 7878;
const HOST = '127.0.0.1'; // localhost only — this app can run shell commands on your machine
const OLLAMA_URL = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

const isWin = process.platform === 'win32';
const shell = isWin ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/bash');

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
  res.json({ cwd: process.env.CLAUDE_CWD || process.cwd(), home: os.homedir() });
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
    cwd: process.env.CLAUDE_CWD || process.cwd(),
    contextWindow: 32768,
  });
});

// pick the active model (the picker calls this; we use it as the chat model)
app.post('/api/config', (req, res) => {
  const model = req.body && req.body.model;
  if (model && typeof model === 'string') chatModel = model;
  res.json({ ok: true, provider: 'ollama', model: chatModel, baseUrl: OLLAMA_URL });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/pty' });

function buildArgs(model) {
  const cmd = `ollama launch claude --model ${model} -y`;
  return isWin ? ['/c', cmd] : ['-lc', cmd];
}

wss.on('connection', (ws, req) => {
  // require a valid session — the browser sends the cookie on the handshake
  if (!getSession(req)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
    ws.close();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const model = (url.searchParams.get('model') || 'qwen2.5-coder:7b').trim();
  let cwd = url.searchParams.get('cwd') || os.homedir();
  if (!cwd || !fs.existsSync(cwd)) cwd = os.homedir();
  const cols = parseInt(url.searchParams.get('cols'), 10) || 100;
  const rows = parseInt(url.searchParams.get('rows'), 10) || 30;

  // basic guard against absurd model strings going onto a shell line
  if (!/^[\w.:\-\/]+$/.test(model)) {
    ws.send(JSON.stringify({ type: 'error', message: `Invalid model name: ${model}` }));
    ws.close();
    return;
  }

  let term;
  try {
    term = pty.spawn(shell, buildArgs(model), {
      name: 'xterm-256color', cols, rows, cwd, env: process.env,
    });
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: String(e && e.message || e) }));
    ws.close();
    return;
  }

  ws.send(JSON.stringify({ type: 'status', state: 'running', model, cwd }));

  const onData = term.onData(d => {
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(d, 'utf8'));
  });
  const onExit = term.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
    try { ws.close(); } catch (_) {}
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      term.write(msg.data);
    } else if (msg.type === 'resize' && msg.cols && msg.rows) {
      try { term.resize(msg.cols, msg.rows); } catch (_) {}
    }
  });

  ws.on('close', () => {
    onData.dispose();
    onExit.dispose();
    try { term.kill(); } catch (_) {}
  });
});

ensureUsersFile();

server.listen(PORT, HOST, () => {
  const users = loadUsers();
  console.log(`\n  Claude Code Web UI  →  http://${HOST}:${PORT}\n`);
  console.log(`  Backend: ollama launch claude   |   Ollama API: ${OLLAMA_URL}`);
  console.log(`  Bound to ${HOST} only (not exposed to your network).`);
  console.log(`  Accounts (${users.length}): ${users.map(u => u.username).join(', ')}`);
  console.log(`  Edit ${USERS_FILE} to add users or change passwords.`);
  if (users.some(u => u.password === 'admin')) {
    console.log(`  ⚠  An account still uses the password "admin" — change it in users.json.`);
  }
  console.log('');
});
