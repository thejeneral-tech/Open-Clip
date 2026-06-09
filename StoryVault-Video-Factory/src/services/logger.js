'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db/database');
const { id } = require('../util/ids');
const { PATHS } = require('../config');

// Central event bus: services emit activity, the HTTP layer streams it to the UI
// over Server-Sent Events (spec §23 live activity log).
const bus = new EventEmitter();
bus.setMaxListeners(100);

function logFilePath() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(PATHS.logs, `activity-${day}.log`);
}

function activity(tag, message, opts = {}) {
  const level = opts.level || 'info';
  const refId = opts.refId || null;
  const row = {
    id: id('act'),
    tag: String(tag || 'SYSTEM').toUpperCase(),
    message: String(message),
    level,
    ref_id: refId,
    created_at: db.nowIso(),
  };
  try { db.insert('activity', row); } catch { /* never let logging break a job */ }
  const line = `[${row.created_at}] [${row.tag}] ${row.message}`;
  try { fs.appendFileSync(logFilePath(), line + '\n'); } catch { /* ignore */ }
  bus.emit('activity', row);
  return row;
}

function error(scope, message, detail, refId) {
  const row = {
    id: id('err'),
    scope: scope || 'SYSTEM',
    message: String(message),
    detail: detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null,
    ref_id: refId || null,
    created_at: db.nowIso(),
  };
  try { db.insert('errors', row); } catch { /* ignore */ }
  activity(scope || 'SYSTEM', message, { level: 'error', refId });
  return row;
}

// Emit a progress event for a specific entity (batch item, render job, etc.).
function progress(channel, payload) {
  bus.emit('progress', { channel, ...payload, at: db.nowIso() });
}

function recent(limit = 200) {
  return db.all('SELECT * FROM activity ORDER BY created_at DESC LIMIT ?', [limit]);
}

module.exports = { bus, activity, error, progress, recent };
