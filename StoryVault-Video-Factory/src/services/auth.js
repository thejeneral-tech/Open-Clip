'use strict';
/**
 * User authentication — multi-user with admin/user roles, first-run admin setup,
 * 7-day sessions, change-password and admin user management.
 *
 * Backed by a plain JSON file (data/auth.json), written atomically, and Node's
 * built-in scrypt (no bcrypt dependency). Distinct from the source-`accounts.js`
 * (Reddit/Quora credentials).
 *
 * Store shape (data/auth.json):
 *   { "users": [ { id, username, password_hash, is_admin, status, created_at, last_login_at } ],
 *     "sessions": [ { token, user_id, created_at, expires_at } ],
 *     "meta": { "signup_enabled": false } }
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { PATHS, AUTH } = require('../config');
const { id } = require('../util/ids');
const { atomicWriteJson, readJson } = require('../util/atomicIo');
const log = require('./logger');

const STORE_FILE = path.join(PATHS.data, 'auth.json');
const RESERVED = new Set(['internal-tool', 'api', 'system', 'admin-internal']);

function nowIso() { return new Date().toISOString(); }

// ── JSON store (data/auth.json) ────────────────────────────────────────────────
// Loaded once into memory and write-through on every mutation (this process is the
// only writer). atomicWriteJson writes to a tmp sibling + rename, so a crash
// mid-write never corrupts the file.
let store = null;

function emptyStore() { return { users: [], sessions: [], meta: { signup_enabled: false } }; }

function load() {
  if (store) return store;
  const raw = readJson(STORE_FILE, null);
  store = raw && typeof raw === 'object' ? raw : emptyStore();
  if (!Array.isArray(store.users)) store.users = [];
  if (!Array.isArray(store.sessions)) store.sessions = [];
  if (!store.meta || typeof store.meta !== 'object') store.meta = { signup_enabled: false };
  return store;
}

function save() { atomicWriteJson(STORE_FILE, load()); }

// ── password hashing (scrypt, timing-safe) ────────────────────────────────────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `s1$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [v, saltHex, hashHex] = String(stored).split('$');
    if (v !== 's1' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

function normUser(u) { return String(u || '').trim().toLowerCase(); }
function validUsername(u) {
  if (!u || u.length < 2 || u.length > 32) return false;
  if (RESERVED.has(u)) return false;
  return /^[a-z0-9_.-]+$/.test(u);
}

// ── meta (signup toggle) ──────────────────────────────────────────────────────
function signupEnabled() { return !!load().meta.signup_enabled; }
function setSignupEnabled(on) { load().meta.signup_enabled = !!on; save(); return signupEnabled(); }

// ── users ─────────────────────────────────────────────────────────────────────
function isConfigured() { return load().users.length > 0; }
function findUser(username) { const u = normUser(username); return load().users.find((x) => x.username === u) || null; }

function createUser({ username, password, isAdmin = false } = {}) {
  const u = normUser(username);
  if (!validUsername(u)) throw new Error('Username must be 2–32 chars: letters, numbers, _.- only.');
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters.');
  if (findUser(u)) throw new Error('That username is already taken.');
  const user = { id: id('user'), username: u, password_hash: hashPassword(password), is_admin: !!isAdmin, status: 'active', created_at: nowIso(), last_login_at: null };
  load().users.push(user);
  save();
  log.activity('AUTH', `User created: ${u}${isAdmin ? ' (admin)' : ''}`, { level: 'success' });
  return { id: user.id, username: u, is_admin: !!isAdmin };
}

// First-run only: creates the initial admin. Fails if any user already exists.
function setup({ username, password } = {}) {
  if (isConfigured()) throw new Error('Already configured.');
  return createUser({ username, password, isAdmin: true });
}

function listUsers() {
  return load().users
    .slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((r) => ({ id: r.id, username: r.username, is_admin: !!r.is_admin, created_at: r.created_at, last_login_at: r.last_login_at }));
}

function deleteUser(username, byUserId) {
  const target = findUser(username);
  if (!target) throw new Error('User not found.');
  if (target.id === byUserId) throw new Error('You cannot delete your own account.');
  const s = load();
  s.sessions = s.sessions.filter((x) => x.user_id !== target.id);
  s.users = s.users.filter((x) => x.id !== target.id);
  save();
  log.activity('AUTH', `User deleted: ${target.username}`, { level: 'warn' });
  return { ok: true };
}

function renameUser(oldUsername, newUsername) {
  const target = findUser(oldUsername);
  if (!target) throw new Error('User not found.');
  const nu = normUser(newUsername);
  if (!validUsername(nu)) throw new Error('Invalid new username.');
  if (findUser(nu)) throw new Error('That username is already taken.');
  target.username = nu;
  save();
  return { ok: true, username: nu };
}

function changePassword(userId, currentPassword, newPassword) {
  const user = load().users.find((x) => x.id === userId);
  if (!user) throw new Error('Not signed in.');
  if (!verifyPassword(currentPassword, user.password_hash)) throw new Error('Current password is incorrect.');
  if (String(newPassword || '').length < 8) throw new Error('New password must be at least 8 characters.');
  user.password_hash = hashPassword(newPassword);
  save();
  return { ok: true };
}

// ── sessions ──────────────────────────────────────────────────────────────────
function pruneExpired(s, now) {
  const before = s.sessions.length;
  s.sessions = s.sessions.filter((x) => new Date(x.expires_at).getTime() > now);
  return s.sessions.length !== before;
}

function login({ username, password } = {}) {
  const user = findUser(username);
  if (!user || !verifyPassword(password, user.password_hash)) throw new Error('Invalid username or password.');
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const s = load();
  s.sessions.push({ token, user_id: user.id, created_at: new Date(now).toISOString(), expires_at: new Date(now + AUTH.sessionTtlMs).toISOString() });
  user.last_login_at = nowIso();
  pruneExpired(s, now);
  save();
  log.activity('AUTH', `Signed in: ${user.username}`, { level: 'success' });
  return { token, username: user.username, is_admin: !!user.is_admin };
}

function validateToken(token) {
  if (!token) return null;
  const s = load();
  const sess = s.sessions.find((x) => x.token === token);
  if (!sess) return null;
  if (new Date(sess.expires_at).getTime() <= Date.now()) { revokeToken(token); return null; }
  const user = s.users.find((x) => x.id === sess.user_id);
  if (!user) { revokeToken(token); return null; }
  return { userId: user.id, username: user.username, is_admin: !!user.is_admin };
}

function revokeToken(token) {
  if (!token) return;
  const s = load();
  const before = s.sessions.length;
  s.sessions = s.sessions.filter((x) => x.token !== token);
  if (s.sessions.length !== before) save();
}

function revokeUserSessions(userId, exceptToken) {
  const s = load();
  const before = s.sessions.length;
  s.sessions = s.sessions.filter((x) => x.user_id !== userId || (exceptToken && x.token === exceptToken));
  if (s.sessions.length !== before) save();
}

// Status object for /api/auth/status.
function getStatus(token) {
  const configured = isConfigured();
  const who = token ? validateToken(token) : null;
  return {
    configured,
    authenticated: !!who,
    username: who ? who.username : null,
    is_admin: who ? who.is_admin : false,
    signup_enabled: signupEnabled(),
    auth_enabled: AUTH.enabled,
  };
}

module.exports = {
  hashPassword, verifyPassword, isConfigured, findUser, createUser, setup, listUsers, deleteUser, renameUser,
  changePassword, login, validateToken, revokeToken, revokeUserSessions, signupEnabled, setSignupEnabled, getStatus,
};
