'use strict';
// Create/upgrade the database schema and seed default categories + preferences.
const db = require('../src/db/database');
db.getDb();
const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
console.log(`Database initialised (${tables.length} tables): ${tables.sort().join(', ')}`);
