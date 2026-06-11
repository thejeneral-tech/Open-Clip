'use strict';
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

// Minimal .env loader (no dependency). Parses KEY=VALUE lines at the project
// root and applies them without overwriting variables already in the
// environment. The launcher writes this file so its settings reach the server.
function loadDotenv() {
  try {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    let text = fs.readFileSync(envPath, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip PowerShell UTF-8 BOM
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* ignore malformed .env */ }
}
loadDotenv();

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
  models: path.join(DATA, 'models'),
  voiceRefs: path.join(DATA, 'voice-refs'),
  voicePreviews: path.join(DATA, 'voice-previews'),
};

function ensureDirs() {
  for (const p of Object.values(PATHS)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

const DB_FILE = path.join(PATHS.database, 'storyvault.sqlite');

// External tool binaries. Resolution order: explicit env var → bundled ./bin → PATH.
// The bundled binaries (committed-out via .gitignore) make a fresh checkout render without
// a system ffmpeg install; set FFMPEG_PATH/FFPROBE_PATH to override on other machines.
function resolveBin(envVar, fallback) {
  if (process.env[envVar]) return process.env[envVar];
  const exe = process.platform === 'win32' ? `${fallback}.exe` : fallback;
  const bundled = path.join(ROOT, 'bin', exe);
  if (fs.existsSync(bundled)) return bundled;
  return fallback;
}
const FFMPEG = resolveBin('FFMPEG_PATH', 'ffmpeg');
const FFPROBE = resolveBin('FFPROBE_PATH', 'ffprobe');

const SERVER = {
  port: Number(process.env.PORT) || 4400,
  host: process.env.HOST || '127.0.0.1',
};

// Local AI (no API key). Defaults match Ollama; llmAdmin persists user overrides
// to data/llm-settings.json which win over these at runtime.
const AI = {
  llmUrl: process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1',
  llmModel: process.env.LOCAL_LLM_MODEL || 'llama3.1:8b',
};

// User authentication. Enabled by default with a first-run admin setup; set
// AUTH_ENABLED=false to bypass the login gate entirely (single-user/dev).
const AUTH = {
  enabled: String(process.env.AUTH_ENABLED || 'true').toLowerCase() !== 'false',
  localhostBypass: String(process.env.LOCALHOST_BYPASS || 'false').toLowerCase() === 'true',
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  cookieName: 'storyvault_session',
};

// Fish Speech S2 Pro runtime locations (set by the launcher / setup).
const FISH = {
  modelDir: process.env.FISH_MODEL_DIR || path.join(DATA, 'models', 's2-pro-gguf'),
  s2Bin: process.env.FISH_S2_BIN || '',
  ttsUrl: process.env.FISH_TTS_URL || 'http://127.0.0.1:8080',
  python: process.env.PYTHON_PATH || 'python',
};

// Upload limits (spec §10 / §30).
const UPLOAD = {
  maxFileBytes: 4 * 1024 * 1024 * 1024, // 4 GB per background file
  acceptedVideo: ['.mp4', '.mov', '.mkv', '.webm', '.m4v'],
  acceptedImport: ['.txt', '.csv', '.json'],
};

// Default video output (spec §19). 60 fps + CRF 18 for sharper, smoother (less "framey")
// renders — the source gameplay is 60 fps, so 30 fps was throwing away half the frames.
const RENDER = {
  width: 1080,
  height: 1920,
  fps: 60,
  vcodec: 'libx264',
  acodec: 'aac',
  crf: 18,
  presets: {
    tiktok: { width: 1080, height: 1920, fps: 60 },
    shorts: { width: 1080, height: 1920, fps: 60 },
    reels: { width: 1080, height: 1920, fps: 60 },
  },
};

module.exports = { ROOT, DATA, PATHS, DB_FILE, FFMPEG, FFPROBE, SERVER, AI, AUTH, FISH, UPLOAD, RENDER, ensureDirs };
