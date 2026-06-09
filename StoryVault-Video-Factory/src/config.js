'use strict';
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

// Folder layout (spec §21). Never overwrite originals; everything is derived.
const PATHS = {
  root: ROOT,
  data: DATA,
  database: path.join(DATA, 'database'),
  stories: path.join(DATA, 'stories'),
  imports: path.join(DATA, 'imports'),
  backgrounds: path.join(DATA, 'backgrounds'),
  backgroundsMinecraft: path.join(DATA, 'backgrounds', 'minecraft'),
  backgroundsNature: path.join(DATA, 'backgrounds', 'nature'),
  backgroundsCustom: path.join(DATA, 'backgrounds', 'custom'),
  segments: path.join(DATA, 'segments'),
  narration: path.join(DATA, 'narration'),
  captions: path.join(DATA, 'captions'),
  previews: path.join(DATA, 'previews'),
  renders: path.join(DATA, 'renders'),
  thumbnails: path.join(DATA, 'thumbnails'),
  logs: path.join(DATA, 'logs'),
  tmp: path.join(DATA, 'tmp'),
};

function ensureDirs() {
  for (const p of Object.values(PATHS)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

const DB_FILE = path.join(PATHS.database, 'storyvault.sqlite');

// External tool binaries (overridable via env for portability).
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const SERVER = {
  port: Number(process.env.PORT) || 4400,
  host: process.env.HOST || '127.0.0.1',
};

// Upload limits (spec §10 / §30).
const UPLOAD = {
  maxFileBytes: 4 * 1024 * 1024 * 1024, // 4 GB per background file
  acceptedVideo: ['.mp4', '.mov', '.mkv', '.webm', '.m4v'],
  acceptedImport: ['.txt', '.csv', '.json'],
};

// Default video output (spec §19).
const RENDER = {
  width: 1080,
  height: 1920,
  fps: 30,
  vcodec: 'libx264',
  acodec: 'aac',
  crf: 20,
  presets: {
    tiktok: { width: 1080, height: 1920, fps: 30 },
    shorts: { width: 1080, height: 1920, fps: 30 },
    reels: { width: 1080, height: 1920, fps: 30 },
  },
};

module.exports = { ROOT, DATA, PATHS, DB_FILE, FFMPEG, FFPROBE, SERVER, UPLOAD, RENDER, ensureDirs };
