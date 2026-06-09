'use strict';
// Encrypt-at-rest for account secrets (Reddit client id/secret, session blobs).
// Mirrors Odysseus's principle: secrets are NEVER stored in plaintext and NEVER logged.
// AES-256-GCM with a 32-byte key persisted once to a 0600 key file (gitignored),
// written atomically. If STORYVAULT_SECRET_KEY (64 hex chars) is set, it is used instead.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PATHS } = require('../config');
const { atomicWriteText } = require('./atomicIo');

const KEY_FILE = path.join(PATHS.database, 'secret.key');
let KEY = null;

function getKey() {
  if (KEY) return KEY;
  const envKey = process.env.STORYVAULT_SECRET_KEY;
  if (envKey && /^[0-9a-f]{64}$/i.test(envKey.trim())) { KEY = Buffer.from(envKey.trim(), 'hex'); return KEY; }
  try {
    if (fs.existsSync(KEY_FILE)) {
      const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) { KEY = Buffer.from(hex, 'hex'); return KEY; }
    }
  } catch { /* regenerate below */ }
  KEY = crypto.randomBytes(32);
  atomicWriteText(KEY_FILE, KEY.toString('hex'));
  try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* best effort on Windows */ }
  return KEY;
}

function encrypt(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(blob) {
  if (!blob) return null;
  try {
    const raw = Buffer.from(String(blob).replace(/^v1:/, ''), 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch { return null; }
}

// Mask a secret for any human-facing surface (never log full secrets).
function redact(s) {
  if (!s) return '';
  const str = String(s);
  return str.length <= 6 ? '••••' : str.slice(0, 2) + '••••' + str.slice(-2);
}

module.exports = { encrypt, decrypt, redact };
