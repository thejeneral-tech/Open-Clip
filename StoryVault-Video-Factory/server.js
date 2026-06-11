'use strict';
// StoryVault Video Factory — HTTP server entry point.
const express = require('express');
const path = require('node:path');
const { SERVER, PATHS, ensureDirs } = require('./src/config');
const db = require('./src/db/database');
const log = require('./src/services/logger');
const { errorHandler } = require('./src/routes/helpers');

ensureDirs();
db.getDb(); // initialise schema + seed on boot

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

// Public auth endpoints (login/setup/status) — no gate.
app.use('/api/auth', require('./src/routes/auth'));
// Login gate: everything else under /api requires a session (when AUTH_ENABLED).
app.use('/api', require('./src/middleware/auth').gate);

// Protected API routes
app.use('/api', require('./src/routes/meta'));
app.use('/api', require('./src/routes/discovery'));
app.use('/api', require('./src/routes/library'));
app.use('/api', require('./src/routes/production'));
app.use('/api', require('./src/routes/voice'));
app.use('/api', require('./src/routes/llm'));

// Serve generated media (previews, renders, thumbnails) read-only.
app.use('/media', express.static(PATHS.data, {
  setHeaders: (res, p) => { if (p.endsWith('.mp4')) res.set('Accept-Ranges', 'bytes'); },
}));

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// JSON 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` }));
app.use(errorHandler);

let server;
function startServer(attempt = 0) {
  server = app.listen(SERVER.port, SERVER.host, () => {
    log.activity('SYSTEM', `StoryVault Video Factory running at http://${SERVER.host}:${SERVER.port}`, { level: 'success' });
    // eslint-disable-next-line no-console
    console.log(`\n  🎬 StoryVault Video Factory\n  → http://${SERVER.host}:${SERVER.port}\n`);
    // Phase 5 restart recovery: resume interrupted jobs/batches + stuck render jobs from
    // their last completed stage (spec §16/§17). Non-fatal — never block startup.
    try { require('./src/services/batch').recoverInterrupted(); } catch (e) { log.error('SYSTEM', `Batch recovery failed: ${e.message}`); }
    try { require('./src/services/systemStatus').resumeFailedJobs(); } catch (e) { log.error('SYSTEM', `Render-job recovery failed: ${e.message}`); }
  });
  // Without this, an EADDRINUSE bubbles up to the uncaughtException handler below,
  // which only logs — leaving a process that is alive but NOT listening (a zombie
  // server that looks up but serves nothing). Handle the listen error explicitly.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // A previous instance may still be releasing the port — common when `npm run dev`
      // (--watch) restarts the server on a file change. Retry briefly, then give up with
      // a clear message instead of zombie-ing.
      if (attempt < 5) {
        log.activity('SYSTEM', `Port ${SERVER.port} busy, retrying (${attempt + 1}/5)…`, { level: 'warning' });
        setTimeout(() => startServer(attempt + 1), 600);
        return;
      }
      log.error('SYSTEM', `Port ${SERVER.port} is already in use. Another StoryVault instance is probably running — close it (or set PORT to a free port) and start again.`);
    } else {
      log.error('SYSTEM', `Server failed to start: ${err.message}`, err.stack);
    }
    process.exit(1);
  });
}
startServer();

process.on('SIGINT', () => { log.activity('SYSTEM', 'Shutting down.'); if (server) server.close(() => process.exit(0)); else process.exit(0); });
process.on('uncaughtException', (e) => log.error('SYSTEM', `Uncaught: ${e.message}`, e.stack));
process.on('unhandledRejection', (e) => log.error('SYSTEM', `Unhandled rejection: ${e?.message || e}`));

module.exports = app;
