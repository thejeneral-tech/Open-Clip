'use strict';
// Atomic file writes — ported from Odysseus core/atomic_io.py.
// A plain writeFileSync truncates first, so a crash mid-write loses data. We write
// to a sibling tmp file (PID-suffixed so concurrent writers don't collide), fsync,
// then rename into place (atomic on the same filesystem).
const fs = require('node:fs');
const path = require('node:path');

function atomicWriteText(p, text) {
  fs.mkdirSync(path.dirname(p) || '.', { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p);
}

function atomicWriteJson(p, data, indent = 2) {
  atomicWriteText(p, JSON.stringify(data, null, indent));
}

function readJson(p, fallback = null) {
  // Strip a UTF-8 BOM — PowerShell's Set-Content -Encoding utf8 (PS 5.1) prepends
  // one (char code 0xFEFF), and JSON.parse rejects a leading BOM.
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return fallback; }
}

module.exports = { atomicWriteText, atomicWriteJson, readJson };
