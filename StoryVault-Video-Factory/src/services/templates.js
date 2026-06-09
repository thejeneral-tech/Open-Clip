'use strict';
// Template store (spec "REFERENCE-BASED TEMPLATE SYSTEM"). Built-ins are seeded by the
// migration; users can create/edit/delete their own. Built-ins cannot be deleted.
const db = require('../db/database');
const { id } = require('../util/ids');
const { REFERENCE_TEMPLATE } = require('../templates-data');

function hydrate(row) {
  if (!row) return null;
  let data = {}; try { data = JSON.parse(row.data); } catch {}
  return { ...data, id: row.id, name: row.name, builtin: !!row.builtin, isDefault: !!row.is_default };
}

function list({ trash } = {}) {
  const where = trash ? 'WHERE deleted_at IS NOT NULL' : 'WHERE deleted_at IS NULL';
  return db.all(`SELECT * FROM templates ${where} ORDER BY is_default DESC, builtin DESC, name`).map(hydrate);
}
function get(tplId) {
  return hydrate(db.get('SELECT * FROM templates WHERE id = ?', [tplId]));
}
function getDefault() {
  return hydrate(db.get('SELECT * FROM templates WHERE is_default = 1 LIMIT 1')) || REFERENCE_TEMPLATE;
}
// Resolve an id (or undefined) to a full template config; falls back to the default.
function resolve(tplId) {
  if (!tplId) return getDefault();
  return get(tplId) || getDefault();
}

function create(name, data) {
  const tid = 'tpl_' + id('t');
  const now = db.nowIso();
  db.insert('templates', { id: tid, name: name || 'Untitled template', builtin: 0, is_default: 0, data: JSON.stringify({ ...data, id: tid, name }), created_at: now, updated_at: now });
  return get(tid);
}
function update(tplId, patch) {
  const row = db.get('SELECT * FROM templates WHERE id = ?', [tplId]);
  if (!row) throw new Error('Template not found.');
  const merged = { ...hydrate(row), ...patch };
  db.update('templates', tplId, { name: merged.name || row.name, data: JSON.stringify(merged), updated_at: db.nowIso() });
  return get(tplId);
}
// Make a template the active default (drives every new video).
function setDefault(tplId) {
  const row = db.get('SELECT * FROM templates WHERE id = ?', [tplId]);
  if (!row) throw new Error('Template not found.');
  db.run('UPDATE templates SET is_default = 0');
  db.update('templates', tplId, { is_default: 1, updated_at: db.nowIso() });
  return get(tplId);
}
// Soft-delete a CUSTOM template (→ trash). Built-ins cannot be removed.
function softRemove(tplId) {
  const row = db.get('SELECT * FROM templates WHERE id = ?', [tplId]);
  if (!row) throw new Error('Template not found.');
  if (row.builtin) throw new Error('Built-in templates cannot be deleted. Duplicate it and edit the copy instead.');
  db.update('templates', tplId, { deleted_at: db.nowIso(), is_default: 0, updated_at: db.nowIso() });
  return { ok: true };
}
function remove(tplId) {
  const row = db.get('SELECT * FROM templates WHERE id = ?', [tplId]);
  if (!row) throw new Error('Template not found.');
  if (row.builtin) throw new Error('Built-in templates cannot be deleted. Duplicate it and edit the copy instead.');
  db.run('DELETE FROM templates WHERE id = ?', [tplId]);
  return { ok: true };
}
function duplicate(tplId, name) {
  const src = get(tplId);
  if (!src) throw new Error('Template not found.');
  return create(name || (src.name + ' copy'), { ...src });
}

module.exports = { list, get, getDefault, resolve, create, update, remove, softRemove, setDefault, duplicate };
