'use strict';
// Wipe all generated data (DB + media) back to an empty state. Folder structure
// is preserved. Use before a clean test run or to start fresh.
const fs = require('node:fs');
const path = require('node:path');
const { PATHS, ensureDirs } = require('../src/config');

const WIPE = ['database', 'stories', 'imports', 'backgrounds', 'segments', 'narration',
  'captions', 'previews', 'renders', 'thumbnails', 'logs', 'tmp'];

function rmContents(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    fs.rmSync(full, { recursive: true, force: true });
  }
}

for (const key of WIPE) rmContents(PATHS[key]);
ensureDirs();
console.log('Reset complete — all generated data cleared.');
