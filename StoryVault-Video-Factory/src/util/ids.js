'use strict';
const crypto = require('node:crypto');

// Stable, sortable-ish unique ids (spec §20 "Use stable IDs").
function id(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

module.exports = { id };
