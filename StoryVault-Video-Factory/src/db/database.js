'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { DB_FILE, DEFAULT_PREFERENCES, ensureDirs } = require('../config');
const constants = require('../constants');

let db = null;

function getDb() {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA foreign_keys = ON;');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  require('./migrate').run(db, nowIso); // additive, non-destructive migrations + template seed
  seedDefaults();
  return db;
}

function nowIso() {
  // Date.now is available in normal runtime (only restricted inside workflow scripts).
  return new Date().toISOString();
}

function seedDefaults() {
  const row = db.prepare('SELECT id FROM preferences WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO preferences (id, data, updated_at) VALUES (1, ?, ?)')
      .run(JSON.stringify(constants.DEFAULT_PREFERENCES), nowIso());
  }
  // Seed the canonical categories (idempotent).
  const insertCat = db.prepare(
    'INSERT OR IGNORE INTO categories (id, name, custom, created_at) VALUES (?, ?, 0, ?)'
  );
  for (const name of constants.CATEGORIES) {
    insertCat.run('cat_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), name, nowIso());
  }
}

// Small helpers used across services -------------------------------------------------
function run(sql, params = []) { return getDb().prepare(sql).run(...params); }
function get(sql, params = []) { return getDb().prepare(sql).get(...params); }
function all(sql, params = []) { return getDb().prepare(sql).all(...params); }

// Insert a row from an object of column->value. Returns the row's id.
function insert(table, obj) {
  const cols = Object.keys(obj);
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  getDb().prepare(sql).run(...cols.map((c) => normalize(obj[c])));
  return obj.id;
}

function update(table, id, obj) {
  const cols = Object.keys(obj);
  if (!cols.length) return;
  const setClause = cols.map((c) => `${c} = ?`).join(', ');
  const sql = `UPDATE ${table} SET ${setClause} WHERE id = ?`;
  getDb().prepare(sql).run(...cols.map((c) => normalize(obj[c])), id);
}

// node:sqlite only binds null/number/bigint/string/Uint8Array. Coerce others.
function normalize(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

module.exports = { getDb, run, get, all, insert, update, nowIso, normalize };
