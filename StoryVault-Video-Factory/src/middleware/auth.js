'use strict';
// Login gate for /api/* — validates the session cookie, exempting the auth
// endpoints and a few public ones. Honors AUTH_ENABLED / LOCALHOST_BYPASS.
// Manual cookie parsing keeps the zero-extra-dependency posture.
const auth = require('../services/auth');
const { AUTH } = require('../config');

// Paths (relative to the /api mount) that never require a session.
const EXEMPT = new Set(['/version', '/health']);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function readToken(req) { return parseCookies(req.headers.cookie)[AUTH.cookieName] || null; }

function isLoopback(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers.forwarded) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Express middleware mounted as app.use('/api', gate). req.path is the path AFTER
// the /api prefix (e.g. '/meta'); /api/auth/* is handled by its own router first.
function gate(req, res, next) {
  if (!AUTH.enabled) { req.user = null; return next(); }
  if (req.path.startsWith('/auth') || EXEMPT.has(req.path)) return next();
  if (AUTH.localhostBypass && isLoopback(req)) { req.user = { bypass: true }; return next(); }
  const who = auth.validateToken(readToken(req));
  if (!who) return res.status(401).json({ error: 'Not authenticated' });
  req.user = who;
  next();
}

module.exports = { gate, readToken, parseCookies };
