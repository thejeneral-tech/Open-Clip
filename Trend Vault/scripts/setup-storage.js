/**
 * setup-storage.js
 * Creates all required Zodiac Program storage folders.
 * Run: npm run setup:storage
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DIRS = [
  'zodiac-output',
  'output/final',
  'output/raw',
  'output/tts',
  'uploads',
  'backgrounds',
  'music',
  'custom-audio',
  'data/drafts',
  'logs',
  'voice-samples',
  'voice-test-samples',
  'outputs/voices',
];

console.log('\n  Setting up Zodiac Program storage folders...\n');
let created = 0;
for (const dir of DIRS) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) {
    fs.mkdirSync(full, { recursive: true });
    console.log(`  + created: ${dir}`);
    created++;
  } else {
    console.log(`  ok: ${dir}`);
  }
}
console.log(`\n  Done. ${created} folder(s) created.\n`);
