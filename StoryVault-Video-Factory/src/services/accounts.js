'use strict';
// Reddit / Quora account store. Secrets are encrypted at rest (src/util/secrets.js)
// and never returned to the client or written to logs — only a `hasSecret` flag.
const db = require('../db/database');
const { id } = require('../util/ids');
const secrets = require('../util/secrets');
const log = require('./logger');

function hydrate(row) {
  if (!row) return null;
  let meta = {}; try { meta = JSON.parse(row.meta || '{}'); } catch { /* */ }
  return {
    id: row.id, platform: row.platform, label: row.label, method: row.method,
    username: row.username, status: row.status, scopes: row.scopes,
    lastOkAt: row.last_ok_at, lastError: row.last_error, tokenExpiresAt: row.token_expires_at,
    hasSecret: !!row.token_enc, meta,
  };
}

function list(platform) {
  const rows = platform
    ? db.all('SELECT * FROM accounts WHERE platform = ? ORDER BY created_at DESC', [platform])
    : db.all('SELECT * FROM accounts ORDER BY created_at DESC');
  return rows.map(hydrate);
}
function rawByPlatform(platform) { return db.get('SELECT * FROM accounts WHERE platform = ? ORDER BY created_at DESC LIMIT 1', [platform]); }

// Store Reddit OAuth app credentials (client id + secret) encrypted at rest.
function connectReddit({ clientId, clientSecret, label } = {}) {
  clientId = (clientId || '').trim(); clientSecret = (clientSecret || '').trim();
  if (!clientId || !clientSecret) throw new Error('Reddit client ID and secret are both required.');
  const enc = secrets.encrypt(JSON.stringify({ clientId, clientSecret }));
  const now = db.nowIso();
  const existing = rawByPlatform('reddit');
  if (existing) {
    db.update('accounts', existing.id, { method: 'oauth', label: label || existing.label, token_enc: enc, status: 'configured', last_error: null, updated_at: now });
    log.activity('SYSTEM', 'Reddit credentials saved (encrypted at rest).', { level: 'success' });
    return hydrate(rawByPlatform('reddit'));
  }
  const aid = 'acct_' + id('a');
  db.insert('accounts', { id: aid, platform: 'reddit', label: label || 'Reddit app', method: 'oauth', username: null, status: 'configured', token_enc: enc, token_expires_at: null, scopes: 'read', last_ok_at: null, last_error: null, meta: '{}', created_at: now, updated_at: now });
  log.activity('SYSTEM', 'Reddit credentials saved (encrypted at rest).', { level: 'success' });
  return hydrate(db.get('SELECT * FROM accounts WHERE id = ?', [aid]));
}

// Resolve usable Reddit creds: env wins, else the stored (decrypted) account.
function getRedditCreds() {
  if (process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET) {
    return { clientId: process.env.REDDIT_CLIENT_ID, clientSecret: process.env.REDDIT_CLIENT_SECRET, source: 'env' };
  }
  const row = rawByPlatform('reddit');
  if (row && row.token_enc) {
    try { const c = JSON.parse(secrets.decrypt(row.token_enc) || '{}'); if (c.clientId && c.clientSecret) return { ...c, source: 'account' }; } catch { /* */ }
  }
  return null;
}

async function testReddit() {
  const creds = getRedditCreds();
  const row = rawByPlatform('reddit');
  const reddit = require('./sources/reddit');
  if (!creds) return { ok: false, status: 'Limited', detail: 'No Reddit credentials configured — anonymous mode (rate-limited). Add a client ID/secret for reliable access.' };
  try {
    await reddit.fetchCommunity('AmItheAsshole', { limit: 1 });
    if (row) db.update('accounts', row.id, { status: 'connected', last_ok_at: db.nowIso(), last_error: null, updated_at: db.nowIso() });
    return { ok: true, status: 'Connected', detail: `Reddit OAuth verified (${creds.source}).` };
  } catch (e) {
    if (row) db.update('accounts', row.id, { status: 'error', last_error: e.message, updated_at: db.nowIso() });
    return { ok: false, status: 'Error', detail: e.message };
  }
}

// Quora has no open story API — record that this install uses the manual-import path.
function connectQuoraManual() {
  const now = db.nowIso();
  const existing = rawByPlatform('quora');
  if (existing) { db.update('accounts', existing.id, { status: 'connected', last_ok_at: now, updated_at: now }); return hydrate(rawByPlatform('quora')); }
  const aid = 'acct_' + id('a');
  db.insert('accounts', { id: aid, platform: 'quora', label: 'Quora (manual import)', method: 'manual_import', username: null, status: 'connected', token_enc: null, token_expires_at: null, scopes: null, last_ok_at: now, last_error: null, meta: '{}', created_at: now, updated_at: now });
  return hydrate(db.get('SELECT * FROM accounts WHERE id = ?', [aid]));
}

function disconnect(platform) {
  const row = rawByPlatform(platform);
  if (row) { db.run('DELETE FROM accounts WHERE id = ?', [row.id]); log.activity('SYSTEM', `${platform} account disconnected.`); }
  return { ok: true };
}

module.exports = { list, connectReddit, getRedditCreds, testReddit, connectQuoraManual, disconnect };
