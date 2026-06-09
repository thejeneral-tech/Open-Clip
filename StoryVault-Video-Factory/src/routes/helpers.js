'use strict';
const path = require('node:path');
const { PATHS } = require('../config');
const log = require('../services/logger');

// Wrap async route handlers so rejected promises become clean 4xx/5xx JSON.
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Convert an absolute path under data/ into a browser URL served at /media/...
function mediaUrl(absPath) {
  if (!absPath) return null;
  const rel = path.relative(PATHS.data, absPath);
  if (rel.startsWith('..')) return null;
  return '/media/' + rel.split(path.sep).join('/');
}

// Recursively add *_url fields for known media path keys so the UI can render them.
function withMedia(obj) {
  if (Array.isArray(obj)) return obj.map(withMedia);
  if (obj && typeof obj === 'object') {
    const out = { ...obj };
    const keys = { thumbnail: 'thumbnail_url', preview_path: 'preview_url', render_path: 'render_url', path: 'file_url', ass_path: 'ass_url', srt_path: 'srt_url', output_path: 'output_url' };
    for (const [k, urlKey] of Object.entries(keys)) {
      if (typeof out[k] === 'string' && out[k].includes(PATHS.data)) out[urlKey] = mediaUrl(out[k]);
    }
    for (const k of Object.keys(out)) if (out[k] && typeof out[k] === 'object') out[k] = withMedia(out[k]);
    return out;
  }
  return obj;
}

// Express error handler → consistent JSON, logged once.
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const code = err.status || (/(not found|missing|no such)/i.test(err.message) ? 404 : 400);
  if (code >= 500) log.error('SYSTEM', `${req.method} ${req.path}: ${err.message}`, err.stack);
  res.status(code).json({ error: err.message || 'Request failed' });
}

module.exports = { wrap, mediaUrl, withMedia, errorHandler };
