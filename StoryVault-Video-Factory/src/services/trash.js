'use strict';
// Generic soft-delete (trash bin) used across Story Library, Footage, Templates, Exports,
// and Voices. Soft-delete sets deleted_at; restore clears it; purge removes the row (and any
// on-disk files named by fileCols). Lists/queries elsewhere add `deleted_at IS NULL`.
const fs = require('node:fs');
const db = require('../db/database');

function softDelete(table, ids) {
  let n = 0;
  for (const id of [].concat(ids || [])) { db.update(table, id, { deleted_at: db.nowIso() }); n++; }
  return n;
}
function restore(table, ids) {
  let n = 0;
  for (const id of [].concat(ids || [])) { db.update(table, id, { deleted_at: null }); n++; }
  return n;
}
function purge(table, ids, fileCols = []) {
  let n = 0;
  for (const id of [].concat(ids || [])) {
    const row = db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (!row) continue;
    for (const col of fileCols) { const p = row[col]; if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* */ } } }
    db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
    n++;
  }
  return n;
}
function listTrash(table, limit = 200) {
  return db.all(`SELECT * FROM ${table} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?`, [limit]);
}
// Empty the whole trash for a table (purge everything soft-deleted).
function emptyTrash(table, fileCols = []) {
  const ids = db.all(`SELECT id FROM ${table} WHERE deleted_at IS NOT NULL`).map((r) => r.id);
  return purge(table, ids, fileCols);
}

module.exports = { softDelete, restore, purge, listTrash, emptyTrash };
