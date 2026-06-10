'use strict';
// Authentication endpoints (public router, mounted before the /api gate).
const express = require('express');
const { wrap } = require('./helpers');
const auth = require('../services/auth');
const { readToken } = require('../middleware/auth');
const { AUTH } = require('../config');

const router = express.Router();

function setSessionCookie(res, token, remember) {
  res.cookie(AUTH.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: String(process.env.SECURE_COOKIES || '').toLowerCase() === 'true',
    ...(remember === false ? {} : { maxAge: AUTH.sessionTtlMs }),
  });
}
function currentUser(req) { return auth.validateToken(readToken(req)); }
function requireAuth(req) { const who = currentUser(req); if (!who) { const e = new Error('Not authenticated'); e.status = 401; throw e; } return who; }
function requireAdmin(req) { const who = requireAuth(req); if (!who.is_admin) { const e = new Error('Admins only.'); e.status = 403; throw e; } return who; }

// First-run admin creation.
router.post('/setup', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  auth.setup({ username, password });
  res.json({ ok: true, message: 'Admin account created. Please sign in.' });
}));

// Open signup (only when an admin has enabled it).
router.post('/signup', wrap(async (req, res) => {
  if (!auth.isConfigured()) { res.status(400); throw new Error('Not configured yet.'); }
  if (!auth.signupEnabled()) { res.status(403); throw new Error('Signup is disabled.'); }
  const { username, password } = req.body || {};
  auth.createUser({ username, password, isAdmin: false });
  res.json({ ok: true, message: 'Account created. Please sign in.' });
}));

router.post('/login', wrap(async (req, res) => {
  const { username, password, remember } = req.body || {};
  const r = auth.login({ username, password });
  setSessionCookie(res, r.token, remember);
  res.json({ ok: true, username: r.username, is_admin: r.is_admin });
}));

router.post('/logout', wrap(async (req, res) => {
  auth.revokeToken(readToken(req));
  res.clearCookie(AUTH.cookieName, { path: '/' });
  res.json({ ok: true });
}));

router.get('/status', wrap(async (req, res) => res.json(auth.getStatus(readToken(req)))));

router.post('/change-password', wrap(async (req, res) => {
  const who = requireAuth(req);
  const { current_password, new_password } = req.body || {};
  auth.changePassword(who.userId, current_password, new_password);
  auth.revokeUserSessions(who.userId, readToken(req)); // keep current session, drop the rest
  res.json({ ok: true });
}));

// --- Admin: user management ---
router.get('/users', wrap(async (req, res) => { requireAdmin(req); res.json({ users: auth.listUsers() }); }));
router.post('/users', wrap(async (req, res) => {
  requireAdmin(req);
  const { username, password, is_admin } = req.body || {};
  auth.createUser({ username, password, isAdmin: !!is_admin });
  res.json({ ok: true });
}));
router.delete('/users', wrap(async (req, res) => {
  const who = requireAdmin(req);
  auth.deleteUser((req.body || {}).username, who.userId);
  res.json({ ok: true });
}));
router.put('/users/:u/rename', wrap(async (req, res) => {
  requireAdmin(req);
  const r = auth.renameUser(req.params.u, (req.body || {}).username);
  res.json(r);
}));
router.put('/open-signup', wrap(async (req, res) => {
  requireAdmin(req);
  res.json({ ok: true, signup_enabled: auth.setSignupEnabled(!!(req.body || {}).enabled) });
}));

module.exports = router;
