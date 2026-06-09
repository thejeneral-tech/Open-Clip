'use strict';
const db = require('../db/database');
const { DEFAULT_PREFERENCES } = require('../constants');

function get() {
  const row = db.get('SELECT data FROM preferences WHERE id = 1');
  if (!row) return { ...DEFAULT_PREFERENCES };
  try { return { ...DEFAULT_PREFERENCES, ...JSON.parse(row.data) }; }
  catch { return { ...DEFAULT_PREFERENCES }; }
}

function update(patch) {
  const merged = { ...get(), ...patch };
  db.run('UPDATE preferences SET data = ?, updated_at = ? WHERE id = 1', [JSON.stringify(merged), db.nowIso()]);
  return merged;
}

module.exports = { get, update };
