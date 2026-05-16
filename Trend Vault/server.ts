/**
 * Trend Vault Program — Local Web Server
 * Run: npm start  (or double-click start.bat)
 *
 * Trend Vault Studio: /trend-vault   → trend-vault-output/<folder>/
 * Clip Tool:     /          → output/final/<VideoName>/
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import express from 'express';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';
import { generateTrendVaultScript, generateFallbackScript } from './scripts/trend-vault-generate';
import { generateVoice, VOICE_PRESETS } from './scripts/tts/ttsService';
import { probeLocalTts } from './scripts/tts/localTtsAdapter';
import { aiComplete, parseAIJson } from './scripts/ai-completion';
import { AssemblyAI } from 'assemblyai';
import {
  buildTimedCaptions,
  logTimingDebug,
  bundleToRenderLines,
  type TimedCaptionsBundle,
} from './scripts/timing';
import {
  listElevenLabsVoices,
  generateElevenLabsVoiceWithTimestamps,
  alignWordsToLines,
  readElevenLabsUsage,
  incrementElevenLabsUsage,
} from './scripts/tts/elevenLabsAdapter';

// ─── Config ────────────────────────────────────────────────────────────────

const PORT          = 3001;
const ROOT          = path.resolve('.');
const UPLOADS       = path.join(ROOT, 'uploads');
const FINAL_DIR     = path.join(ROOT, 'output', 'final');
const RAW_DIR       = path.join(ROOT, 'output', 'raw');
const JOB_STATE_FILE = path.join(ROOT, 'output', 'active-job.json');
const BACKGROUNDS   = path.join(ROOT, 'backgrounds');
const MUSIC_DIR     = path.join(ROOT, 'music');
const AUDIO_DIR     = path.join(ROOT, 'custom-audio');
const TREND_VAULT_OUT    = path.join(ROOT, 'trend-vault-output');
const DRAFTS_DIR    = path.join(ROOT, 'data', 'drafts');
const PIPER_DIR     = path.join(ROOT, 'piper');
const PIPER_EXE     = path.join(PIPER_DIR, 'piper.exe');
const PIPER_VOICES  = path.join(PIPER_DIR, 'voices');
// Local cache of generated ElevenLabs audio (and any other voice output).
// Older preview payloads referenced this directory under the same name, so
// existing /outputs-voices URLs continue to resolve after the cleanup.
const ELEVENLABS_OUT_DIR = path.join(ROOT, 'outputs', 'voices');
// When set, POST /api/trend-vault/render proxies the Remotion step to the remote
// worker instead of running it in-process. TTS + alignment still run here.
// Local test: RENDER_WORKER_URL=http://localhost:4000
// Remote:     RENDER_WORKER_URL=http://192.168.x.x:4000
const RENDER_WORKER_URL  = (process.env.RENDER_WORKER_URL ?? '').trim();

for (const d of [UPLOADS, FINAL_DIR, BACKGROUNDS, MUSIC_DIR, AUDIO_DIR, TREND_VAULT_OUT, DRAFTS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── Startup: sweep stale orphan job files left by any previous crashed session
// These job_*.json / test_job.json files are created at render-start and
// deleted in the finally block after success or failure. If the server was
// killed mid-render they stay behind forever and clutter trend-vault-output/.
try {
  const orphans = fs.readdirSync(TREND_VAULT_OUT)
    .filter(f => (f.startsWith('job_') || f === 'test_job.json') && f.endsWith('.json'));
  for (const orphan of orphans) {
    try {
      fs.unlinkSync(path.join(TREND_VAULT_OUT, orphan));
      console.log(`[STARTUP] cleaned stale job file: ${orphan}`);
    } catch { /* ignore individual failures */ }
  }
} catch { /* ignore if trend-vault-output doesn't exist yet */ }

// ── Piper TTS helpers ─────────────────────────────────────────────────────────

function getPiperVoices(): string[] {
  if (!fs.existsSync(PIPER_VOICES)) return [];
  return fs.readdirSync(PIPER_VOICES)
    .filter(f => f.endsWith('.onnx'))
    .map(f => f.replace('.onnx', ''));
}

async function runPiper(text: string, modelName: string): Promise<Buffer> {
  const modelPath = path.join(PIPER_VOICES, `${modelName}.onnx`);
  if (!fs.existsSync(modelPath)) throw new Error(`Voice not installed: ${modelName}`);
  const tmpFile = path.join(os.tmpdir(), `trend-vault-${Date.now()}.wav`);
  return new Promise((resolve, reject) => {
    const proc = spawn(PIPER_EXE, [
      '--model', modelPath,
      '--output-file', tmpFile,
      '--sentence-silence', '0.25',
    ]);
    proc.stdin.write(text, 'utf8');
    proc.stdin.end();
    proc.stderr.on('data', () => {});
    proc.on('close', (code) => {
      if (code !== 0) { reject(new Error(`Piper exited ${code}`)); return; }
      try {
        const buf = fs.readFileSync(tmpFile);
        try { fs.unlinkSync(tmpFile); } catch {}
        resolve(buf);
      } catch (e) { reject(e); }
    });
    proc.on('error', reject);
  });
}

// ─── Express ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'frontend')));
app.use('/clips',       express.static(FINAL_DIR));
app.use('/backgrounds', express.static(BACKGROUNDS));
app.use('/music',       express.static(MUSIC_DIR));
app.use('/trend-vault-clips',   express.static(TREND_VAULT_OUT));
if (!fs.existsSync(ELEVENLABS_OUT_DIR)) fs.mkdirSync(ELEVENLABS_OUT_DIR, { recursive: true });
app.use('/outputs-voices', express.static(ELEVENLABS_OUT_DIR));
// Serve generated voice MP3 and timed-caption JSON files for the frontend
// preview (and for any other consumer that needs the canonical timing).
app.use('/custom-audio', express.static(path.join(ROOT, 'public', 'custom-audio')));
app.use('/captions',     express.static(path.join(ROOT, 'public', 'captions')));

function safeName(original: string): string {
  return original.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (_req, file, cb) => cb(null, safeName(file.originalname)),
  }),
});

const bgUpload = multer({
  storage: multer.diskStorage({
    destination: BACKGROUNDS,
    filename: (_req, file, cb) => cb(null, safeName(file.originalname)),
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

const musicUpload = multer({
  storage: multer.diskStorage({
    destination: MUSIC_DIR,
    filename: (_req, file, cb) => cb(null, safeName(file.originalname)),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const audioUpload = multer({
  storage: multer.diskStorage({
    destination: AUDIO_DIR,
    filename: (_req, file, cb) => cb(null, safeName(file.originalname)),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ─── Folder naming ─────────────────────────────────────────────────────────

function datestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

function toFolderName(original: string): string {
  // Spaces must become underscores — spaces in spawn args break cmd.exe (shell:true)
  const base = path.basename(original, path.extname(original))
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim()
    .slice(0, 60);
  return `${datestamp()}_${base}`;
}

// ─── Job state persistence ──────────────────────────────────────────────────

function saveJobState(videoPath: string, job: Job) {
  try { fs.writeFileSync(JOB_STATE_FILE, JSON.stringify({ videoPath, job })); } catch { /* ignore */ }
}

function clearJobState() {
  try { if (fs.existsSync(JOB_STATE_FILE)) fs.unlinkSync(JOB_STATE_FILE); } catch { /* ignore */ }
}

function loadJobState(): { videoPath: string; job: Job } | null {
  try {
    if (!fs.existsSync(JOB_STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(JOB_STATE_FILE, 'utf8'));
  } catch { return null; }
}

// ─── SSE ───────────────────────────────────────────────────────────────────

interface SSEClient { res: express.Response; jobId: string; }
const sseClients = new Set<SSEClient>();

function broadcast(jobId: string, data: object) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    if (c.jobId === jobId) try { c.res.write(msg); } catch { /* ignore */ }
  }
}

// ─── Job ───────────────────────────────────────────────────────────────────

interface Job {
  id: string;
  status: 'running' | 'done' | 'error';
  logs: string[];
  folder: string;
  filename: string;
  startTime: number;
  stage: number;          // 0=extract 1=transcribe 2=select 3=cut 4=render
  currentClip: number;   // 1-based clip being rendered
  totalClips: number;
  clipPct: number;        // 0-100, current clip render %
  clipsFinished: string[];
  overallPct: number;
}

let activeJob: Job | null = null;

// ─── Progress math ─────────────────────────────────────────────────────────
//
// Stage weights (cumulative end %):
//   0 extract   →   3%
//   1 transcribe → 15%
//   2 select    →  18%
//   3 cut       →  23%
//   4 render    → 100%  (77 percentage points, one per ~7.7 clips)
//
const STAGE_BASE = [0, 3, 15, 18, 23];
const STAGE_END  = [3, 15, 18, 23, 100];

function computeOverallPct(job: Job): number {
  if (job.stage < 4) {
    // Interpolate within the stage based on audio extraction sub-progress
    const base  = STAGE_BASE[job.stage];
    const range = STAGE_END[job.stage] - base;
    // clipPct reused for audio extraction sub-% when stage===0
    const sub = job.stage === 0 ? job.clipPct / 100 : 0.5;
    return Math.round(base + sub * range);
  }
  const total   = job.totalClips || 10;
  const done    = job.clipsFinished.length;
  const frac    = (done + job.clipPct / 100) / total;
  return Math.min(99, Math.round(23 + frac * 77));
}

function broadcastProgress(job: Job) {
  const pct       = computeOverallPct(job);
  job.overallPct  = pct;
  const elapsedMs = Date.now() - job.startTime;
  const etaMs     = pct > 3
    ? Math.max(0, (elapsedMs / pct) * (100 - pct))
    : null;

  broadcast(job.id, {
    progress: {
      stage:          job.stage,
      overallPct:     pct,
      clipPct:        job.clipPct,
      currentClip:    job.currentClip,
      totalClips:     job.totalClips,
      clipsFinished:  job.clipsFinished.length,
      elapsedMs,
      etaMs,
    },
  });
}

// ─── Log parsing ───────────────────────────────────────────────────────────

function parseLogLine(line: string, job: Job) {
  const l = line.toLowerCase();

  // Stage detection (advance only, never go backwards)
  if (job.stage < 1 && (l.includes('uploading audio') || l.includes('assemblyai') || l.includes('using cached transcript'))) {
    job.stage = 1; job.clipPct = 0;
  } else if (job.stage < 2 && (l.includes('clips selected') || l.includes('claude') || l.includes('heuristic') || l.includes('choose'))) {
    job.stage = 2; job.clipPct = 0;
  } else if (job.stage < 3 && (l.includes('cutting clip') || l.includes('cutting clips'))) {
    job.stage = 3; job.clipPct = 0;
  } else if (job.stage < 4 && (l.includes('bundling remotion') || l.includes('rendering'))) {
    job.stage = 4; job.clipPct = 0;
  } else if (job.stage < 1 && (l.includes('extracting audio') || l.includes('using cached audio'))) {
    job.stage = 0;
  }

  // "Rendering N/M: Title" — start of a new clip
  const renderMatch = line.match(/Rendering (\d+)\/(\d+):/);
  if (renderMatch) {
    job.currentClip = parseInt(renderMatch[1]);
    job.totalClips  = parseInt(renderMatch[2]);
    job.clipPct     = 0;
  }

  // "  → /path/to/clip-05.mp4" — clip finished
  const doneMatch = line.match(/→.*clip-(\d+)\.mp4/i);
  if (doneMatch) {
    const n    = doneMatch[1].padStart(2, '0');
    const name = `clip-${n}.mp4`;
    if (!job.clipsFinished.includes(name)) {
      job.clipsFinished.push(name);
      job.clipPct = 100;
      broadcast(job.id, { clipReady: { folder: job.folder, name } });
    }
  }

  // "Cutting clip N/M:" — cut stage sub-info
  const cutMatch = line.match(/Cutting clip (\d+)\/(\d+):/);
  if (cutMatch) {
    job.currentClip = parseInt(cutMatch[1]);
    job.totalClips  = parseInt(cutMatch[2]);
  }

  broadcastProgress(job);
}

// ─── Pipeline runner ────────────────────────────────────────────────────────

function runPipeline(videoPath: string, job: Job, retryCount = 0) {
  const MAX_RETRIES = 8; // EMFILE can need several retries on slow machines

  // ── Why env vars instead of shell args ───────────────────────────────────
  // The project folder path ("Antonio Clip code proj") contains spaces.
  // shell:true + args array → cmd.exe splits on spaces → broken path.
  // Env vars are handed directly from OS to child process, never shell-parsed.
  // Empty args array [] also eliminates Node v25 DEP0190 deprecation warning.
  const proc = spawn('npx tsx scripts/clip.ts', [], {
    cwd: ROOT,
    shell: true,
    env: {
      ...process.env,
      CLIP_FACTORY_VIDEO:  videoPath,  // absolute path, spaces totally safe
      CLIP_FACTORY_FOLDER: job.folder, // underscore folder name
    },
  });

  const pushLog = (line: string) => {
    job.logs.push(line);
    broadcast(job.id, { log: line });
    parseLogLine(line, job);
  };

  const onData = (data: Buffer) => {
    const raw = data.toString().replace(/\x1B\[[0-9;]*m/g, '');
    for (const section of raw.split('\n')) {
      const parts = section.split('\r');
      let latestText = '';
      let lastPct    = -1;
      for (const part of parts) {
        const t = part.trim();
        if (!t) continue;
        const pctMatch = t.match(/^(\d+)%\s*$/);
        if (pctMatch) { lastPct = parseInt(pctMatch[1]); }
        else           { latestText = t; }
      }
      if (lastPct >= 0) { job.clipPct = lastPct; broadcastProgress(job); }
      if (latestText)     pushLog(latestText);
    }
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', (code) => {
    if (code === 0) {
      // ── Success ────────────────────────────────────────────────────────
      job.status     = 'done';
      job.overallPct = 100;
      const clips = fs.existsSync(path.join(FINAL_DIR, job.folder))
        ? fs.readdirSync(path.join(FINAL_DIR, job.folder)).filter(f => f.endsWith('.mp4')).sort()
        : [];
      clearJobState();
      broadcast(job.id, { done: true, success: true, folder: job.folder, clips });
      console.log(`\n✓ Done — ${clips.length} clips in output/final/${job.folder}/\n`);
      return;
    }

    // ── Check for EMFILE (too many open files) ─────────────────────────
    const hitEmfile = job.logs.some(l => l.includes('EMFILE'));
    if (hitEmfile && retryCount < MAX_RETRIES) {
      const wait = 12000 + retryCount * 4000; // back-off: 12s, 16s, 20s …
      const attempt = retryCount + 1;
      const msg = `⚠️  EMFILE — Windows file-descriptor limit hit. Auto-resuming in ${wait / 1000}s... (attempt ${attempt}/${MAX_RETRIES})`;
      pushLog(msg);
      console.log('\n' + msg);
      // Pipeline caches all completed clips — resume picks up from next one
      setTimeout(() => runPipeline(videoPath, job, retryCount + 1), wait);
      return;
    }

    // ── Unrecoverable error ─────────────────────────────────────────────
    job.status = 'error';
    const clips = fs.existsSync(path.join(FINAL_DIR, job.folder))
      ? fs.readdirSync(path.join(FINAL_DIR, job.folder)).filter(f => f.endsWith('.mp4')).sort()
      : [];
    clearJobState();
    broadcast(job.id, { done: true, success: false, folder: job.folder, clips });
    console.log(`\n✗ Pipeline failed (exit ${code})\n`);
  });
}

// ─── Cache clearing ─────────────────────────────────────────────────────────

function clearIntermediateFiles() {
  if (fs.existsSync(RAW_DIR)) {
    for (const f of fs.readdirSync(RAW_DIR)) {
      try { fs.unlinkSync(path.join(RAW_DIR, f)); } catch { /* ignore */ }
    }
  }
  for (const f of [
    path.join(ROOT, 'input', 'audio.mp3'),
    path.join(ROOT, 'transcripts', 'video.json'),
    path.join(ROOT, 'output', 'clips.json'),
  ]) { if (fs.existsSync(f)) fs.unlinkSync(f); }
}

// ─── Video folder reader ────────────────────────────────────────────────────

interface VideoFolder { name: string; clips: string[]; }

function getVideoFolders(): VideoFolder[] {
  if (!fs.existsSync(FINAL_DIR)) return [];
  return fs.readdirSync(FINAL_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({
      name: d.name,
      clips: fs.readdirSync(path.join(FINAL_DIR, d.name)).filter(f => f.endsWith('.mp4')).sort(),
    }))
    .filter(d => d.clips.length > 0)
    .reverse();
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get('/events/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client: SSEClient = { res, jobId: req.params.jobId };
  sseClients.add(client);

  if (activeJob?.id === req.params.jobId) {
    for (const log of activeJob.logs) res.write(`data: ${JSON.stringify({ log })}\n\n`);
    broadcastProgress(activeJob);
    if (activeJob.status !== 'running') {
      const clips = fs.existsSync(path.join(FINAL_DIR, activeJob.folder))
        ? fs.readdirSync(path.join(FINAL_DIR, activeJob.folder)).filter(f => f.endsWith('.mp4')).sort()
        : [];
      res.write(`data: ${JSON.stringify({ done: true, success: activeJob.status === 'done', folder: activeJob.folder, clips })}\n\n`);
    }
  }

  req.on('close', () => sseClients.delete(client));
});

app.get('/status', (_req, res) => {
  res.json({
    running:  activeJob?.status === 'running',
    jobId:    activeJob?.id ?? null,
    filename: activeJob?.filename ?? null,
    folder:   activeJob?.folder ?? null,
    videos:   getVideoFolders(),
  });
});

app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file)                      { res.status(400).json({ error: 'No file.' }); return; }
  if (activeJob?.status === 'running'){ res.status(409).json({ error: 'Already running.' }); return; }

  const folder    = toFolderName(req.file.originalname);
  const videoPath = req.file.path;
  const jobId     = Date.now().toString();

  activeJob = {
    id: jobId, status: 'running', logs: [], folder,
    filename: req.file.originalname, startTime: Date.now(),
    stage: 0, currentClip: 0, totalClips: 10,
    clipPct: 0, clipsFinished: [], overallPct: 0,
  };

  res.json({ ok: true, jobId, filename: req.file.originalname, folder });

  saveJobState(videoPath, activeJob);
  clearIntermediateFiles();
  broadcast(jobId, { status: 'starting', filename: req.file.originalname, folder });
  broadcastProgress(activeJob);

  console.log(`\nStarting pipeline → output/final/${folder}/\n`);
  runPipeline(videoPath, activeJob);
});

app.get('/download/:folder/:filename', (req, res) => {
  const p = path.join(FINAL_DIR, path.basename(req.params.folder), path.basename(req.params.filename));
  if (!fs.existsSync(p)) { res.status(404).send('Not found'); return; }
  res.download(p);
});

// ════════════════════════════════════════════════════════════════════════════
//  TREND_VAULT STUDIO ROUTES
// ════════════════════════════════════════════════════════════════════════════

// Serve trend-vault studio page
app.get('/trend-vault', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(ROOT, 'frontend', 'trend-vault.html'));
});

app.get('/mainframe', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(ROOT, 'frontend', 'mainframe.html'));
});

// ════════════════════════════════════════════════════════════════════════════
//  TIKTOK AUTO-UPLOAD ROUTES
// ════════════════════════════════════════════════════════════════════════════

interface TikTokJob {
  id: string;
  status: 'running' | 'done' | 'error';
  logs: string[];
  error?: string;
  startedAt: number;
  videoPath: string;
}
const tikTokJobs = new Map<string, TikTokJob>();

interface TikTokAutoPost {
  enabled: boolean;
  captionTemplate: string;
  privacy: 'public' | 'friends' | 'private';
  mode: 'direct' | 'draft';
}
const AUTOPOST_FILE = path.join(ROOT, 'data', 'tiktok-autopost.json');
const AUTOPOST_DEFAULT: TikTokAutoPost = {
  enabled: false,
  captionTemplate: '{folder} #fyp #trendvault',
  privacy: 'public',
  mode: 'draft',
};
function loadAutoPost(): TikTokAutoPost {
  try {
    if (fs.existsSync(AUTOPOST_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(AUTOPOST_FILE, 'utf8'));
      return { ...AUTOPOST_DEFAULT, ...parsed };
    }
  } catch { /* ignore */ }
  return { ...AUTOPOST_DEFAULT };
}
function saveAutoPost(cfg: TikTokAutoPost) {
  fs.mkdirSync(path.dirname(AUTOPOST_FILE), { recursive: true });
  fs.writeFileSync(AUTOPOST_FILE, JSON.stringify(cfg, null, 2));
}

function startTikTokJob(videoAbs: string, caption: string, privacy: TikTokAutoPost['privacy'], mode: TikTokAutoPost['mode']): string {
  const id = `tt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const job: TikTokJob = { id, status: 'running', logs: [], startedAt: Date.now(), videoPath: videoAbs };
  tikTokJobs.set(id, job);
  (async () => {
    try {
      const { uploadVideo } = await import('./scripts/tiktok-uploader');
      const result = await uploadVideo({
        videoPath: videoAbs,
        caption,
        privacy,
        mode,
        onLog: (line) => {
          job.logs.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
          if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
        },
      });
      if (result.ok) job.status = 'done';
      else { job.status = 'error'; job.error = result.error; }
    } catch (err: any) {
      job.status = 'error';
      job.error = err?.message ?? String(err);
    }
  })();
  return id;
}

function maybeAutoPostRender(folder: string, pushLog: (msg: string, pct?: number) => void) {
  const cfg = loadAutoPost();
  if (!cfg.enabled) return;
  const videoAbs = path.join(TREND_VAULT_OUT, folder, 'video.mp4');
  if (!fs.existsSync(videoAbs)) {
    pushLog(`⚠ Auto-post skipped — ${videoAbs} not found`);
    return;
  }
  const caption = cfg.captionTemplate.replace(/\{folder\}/g, folder);
  const id = startTikTokJob(videoAbs, caption, cfg.privacy, cfg.mode);
  pushLog(`📤 Auto-posting to TikTok (${cfg.mode}) — job ${id}`);
}

function recentMp4s(): { path: string; rel: string; mtime: number; size: number }[] {
  const roots = [TREND_VAULT_OUT, FINAL_DIR];
  const found: { path: string; rel: string; mtime: number; size: number }[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fp);
      else if (entry.isFile() && /\.mp4$/i.test(entry.name)) {
        const st = fs.statSync(fp);
        found.push({ path: fp, rel: path.relative(ROOT, fp), mtime: st.mtimeMs, size: st.size });
      }
    }
  };
  for (const r of roots) walk(r);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, 50);
}

app.get('/tiktok', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(ROOT, 'frontend', 'tiktok.html'));
});

app.get('/api/tiktok/videos', (_req, res) => {
  res.json({ videos: recentMp4s().map(v => ({ rel: v.rel, mtime: v.mtime, size: v.size })) });
});

app.get('/api/tiktok/login-status', async (_req, res) => {
  try {
    const { isLoggedIn } = await import('./scripts/tiktok-uploader');
    res.json({ loggedIn: await isLoggedIn() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post('/api/tiktok/login', async (_req, res) => {
  try {
    const { loginInteractive } = await import('./scripts/tiktok-uploader');
    await loginInteractive();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post('/api/tiktok/upload', express.json(), async (req, res) => {
  const { rel, caption, privacy, mode } = req.body ?? {};
  if (typeof rel !== 'string' || !rel) { res.status(400).json({ error: 'rel required' }); return; }
  const safeRel = path.normalize(rel).replace(/^([/\\]+)/, '');
  const abs = path.join(ROOT, safeRel);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs)) { res.status(400).json({ error: 'video not found' }); return; }
  const allowedPrivacy = new Set(['public', 'friends', 'private']);
  const allowedMode = new Set(['direct', 'draft']);
  const p: TikTokAutoPost['privacy'] = allowedPrivacy.has(privacy) ? privacy : 'public';
  const m: TikTokAutoPost['mode'] = allowedMode.has(mode) ? mode : 'draft';
  const cap = typeof caption === 'string' ? caption.slice(0, 2200) : '';

  const id = startTikTokJob(abs, cap, p, m);
  res.json({ jobId: id });
});

app.get('/api/tiktok/status/:jobId', (req, res) => {
  const job = tikTokJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ id: job.id, status: job.status, logs: job.logs, error: job.error });
});

app.get('/api/tiktok/autopost', (_req, res) => {
  res.json(loadAutoPost());
});

app.post('/api/tiktok/autopost', express.json(), (req, res) => {
  const incoming = req.body ?? {};
  const cfg: TikTokAutoPost = {
    enabled: !!incoming.enabled,
    captionTemplate: typeof incoming.captionTemplate === 'string'
      ? incoming.captionTemplate.slice(0, 2200)
      : AUTOPOST_DEFAULT.captionTemplate,
    privacy: ['public', 'friends', 'private'].includes(incoming.privacy) ? incoming.privacy : 'public',
    mode: ['direct', 'draft'].includes(incoming.mode) ? incoming.mode : 'draft',
  };
  saveAutoPost(cfg);
  res.json(cfg);
});

app.get('/api/tiktok/recent-jobs', (_req, res) => {
  const jobs = [...tikTokJobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 10)
    .map(j => ({ id: j.id, status: j.status, error: j.error, startedAt: j.startedAt, videoPath: path.basename(j.videoPath) }));
  res.json({ jobs });
});

// ════════════════════════════════════════════════════════════════════════════
//  YOUTUBE SHORTS AUTO-UPLOAD ROUTES
// ════════════════════════════════════════════════════════════════════════════

interface YouTubeJob {
  id: string;
  status: 'running' | 'done' | 'error';
  logs: string[];
  error?: string;
  videoId?: string;
  url?: string;
  startedAt: number;
  videoPath: string;
}
const youTubeJobs = new Map<string, YouTubeJob>();

interface YouTubeAutoPost {
  enabled: boolean;
  titleTemplate: string;
  descriptionTemplate: string;
  tags: string;
  privacy: 'public' | 'unlisted' | 'private';
  madeForKids: boolean;
}
const YT_AUTOPOST_FILE = path.join(ROOT, 'data', 'youtube-autopost.json');
const YT_AUTOPOST_DEFAULT: YouTubeAutoPost = {
  enabled: false,
  titleTemplate: '{folder} #Shorts',
  descriptionTemplate: 'Generated with Trend Vault.\n\n#Shorts #trendvault',
  tags: 'shorts,trendvault,fyp',
  privacy: 'public',
  madeForKids: false,
};
function loadYtAutoPost(): YouTubeAutoPost {
  try {
    if (fs.existsSync(YT_AUTOPOST_FILE)) {
      return { ...YT_AUTOPOST_DEFAULT, ...JSON.parse(fs.readFileSync(YT_AUTOPOST_FILE, 'utf8')) };
    }
  } catch { /* ignore */ }
  return { ...YT_AUTOPOST_DEFAULT };
}
function saveYtAutoPost(cfg: YouTubeAutoPost) {
  fs.mkdirSync(path.dirname(YT_AUTOPOST_FILE), { recursive: true });
  fs.writeFileSync(YT_AUTOPOST_FILE, JSON.stringify(cfg, null, 2));
}

function startYouTubeJob(opts: { videoAbs: string; title: string; description: string; tags: string[]; privacy: YouTubeAutoPost['privacy']; madeForKids: boolean }): string {
  const id = `yt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const job: YouTubeJob = { id, status: 'running', logs: [], startedAt: Date.now(), videoPath: opts.videoAbs };
  youTubeJobs.set(id, job);
  (async () => {
    try {
      const { uploadShort } = await import('./scripts/youtube-uploader');
      const result = await uploadShort({
        videoPath: opts.videoAbs,
        title: opts.title,
        description: opts.description,
        tags: opts.tags,
        privacy: opts.privacy,
        madeForKids: opts.madeForKids,
        onLog: (line) => {
          job.logs.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
          if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
        },
      });
      if (result.ok) { job.status = 'done'; job.videoId = result.videoId; job.url = result.url; }
      else { job.status = 'error'; job.error = result.error; }
    } catch (err: any) {
      job.status = 'error';
      job.error = err?.message ?? String(err);
    }
  })();
  return id;
}

function maybeAutoPostYouTube(folder: string, pushLog: (msg: string, pct?: number) => void) {
  const cfg = loadYtAutoPost();
  if (!cfg.enabled) return;
  const videoAbs = path.join(TREND_VAULT_OUT, folder, 'video.mp4');
  if (!fs.existsSync(videoAbs)) {
    pushLog(`⚠ YouTube auto-post skipped — ${videoAbs} not found`);
    return;
  }
  const title = cfg.titleTemplate.replace(/\{folder\}/g, folder);
  const description = cfg.descriptionTemplate.replace(/\{folder\}/g, folder);
  const tags = cfg.tags.split(',').map(s => s.trim()).filter(Boolean);
  const id = startYouTubeJob({ videoAbs, title, description, tags, privacy: cfg.privacy, madeForKids: cfg.madeForKids });
  pushLog(`📺 Auto-posting to YouTube Shorts (${cfg.privacy}) — job ${id}`);
}

app.get('/youtube', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(ROOT, 'frontend', 'youtube.html'));
});

app.get('/api/youtube/videos', (_req, res) => {
  // Reuse the same recentMp4s helper from the TikTok routes
  res.json({ videos: recentMp4s().map(v => ({ rel: v.rel, mtime: v.mtime, size: v.size })) });
});

app.get('/api/youtube/auth-status', async (_req, res) => {
  try {
    const { getAuthState, getRedirectUri } = await import('./scripts/youtube-uploader');
    const state = await getAuthState();
    res.json({ ...state, redirectUri: getRedirectUri() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.get('/api/youtube/auth-url', async (_req, res) => {
  try {
    const { getAuthUrl } = await import('./scripts/youtube-uploader');
    res.json({ url: getAuthUrl() });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? String(err) });
  }
});

app.get('/api/youtube/oauth-callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const err = typeof req.query.error === 'string' ? req.query.error : '';
  if (err) { res.status(400).send(`<h2>OAuth error: ${err}</h2><p><a href="/youtube">Back</a></p>`); return; }
  if (!code) { res.status(400).send('<h2>Missing code</h2>'); return; }
  try {
    const { exchangeCode } = await import('./scripts/youtube-uploader');
    await exchangeCode(code);
    res.send('<!doctype html><meta charset="utf-8"><title>YouTube signed in</title><body style="background:#020108;color:#ede8f5;font-family:system-ui;text-align:center;padding:60px"><h2>✅ YouTube signed in</h2><p>You can close this tab.</p><script>setTimeout(()=>window.close(),1500);</script><p><a style="color:#c084fc" href="/youtube">Back to Trend Vault</a></p></body>');
  } catch (e: any) {
    res.status(500).send(`<h2>Token exchange failed</h2><pre>${e?.message ?? e}</pre>`);
  }
});

app.post('/api/youtube/sign-out', async (_req, res) => {
  try {
    const { signOut } = await import('./scripts/youtube-uploader');
    signOut();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post('/api/youtube/upload', express.json(), async (req, res) => {
  const { rel, title, description, tags, privacy, madeForKids } = req.body ?? {};
  if (typeof rel !== 'string' || !rel) { res.status(400).json({ error: 'rel required' }); return; }
  const safeRel = path.normalize(rel).replace(/^([/\\]+)/, '');
  const abs = path.join(ROOT, safeRel);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs)) { res.status(400).json({ error: 'video not found' }); return; }
  const allowedPrivacy = new Set<YouTubeAutoPost['privacy']>(['public', 'unlisted', 'private']);
  const p: YouTubeAutoPost['privacy'] = allowedPrivacy.has(privacy) ? privacy : 'public';
  const t = (typeof title === 'string' ? title : 'Short').slice(0, 100);
  const d = (typeof description === 'string' ? description : '').slice(0, 5000);
  const tagList: string[] = Array.isArray(tags)
    ? tags.map(String)
    : typeof tags === 'string'
      ? tags.split(',').map(s => s.trim()).filter(Boolean)
      : [];

  const id = startYouTubeJob({ videoAbs: abs, title: t, description: d, tags: tagList, privacy: p, madeForKids: !!madeForKids });
  res.json({ jobId: id });
});

app.get('/api/youtube/status/:jobId', (req, res) => {
  const job = youTubeJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ id: job.id, status: job.status, logs: job.logs, error: job.error, videoId: job.videoId, url: job.url });
});

app.get('/api/youtube/autopost', (_req, res) => {
  res.json(loadYtAutoPost());
});

app.post('/api/youtube/autopost', express.json(), (req, res) => {
  const incoming = req.body ?? {};
  const cfg: YouTubeAutoPost = {
    enabled: !!incoming.enabled,
    titleTemplate: typeof incoming.titleTemplate === 'string' ? incoming.titleTemplate.slice(0, 100) : YT_AUTOPOST_DEFAULT.titleTemplate,
    descriptionTemplate: typeof incoming.descriptionTemplate === 'string' ? incoming.descriptionTemplate.slice(0, 5000) : YT_AUTOPOST_DEFAULT.descriptionTemplate,
    tags: typeof incoming.tags === 'string' ? incoming.tags.slice(0, 500) : YT_AUTOPOST_DEFAULT.tags,
    privacy: ['public', 'unlisted', 'private'].includes(incoming.privacy) ? incoming.privacy : 'public',
    madeForKids: !!incoming.madeForKids,
  };
  saveYtAutoPost(cfg);
  res.json(cfg);
});

app.get('/api/youtube/recent-jobs', (_req, res) => {
  const jobs = [...youTubeJobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 10)
    .map(j => ({ id: j.id, status: j.status, error: j.error, startedAt: j.startedAt, videoPath: path.basename(j.videoPath), videoId: j.videoId, url: j.url }));
  res.json({ jobs });
});

// ════════════════════════════════════════════════════════════════════════════
//  INSTAGRAM REELS AUTO-UPLOAD ROUTES
// ════════════════════════════════════════════════════════════════════════════

interface InstagramJob {
  id: string;
  status: 'running' | 'done' | 'error';
  logs: string[];
  error?: string;
  mediaId?: string;
  url?: string;
  startedAt: number;
  videoPath: string;
}
const instagramJobs = new Map<string, InstagramJob>();

interface InstagramAutoPost {
  enabled: boolean;
  captionTemplate: string;
  shareToFeed: boolean;
}
const IG_AUTOPOST_FILE = path.join(ROOT, 'data', 'instagram-autopost.json');
const IG_AUTOPOST_DEFAULT: InstagramAutoPost = {
  enabled: false,
  captionTemplate: '{folder}\n\n#reels #trendvault',
  shareToFeed: true,
};
function loadIgAutoPost(): InstagramAutoPost {
  try {
    if (fs.existsSync(IG_AUTOPOST_FILE)) {
      return { ...IG_AUTOPOST_DEFAULT, ...JSON.parse(fs.readFileSync(IG_AUTOPOST_FILE, 'utf8')) };
    }
  } catch { /* ignore */ }
  return { ...IG_AUTOPOST_DEFAULT };
}
function saveIgAutoPost(cfg: InstagramAutoPost) {
  fs.mkdirSync(path.dirname(IG_AUTOPOST_FILE), { recursive: true });
  fs.writeFileSync(IG_AUTOPOST_FILE, JSON.stringify(cfg, null, 2));
}

function startInstagramJob(opts: { videoAbs: string; caption: string; shareToFeed: boolean }): string {
  const id = `ig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const job: InstagramJob = { id, status: 'running', logs: [], startedAt: Date.now(), videoPath: opts.videoAbs };
  instagramJobs.set(id, job);
  (async () => {
    try {
      const { uploadReel } = await import('./scripts/instagram-uploader');
      const result = await uploadReel({
        videoPath: opts.videoAbs,
        caption: opts.caption,
        shareToFeed: opts.shareToFeed,
        onLog: (line) => {
          job.logs.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
          if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
        },
      });
      if (result.ok) { job.status = 'done'; job.mediaId = result.mediaId; job.url = result.url; }
      else { job.status = 'error'; job.error = result.error; }
    } catch (err: any) {
      job.status = 'error';
      job.error = err?.message ?? String(err);
    }
  })();
  return id;
}

function maybeAutoPostInstagram(folder: string, pushLog: (msg: string, pct?: number) => void) {
  const cfg = loadIgAutoPost();
  if (!cfg.enabled) return;
  const videoAbs = path.join(TREND_VAULT_OUT, folder, 'video.mp4');
  if (!fs.existsSync(videoAbs)) {
    pushLog(`⚠ Instagram auto-post skipped — ${videoAbs} not found`);
    return;
  }
  const caption = cfg.captionTemplate.replace(/\{folder\}/g, folder);
  const id = startInstagramJob({ videoAbs, caption, shareToFeed: cfg.shareToFeed });
  pushLog(`📸 Auto-posting Reel to Instagram — job ${id}`);
}

app.get('/instagram', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(ROOT, 'frontend', 'instagram.html'));
});

app.get('/api/instagram/videos', (_req, res) => {
  res.json({ videos: recentMp4s().map(v => ({ rel: v.rel, mtime: v.mtime, size: v.size })) });
});

app.get('/api/instagram/auth-status', async (_req, res) => {
  try {
    const { getAuthState } = await import('./scripts/instagram-uploader');
    res.json(await getAuthState());
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post('/api/instagram/sign-in', express.json(), async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'username and password required' });
    return;
  }
  try {
    const { signIn } = await import('./scripts/instagram-uploader');
    const r = await signIn(username, password);
    res.json(r);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post('/api/instagram/sign-in/2fa', express.json(), async (req, res) => {
  const { code } = req.body ?? {};
  if (typeof code !== 'string') { res.status(400).json({ error: 'code required' }); return; }
  try {
    const { submitTwoFactor } = await import('./scripts/instagram-uploader');
    const r = await submitTwoFactor(code);
    res.json(r);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post('/api/instagram/sign-out', async (_req, res) => {
  try {
    const { signOut } = await import('./scripts/instagram-uploader');
    signOut();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post('/api/instagram/upload', express.json(), async (req, res) => {
  const { rel, caption, shareToFeed } = req.body ?? {};
  if (typeof rel !== 'string' || !rel) { res.status(400).json({ error: 'rel required' }); return; }
  const safeRel = path.normalize(rel).replace(/^([/\\]+)/, '');
  const abs = path.join(ROOT, safeRel);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs)) { res.status(400).json({ error: 'video not found' }); return; }
  const cap = typeof caption === 'string' ? caption.slice(0, 2200) : '';
  const id = startInstagramJob({ videoAbs: abs, caption: cap, shareToFeed: shareToFeed !== false });
  res.json({ jobId: id });
});

app.get('/api/instagram/status/:jobId', (req, res) => {
  const job = instagramJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ id: job.id, status: job.status, logs: job.logs, error: job.error, mediaId: job.mediaId, url: job.url });
});

app.get('/api/instagram/autopost', (_req, res) => {
  res.json(loadIgAutoPost());
});

app.post('/api/instagram/autopost', express.json(), (req, res) => {
  const incoming = req.body ?? {};
  const cfg: InstagramAutoPost = {
    enabled: !!incoming.enabled,
    captionTemplate: typeof incoming.captionTemplate === 'string'
      ? incoming.captionTemplate.slice(0, 2200)
      : IG_AUTOPOST_DEFAULT.captionTemplate,
    shareToFeed: incoming.shareToFeed !== false,
  };
  saveIgAutoPost(cfg);
  res.json(cfg);
});

app.get('/api/instagram/recent-jobs', (_req, res) => {
  const jobs = [...instagramJobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 10)
    .map(j => ({ id: j.id, status: j.status, error: j.error, startedAt: j.startedAt, videoPath: path.basename(j.videoPath), mediaId: j.mediaId, url: j.url }));
  res.json({ jobs });
});

// ── List backgrounds ──────────────────────────────────────────────────────────
app.get('/api/backgrounds', (_req, res) => {
  const files = fs.existsSync(BACKGROUNDS)
    ? fs.readdirSync(BACKGROUNDS).filter(f => /\.(mp4|webm|mov)$/i.test(f))
    : [];
  res.json({ files });
});

// ── Upload background ─────────────────────────────────────────────────────────
app.post('/api/backgrounds/upload', bgUpload.single('video'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'No file.' }); return; }
  res.json({ ok: true, filename: req.file.filename });
});

// ── Delete background ─────────────────────────────────────────────────────────
app.delete('/api/backgrounds/:filename', (req, res) => {
  const fp = path.join(BACKGROUNDS, path.basename(req.params.filename));
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

// ── List music ────────────────────────────────────────────────────────────────
app.get('/api/music', (_req, res) => {
  const files = fs.existsSync(MUSIC_DIR)
    ? fs.readdirSync(MUSIC_DIR).filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f))
    : [];
  res.json({ files });
});

// ── Upload music ──────────────────────────────────────────────────────────────
app.post('/api/music/upload', musicUpload.single('audio'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'No file.' }); return; }
  res.json({ ok: true, filename: req.file.filename });
});

// ── Upload custom voice audio ─────────────────────────────────────────────────
app.post('/api/audio/upload', audioUpload.single('audio'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'No file.' }); return; }
  res.json({ ok: true, filename: req.file.filename });
});

// ── List custom audio ─────────────────────────────────────────────────────────
app.get('/api/audio', (_req, res) => {
  const files = fs.existsSync(AUDIO_DIR)
    ? fs.readdirSync(AUDIO_DIR).filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f))
    : [];
  res.json({ files });
});

// ── Delete custom audio ───────────────────────────────────────────────────────
app.delete('/api/audio/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // strip any path traversal
  const targets = [
    path.join(AUDIO_DIR, filename),
    path.join(ROOT, 'public', 'custom-audio', filename),
  ];
  let deleted = false;
  for (const p of targets) {
    if (fs.existsSync(p)) { fs.unlinkSync(p); deleted = true; }
  }
  if (deleted) {
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'File not found.' });
  }
});

// ── Generate script ───────────────────────────────────────────────────────────
app.post('/api/trend-vault/generate-script', async (req, res) => {
  const { trendVaultSign, category, prompt, angle, emotionalTone, targetDuration } = req.body;

  if (!trendVaultSign || !prompt) {
    res.status(400).json({ error: 'trendVaultSign and prompt are required.' });
    return;
  }

  const sendFallback = (notice?: string) => {
    try {
      const script = generateFallbackScript({ trendVaultSign, prompt: prompt || '', angle: angle || '' });
      res.json({ ok: true, script, source: 'fallback', ...(notice ? { notice } : {}) });
    } catch (fbErr) {
      res.status(500).json({ ok: false, error: 'Script generation failed.' });
    }
  };

  if (!process.env.ANTHROPIC_API_KEY) {
    sendFallback();
    return;
  }

  try {
    const script = await generateTrendVaultScript({
      trendVaultSign,
      category:       category || 'general',
      prompt,
      angle:          angle || '',
      emotionalTone:  emotionalTone || 'mysterious',
      targetDuration: targetDuration || 100,
    });
    res.json({ ok: true, script, source: 'claude' });
  } catch (err: unknown) {
    const msg = String((err as Error).message || '');
    const isBilling = /credit|billing|balance|quota|429|insufficient|402|400/i.test(msg);
    console.warn('[Trend Vault] Anthropic script error:', msg.slice(0, 150));

    // Try OpenAI as fallback when Anthropic fails (especially on billing errors)
    if (process.env.OPENAI_API_KEY && isBilling) {
      try {
        const result = await aiComplete({
          maxTokens: 2048,
          user: `Write a TikTok trend-vault storytelling script for ${trendVaultSign}.

Topic: ${prompt}
Angle: ${angle || ''}
Tone: ${emotionalTone || 'mysterious'}
Target duration: ${targetDuration || 100} seconds

Return ONLY valid JSON, no other text:
{
  "lines": [
    {"text": "...", "type": "hook", "durationSeconds": 4},
    {"text": "...", "type": "observation", "durationSeconds": 5}
  ],
  "totalDuration": 95,
  "title": "Short memorable title",
  "hook": "Opening line"
}

Use these line types in order: hook, observation, escalation, truth, twist, ending. 12-18 lines total. Each line 1-2 sentences, 3-8 seconds.`,
        });
        const parsed = parseAIJson<{ lines: unknown[]; totalDuration: number; title: string; hook: string }>(result.text);
        const fullScript = { ...parsed, trendVaultSign, topic: prompt, emotionalTone: emotionalTone || 'mysterious' };
        res.json({ ok: true, script: fullScript, source: 'openai', notice: result.warning || 'Using OpenAI (Anthropic credits exhausted).' });
        return;
      } catch (oaiErr) {
        console.warn('[Trend Vault] OpenAI fallback also failed:', String((oaiErr as Error).message).slice(0, 100));
      }
    }

    sendFallback(isBilling ? 'Both AI providers unavailable — using built-in template.' : undefined);
  }
});

// ── TTS: Piper (offline) + Edge TTS (online fallback) ────────────────────────

app.get('/api/trend-vault/tts-status', (_req, res) => {
  const piperReady  = fs.existsSync(PIPER_EXE);
  const piperVoices = getPiperVoices();
  res.json({ piperReady, piperVoices });
});

app.post('/api/trend-vault/tts', async (req, res) => {
  const { text, piperId, edgeId } = req.body as { text: string; piperId?: string; edgeId?: string };
  if (!text) { res.status(400).json({ error: 'text required' }); return; }

  // 1. Try Piper (offline) first
  if (piperId && fs.existsSync(PIPER_EXE)) {
    const modelPath = path.join(PIPER_VOICES, `${piperId}.onnx`);
    if (fs.existsSync(modelPath)) {
      try {
        const audio = await runPiper(text, piperId);
        res.setHeader('Content-Type', 'audio/wav');
        res.send(audio);
        return;
      } catch (e) {
        console.warn('[TTS] Piper failed, trying Edge TTS:', (e as Error).message);
      }
    }
  }

  // 2. Try Edge TTS (online, free, no key needed)
  if (edgeId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { EdgeTTS } = require('node-edge-tts');
      const tts = new EdgeTTS({ voice: edgeId, outputFormat: 'audio-24khz-96kbitrate-mono-mp3' });
      const tmpFile = path.join(os.tmpdir(), `trend-vault-edge-${Date.now()}.mp3`);
      await tts.ttsPromise(text, tmpFile);
      const buf = fs.readFileSync(tmpFile);
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      res.setHeader('Content-Type', 'audio/mpeg');
      res.send(buf);
      return;
    } catch (e) {
      console.warn('[TTS] Edge TTS failed:', (e as Error).message);
    }
  }

  res.status(503).json({ error: 'No TTS engine ready. Run setup-voices.bat for offline voices.' });
});

// ── Serve Voice Lab page ──────────────────────────────────────────────────────
app.get('/voice-lab', (_req, res) => {
  res.sendFile(path.join(ROOT, 'frontend', 'voice-lab.html'));
});

// ── Serve MP3 Voice Editor page ──────────────────────────────────────────────
app.get('/voice-editor', (_req, res) => {
  res.sendFile(path.join(ROOT, 'frontend', 'voice-editor.html'));
});

// ── Custom presets storage ────────────────────────────────────────────────────
const CUSTOM_PRESETS_FILE = path.join(ROOT, 'custom-presets.json');
function readCustomPresets(): unknown[] {
  if (!fs.existsSync(CUSTOM_PRESETS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CUSTOM_PRESETS_FILE, 'utf8')); }
  catch { return []; }
}
function writeCustomPresets(arr: unknown[]) {
  fs.writeFileSync(CUSTOM_PRESETS_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

app.get('/api/custom-presets', (_req, res) => {
  res.json({ presets: readCustomPresets() });
});

app.post('/api/custom-presets', (req, res) => {
  const incoming = req.body as Record<string, unknown>;
  if (!incoming?.name || !incoming?.edgeId) {
    res.status(400).json({ error: 'name and edgeId required' });
    return;
  }
  const presets = readCustomPresets() as Array<Record<string, unknown>>;
  const id = (incoming.id as string) || `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const preset = {
    id,
    name: incoming.name,
    icon: incoming.icon || '🎨',
    description: incoming.description || 'Custom preset from MP3 analysis',
    category: 'custom',
    favorite: !!incoming.favorite,
    edgeId: incoming.edgeId,
    defaults: incoming.defaults || { pitch: 0, rate: 0, speed: 1.0, volume: 0, intensity: 30 },
    sliders: incoming.sliders || { throatDepth: 0, ancientRasp: 0, royalPace: 0, chamberSpace: 0 },
    eq: incoming.eq || 'clear',
    reverb: !!incoming.reverb,
    robot: !!incoming.robot,
    custom: true,
    createdAt: new Date().toISOString(),
    sourceFile: incoming.sourceFile || null,
    analysis: incoming.analysis || null,
  };
  // Replace if id collides, otherwise prepend
  const idx = presets.findIndex(p => p.id === id);
  if (idx >= 0) presets[idx] = preset; else presets.unshift(preset);
  writeCustomPresets(presets);
  res.json({ ok: true, preset });
});

app.delete('/api/custom-presets/:id', (req, res) => {
  const id = req.params.id;
  const presets = (readCustomPresets() as Array<Record<string, unknown>>).filter(p => p.id !== id);
  writeCustomPresets(presets);
  res.json({ ok: true });
});

// ── Voice presets list (built-in + custom merged) ────────────────────────────
app.get('/api/trend-vault/voice-presets', (_req, res) => {
  const custom = readCustomPresets();
  res.json({ presets: [...custom, ...VOICE_PRESETS] });
});

// ── Check openai-edge-tts server (localhost:5050) ─────────────────────────────
app.get('/api/trend-vault/edge-tts-status', async (_req, res) => {
  try {
    const r = await fetch('http://localhost:5050/v1/voices', { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const data = await r.json() as { voices?: unknown[] };
      res.json({ available: true, voices: Array.isArray(data.voices) ? data.voices.length : 0 });
    } else {
      res.json({ available: false });
    }
  } catch {
    res.json({ available: false });
  }
});

// ── Generate voice via openai-edge-tts (high quality, localhost:5050) ─────────
app.post('/api/trend-vault/generate-voice-openai', async (req, res) => {
  const { text, voice, speed } = req.body as { text: string; voice: string; speed?: number };
  if (!text || !voice) { res.status(400).json({ error: 'text and voice required' }); return; }
  try {
    const r = await fetch('http://localhost:5050/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice, input: text, response_format: 'mp3', speed: speed ?? 1.0 }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`openai-edge-tts error: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buf);
  } catch (e) {
    res.status(503).json({ error: (e as Error).message });
  }
});

// ── Voice cloning: sample upload + storage ────────────────────────────────────
const VOICE_SAMPLES_DIR = path.join(ROOT, 'voice-samples');
if (!fs.existsSync(VOICE_SAMPLES_DIR)) fs.mkdirSync(VOICE_SAMPLES_DIR, { recursive: true });

const sampleUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const id = (_req.body as { voiceId?: string }).voiceId || 'default';
      const voiceDir = path.join(VOICE_SAMPLES_DIR, id);
      fs.mkdirSync(voiceDir, { recursive: true });
      cb(null, voiceDir);
    },
    filename: (_req, file, cb) => cb(null, `${Date.now()}_${safeName(file.originalname)}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.get('/api/voice-clone/list', (_req, res) => {
  if (!fs.existsSync(VOICE_SAMPLES_DIR)) { res.json({ voices: [] }); return; }
  const voices = fs.readdirSync(VOICE_SAMPLES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const voiceDir = path.join(VOICE_SAMPLES_DIR, d.name);
      const metaFile = path.join(voiceDir, 'meta.json');
      const samples = fs.readdirSync(voiceDir).filter(f => /\.(mp3|wav|m4a|ogg)$/i.test(f));
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* no meta */ }
      return { id: d.name, sampleCount: samples.length, meta };
    });
  res.json({ voices });
});

app.post('/api/voice-clone/upload', sampleUpload.array('samples', 20), (req, res) => {
  const files = req.files as Express.Multer.File[];
  if (!files?.length) { res.status(400).json({ error: 'No files.' }); return; }
  const voiceId = (req.body as { voiceId?: string }).voiceId || 'default';
  const name    = (req.body as { name?: string }).name || voiceId;
  const metaFile = path.join(VOICE_SAMPLES_DIR, voiceId, 'meta.json');
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* new */ }
  meta.name = name; meta.updatedAt = new Date().toISOString();
  if (!meta.createdAt) meta.createdAt = meta.updatedAt;
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  res.json({ ok: true, voiceId, filesAdded: files.length });
});

app.delete('/api/voice-clone/:voiceId', (req, res) => {
  const voiceDir = path.join(VOICE_SAMPLES_DIR, path.basename(req.params.voiceId));
  if (fs.existsSync(voiceDir)) {
    for (const f of fs.readdirSync(voiceDir)) {
      try { fs.unlinkSync(path.join(voiceDir, f)); } catch { /* ignore */ }
    }
    try { fs.rmdirSync(voiceDir); } catch { /* ignore */ }
  }
  res.json({ ok: true });
});

app.get('/api/voice-clone/:voiceId/samples', (req, res) => {
  const voiceDir = path.join(VOICE_SAMPLES_DIR, path.basename(req.params.voiceId));
  if (!fs.existsSync(voiceDir)) { res.json({ samples: [] }); return; }
  const samples = fs.readdirSync(voiceDir).filter(f => /\.(mp3|wav|m4a|ogg)$/i.test(f));
  res.json({ samples });
});

// Serve voice sample files for playback
app.use('/voice-samples', express.static(VOICE_SAMPLES_DIR));

// ── Generate voice with presets + sliders ─────────────────────────────────────
// ── Export current trend-vault project to a CapCutAPI draft ───────────────────────
// Calls the local CapCutAPI Python server (default :9001) to build a draft the
// user can finish in CapCut. Does NOT replace the Remotion render — both work
// independently. Falls back to a clear error if the Python server isn't up.
app.post('/api/trend-vault/export-capcut', async (req, res) => {
  const capcutUrl = process.env.CAPCUT_API_URL || 'http://localhost:9001';
  const { settings, scriptLines, voiceUrl, backgroundUrl } = req.body as {
    settings: Record<string, unknown>;
    scriptLines: Array<{ text: string; durationSeconds: number; startMs?: number; endMs?: number }>;
    voiceUrl?: string;
    backgroundUrl?: string;
  };
  if (!settings || !scriptLines?.length) {
    res.status(400).json({ error: 'settings and scriptLines required' });
    return;
  }

  // Probe first so we fail fast with a friendly message
  try {
    await fetch(capcutUrl, { signal: AbortSignal.timeout(2000) });
  } catch {
    res.status(503).json({
      error: 'CapCutAPI server not reachable at ' + capcutUrl + '. ' +
             'Start it with: python capcut_server.py (port 9001).',
    });
    return;
  }

  const post = async (endpoint: string, body: unknown) => {
    const r = await fetch(`${capcutUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`${endpoint} → HTTP ${r.status}`);
    return r.json();
  };

  try {
    // 1. Create draft
    const createRes = await post('/create_draft', {
      width: 1080, height: 1920,
    });
    const draftId = (createRes as { draft_id?: string; output?: { draft_id?: string } }).draft_id
                 ?? (createRes as { output?: { draft_id?: string } }).output?.draft_id;
    if (!draftId) throw new Error('CapCutAPI did not return a draft_id');

    // 2. Add background video (if URL was provided)
    if (backgroundUrl) {
      const totalDur = scriptLines.reduce((s, l) => s + (l.durationSeconds || 4), 0) + 2;
      await post('/add_video', {
        draft_id: draftId,
        video_url: backgroundUrl,
        start: 0, end: totalDur,
        width: 1080, height: 1920,
      });
    }

    // 3. Add narration audio (if URL was provided)
    if (voiceUrl) {
      const totalDur = scriptLines.reduce((s, l) => s + (l.durationSeconds || 4), 0);
      await post('/add_audio', {
        draft_id: draftId,
        audio_url: voiceUrl,
        start: 0, end: totalDur,
      });
    }

    // 4. Add each script line as a text segment (use word-aligned timings if present)
    let cursor = 0;
    for (const line of scriptLines) {
      const startSec = line.startMs != null ? line.startMs / 1000 : cursor;
      const endSec   = line.endMs   != null ? line.endMs   / 1000 : cursor + (line.durationSeconds || 3);
      await post('/add_text', {
        draft_id: draftId,
        text: line.text,
        start: startSec,
        end:   endSec,
        font_size: Number(settings.fontSize) || 68,
        font_color: settings.textColor || '#FFFFFF',
      });
      cursor = endSec;
    }

    // 5. Save draft. The user must specify their CapCut Drafts folder via env.
    const draftFolder = process.env.CAPCUT_DRAFT_FOLDER || ''; // optional
    const saveRes = await post('/save_draft', {
      draft_id: draftId,
      draft_folder: draftFolder,
    });

    res.json({
      ok: true,
      draftId,
      message: draftFolder
        ? `Draft saved to ${draftFolder}. Open CapCut to finish.`
        : `Draft saved to CapCutAPI server's working directory as folder dfd_${draftId}. Copy it to your CapCut Drafts folder, then open CapCut.`,
      saveResult: saveRes,
    });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.error('[CapCut export]', msg);
    res.status(500).json({ error: msg });
  }
});

// ── Probe local TTS engine + CapCutAPI server (UI status indicators) ─────────

app.get('/api/trend-vault/engine-status', async (_req, res) => {
  const localTts = await probeLocalTts();

  // CapCutAPI
  const capcutUrl = process.env.CAPCUT_API_URL || 'http://localhost:9001';
  let capcutOk = false;
  try {
    const r = await fetch(capcutUrl, { signal: AbortSignal.timeout(1500) });
    capcutOk = r.ok || r.status === 404 || r.status === 405;
  } catch { /* not running */ }

  // ElevenLabs — only check is whether the API key is present. The full
  // ElevenLabs status (account / quota) lives at /api/elevenlabs/status.
  const elConfigured = !!(process.env.ELEVENLABS_API_KEY);

  res.json({
    localTts,
    capcut:      { ok: capcutOk,     url: capcutUrl },
    edge:        { ok: true,         name: 'Microsoft Edge TTS (always available)' },
    elevenlabs:  { configured: elConfigured },
  });
});

app.post('/api/trend-vault/generate-voice', async (req, res) => {
  const {
    text, presetId, pitch, rate, speed, volume, intensity, preview, engine,
    throatDepth, ancientRasp, royalPace, chamberSpace,
  } = req.body as {
    text: string; presetId: string; pitch?: number; rate?: number;
    speed?: number; volume?: number; intensity?: number; preview?: boolean;
    engine?: 'auto' | 'local' | 'edge';
    throatDepth?: number; ancientRasp?: number; royalPace?: number; chamberSpace?: number;
  };
  if (!text || !presetId) { res.status(400).json({ error: 'text and presetId required' }); return; }

  try {
    const { buffer, mimeType } = await generateVoice({
      text, presetId, pitch, rate, speed, volume, intensity, preview, engine,
      throatDepth, ancientRasp, royalPace, chamberSpace,
    });
    res.setHeader('Content-Type', mimeType);
    res.send(buffer);
  } catch (e) {
    // node-edge-tts throws plain strings ("Timed out") so coerce safely
    const msg = e instanceof Error ? e.message
      : typeof e === 'string' ? e
      : JSON.stringify(e) || 'Unknown voice generation error';
    console.error('[Voice] generate-voice error:', msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(500).json({ error: msg });
  }
});

// ── Voice Preview ─────────────────────────────────────────────────────────────
// Generates the TTS audio for the current script AND builds the canonical
// timed-captions bundle (same engine the render path uses). The frontend
// caches both and plays them together — preview audio + captions are now
// driven by the SAME timeline the final render will use.
app.post('/api/trend-vault/voice-preview', async (req, res) => {
  const { scriptLines, voice = {}, voiceEngine = 'auto' } = req.body as {
    scriptLines: Array<{ text: string; type?: string; durationSeconds?: number }>;
    voice: {
      presetId?: string; pitch?: number; rate?: number; speed?: number;
      volume?: number; intensity?: number;
      throatDepth?: number; ancientRasp?: number; royalPace?: number; chamberSpace?: number;
      // ElevenLabs-specific
      elevenLabsVoiceId?: string;
      elevenLabsModel?:   string;
      stability?:    number;
      similarity?:   number;
      style?:        number;
      speakerBoost?: boolean;
    };
    voiceEngine: 'auto' | 'local' | 'edge' | 'elevenlabs';
  };
  if (!Array.isArray(scriptLines) || scriptLines.length === 0) {
    res.status(400).json({ error: 'scriptLines[] required' }); return;
  }
  const presetId = voice.presetId || 'tiktok_female';
  const fullText = scriptLines.map(l => l.text).filter(Boolean).join('\n\n');
  if (!fullText.trim()) { res.status(400).json({ error: 'scriptLines all empty' }); return; }

  const previewId = `pv_${Date.now()}`;
  const audioFile = `trend_vault_preview_${previewId}.mp3`;
  const audioPath = path.join(AUDIO_DIR, audioFile);
  const publicAudioDir = path.join(ROOT, 'public', 'custom-audio');
  fs.mkdirSync(publicAudioDir, { recursive: true });
  const publicAudioPath = path.join(publicAudioDir, audioFile);

  try {
    // ── 1. Generate the voice ──────────────────────────────────────────────
    // Branch by engine. ElevenLabs is the high-quality path that ALSO returns
    // per-word timestamps — when used, downstream sync is exact, not
    // approximate. All other engines fall through to the existing
    // generateVoice() pipeline (Edge / Kokoro / Piper).
    let buffer: Buffer | undefined;
    let resolvedEngine: string = voiceEngine;
    let perLineWords: Array<Array<{ word: string; startMs: number; endMs: number }>> | undefined;
    let timingSource: TimedCaptionsBundle['source'] = 'word-proportional';

    if (voiceEngine === 'elevenlabs') {
      if (!voice.elevenLabsVoiceId) {
        throw new Error('voiceEngine=elevenlabs requires voice.elevenLabsVoiceId');
      }
      const r = await generateElevenLabsVoiceWithTimestamps({
        text:     fullText,
        voiceId:  voice.elevenLabsVoiceId,
        modelId:  voice.elevenLabsModel,
        stability:    voice.stability,
        similarity:   voice.similarity,
        style:        voice.style,
        speakerBoost: voice.speakerBoost,
      });
      buffer = r.buffer;
      resolvedEngine = 'elevenlabs';
      if (r.words.length > 0) {
        perLineWords = alignWordsToLines(scriptLines, r.words);
        timingSource = 'assemblyai-forced-alignment'; // reuse the "word-level" label
      }
    } else {
      // ── Auto / Local / Edge path ─────────────────────────────────────────
      // Auto cascade: ElevenLabs (if key + selected voice) → Local/Edge
      let autoEngine: 'auto' | 'local' | 'edge' = voiceEngine as 'auto' | 'local' | 'edge';
      if (voiceEngine === 'auto') {
        const hasEL = !!(process.env.ELEVENLABS_API_KEY && voice.elevenLabsVoiceId);
        if (hasEL) {
          const r = await generateElevenLabsVoiceWithTimestamps({
            text:        fullText,
            voiceId:     voice.elevenLabsVoiceId!,
            modelId:     voice.elevenLabsModel,
            stability:   voice.stability,
            similarity:  voice.similarity,
            style:       voice.style,
            speakerBoost: voice.speakerBoost,
          });
          buffer = r.buffer;
          if (r.words.length > 0) {
            perLineWords  = alignWordsToLines(scriptLines, r.words);
            timingSource  = 'assemblyai-forced-alignment';
          }
          resolvedEngine = 'auto→elevenlabs';
        } else {
          const result = await generateVoice({
            text: fullText, presetId,
            pitch: voice.pitch, rate: voice.rate, speed: voice.speed,
            volume: voice.volume, intensity: voice.intensity,
            engine: 'auto',
            throatDepth: voice.throatDepth, ancientRasp: voice.ancientRasp,
            royalPace: voice.royalPace, chamberSpace: voice.chamberSpace,
          });
          buffer = result.buffer;
          resolvedEngine = 'auto→local';
          autoEngine = 'auto';
        }
      } else {
        const result = await generateVoice({
          text: fullText,
          presetId,
          pitch: voice.pitch, rate: voice.rate, speed: voice.speed,
          volume: voice.volume, intensity: voice.intensity,
          engine: autoEngine,
          throatDepth: voice.throatDepth, ancientRasp: voice.ancientRasp,
          royalPace:   voice.royalPace,   chamberSpace: voice.chamberSpace,
        });
        buffer = result.buffer;
        resolvedEngine = autoEngine;
      }
    }

    if (!buffer || buffer.length < 1024) {
      throw new Error(`TTS returned suspiciously small audio (${buffer?.length || 0} bytes).`);
    }
    fs.writeFileSync(audioPath, buffer);
    fs.copyFileSync(audioPath, publicAudioPath);

    // ── 2. Measure exact audio duration ────────────────────────────────────
    const audioDurationSec = await getVideoDuration(audioPath);
    if (audioDurationSec < 0.4) {
      throw new Error(`TTS produced ${audioDurationSec.toFixed(2)}s of audio — too short / silent.`);
    }

    // ── 3. Build canonical caption bundle ──────────────────────────────────
    // When ElevenLabs gave us per-word timings we pass them in — the engine
    // uses them for word-level reveal AND still normalizes the last caption
    // end to exactly audioDurationSec.
    const bundle = buildTimedCaptions(
      scriptLines.map(l => ({ text: l.text, type: l.type as 'observation' | undefined })),
      audioDurationSec,
      { source: timingSource, perLineWords },
    );

    // 4. Persist captions JSON so the render and the preview can share it
    const captionsDir = path.join(ROOT, 'public', 'captions');
    fs.mkdirSync(captionsDir, { recursive: true });
    const captionsRelPath = `captions/preview_${previewId}.json`;
    fs.writeFileSync(
      path.join(ROOT, 'public', captionsRelPath),
      JSON.stringify({
        audioFile,
        audioDurationSec: bundle.audioDurationSec,
        source: bundle.source,
        captions: bundle.captions,
      }, null, 2),
    );

    // 5. Server-side debug log so you see the same numbers the client sees
    console.log(`\n[VOICE-PREVIEW] ${previewId}`);
    logTimingDebug(bundle, (s) => console.log(s), 'VOICE-PREVIEW');

    // ── Canonical timing object (Phase 3) ─────────────────────────────────
    // This is the SINGLE shared object preview + render must agree on.
    // Frontend stores it on state.previewTiming and sends it back to /render.
    const stableHash = (s: string) => {
      let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      return String(h);
    };
    const scriptText = scriptLines.map(l => (l.text || '').trim()).join('||');
    // KEEP IN SYNC with the submittedVoiceKey computation inside /api/trend-vault/render.
    // Any voice-affecting field that changes the generated audio must appear here,
    // otherwise the render-time hash check will let a stale preview through.
    const voiceKey   = [
      voiceEngine, voice.elevenLabsVoiceId || '', voice.elevenLabsModel || '',
      voice.presetId || '',
      voice.speed ?? '', voice.pitch ?? '', voice.rate ?? '',
      voice.volume ?? '', voice.intensity ?? '',
      voice.stability ?? '', voice.similarity ?? '',
      voice.style ?? '', voice.speakerBoost ?? '',
      voice.throatDepth ?? '', voice.ancientRasp ?? '',
      voice.royalPace ?? '', voice.chamberSpace ?? '',
    ].join('|');
    const _v = voice as Record<string, unknown>;
    const timing = {
      mode:                      (_v.durationMode as string) || 'autoMatchVoice',
      targetDurationSeconds:     (_v.targetDurationSec as number | undefined) ?? null,
      actualAudioDurationSeconds: bundle.audioDurationSec,
      finalVideoDurationSeconds: bundle.audioDurationSec,  // overridden by render when forced
      scriptHash:                stableHash(scriptText),
      voiceHash:                 stableHash(voiceKey),
      provider:                  resolvedEngine,
      voiceId:                   voice.elevenLabsVoiceId || voice.presetId || null,
      audioUrl:                  `/custom-audio/${audioFile}`,
      audioFile,
      audioPath:                 publicAudioPath,
      lines: bundle.captions.map((c, i) => ({
        id:       `line_${i}`,
        text:     c.text,
        start:    c.start,
        end:      c.end,
        duration: c.duration,
        wordCount: c.wordCount,
      })),
      totalWords: bundle.totalWords,
      source:     bundle.source,
      createdAt:  new Date().toISOString(),
    };

    res.json({
      ok: true,
      previewId,
      audioUrl: `/custom-audio/${audioFile}`,
      captionsUrl: `/${captionsRelPath}`,
      audioDurationSec: bundle.audioDurationSec,
      totalWords: bundle.totalWords,
      source: bundle.source,
      resolvedEngine,
      captions: bundle.captions,
      timing,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
    console.error('[VOICE-PREVIEW] failed:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

// ── ElevenLabs — list voices, save preset, read usage ────────────────────────
// Three small routes the studio uses to surface ElevenLabs as a first-class
// voice provider with a clean preset workflow.

const EL_PRESETS_PATH = path.resolve('data', 'elevenlabs-presets.json');

function readElevenLabsPresets(): Array<{
  id: string; name: string; voiceId: string; modelId?: string;
  stability?: number; similarity?: number; style?: number; speakerBoost?: boolean;
  createdAt: string;
}> {
  try { return JSON.parse(fs.readFileSync(EL_PRESETS_PATH, 'utf8')); } catch { return []; }
}
function writeElevenLabsPresets(list: ReturnType<typeof readElevenLabsPresets>): void {
  fs.mkdirSync(path.dirname(EL_PRESETS_PATH), { recursive: true });
  fs.writeFileSync(EL_PRESETS_PATH, JSON.stringify(list, null, 2));
}

app.get('/api/elevenlabs/voices', async (_req, res) => {
  try {
    if (!process.env.ELEVENLABS_API_KEY) {
      res.json({ ok: false, configured: false, voices: [], error: 'ELEVENLABS_API_KEY not set in .env' });
      return;
    }
    const voices = await listElevenLabsVoices();
    res.json({ ok: true, configured: true, voices });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, configured: true, error: msg });
  }
});

app.get('/api/elevenlabs/presets', (_req, res) => {
  const presets = readElevenLabsPresets();
  const usage = readElevenLabsUsage();
  res.json({ ok: true, presets, usage });
});

app.post('/api/elevenlabs/presets', (req, res) => {
  const body = req.body as {
    name: string; voiceId: string; modelId?: string;
    stability?: number; similarity?: number; style?: number; speakerBoost?: boolean;
  };
  if (!body?.name || !body?.voiceId) {
    res.status(400).json({ ok: false, error: 'name and voiceId required' }); return;
  }
  const presets = readElevenLabsPresets();
  const id = 'el_' + body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now().toString(36);
  const entry = {
    id, name: body.name, voiceId: body.voiceId,
    modelId: body.modelId, stability: body.stability,
    similarity: body.similarity, style: body.style,
    speakerBoost: body.speakerBoost,
    createdAt: new Date().toISOString(),
  };
  presets.unshift(entry);
  writeElevenLabsPresets(presets);
  res.json({ ok: true, preset: entry });
});

app.delete('/api/elevenlabs/presets/:id', (req, res) => {
  const presets = readElevenLabsPresets().filter(p => p.id !== req.params.id);
  writeElevenLabsPresets(presets);
  res.json({ ok: true });
});

app.post('/api/elevenlabs/usage/increment', (_req, res) => {
  res.json({ ok: true, usage: incrementElevenLabsUsage() });
});

// ── ElevenLabs — full voice studio API surface ───────────────────────────────
// These routes back the in-app ElevenLabs panel. They all rely on the server-
// side ELEVENLABS_API_KEY from .env — the API key is never exposed to the
// browser. Endpoints:
//   GET  /api/elevenlabs/status         — key present + account info
//   GET  /api/elevenlabs/voices         — list every voice on the account
//   POST /api/elevenlabs/preview        — short preview clip from a voice_id
//   POST /api/elevenlabs/generate       — full script → mp3 saved on disk
//   GET  /api/elevenlabs/default-voice  — read the saved default voice/settings
//   POST /api/elevenlabs/default-voice  — write the saved default voice/settings
// (Preset list / save / delete and usage increment routes are defined above.)

const ELEVENLABS_DEFAULT_FILE = path.join(ROOT, 'data', 'elevenlabs-default-voice.json');

interface ElevenLabsDefaultVoice {
  voiceId: string;
  name: string;
  modelId: string;
  stability: number;
  similarity: number;
  style: number;
  speakerBoost: boolean;
  updatedAt: string;
}

function readElevenLabsDefault(): ElevenLabsDefaultVoice | null {
  try {
    if (!fs.existsSync(ELEVENLABS_DEFAULT_FILE)) return null;
    return JSON.parse(fs.readFileSync(ELEVENLABS_DEFAULT_FILE, 'utf8'));
  } catch { return null; }
}

function writeElevenLabsDefault(d: ElevenLabsDefaultVoice): void {
  fs.mkdirSync(path.dirname(ELEVENLABS_DEFAULT_FILE), { recursive: true });
  fs.writeFileSync(ELEVENLABS_DEFAULT_FILE, JSON.stringify(d, null, 2));
}

// GET /api/elevenlabs/status — connectivity + (best-effort) subscription quota
app.get('/api/elevenlabs/status', async (_req, res) => {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    res.json({
      ok:        false,
      connected: false,
      reason:    'ELEVENLABS_API_KEY is not set. Add it to .env as ELEVENLABS_API_KEY=your_key_here, then restart the server.',
    });
    return;
  }
  try {
    // /v1/user/subscription returns character_count, character_limit, tier
    const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': key },
      signal:  AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      res.json({
        ok:        false,
        connected: false,
        reason:    `ElevenLabs rejected the API key (HTTP ${r.status}). ${body.slice(0, 200)}`,
      });
      return;
    }
    const data = await r.json() as {
      tier?: string;
      character_count?: number;
      character_limit?: number;
      next_character_count_reset_unix?: number;
      voice_limit?: number;
    };
    const usage = readElevenLabsUsage();
    const defaultVoice = readElevenLabsDefault();
    res.json({
      ok:        true,
      connected: true,
      account: {
        tier:                data.tier               ?? null,
        charactersUsed:      data.character_count    ?? null,
        charactersAllowed:   data.character_limit    ?? null,
        nextResetUnix:       data.next_character_count_reset_unix ?? null,
        voiceLimit:          data.voice_limit        ?? null,
      },
      localUsage:    usage,
      defaultVoice,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.json({
      ok:        false,
      connected: false,
      reason:    /abort|timeout/i.test(msg)
        ? 'ElevenLabs API did not respond within 8s. Check your internet connection.'
        : `ElevenLabs API error: ${msg}`,
    });
  }
});

// POST /api/elevenlabs/preview — generate a short sample clip for a voice_id.
//   Body: { voiceId, text? (default sample), modelId?, stability?, similarity?, style?, speakerBoost? }
//   Returns: { ok, audioUrl, audioPath, durationSec }
//   The audio is written into outputs/voices/ so it is served by /outputs-voices.
app.post('/api/elevenlabs/preview', async (req, res) => {
  const body = req.body as {
    voiceId?: string; text?: string; modelId?: string;
    stability?: number; similarity?: number; style?: number; speakerBoost?: boolean;
  };
  if (!process.env.ELEVENLABS_API_KEY) {
    res.status(400).json({ ok: false, error: 'ELEVENLABS_API_KEY is not set in .env' });
    return;
  }
  if (!body?.voiceId) {
    res.status(400).json({ ok: false, error: 'voiceId is required' });
    return;
  }
  const previewText = (body.text && body.text.trim().length > 0)
    ? body.text.trim().slice(0, 280)
    : 'This is your selected ElevenLabs voice preview.';

  try {
    const r = await generateElevenLabsVoiceWithTimestamps({
      text:         previewText,
      voiceId:      body.voiceId,
      modelId:      body.modelId ?? 'eleven_flash_v2_5',
      stability:    body.stability,
      similarity:   body.similarity,
      style:        body.style,
      speakerBoost: body.speakerBoost,
    });
    const fileName = `el_preview_${Date.now()}.mp3`;
    const outPath  = path.join(ELEVENLABS_OUT_DIR, fileName);
    fs.writeFileSync(outPath, r.buffer);
    // Also copy into public/custom-audio so the studio can play it as part of
    // the preview pipeline if it wants to.
    const publicAudioDir = path.join(ROOT, 'public', 'custom-audio');
    fs.mkdirSync(publicAudioDir, { recursive: true });
    fs.copyFileSync(outPath, path.join(publicAudioDir, fileName));

    let durationSec: number | null = null;
    try { durationSec = await getVideoDuration(outPath); } catch { /* non-fatal */ }

    res.json({
      ok:           true,
      audioUrl:     `/outputs-voices/${fileName}`,
      audioPath:    outPath,
      durationSec,
      bytes:        r.buffer.length,
      voiceId:      body.voiceId,
      modelId:      body.modelId ?? 'eleven_flash_v2_5',
      previewText,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

// POST /api/elevenlabs/generate — full script → audio file used by the render.
//   Body: { text, voiceId, modelId?, stability?, similarity?, style?, speakerBoost?, outputName? }
//   Returns: { ok, audioUrl, audioPath, durationSec, words[] }
//   words[] is the per-word timing if ElevenLabs returned alignment data.
app.post('/api/elevenlabs/generate', async (req, res) => {
  const body = req.body as {
    text?: string; voiceId?: string; modelId?: string;
    stability?: number; similarity?: number; style?: number;
    speakerBoost?: boolean; outputName?: string;
  };
  if (!process.env.ELEVENLABS_API_KEY) {
    res.status(400).json({ ok: false, error: 'ELEVENLABS_API_KEY is not set in .env' });
    return;
  }
  if (!body?.text?.trim()) {
    res.status(400).json({ ok: false, error: 'text is required' });
    return;
  }
  if (!body?.voiceId) {
    res.status(400).json({ ok: false, error: 'voiceId is required' });
    return;
  }
  try {
    const r = await generateElevenLabsVoiceWithTimestamps({
      text:         body.text,
      voiceId:      body.voiceId,
      modelId:      body.modelId,
      stability:    body.stability,
      similarity:   body.similarity,
      style:        body.style,
      speakerBoost: body.speakerBoost,
    });
    const cleanName = (body.outputName || `el_${Date.now()}`).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
    const fileName  = `${cleanName}.mp3`;
    const outPath   = path.join(ELEVENLABS_OUT_DIR, fileName);
    fs.writeFileSync(outPath, r.buffer);

    // Copy to public/custom-audio so the render pipeline can find it.
    const publicAudioDir = path.join(ROOT, 'public', 'custom-audio');
    fs.mkdirSync(publicAudioDir, { recursive: true });
    fs.copyFileSync(outPath, path.join(publicAudioDir, fileName));

    let durationSec: number | null = null;
    try { durationSec = await getVideoDuration(outPath); } catch { /* non-fatal */ }

    // Count this against the soft usage budget.
    try { incrementElevenLabsUsage(); } catch { /* non-fatal */ }

    res.json({
      ok:           true,
      audioUrl:     `/outputs-voices/${fileName}`,
      audioPath:    outPath,
      durationSec,
      bytes:        r.buffer.length,
      words:        r.words,
      voiceId:      body.voiceId,
      modelId:      body.modelId ?? 'eleven_multilingual_v2',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

// GET /api/elevenlabs/default-voice — return the persisted default voice
app.get('/api/elevenlabs/default-voice', (_req, res) => {
  res.json({ ok: true, defaultVoice: readElevenLabsDefault() });
});

// POST /api/elevenlabs/default-voice — save the picked default voice
app.post('/api/elevenlabs/default-voice', (req, res) => {
  const b = req.body as Partial<ElevenLabsDefaultVoice> & { voiceId: string; name?: string };
  if (!b?.voiceId) { res.status(400).json({ ok: false, error: 'voiceId required' }); return; }
  const next: ElevenLabsDefaultVoice = {
    voiceId:      b.voiceId,
    name:         b.name         ?? '',
    modelId:      b.modelId      ?? 'eleven_multilingual_v2',
    stability:    typeof b.stability    === 'number' ? b.stability    : 0.5,
    similarity:   typeof b.similarity   === 'number' ? b.similarity   : 0.75,
    style:        typeof b.style        === 'number' ? b.style        : 0.0,
    speakerBoost: b.speakerBoost  !== false,
    updatedAt:    new Date().toISOString(),
  };
  writeElevenLabsDefault(next);
  res.json({ ok: true, defaultVoice: next });
});

// POST /api/elevenlabs/save-preset — accepted as an alias for POST /presets
// so the new ElevenLabs panel can use the more descriptive URL.
app.post('/api/elevenlabs/save-preset', (req, res) => {
  const body = req.body as {
    name: string; voiceId: string; modelId?: string;
    stability?: number; similarity?: number; style?: number; speakerBoost?: boolean;
  };
  if (!body?.name || !body?.voiceId) {
    res.status(400).json({ ok: false, error: 'name and voiceId required' });
    return;
  }
  const presets = readElevenLabsPresets();
  const id = 'el_' + body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now().toString(36);
  const entry = {
    id, name: body.name, voiceId: body.voiceId,
    modelId: body.modelId, stability: body.stability,
    similarity: body.similarity, style: body.style,
    speakerBoost: body.speakerBoost,
    createdAt: new Date().toISOString(),
  };
  presets.unshift(entry);
  writeElevenLabsPresets(presets);
  res.json({ ok: true, preset: entry });
});

// ── Active trend-vault renders ─────────────────────────────────────────────────────
interface TrendVaultRenderState {
  status: 'running' | 'done' | 'error';
  logs: string[];
  pct: number;
  stage: string;
  outputFolder: string;
  outputFile?: string;
  startTime: number;
}
const activeTrendVaultRenders = new Map<string, TrendVaultRenderState>();

// SSE clients per jobId — for real-time log streaming
const trendVaultSseClients = new Map<string, Set<express.Response>>();

function trendVaultBroadcast(jobId: string, payload: object) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  trendVaultSseClients.get(jobId)?.forEach(c => { try { c.write(msg); } catch { /* ignore */ } });
}

// ── SSE for trend-vault render progress ────────────────────────────────────────────
app.get('/api/trend-vault/render-status/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const jobId = req.params.jobId;

  // Register this client for real-time pushes
  if (!trendVaultSseClients.has(jobId)) trendVaultSseClients.set(jobId, new Set());
  trendVaultSseClients.get(jobId)!.add(res);

  // Replay existing logs so reconnects get history
  const job = activeTrendVaultRenders.get(jobId);
  if (job) {
    for (const log of job.logs) {
      res.write(`data: ${JSON.stringify({ log })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ progress: job.pct, stage: job.stage })}\n\n`);
    if (job.status !== 'running') {
      res.write(`data: ${JSON.stringify({ done: true, success: job.status === 'done', outputFile: job.outputFile })}\n\n`);
      trendVaultSseClients.get(jobId)?.delete(res);
    }
  }

  // Heartbeat every 15s to keep connection alive
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); } }, 15000);

  req.on('close', () => {
    clearInterval(hb);
    trendVaultSseClients.get(jobId)?.delete(res);
  });
});

// ── Trigger trend-vault render ─────────────────────────────────────────────────────
app.post('/api/trend-vault/render', async (req, res) => {
  const { settings, scriptLines } = req.body;

  // ── Preflight: every required field validated BEFORE we mark a job started.
  // Returns the exact missing/invalid item so the studio can highlight it.
  const preflightErrors: string[] = [];
  if (!settings) preflightErrors.push('settings missing');
  if (!Array.isArray(scriptLines) || scriptLines.length === 0) {
    preflightErrors.push('scriptLines: at least one line required');
  } else if (scriptLines.some((l: { text?: string }) => !l?.text?.trim())) {
    preflightErrors.push('scriptLines: empty line text — remove blank lines');
  }
  if (settings) {
    if (!settings.trendVaultSign) preflightErrors.push('trendVaultSign missing');
    const engine = settings.voiceEngine || 'auto';
    if (engine === 'elevenlabs' && !settings.voice?.elevenLabsVoiceId) {
      preflightErrors.push('voiceEngine=elevenlabs but no elevenLabsVoiceId selected');
    }
    if (settings.durationMode === 'fixed' && !(settings.durationSeconds > 0)) {
      preflightErrors.push('durationMode=fixed but durationSeconds invalid');
    }

    // Phase 7: If a timing object was provided, its scriptHash/voiceHash must
    // match the current submission. This guarantees the render is using the
    // same audio + script the user actually previewed.
    if (settings.previewTiming) {
      const t = settings.previewTiming as { scriptHash?: string; voiceHash?: string; audioPath?: string };
      const stableHash = (s: string) => {
        let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return String(h);
      };
      const submittedScriptHash = stableHash(scriptLines.map((l: { text?: string }) => (l.text || '').trim()).join('||'));
      // KEEP IN SYNC with the voiceKey computation inside /api/trend-vault/voice-preview.
      // Adding any new voice-affecting param requires updating both sites.
      const v = (settings.voice || {}) as Record<string, unknown>;
      const submittedVoiceKey   = [
        settings.voiceEngine || 'auto',
        v.elevenLabsVoiceId || '', v.elevenLabsModel || '',
        v.presetId || '',
        v.speed ?? '', v.pitch ?? '', v.rate ?? '',
        v.volume ?? '', v.intensity ?? '',
        v.stability ?? '', v.similarity ?? '',
        v.style ?? '', v.speakerBoost ?? '',
        v.throatDepth ?? '', v.ancientRasp ?? '',
        v.royalPace ?? '', v.chamberSpace ?? '',
      ].join('|');
      const submittedVoiceHash = stableHash(submittedVoiceKey);
      if (t.scriptHash && t.scriptHash !== submittedScriptHash) {
        preflightErrors.push('script changed since preview was generated — regenerate the voice preview');
      }
      if (t.voiceHash && t.voiceHash !== submittedVoiceHash) {
        preflightErrors.push('voice/provider changed since preview — regenerate the voice preview');
      }
      if (t.audioPath && !fs.existsSync(t.audioPath)) {
        preflightErrors.push(`preview audio file missing on disk: ${t.audioPath}`);
      }
      // Phase 8: provider mismatch — if timing was built by one engine but the
      // render submits a different engine, the audio file won't match. Block it.
      const tProv = (settings.previewTiming as { provider?: string }).provider;
      const submittedEngine = settings.voiceEngine || 'auto';
      if (tProv && submittedEngine !== 'auto' && tProv.indexOf(submittedEngine) === -1 && submittedEngine.indexOf(tProv) === -1) {
        preflightErrors.push(`timeline audio was generated by ${tProv} but render requested ${submittedEngine} — regenerate the voice preview after switching providers`);
      }
    }
  }
  if (preflightErrors.length) {
    res.status(400).json({ error: 'Preflight validation failed', errors: preflightErrors });
    return;
  }

  const jobId  = Date.now().toString();
  const folder = `${new Date().toISOString().slice(0, 10)}_${settings.trendVaultSign.replace(/\s+/g, '_')}_${jobId}`;

  const jobFile = path.join(TREND_VAULT_OUT, `job_${jobId}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ jobId, outputFolder: folder, scriptLines, settings }));

  const renderState: TrendVaultRenderState = {
    status: 'running',
    logs:   [],
    pct:    0,
    stage:  'Starting...',
    outputFolder: folder,
    startTime: Date.now(),
  };
  activeTrendVaultRenders.set(jobId, renderState);

  // Respond immediately — pipeline runs in background
  res.json({ ok: true, jobId, folder });

  // ─── Helper: push log line + broadcast to all SSE clients ──────────────────
  // The logs array is capped at 500 lines (rolling) so that long renders or a
  // long-running server with many sequential renders can't grow this Map
  // entry without bound — previously a render that produced thousands of
  // ffmpeg/Remotion stdout lines would keep all of them in memory forever,
  // and every SSE reconnect replayed the full history. 500 lines is enough
  // for the UI's scrollback while keeping per-render memory bounded.
  const LOG_CAP = 500;
  const pushLog = (line: string, pct?: number) => {
    const clean = line.replace(/\x1B\[[0-9;]*m/g, '').trim();
    if (!clean) return;
    renderState.logs.push(clean);
    if (renderState.logs.length > LOG_CAP) renderState.logs.splice(0, renderState.logs.length - LOG_CAP);
    if (pct !== undefined) renderState.pct = pct;
    const pctMatch = clean.match(/^(\d+)%/);
    if (pctMatch) renderState.pct = Math.max(renderState.pct, parseInt(pctMatch[1]));
    trendVaultBroadcast(jobId, { log: clean, progress: renderState.pct, stage: renderState.stage });
  };

  const setStage = (label: string, pct: number) => {
    renderState.stage = label;
    renderState.pct   = pct;
    trendVaultBroadcast(jobId, { stage: label, progress: pct });
  };

  // ─── Background pipeline ────────────────────────────────────────────────────
  (async () => {
    try {
      // ── Step 1: Generate TTS voice audio ────────────────────────────────────
      setStage('🎙 Generating voice...', 5);
      pushLog('🎙 Generating TTS voice audio...');

      const voiceParams    = settings.voice || {};
      const fullText       = (scriptLines as Array<{text:string}>).map(l => l.text).join('\n\n');
      const voiceFile      = `trend_vault_voice_${jobId}.mp3`;
      const voicePath      = path.join(AUDIO_DIR, voiceFile);
      const selectedPreset = voiceParams.presetId || 'tiktok_female';
      const selectedEngine = settings.voiceEngine || 'auto';

      pushLog(`[TTS] selected voice: preset=${selectedPreset} engine=${selectedEngine}`);
      pushLog(`[TTS] text length: ${fullText.length} chars across ${scriptLines.length} lines`);

      let voiceBuffer: Buffer;
      // ElevenLabs gives us per-word timestamps as part of TTS — capture them
      // so the timing engine downstream can use real word boundaries instead
      // of word-proportional approximation. Same path as voice-preview.
      let elevenLabsWords: Array<{ word: string; startMs: number; endMs: number }> | undefined;
      try {
        if (selectedEngine === 'elevenlabs') {
          if (!voiceParams.elevenLabsVoiceId) {
            throw new Error('voiceEngine=elevenlabs requires voice.elevenLabsVoiceId');
          }
          const r = await generateElevenLabsVoiceWithTimestamps({
            text:     fullText,
            voiceId:  voiceParams.elevenLabsVoiceId,
            modelId:  voiceParams.elevenLabsModel,
            stability:    voiceParams.stability,
            similarity:   voiceParams.similarity,
            style:        voiceParams.style,
            speakerBoost: voiceParams.speakerBoost,
          });
          voiceBuffer = r.buffer;
          elevenLabsWords = r.words;
          // Bump usage so the studio can warn when budget is nearly reached.
          try { incrementElevenLabsUsage(); } catch { /* non-fatal */ }
        } else {
          const result = await generateVoice({
            text:      fullText,
            presetId:  selectedPreset,
            pitch:     voiceParams.pitch,
            rate:      voiceParams.rate,
            speed:     voiceParams.speed,
            volume:    voiceParams.volume,
            intensity: voiceParams.intensity,
            engine:    settings.voiceEngine as 'auto' | 'local' | 'edge',
            // Cinematic narrator sliders — preview & render use the SAME values
            throatDepth:  voiceParams.throatDepth,
            ancientRasp:  voiceParams.ancientRasp,
            royalPace:    voiceParams.royalPace,
            chamberSpace: voiceParams.chamberSpace,
          });
          voiceBuffer = result.buffer;
        }
      } catch (ttsErr) {
        const msg = (ttsErr as Error).message || String(ttsErr);
        throw new Error(`TTS generation failed: ${msg}. Render aborted — silent videos are no longer allowed. Check internet connection (for Edge TTS) or local TTS server.`);
      }

      // Hard guard: TTS must produce a non-trivial audio file
      if (!voiceBuffer || voiceBuffer.length < 1024) {
        throw new Error(`TTS returned suspiciously small audio (${voiceBuffer?.length || 0} bytes). Render aborted — final video would be silent.`);
      }

      fs.writeFileSync(voicePath, voiceBuffer);
      pushLog(`[TTS] output path: ${voicePath}`);
      pushLog(`[TTS] output size: ${(voiceBuffer.length / 1024).toFixed(0)} KB`, 15);

      // Verify the TTS file actually has duration (not just MP3 headers around
      // silence). Anything under 0.4s is treated as failure and aborts the
      // render — silent voice files are the most common silent-video cause.
      let ttsDurationSec = 0;
      try { ttsDurationSec = await getVideoDuration(voicePath); } catch { ttsDurationSec = 0; }
      pushLog(`[TTS] duration: ${ttsDurationSec.toFixed(2)}s`);
      if (ttsDurationSec < 0.4) {
        throw new Error(`TTS file ${voiceFile} has duration ${ttsDurationSec.toFixed(2)}s — too short / likely silence. Render aborted.`);
      }

      // Copy into public/custom-audio/ so Remotion's staticFile() can find it
      const publicAudioDir = path.join(ROOT, 'public', 'custom-audio');
      fs.mkdirSync(publicAudioDir, { recursive: true });
      const publicAudioPath = path.join(publicAudioDir, voiceFile);
      fs.copyFileSync(voicePath, publicAudioPath);
      pushLog(`[AUDIO] voice path used: ${publicAudioPath}`);
      pushLog(`[AUDIO] voice volume: ${settings.voiceVolume ?? 1}`);
      pushLog(`[AUDIO] music file: ${settings.musicFile || '(none)'}`);
      pushLog(`[AUDIO] music volume: ${settings.musicVolume ?? 0.25}`);
      pushLog(`[DURATION] mode=${settings.durationMode || 'autoVoice'} target=${settings.durationSeconds ?? 'n/a'}s ttsDur=${ttsDurationSec.toFixed(2)}s`);

      // ── Canonical timing build — voice duration is the master clock ─────
      // ONE pipeline produces the timeline used by preview AND render:
      //   1. (optional) Try AssemblyAI to get real per-word timestamps.
      //   2. Always feed the result into buildTimedCaptions() so the final
      //      line boundaries are normalized to the EXACT audio duration.
      //   3. Persist the canonical caption JSON for the frontend to fetch.
      type ScriptLineWithWords = {
        text: string; type: string; durationSeconds: number;
        startMs?: number; endMs?: number;
        words?: Array<{ word: string; startMs: number; endMs: number }>;
      };
      const inputLines: ScriptLineWithWords[] =
        (scriptLines as ScriptLineWithWords[]).map(l => ({ ...l }));

      // Per-word alignment for the timing engine. Three possible sources, in
      // order of preference:
      //   1. ElevenLabs returned timestamps with its TTS (no extra API call)
      //   2. AssemblyAI transcription of the generated voice file
      //   3. Fallback to pure word-proportional inside buildTimedCaptions()
      let perLineWords: Array<Array<{ word: string; startMs: number; endMs: number }>> | undefined;
      let timingSource: TimedCaptionsBundle['source'] = 'word-proportional';

      // Path 1: ElevenLabs already gave us word timestamps
      if (elevenLabsWords && elevenLabsWords.length > 0) {
        perLineWords = alignWordsToLines(scriptLines, elevenLabsWords);
        timingSource = 'assemblyai-forced-alignment';
        pushLog(`✓ ElevenLabs word timestamps: ${elevenLabsWords.length} words across ${inputLines.length} lines`);
      }

      const aaiKey = process.env.ASSEMBLYAI_API_KEY;
      // Path 2: AssemblyAI — skip if ElevenLabs already provided word timings
      if (!perLineWords && aaiKey && fs.existsSync(voicePath)) {
        try {
          pushLog('🔤 Aligning captions to voice (AssemblyAI)...', 16);
          const aai = new AssemblyAI({ apiKey: aaiKey });
          const transcript = await aai.transcripts.transcribe({
            audio: voicePath,
            speech_model: 'best',
          });
          if (transcript.status === 'completed' && transcript.words?.length) {
            const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
            const allWords = transcript.words.map(w => ({
              raw: w.text, norm: norm(w.text), start: w.start, end: w.end,
            }));
            let cursor = 0;
            perLineWords = inputLines.map(line => {
              const lineTokens = line.text.split(/\s+/).filter(Boolean);
              const matched: { word: string; startMs: number; endMs: number }[] = [];
              for (const tok of lineTokens) {
                const target = norm(tok);
                if (!target) { matched.push({ word: tok, startMs: 0, endMs: 0 }); continue; }
                let found = -1;
                for (let i = cursor; i < Math.min(cursor + 6, allWords.length); i++) {
                  if (allWords[i].norm === target) { found = i; break; }
                }
                if (found >= 0) {
                  matched.push({ word: tok, startMs: allWords[found].start, endMs: allWords[found].end });
                  cursor = found + 1;
                } else if (cursor < allWords.length) {
                  matched.push({ word: tok, startMs: allWords[cursor].start, endMs: allWords[cursor].end });
                  cursor += 1;
                } else {
                  matched.push({ word: tok, startMs: 0, endMs: 0 });
                }
              }
              return matched;
            });
            timingSource = 'assemblyai-forced-alignment';
            pushLog(`✓ Aligned ${transcript.words.length} words to ${inputLines.length} lines`);
          } else {
            pushLog(`⚠ AssemblyAI returned status="${transcript.status}" — using word-proportional timing`);
          }
        } catch (e) {
          const msg = (e as Error).message || String(e);
          pushLog(`⚠ AssemblyAI alignment failed (${msg.slice(0, 60)}) — using word-proportional timing`);
        }
      }

      // ── Build the canonical bundle from the actual TTS file duration ────
      // ttsDurationSec was already probed above. This is the master clock —
      // every consumer downstream snaps to this number.
      let canonicalBundle: TimedCaptionsBundle = buildTimedCaptions(
        inputLines.map(l => ({ text: l.text, type: (l.type as 'hook'|'observation'|'escalation'|'truth'|'twist'|'ending'|undefined) ?? 'observation' })),
        ttsDurationSec,
        { perLineWords, source: timingSource },
      );

      // ── Fixed-duration mode ──────────────────────────────────────────────
      // When the user pinned the clip length, REBUILD the bundle against the
      // pinned target instead of the natural voice length. This guarantees
      // the timeline still ends exactly when the user asked, while keeping
      // word-proportional spacing inside the window.
      // Fixed mode OR autoVoice + forceTargetDuration both rescale to target.
      const forceTarget = !!settings.forceTargetDuration;
      const targetDurValid = typeof settings.durationSeconds === 'number' && settings.durationSeconds > 0;
      const modeIsFixed   = (settings.durationMode || 'autoVoice') === 'fixed';
      if ((modeIsFixed || forceTarget) && targetDurValid) {
        const target = settings.durationSeconds;
        // Per-word timings (if any) were anchored to the natural voice clock;
        // rescale them to the new target so they still align with the (sped-up
        // or slowed-down) playback in the renderer.
        const scale = target / canonicalBundle.audioDurationSec;
        const scaledPerLineWords = perLineWords?.map(line => line.map(w => ({
          word: w.word, startMs: w.startMs * scale, endMs: w.endMs * scale,
        })));
        canonicalBundle = buildTimedCaptions(
          inputLines.map(l => ({ text: l.text, type: (l.type as 'hook'|'observation'|'escalation'|'truth'|'twist'|'ending'|undefined) ?? 'observation' })),
          target,
          { perLineWords: scaledPerLineWords, source: timingSource },
        );
        const reason = modeIsFixed ? 'fixed mode' : 'autoVoice + forceTargetDuration';
        pushLog(`[DURATION] ${reason}: rebuilt timeline to fit ${target}s window (${scale.toFixed(3)}× scale)`);
      }

      // ── Apply Text Sync Offset ──────────────────────────────────────────
      // The frontend preview applies (state.textSyncOffsetMs / 1000) to the
      // audio.currentTime → caption-lookup mapping. The renderer historically
      // ignored this value, so any offset the user dialed in to make preview
      // captions match the voice was silently dropped at render time. We now
      // shift every line + word ms by the offset (clamped to ±2000ms and to
      // the audio window) so the baked-in timing matches the preview the user
      // already approved.
      const rawSyncOffset = Number((settings as { textSyncOffsetMs?: number }).textSyncOffsetMs) || 0;
      const textSyncOffsetMs = Math.max(-2000, Math.min(2000, rawSyncOffset));
      if (textSyncOffsetMs !== 0) {
        const offsetSec = textSyncOffsetMs / 1000;
        const maxSec   = canonicalBundle.audioDurationSec;
        const maxMs    = maxSec * 1000;
        const shifted = canonicalBundle.captions.map(c => {
          const newStart = Math.max(0, Math.min(maxSec, c.start + offsetSec));
          const newEnd   = Math.max(newStart, Math.min(maxSec, c.end + offsetSec));
          const newWords = c.words?.map(w => {
            const ws = Math.max(0, Math.min(maxMs, w.startMs + textSyncOffsetMs));
            const we = Math.max(ws, Math.min(maxMs, w.endMs + textSyncOffsetMs));
            return { word: w.word, startMs: ws, endMs: we };
          });
          return {
            ...c,
            start: newStart,
            end: newEnd,
            duration: newEnd - newStart,
            startMs: newStart * 1000,
            endMs: newEnd * 1000,
            words: newWords && newWords.length ? newWords : c.words,
          };
        });
        canonicalBundle = { ...canonicalBundle, captions: shifted };
        pushLog(`[TIMING] applied textSyncOffsetMs=${textSyncOffsetMs} (${offsetSec.toFixed(3)}s) to all caption + word timings`);
      } else {
        pushLog(`[TIMING] textSyncOffsetMs=0 (no offset applied)`);
      }

      // ── Debug log + persist canonical caption JSON ──────────────────────
      logTimingDebug(canonicalBundle, pushLog);
      const captionsDir = path.join(ROOT, 'public', 'captions');
      try {
        fs.mkdirSync(captionsDir, { recursive: true });
        fs.writeFileSync(
          path.join(captionsDir, `captions_${jobId}.json`),
          JSON.stringify({
            audioFile: voiceFile,
            audioDurationSec: canonicalBundle.audioDurationSec,
            source:    canonicalBundle.source,
            captions:  canonicalBundle.captions,
          }, null, 2),
        );
        pushLog(`[TIMING] persisted → public/captions/captions_${jobId}.json`);
      } catch (e) {
        pushLog(`[TIMING] could not persist caption JSON: ${(e as Error).message}`);
      }

      // Convert the bundle into the shape trend-vault-render.ts already consumes
      // (text + startMs + endMs + words). Preview and render now share this
      // same array via the captions JSON above.
      const alignedScriptLines: ScriptLineWithWords[] = bundleToRenderLines(canonicalBundle) as ScriptLineWithWords[];

      // Update job file with voice audioFile + canonical timings
      try {
        const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
        job.settings.audioFile = fs.existsSync(voicePath) ? voiceFile : (settings.audioFile || '');
        job.settings.durationMode    = settings.durationMode    ?? 'autoVoice';
        job.settings.durationSeconds = settings.durationSeconds ?? job.settings.durationSeconds;
        job.settings.voiceVolume     = settings.voiceVolume     ?? 1;
        job.scriptLines = alignedScriptLines;
        // Surface the canonical bundle on the job so anyone reading the job
        // file (sync worker, debugging) sees the same numbers as the renderer.
        job.timing = {
          audioDurationSec: canonicalBundle.audioDurationSec,
          source:           canonicalBundle.source,
          captionsPath:     `public/captions/captions_${jobId}.json`,
        };
        fs.writeFileSync(jobFile, JSON.stringify(job));
      } catch { /* job file update failed — render continues */ }

      // ── Step 2: Bundle & render — via worker or in-process ─────────────────────
      setStage('🎬 Bundling & rendering...', 18);
      pushLog('🎬 Starting Remotion render pipeline...');

      if (RENDER_WORKER_URL) {
        // ── Remote worker path ─────────────────────────────────────────────────
        pushLog(`[WORKER] Delegating render to ${RENDER_WORKER_URL}`);

        // 1. Health-check the worker
        try {
          const hRes = await fetch(`${RENDER_WORKER_URL}/api/render/health`, { signal: AbortSignal.timeout(5000) });
          if (!hRes.ok) throw new Error(`Worker health returned ${hRes.status}`);
          pushLog('[WORKER] Worker is healthy');
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`Render worker unreachable at ${RENDER_WORKER_URL}: ${msg}`);
        }

        // 2. POST the job
        const workerPayload = {
          jobId,
          outputFolder: folder,
          jobFile,
          settings: JSON.parse(fs.readFileSync(jobFile, 'utf-8')),
        };
        const postRes = await fetch(`${RENDER_WORKER_URL}/api/render/job`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(workerPayload),
          signal: AbortSignal.timeout(10000),
        });
        if (!postRes.ok) {
          const body = await postRes.text().catch(() => '');
          throw new Error(`Worker rejected job: ${postRes.status} ${body}`);
        }
        const { id: workerJobId } = await postRes.json() as { id: string };
        pushLog(`[WORKER] Job accepted: ${workerJobId}`);

        // 3. Poll until done, forwarding logs & progress
        let lastLogCount = 0;
        await new Promise<void>((resolve, reject) => {
          const poll = async () => {
            try {
              const statusRes = await fetch(
                `${RENDER_WORKER_URL}/api/render/job/${workerJobId}`,
                { signal: AbortSignal.timeout(8000) }
              );
              if (!statusRes.ok) { reject(new Error(`Worker status ${statusRes.status}`)); return; }
              const status = await statusRes.json() as {
                state: string; logs: string[]; error?: string;
              };

              // Forward new logs
              const newLogs = status.logs.slice(lastLogCount);
              lastLogCount = status.logs.length;
              for (const log of newLogs) {
                renderState.logs.push(log);
                if (renderState.logs.length > LOG_CAP) renderState.logs.splice(0, renderState.logs.length - LOG_CAP);
                const pctMatch = log.match(/^(\d+)%/);
                if (pctMatch) {
                  const pct = Math.round(18 + parseInt(pctMatch[1]) * 0.82);
                  renderState.pct = pct;
                  renderState.stage = `🎬 Rendering… ${parseInt(pctMatch[1])}%`;
                }
                const fMatch = log.match(/(\d+)%\s*\((\d+)\/(\d+)\s*frames?\)/i);
                if (fMatch) {
                  renderState.pct = Math.round(32 + parseInt(fMatch[1]) * 0.6);
                  renderState.stage = `🎬 ${fMatch[2]} / ${fMatch[3]} frames`;
                }
                trendVaultBroadcast(jobId, { log, progress: renderState.pct, stage: renderState.stage });
              }

              if (status.state === 'done') { resolve(); return; }
              if (status.state === 'error') { reject(new Error(status.error ?? 'Worker render failed')); return; }
              if (status.state === 'cancelled') { reject(new Error('Render cancelled on worker')); return; }

              // Still running — poll again in 2 s
              setTimeout(poll, 2000);
            } catch (e) {
              reject(e);
            }
          };
          poll();
        });

        pushLog('[WORKER] Remote render complete');

      } else {
        // ── In-process path (original) ─────────────────────────────────────────
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('npx tsx scripts/trend-vault-render.ts', [], {
            cwd: ROOT,
            shell: true,
            env: { ...process.env, TREND_VAULT_JOB_FILE: jobFile },
          });

          const onData = (data: Buffer) => {
            const raw = data.toString().replace(/\x1B\[[0-9;]*m/g, '');
            for (const line of raw.split('\n')) {
              const clean = line.trim();
              if (!clean) continue;
              renderState.logs.push(clean);
              if (renderState.logs.length > LOG_CAP) renderState.logs.splice(0, renderState.logs.length - LOG_CAP);
              const pctMatch = clean.match(/^(\d+)%/);
              if (pctMatch) {
                const pct = Math.round(18 + parseInt(pctMatch[1]) * 0.82);
                renderState.pct = pct;
                renderState.stage = `🎬 Rendering… ${parseInt(pctMatch[1])}%`;
              }
              if (/using system browser/i.test(clean))    { renderState.stage = '🌐 Browser ready';          renderState.pct = 20; }
              if (/bundling remotion/i.test(clean))        { renderState.stage = '📦 Bundling...';            renderState.pct = 22; }
              if (/bundle ready/i.test(clean))             { renderState.stage = '🎬 Launching renderer...';  renderState.pct = 28; }
              if (/rendering \d+ frames/i.test(clean))     { renderState.stage = '🎬 Rendering frames...';    renderState.pct = 32; }
              if (/render complete|✓ render/i.test(clean)) { renderState.stage = '💾 Encoding MP4...';        renderState.pct = 95; }
              const fMatch = clean.match(/(\d+)%\s*\((\d+)\/(\d+)\s*frames?\)/i);
              if (fMatch) {
                renderState.pct = Math.round(32 + parseInt(fMatch[1]) * 0.6);
                renderState.stage = `🎬 ${fMatch[2]} / ${fMatch[3]} frames`;
              }
              trendVaultBroadcast(jobId, { log: clean, progress: renderState.pct, stage: renderState.stage });
            }
          };

          proc.stdout.on('data', onData);
          proc.stderr.on('data', onData);

          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`trend-vault-render.ts exited with code ${code}`));
          });
          proc.on('error', reject);
        });
      }


      // ── Done — verify mp4 exists AND has an audio stream with real content ─
      const outFile = path.join(TREND_VAULT_OUT, folder, 'video.mp4');
      if (!fs.existsSync(outFile)) {
        throw new Error('Render process finished but video.mp4 not found');
      }
      pushLog(`[RENDER] final mp4 path: ${outFile}`);

      // Permanent guard: ffprobe must confirm an audio stream. We trust ffprobe
      // when available — a missing or empty audio stream means the final MP4
      // is broken regardless of whether the source voice file still exists on
      // disk. The previous logic accepted a silent MP4 as long as the .mp3
      // was present, which is the root cause of the "no voice in final" bug.
      const ffprobeCandidates = [
        path.join(ROOT, 'node_modules', '@remotion', 'compositor-win32-x64-msvc', 'ffprobe.exe'),
        path.join(ROOT, 'node_modules', '@remotion', 'compositor-darwin-arm64', 'ffprobe'),
        path.join(ROOT, 'node_modules', '@remotion', 'compositor-darwin-x64',   'ffprobe'),
        path.join(ROOT, 'node_modules', '@remotion', 'compositor-linux-x64-gnu',  'ffprobe'),
        path.join(ROOT, 'node_modules', '@remotion', 'compositor-linux-arm64-gnu','ffprobe'),
      ];
      const ffprobePath = ffprobeCandidates.find(p => fs.existsSync(p));
      let audioOk     = false;
      let audioProbed = false;
      if (ffprobePath) {
        try {
          const { execFileSync } = await import('child_process');
          const probe = execFileSync(
            ffprobePath,
            ['-v', 'error', '-show_streams', '-select_streams', 'a', outFile],
            { timeout: 15_000 },
          ).toString();
          audioProbed = true;
          // Accept any audio codec (aac, mp3, opus...) — the previous regex
          // demanded codec_name=aac which spuriously failed on Remotion versions
          // that defaulted to a different audio codec for the H.264 mux.
          audioOk = /codec_type=audio/.test(probe);
        } catch (e) {
          pushLog(`[VERIFY] ffprobe failed: ${(e as Error).message}`);
        }
      }
      const audioFileOk = fs.existsSync(publicAudioPath) && fs.statSync(publicAudioPath).size > 1024;
      pushLog(`[VERIFY] final mp4 has audio stream: ${audioProbed ? (audioOk ? 'yes' : 'no') : 'unknown (no ffprobe)'} (voice file present: ${audioFileOk ? 'yes' : 'no'})`);

      // Strict policy: if ffprobe is available and says there is no audio stream,
      // the render is broken. Never pretend it succeeded just because the source
      // .mp3 still exists on disk.
      if (audioProbed && !audioOk) {
        throw new Error(
          `Render produced a video with NO audio stream. ` +
          `ffprobe at ${ffprobePath} found no audio. ` +
          `Voice source: ${publicAudioPath} (present=${audioFileOk}). ` +
          `Marking job as failed — silent videos are not allowed.`
        );
      }
      // Fallback only when ffprobe is unavailable
      if (!audioProbed && !audioFileOk) {
        throw new Error(`Cannot verify render audio — ffprobe missing and voice file ${publicAudioPath} is missing/empty.`);
      }

      renderState.status     = 'done';
      renderState.pct        = 100;
      renderState.stage      = '✅ Complete!';
      renderState.outputFile = `${folder}/video.mp4`;
      pushLog(`✅ Render complete! → trend-vault-output/${folder}/video.mp4`, 100);
      trendVaultBroadcast(jobId, { done: true, success: true, outputFile: renderState.outputFile });

      try { maybeAutoPostRender(folder, pushLog); }
      catch (err) { pushLog(`⚠ TikTok auto-post error: ${(err as Error).message}`); }

      try { maybeAutoPostYouTube(folder, pushLog); }
      catch (err) { pushLog(`⚠ YouTube auto-post error: ${(err as Error).message}`); }

      try { maybeAutoPostInstagram(folder, pushLog); }
      catch (err) { pushLog(`⚠ Instagram auto-post error: ${(err as Error).message}`); }

    } catch (err) {
      const msg = (err as Error).message || String(err);
      renderState.status = 'error';
      renderState.stage  = '❌ Failed';
      pushLog(`❌ Render failed: ${msg}`);
      trendVaultBroadcast(jobId, { done: true, success: false, error: msg });
    } finally {
      // Clean up job file
      try { if (fs.existsSync(jobFile)) fs.unlinkSync(jobFile); } catch { /* ignore */ }
      // Clean up SSE client refs after a delay
      setTimeout(() => trendVaultSseClients.delete(jobId), 30000);
      // Prune the activeTrendVaultRenders entry after 1 hour so the Map doesn't
      // grow unbounded across many sequential renders in a long server session.
      setTimeout(() => activeTrendVaultRenders.delete(jobId), 3_600_000);
    }
  })();
});

// ── List trend-vault outputs ────────────────────────────────────────────────────────
app.get('/api/trend-vault/outputs', (_req, res) => {
  if (!fs.existsSync(TREND_VAULT_OUT)) { res.json({ folders: [] }); return; }
  const folders = fs.readdirSync(TREND_VAULT_OUT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const videoFile = path.join(TREND_VAULT_OUT, d.name, 'video.mp4');
      const metaFile  = path.join(TREND_VAULT_OUT, d.name, 'meta.json');
      const meta = fs.existsSync(metaFile)
        ? JSON.parse(fs.readFileSync(metaFile, 'utf8'))
        : {};
      return {
        folder: d.name,
        hasVideo: fs.existsSync(videoFile),
        meta,
      };
    })
    .filter(d => d.hasVideo)
    .reverse();
  res.json({ folders });
});

// ── Analyze reference video style ────────────────────────────────────────────
app.post('/api/trend-vault/analyze-reference', bgUpload.single('video'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'No file.' }); return; }

  const videoPath = req.file.path;
  const duration  = await getVideoDuration(videoPath);
  const fileSize  = req.file.size;

  // Generate style fingerprint (heuristic analysis)
  const fingerprint = {
    filename:         req.file.originalname,
    durationSeconds:  duration,
    fileSizeMB:       (fileSize / 1024 / 1024).toFixed(1),
    estimatedPacing:  duration < 60 ? 'fast' : duration < 90 ? 'medium' : 'slow',
    recommendedFps:   30,
    analyzedAt:       new Date().toISOString(),
    suggestions: {
      grainType:      'film',
      colorGrade:     'dark',
      textAnimation:  'fade',
      slowZoom:       true,
      fogOverlay:     duration > 75,
      targetDuration: Math.min(Math.max(Math.round(duration), 90), 120),
    },
  };

  // Save fingerprint
  const fpDir = path.join(ROOT, 'data');
  fs.mkdirSync(fpDir, { recursive: true });
  const fpFile = path.join(fpDir, 'style-fingerprints.json');
  let existing: Record<string, unknown>[] = [];
  try { existing = JSON.parse(fs.readFileSync(fpFile, 'utf8')); } catch { /* new */ }
  existing.unshift(fingerprint);
  fs.writeFileSync(fpFile, JSON.stringify(existing.slice(0, 20), null, 2));

  res.json({ ok: true, fingerprint });
});

// Locate ffprobe ONCE: prefer the bundled Remotion binary so this works on
// machines without system ffprobe on PATH. Previously this function silently
// fell back to `90` when ffprobe was missing, which is why every voice
// preview reported audioDurationSec=90 regardless of the real file length —
// the master cause of timeline desync.
const _ffprobeBundled = path.join(ROOT, 'node_modules', '@remotion', 'compositor-win32-x64-msvc', 'ffprobe.exe');
const _FFPROBE_BIN = fs.existsSync(_ffprobeBundled) ? _ffprobeBundled : 'ffprobe';

function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(_FFPROBE_BIN, [
      '-v', 'error', '-print_format', 'json',
      '-show_format', filePath,
    ], { shell: false });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    proc.on('error', (e) => {
      console.error(`[getVideoDuration] ffprobe spawn failed for ${filePath}: ${e.message}`);
      resolve(0); // 0 → caller can detect failure; 90 was misleading
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[getVideoDuration] ffprobe exit ${code} for ${filePath}: ${err.slice(0,200)}`);
        resolve(0);
        return;
      }
      try {
        const data = JSON.parse(out);
        const d = parseFloat(data.format?.duration);
        if (!isFinite(d) || d <= 0) {
          console.error(`[getVideoDuration] no duration in ffprobe output for ${filePath}`);
          resolve(0);
          return;
        }
        resolve(d);
      } catch (e) {
        console.error(`[getVideoDuration] JSON parse failed for ${filePath}: ${(e as Error).message}`);
        resolve(0);
      }
    });
  });
}

// ── Serve prompts database ─────────────────────────────────────────────────────
app.get('/api/prompts', (_req, res) => {
  const fp = path.join(ROOT, 'data', 'prompts.json');
  if (!fs.existsSync(fp)) { res.json({ prompts: [], categories: [] }); return; }
  res.json(JSON.parse(fs.readFileSync(fp, 'utf8')));
});

// ── Extend existing script with AI ────────────────────────────────────────────
app.post('/api/trend-vault/extend-script', async (req, res) => {
  const { trendVaultSign, prompt, emotionalTone, existingLines, addCount } = req.body as {
    trendVaultSign: string; category?: string; prompt: string; angle?: string;
    emotionalTone: string; existingLines: { text: string; type: string; durationSeconds: number }[];
    addCount: number;
  };
  if (!trendVaultSign || !prompt || !existingLines?.length) {
    res.status(400).json({ error: 'trendVaultSign, prompt, existingLines required.' }); return;
  }
  const count = Math.min(Math.max(addCount || 4, 1), 12);

  const hasAnyKey = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  if (!hasAnyKey) {
    const types = ['observation','escalation','truth','twist'] as const;
    const newLines = Array.from({ length: count }, (_, i) => ({
      text: `${trendVaultSign}s carry something most people never see.`,
      type: types[i % types.length],
      durationSeconds: 5,
    }));
    res.json({ ok: true, lines: newLines, source: 'fallback' }); return;
  }

  try {
    const existingText = existingLines.map((l, i) => `${i + 1}. [${l.type}] "${l.text}"`).join('\n');
    const toneMap: Record<string, string> = {
      mysterious: 'mysterious and psychologically deep', emotional: 'raw and emotionally honest',
      dark: 'dark and uncomfortably true', reflective: 'meditative and introspective',
      dramatic: 'high-stakes and tense', intimate: 'close, personal, whispered',
      melancholic: 'beautifully sad and longing', calm: 'steady, certain, quiet authority',
    };
    const tone = toneMap[emotionalTone] || 'mysterious and emotionally resonant';

    const result = await aiComplete({
      maxTokens: 1024,
      user: `You write TikTok trend-vault storytelling scripts. Tone: ${tone}.

Existing script for ${trendVaultSign} about "${prompt}":
${existingText}

Add ${count} NEW continuation lines. Keep the same emotional arc and tone.
Types available: hook, observation, escalation, truth, twist, ending.

Return ONLY valid JSON array (no other text):
[{"text":"...","type":"observation","durationSeconds":5}, ...]

Rules: 1-2 sentences per line, 3-8 seconds each, psychologically vivid, no astrology clichés.`,
    });
    const newLines = parseAIJson<{ text: string; type: string; durationSeconds: number }[]>(result.text);
    res.json({ ok: true, lines: newLines, source: result.provider, warning: result.warning });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.warn('[extend-script] error:', msg);
    const types = ['observation','escalation','truth','twist'] as const;
    const newLines = Array.from({ length: count }, (_, i) => ({
      text: `And yet — ${trendVaultSign}s always find their way back to themselves.`,
      type: types[i % types.length], durationSeconds: 5,
    }));
    res.json({ ok: true, lines: newLines, source: 'fallback', error: msg });
  }
});

// ── Local (no-API) script reframe engine ─────────────────────────────────────
// Fully rewrites the script from scratch using the source lines as thematic
// seeds. Targets ~90 seconds / 190-230 words. Does NOT apply word-swaps that
// produce filler text. Each output line is unique.
function localReframe(
  lines: { text: string; type: string; durationSeconds: number }[],
  trendVaultSign: string,
  _emotionalTone: string
): { text: string; type: string; durationSeconds: number }[] {

  // ── 1. Fix zodiac sign name (guard against double-s mangling) ────────────
  const CORRECT_SIGN: Record<string, string> = {
    aries: 'Aries', ariess: 'Aries',
    taurus: 'Taurus', tauruss: 'Taurus',
    gemini: 'Gemini', geminis: 'Gemini',
    cancer: 'Cancer', cancers: 'Cancer',
    leo: 'Leo', leos: 'Leo',
    virgo: 'Virgo', virgos: 'Virgo',
    libra: 'Libra', libras: 'Libra',
    scorpio: 'Scorpio', scorpios: 'Scorpio',
    sagittarius: 'Sagittarius', sagittariuss: 'Sagittarius',
    capricorn: 'Capricorn', capricorns: 'Capricorn',
    aquarius: 'Aquarius', aquariuss: 'Aquarius',
    pisces: 'Pisces', piscess: 'Pisces',
  };
  const sign = CORRECT_SIGN[trendVaultSign.toLowerCase().trim()] ?? trendVaultSign.trim();

  // ── 2. Extract clean source themes from existing lines ───────────────────
  const FILLER_PHRASES = [
    /something deeper/gi, /most souls never once see/gi, /never once see/gi,
    /can actually/gi, /will inevitably/gi, /absolutely everything/gi,
    /without exception, always/gi, /desperately need/gi,
    /understand on a level words can't reach/gi,
    /feels deep in their bones/gi, /entire existence/gi,
  ];
  const cleanLine = (t: string): string => {
    let s = t.trim().toUpperCase() === t.trim() ? t.trim().toLowerCase() : t.trim();
    // strip filler injected by the old engine
    for (const pat of FILLER_PHRASES) s = s.replace(pat, '');
    return s.replace(/\s{2,}/g, ' ').replace(/[.!?]+$/, '').trim();
  };

  const sourceTexts = lines
    .map(l => cleanLine(l.text))
    .filter(t => t.length > 8);

  // Seed a simple deterministic-ish shuffle based on source content length
  const seed = sourceTexts.join('').length;
  const rng = (() => {
    let s = (seed ^ 0xdeadbeef) >>> 0;
    return () => {
      s = (Math.imul(s ^ (s >>> 15), s | 1) ^ (s + Math.imul(s ^ (s >>> 7), s | 61))) >>> 0;
      return s / 4294967296;
    };
  })();
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];

  // ── 3. Template pools — clean, human, emotional, no filler ───────────────
  const HOOKS = [
    `Most people think ${sign} moves on fast. They don't.`,
    `There's a version of ${sign} you only get to see once.`,
    `${sign} doesn't go cold. They go quiet — and that's worse.`,
    `You didn't lose a ${sign}. You lost their patience.`,
    `The quietest a ${sign} ever gets is right before they're gone.`,
    `${sign} noticed. They're just not telling you yet.`,
    `You mistook ${sign}'s composure for forgiveness. Those aren't the same thing.`,
    `${sign} never warns you twice. The first time is the only time.`,
    `Here's what no one tells you about ${sign}: they remember everything.`,
    `You kept waiting for ${sign} to react. They already decided — weeks ago.`,
  ];

  const OBSERVATIONS = [
    `They can laugh with you, answer your texts, and still be quietly deciding if they trust you anymore.`,
    `What you see on the surface with ${sign} is the edited version. The first draft would stop you cold.`,
    `They aren't holding back. They're holding something. Most people can't tell the difference.`,
    `${sign} reads every room before they speak. People mistake that for arrogance. It's neither.`,
    `They made it look easy on purpose. That is not the same as easy.`,
    `The part of ${sign} you got was earned, not given. Nobody told you which category you fell into.`,
    `They don't perform their feelings. That's not the same as not having any.`,
    `${sign} has a version of themselves the public never sees — and they guard it carefully.`,
    `You saw composure and called it coldness. Those are not the same thing at all.`,
    `From the outside it looks like indifference. From the inside it sounds like a countdown.`,
  ];

  const ESCALATIONS = [
    `They can be fully present with you and still be somewhere else entirely.`,
    `Behind every "I'm fine" from ${sign} is a sentence they already decided you weren't ready to hear.`,
    `The more comfortable you get, the more ${sign} is paying attention. Not relaxing. Watching.`,
    `${sign} doesn't leave during the storm. They leave after — quietly, without a scene, with everything already decided.`,
    `They've been measuring you from the beginning. You just didn't know there was a test.`,
    `When ${sign} goes silent, that silence has a shape to it. Learn the difference.`,
    `The loyalty you saw wasn't naive. It was a choice they made every single day — until they stopped.`,
    `They stayed longer than they should have. They remember exactly when that changed.`,
  ];

  const TRUTHS = [
    `The wall isn't there to keep you out. It's there because last time, nobody stopped them from giving everything.`,
    `${sign} learned early that the loudest love in the room is rarely the one that stays.`,
    `Behind every layer of distance is someone who felt things so deeply once — they built something around it.`,
    `It isn't trust they're protecting. It's the version of themselves that still believes in it.`,
    `They are not pulling away because they stopped caring. They're pulling away because staying started to feel like betraying themselves.`,
    `What looks like detachment is actually a very deliberate kind of protection.`,
    `The people who seem the hardest to reach are usually the ones who felt things the most, once.`,
    `${sign} doesn't need you to understand all of it. They just need you not to make them regret showing you any of it.`,
  ];

  const TWISTS = [
    `And when ${sign} finally goes quiet, that silence usually means the decision has already been made.`,
    `They didn't go quiet because you stopped mattering. They went quiet because you started.`,
    `The version of ${sign} you lost wasn't who they were at their lowest. It was who they were at their most open.`,
    `It's not that they don't feel it. It's that they felt it first — and alone.`,
    `What looked like indifference was actually the last form of dignity they had left to give.`,
    `They're not difficult to love. You're just new to being seen this clearly.`,
    `The most dangerous thing ${sign} can do is finally agree with you. That means they've stopped fighting for something.`,
  ];

  const ENDINGS = [
    `And when ${sign} finally lowers that wall — even slightly — treat it like the rare thing it is.`,
    `When ${sign} softens around you, you're not winning them. You're being trusted.`,
    `That's what makes ${sign} different. Not the distance — what's behind it.`,
    `If ${sign} is still here, it's not because they have to be. Remember that.`,
    `${sign} will find their way through anything. The question is whether you'll still be there when they do.`,
    `When ${sign} tells you something true, they've already decided you can carry it.`,
  ];

  // ── 4. Build the full arc (16-20 lines, ~90 seconds) ────────────────────
  // Shuffle each pool so lines come out in different order each call
  const shuffle = <T>(arr: T[]): T[] => [...arr].sort(() => rng() - 0.5);

  const sHooks    = shuffle(HOOKS);
  const sObs      = shuffle(OBSERVATIONS);
  const sEsc      = shuffle(ESCALATIONS);
  const sTruths   = shuffle(TRUTHS);
  const sTwists   = shuffle(TWISTS);
  const sEndings  = shuffle(ENDINGS);

  // Blend user-added ideas into a couple of truth/escalation slots if available
  const extraIdeas = sourceTexts
    .filter(t => t.length > 20)
    .slice(0, 4)
    .map(t => {
      // Capitalise cleanly and ensure proper punctuation
      const s = t.charAt(0).toUpperCase() + t.slice(1);
      return s.endsWith('.') || s.endsWith('!') || s.endsWith('?') ? s : s + '.';
    });

  // Arc plan: hook × 1, obs × 3, esc × 2, truth × 3, twist × 2, ending × 2
  // Inject up to 2 user ideas into the truth/escalation zone
  const arcLines: { text: string; type: string; durationSeconds: number }[] = [];

  const addLine = (text: string, type: string) => {
    const words = text.trim().split(/\s+/).length;
    const dur = Math.max(3, Math.min(9, Math.round(words / 2.5)));
    arcLines.push({ text, type, durationSeconds: dur });
  };

  // hook
  addLine(sHooks[0], 'hook');

  // observations
  addLine(sObs[0], 'observation');
  addLine(sObs[1], 'observation');
  addLine(sObs[2] || sObs[0], 'observation');

  // escalations — inject a user idea here if available
  addLine(sEsc[0], 'escalation');
  if (extraIdeas[0]) addLine(extraIdeas[0], 'escalation');
  addLine(sEsc[1], 'escalation');

  // truths — inject another user idea here if available
  addLine(sTruths[0], 'truth');
  if (extraIdeas[1]) addLine(extraIdeas[1], 'truth');
  addLine(sTruths[1], 'truth');
  addLine(sTruths[2] || sTruths[0], 'truth');

  // twists
  addLine(sTwists[0], 'twist');
  if (extraIdeas[2]) addLine(extraIdeas[2], 'twist');
  addLine(sTwists[1], 'twist');

  // endings
  addLine(sEndings[0], 'ending');
  if (extraIdeas[3]) addLine(extraIdeas[3], 'ending');
  addLine(sEndings[1], 'ending');

  // ── 5. Deduplicate — remove any lines with identical text ────────────────
  const seen = new Set<string>();
  const deduped = arcLines.filter(l => {
    const key = l.text.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped;
}

// ── Regenerate / reframe — full rewrite toward 1:30 target ───────────────────
app.post('/api/trend-vault/regenerate-script', async (req, res) => {
  const { trendVaultSign, prompt, angle, emotionalTone, existingLines, targetDurationSec } = req.body as {
    trendVaultSign: string; category?: string; prompt: string; angle: string;
    emotionalTone: string; existingLines: { text: string; type: string; durationSeconds: number }[];
    targetDurationSec?: number;
  };
  if (!existingLines?.length) {
    res.status(400).json({ error: 'existingLines required' }); return;
  }

  const targetSec   = targetDurationSec || 90;
  const targetWPM   = 140;
  const targetWords = Math.round(targetSec * targetWPM / 60); // ≈ 210 at 90 s

  // Format source lines so the AI can extract themes & ideas
  const sourceText = existingLines.map((l, i) => `${i + 1}. [${l.type}] "${l.text}"`).join('\n');

  const aiPrompt = `You are rewriting a TikTok zodiac storytelling script for ${trendVaultSign}.

GOAL: Produce a COMPLETELY REWRITTEN script that:
- Targets ${targetSec} seconds at ${targetWPM} WPM (≈ ${targetWords} words total)
- Has 16–22 lines in this arc: hook → observation (×2-3) → escalation (×2) → truth (×3) → twist (×2) → ending (×2)
- Sounds human, emotional, dramatic, and flows naturally when read aloud
- Uses the SOURCE MATERIAL below as THEMES and IDEAS — do NOT copy lines word-for-word unless they are already strong
- Blends any extra user-added lines naturally into the correct arc position
- Has NO repeated sentences, NO filler phrases, NO bad grammar

SOURCE MATERIAL (use as thematic seeds — rewrite fully):
${sourceText}

Sign: ${trendVaultSign}
Topic: ${prompt || ''}${angle ? `\nAngle: ${angle}` : ''}
Tone: ${emotionalTone || 'mysterious'}

WRITING RULES:
- Each line is 1–2 sentences (8–20 words)
- Vary sentence length — short lines hit hard, medium lines build tension
- Speak directly and specifically — no generic astrology clichés
- The zodiac sign name is exactly: ${trendVaultSign} (never add an extra 's' at the end)
- Total word count must land between ${targetWords - 20} and ${targetWords + 20} words

Return ONLY a valid JSON array (no markdown, no commentary):
[{"text":"...","type":"hook","durationSeconds":4}, ...]

durationSeconds = ceil(word_count_of_line / ${(targetWPM / 60).toFixed(2)}) rounded to nearest integer.`;

  // 1. Try cloud AI (Anthropic → OpenAI auto-fallback)
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    try {
      const result = await aiComplete({ maxTokens: 3000, user: aiPrompt });
      const lines  = parseAIJson<{ text: string; type: string; durationSeconds: number }[]>(result.text);
      const totalWords = lines.reduce((s, l) => s + (l.text || '').split(/\s+/).length, 0);
      res.json({ ok: true, lines, source: result.provider, warning: result.warning, meta: { totalWords, targetWords } });
      return;
    } catch (aiErr) {
      const msg = (aiErr as Error).message || String(aiErr);
      console.warn('[Reframe] Cloud AI unavailable, falling back to local engine:', msg.slice(0, 120));
    }
  }

  // 2. Local engine — always works, no API required
  try {
    const lines = localReframe(existingLines, trendVaultSign || 'Scorpio', emotionalTone || 'mysterious');
    res.json({
      ok: true, lines, source: 'local',
      warning: '⚡ Reframed locally (no API key configured).',
    });
  } catch (localErr) {
    res.status(500).json({ ok: false, error: (localErr as Error).message });
  }
});

// ── Fallback prompt bank (used when AI providers are unavailable) ─────────────
const FALLBACK_PROMPTS: Record<string, string[]> = {
  Aries:       ['Why Aries burns every bridge just to build a better one','The moment Aries stopped apologizing for being too much','Why Aries will outwork everyone in the room and still feel behind','How Aries loves — all or nothing, no in between','The dark side of Aries confidence nobody talks about','Why Aries always wins the argument but loses the relationship','Aries and the war they fight every single morning','What Aries actually needs but will never ask for'],
  Taurus:      ['Why Taurus stays in situations long after they should leave','The thing Taurus builds in silence that shocks everyone','How Taurus shows love — and why most people miss it','Why Taurus is the most loyal person you will ever betray','The moment Taurus decides you are not worth their energy','What Taurus refuses to compromise on — and why they are right','Taurus and the comfort they built to survive the chaos','The stubborn truth Taurus already knows but won\'t say'],
  Gemini:      ['Why Gemini is not two-faced — they just see every side','The loneliness Gemini feels when nobody can keep up','How Gemini falls in love — fast, deep, and terrifyingly real','Why Gemini needs ten tabs open to feel like themselves','The version of Gemini most people never get to see','What happens when Gemini finally gets bored of you','Gemini and the story they keep changing until it becomes true','Why Gemini is always the most interesting person in the room'],
  Cancer:      ['Why Cancer remembers everything you said — and never forgets','The quiet way Cancer sacrifices themselves for everyone else','How Cancer protects their heart after they have been broken','Why Cancer will always come back — even when they should not','The version of Cancer that comes out when they stop caring','What Cancer actually wants but is too scared to ask for','Cancer and the home they build inside their own mind','Why Cancer\'s silence is the loudest thing in the room'],
  Leo:         ['Why Leo shines brightest when nobody is watching','The wound behind Leo\'s need to be seen and celebrated','How Leo loves — loudly, fiercely, and completely','Why Leo is the hardest person to walk away from','The moment Leo realized their power was scaring people','What Leo is actually performing when they perform confidence','Leo and the crown they carry in silence','Why Leo gives more than they will ever admit'],
  Virgo:       ['Why Virgo overthinks everything — and is usually right','The exhaustion of being the most reliable person in every room','How Virgo shows love through every small detail nobody notices','Why Virgo\'s standards are not too high — yours are too low','The moment Virgo decides to stop fixing what is not theirs','What Virgo hides behind their need to have everything perfect','Virgo and the criticism they give themselves before you can','Why Virgo deserves someone who notices the effort'],
  Libra:       ['Why Libra keeps the peace at the cost of their own truth','The moment Libra stopped being everyone\'s emotional support','How Libra loves — beautifully, completely, and dangerously','Why Libra\'s indecision is actually a form of deep empathy','The Libra who finally chose themselves over the relationship','What Libra sees in people before they see it in themselves','Libra and the balance they chase that always tips one way','Why Libra\'s charm is not manipulation — it\'s survival'],
  Scorpio:     ['Why Scorpio never forgets — and rarely forgives','The transformation Scorpio had to go through alone','How Scorpio loves — obsessively, completely, and dangerously','Why Scorpio already knew before you said a word','The version of Scorpio that comes out in complete darkness','What Scorpio is really doing when they go silent','Scorpio and the power they pretend not to have','Why Scorpio will burn it all down before they beg'],
  Sagittarius: ['Why Sagittarius runs from the things they want most','The freedom Sagittarius is actually running toward','How Sagittarius loves — wild, honest, and terrifyingly free','Why Sagittarius says the one thing everyone is afraid to say','The moment Sagittarius realized home was a feeling not a place','What Sagittarius actually fears underneath all the adventure','Sagittarius and the truth they deliver without the filter','Why Sagittarius loyalty hits different when you earn it'],
  Capricorn:   ['Why Capricorn works this hard — and what it costs them','The version of Capricorn nobody sees when the work is done','How Capricorn loves — slowly, carefully, and forever','Why Capricorn carries everyone\'s weight without ever asking for help','The moment Capricorn stopped climbing and finally looked down','What Capricorn sacrificed to become who they are today','Capricorn and the success that still feels like it is not enough','Why Capricorn\'s toughness is just love with armor on'],
  Aquarius:    ['Why Aquarius feels like a stranger in every room they walk into','The revolution Aquarius is quietly planning in their head','How Aquarius loves — unexpectedly, deeply, on their own terms','Why Aquarius detaches before you can see them falling apart','The moment Aquarius realized being different was their superpower','What Aquarius is actually thinking when they go distant','Aquarius and the future they see that nobody else believes in yet','Why Aquarius will die for a cause before they cry for themselves'],
  Pisces:      ['Why Pisces absorbs everyone else\'s pain before their own','The dream Pisces is still chasing no matter what it costs','How Pisces loves — completely, selflessly, and at great risk','Why Pisces already sensed what was about to happen','The moment Pisces stopped being everyone\'s emotional escape','What Pisces feels when reality refuses to match the vision','Pisces and the world they built inside their head to survive','Why Pisces empathy is their greatest gift and greatest wound'],
  All:         ['Why your trend-vault sign knows your trauma before you do','The thing every sign does when they are secretly falling apart','How each trend-vault sign shows they care — without saying a word','The dark trait every sign has that they refuse to acknowledge','Why the most dangerous person in the room is a quiet trend-vault','What each sign does to protect themselves from real love','The moment every sign realizes they have outgrown someone','Why your trend-vault sign attracts the exact chaos it fears'],
};

function _fallbackPrompts(sign: string, n: number, exclude: string[]): string[] {
  const pool = [...(FALLBACK_PROMPTS[sign] || []), ...FALLBACK_PROMPTS.All];
  const filtered = pool.filter(p => !exclude.includes(p));
  const source = filtered.length >= n ? filtered : pool;
  const shuffled = [...source].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

// ── Generate fresh prompts with AI (Anthropic → OpenAI → local fallback) ──────
// ── Improve / build on an existing user prompt (Phase 2/3) ──────────────────
// Takes the user's original prompt + any prior AI additions and asks the model
// to ADD detail/sharpness without replacing the original idea.
//
// Request body:
//   { originalPrompt, currentPrompt, aiAdditions: [{text, source}], trendVaultSign?, tone? }
//
// Response:
//   { ok, improvedPrompt, addedDetails, explanation, provider, warning? }
app.post('/api/trend-vault/improve-prompt', async (req, res) => {
  const body = req.body as {
    // New canonical fields requested by the spec
    prompt?:         string;
    emotionalTone?:  boolean | string;
    currentSign?:    string | null;
    scriptStyle?:    string | null;
    // Legacy / back-compat fields
    originalPrompt?: string;
    currentPrompt?:  string;
    aiAdditions?:    Array<{ text: string; source?: string }>;
    trendVaultSign?:     string;
    tone?:           string;
  };
  // Accept both legacy (currentPrompt/originalPrompt) and new (prompt) shapes.
  const current  = (body.prompt || body.currentPrompt || body.originalPrompt || '').trim();
  const original = (body.originalPrompt || current).trim();
  if (!current) {
    res.status(400).json({ ok: false, error: 'prompt (or currentPrompt) required' });
    return;
  }
  const sign = body.currentSign || body.trendVaultSign || 'any sign';
  // Tone resolution: prefer the boolean `emotionalTone` flag from the new
  // contract; fall back to the legacy string tone id. If `emotionalTone` is
  // explicitly true/false we treat it as the deciding signal; otherwise we
  // infer from the tone string.
  const toneStr = (body.tone || (typeof body.emotionalTone === 'string' ? body.emotionalTone : '') || 'cinematic').toString();
  const emotionalToneApplied = (typeof body.emotionalTone === 'boolean')
    ? body.emotionalTone
    : ['emotional','intense','dramatic','sad','mysterious','dark','heartbreak','romantic','nostalgic','vulnerable'].includes(toneStr.toLowerCase());
  const scriptStyle = body.scriptStyle || '';
  const additionsLog = (body.aiAdditions || []).slice(-5).map((a, i) =>
    `  ${i + 1}. (${a.source || 'unknown'}) ${a.text}`
  ).join('\n');

  // No AI key — passthrough so the UI never freezes
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    res.json({
      ok: true,
      success: true,
      improvedPrompt: current,
      addedDetails:   '(no AI key configured — prompt left unchanged)',
      explanation:    'Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env to enable Apply AI.',
      provider:       'none',
      emotionalToneApplied,
      warning:        'No AI key configured',
    });
    return;
  }

  // Tone instruction: emotional ON → cinematic, deeper, more dramatic.
  // emotional OFF → cleaner, tighter, more direct.
  const toneInstruction = emotionalToneApplied
    ? `EMOTIONAL TONE: ON (${toneStr}). Make the rewrite deeper, more dramatic, more human and story-driven. Use vivid sensory language and a cinematic cadence. Surface the unspoken feeling underneath the idea.`
    : `EMOTIONAL TONE: OFF. Keep the rewrite cleaner, tighter, and more direct. No melodrama — sharp wording, plain phrasing, strong but understated hook.`;

  try {
    const result = await aiComplete({
      maxTokens: 600,
      user: `You are sharpening a TikTok video prompt for ${sign}.

THE ORIGINAL IDEA (do not change the topic):
"${original}"

THE CURRENT PROMPT (build on this — improve it, do NOT replace the idea):
"${current}"
${additionsLog ? `\nRECENT AI IMPROVEMENTS APPLIED:\n${additionsLog}` : ''}
${scriptStyle ? `\nSCRIPT STYLE: ${scriptStyle}` : ''}

${toneInstruction}

Your job: Rewrite the CURRENT prompt into a stronger single-paragraph premise.
- Keep the original idea intact (same topic, same trend-vault sign).
- Preserve the user's intent — do not steer it somewhere new.
- Sharpen the hook, the rhythm, and the emotional precision.
- Add ONE concrete detail or angle that wasn't there before.
- The result should still be a single-paragraph premise usable to generate a 60–90s script.

Return ONLY this JSON, nothing else:
{
  "improvedPrompt": "the new full prompt as one paragraph",
  "addedDetails":   "1 short sentence describing what you added",
  "explanation":    "1 short sentence about why it's stronger"
}`,
    });
    const parsed = parseAIJson<{ improvedPrompt: string; addedDetails: string; explanation: string }>(result.text);
    const improved = (parsed.improvedPrompt || current).trim();
    res.json({
      ok: true,
      success: true,
      improvedPrompt: improved,
      addedDetails:   parsed.addedDetails || '',
      explanation:    parsed.explanation  || '',
      provider:       result.provider,
      emotionalToneApplied,
      warning:        result.warning,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // [DIAG] Surface full cause so we never silently no-op again.
    console.warn('[improve-prompt] AI failed:', msg.slice(0, 400));
    // Local heuristic so the button never silently no-ops — user asked for the
    // Apply AI button to ACTUALLY DO something even when both providers fail.
    const local = _localHeuristicImprove(current, sign, toneStr);
    res.json({
      ok: true,
      success: true,
      improvedPrompt: local.improvedPrompt,
      addedDetails:   local.addedDetails,
      explanation:    'AI provider failed — applied a local sharpening pass. Reason: ' + msg.slice(0, 200),
      provider:       'local-fallback',
      emotionalToneApplied,
      warning:        'AI unavailable — applied a local sharpening pass. ' +
                      'Check server console for the real error (likely API key, credits, or response format).',
    });
  }
});

/**
 * Local, deterministic prompt sharpener used when both AI providers fail.
 * Must change the prompt visibly so the user can see the button worked, while
 * preserving the topic / trend-vault sign. Picks the first pool entry whose opening
 * 24 chars are not already present in the prompt to avoid repeat additions.
 */
function _localHeuristicImprove(
  current: string,
  sign: string,
  tone: string,
): { improvedPrompt: string; addedDetails: string } {
  const base = (current || '').replace(/\s+$/g, '');
  const pool = [
    'Lead with a 2-second hook line that names the contradiction up front.',
    'Pace the reveal: 3 short body lines, then a longer twist line that lands hard.',
    'End with a single 5-word line that reframes the whole thing.',
    'Strip vague phrasing. Use concrete imagery (objects, places, gestures) the viewer can see.',
    'Add one specific number or named detail so the claim feels researched, not generic.',
    `Match the ${tone || 'cinematic'} tone for ${sign || 'this sign'}: rhythm-first, low-EQ delivery, no filler.`,
    "Cut every adjective that doesn't earn its place. Each line must move the story.",
    'Anchor the opening line in a moment the viewer has lived through, not an abstract idea.',
  ];
  const lowered = base.toLowerCase();
  const pick = pool.find(p => !lowered.includes(p.toLowerCase().slice(0, 24))) || pool[0];
  return {
    improvedPrompt: base + (base.endsWith('.') ? ' ' : '. ') + pick,
    addedDetails:   pick,
  };
}

app.post('/api/trend-vault/generate-prompts', async (req, res) => {
  const { trendVaultSign, category, count, exclude } = req.body as {
    trendVaultSign?: string; category?: string; count?: number; exclude?: string[];
  };
  const n = Math.min(Math.max(count || 4, 1), 20);
  const sign = trendVaultSign || 'All';
  const cat  = category  || 'general';
  const signCtx = sign === 'All' ? 'any trend-vault sign (universal)' : sign;
  const excludeList = (exclude || []).slice(0, 30);

  // No AI key — return fallback immediately
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    res.json({ ok: true, prompts: _fallbackPrompts(sign, n, excludeList), provider: 'fallback', warning: 'No AI key configured — showing built-in prompts' });
    return;
  }

  const excludeSection = excludeList.length
    ? `\n\nDO NOT repeat any of these existing prompts:\n${excludeList.map(p => `- ${p}`).join('\n')}`
    : '';

  try {
    const result = await aiComplete({
      maxTokens: 1024,
      user: `Generate ${n} fresh, emotionally powerful TikTok video prompt ideas for ${signCtx} in the "${cat}" category.

Each prompt should be a 1-sentence core premise that would make someone stop scrolling.
Focus on: psychological truths, relatable behavior, emotional resonance, universal human experiences.${excludeSection}

Return ONLY a JSON array of strings, no other text:
["prompt one","prompt two",...]`,
    });
    const prompts = parseAIJson<string[]>(result.text);
    res.json({ ok: true, prompts: prompts.slice(0, n), provider: result.provider, warning: result.warning });
  } catch (e) {
    // AI failed — serve fallback so the UI is never broken
    console.warn('[generate-prompts] AI failed, using fallback:', (e as Error).message?.slice(0, 120));
    res.json({ ok: true, prompts: _fallbackPrompts(sign, n, excludeList), provider: 'fallback', warning: 'AI unavailable — showing built-in prompts (check API credits)' });
  }
});

// ── Draft save / load / delete ─────────────────────────────────────────────────
app.get('/api/trend-vault/drafts', (_req, res) => {
  if (!fs.existsSync(DRAFTS_DIR)) { res.json({ drafts: [] }); return; }
  const drafts = fs.readdirSync(DRAFTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, f), 'utf8'));
        return { id: f.replace('.json', ''), ...data };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a: Record<string,unknown>, b: Record<string,unknown>) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  res.json({ drafts });
});

app.post('/api/trend-vault/drafts', (req, res) => {
  const { name, state: draftState } = req.body as { name: string; state: unknown };
  if (!name || !draftState) { res.status(400).json({ error: 'name and state required' }); return; }
  const id = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const payload = { id, name, savedAt: new Date().toISOString(), state: draftState };
  fs.writeFileSync(path.join(DRAFTS_DIR, `${id}.json`), JSON.stringify(payload, null, 2));
  res.json({ ok: true, id, name });
});

app.delete('/api/trend-vault/drafts/:id', (req, res) => {
  const fp = path.join(DRAFTS_DIR, `${path.basename(req.params.id)}.json`);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

// ── Background download queue (visible to client via SSE) ────────────────────
interface DownloadJob {
  id: string;
  url: string;
  type: 'audio' | 'video';
  status: 'queued' | 'resolving' | 'downloading' | 'extracting' | 'complete' | 'failed';
  filename?: string;
  savePath?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}
const downloadQueue: DownloadJob[] = [];

function addJob(job: DownloadJob) {
  downloadQueue.unshift(job);
  if (downloadQueue.length > 50) downloadQueue.length = 50;
}

app.get('/api/trend-vault/download-queue', (_req, res) => {
  res.json({ jobs: downloadQueue });
});

app.delete('/api/trend-vault/download-queue/:id', (req, res) => {
  const idx = downloadQueue.findIndex(j => j.id === req.params.id);
  if (idx >= 0) downloadQueue.splice(idx, 1);
  res.json({ ok: true });
});

// Resolve TikTok shortened URLs (tiktok.com/t/...) by following redirects
async function resolveUrl(url: string): Promise<string> {
  // TikTok shortened URLs need to be expanded before yt-dlp can handle them reliably
  if (/tiktok\.com\/t\//i.test(url) || /vm\.tiktok\.com/i.test(url) || /vt\.tiktok\.com/i.test(url)) {
    try {
      const r = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(10000),
      });
      // Final URL after redirects
      if (r.url && r.url !== url) return r.url;
    } catch { /* fall through */ }
  }
  return url;
}

// ── Import audio/video from URL (yt-dlp) — background queue ──────────────────
app.post('/api/trend-vault/import-url', async (req, res) => {
  const { url, type } = req.body as { url: string; type: 'audio' | 'video' };
  if (!url) { res.status(400).json({ error: 'url required' }); return; }

  // Quick yt-dlp availability check
  const ytdlp = await new Promise<boolean>(resolve => {
    const check = spawn('yt-dlp', ['--version'], { shell: true });
    check.on('close', code => resolve(code === 0));
    check.on('error', () => resolve(false));
  });
  if (!ytdlp) {
    res.status(503).json({ error: 'yt-dlp not installed. Run: pip install yt-dlp' }); return;
  }

  // Create job and respond immediately — process in background
  const job: DownloadJob = {
    id: `dl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    url, type, status: 'queued', startedAt: Date.now(),
  };
  addJob(job);
  res.json({ ok: true, jobId: job.id, type });

  // Background processing
  (async () => {
    try {
      job.status = 'resolving';
      const resolvedUrl = await resolveUrl(url);
      job.status = 'downloading';

      const destDir  = type === 'video' ? BACKGROUNDS : MUSIC_DIR;
      const safeFmt  = type === 'video' ? 'bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best' : 'bestaudio/best';
      const outTmpl  = path.join(destDir, '%(title).40s.%(ext)s');

      await new Promise<void>((resolve, reject) => {
        const args = [
          '--no-playlist',
          '--no-warnings',
          '--retries', '3',
          '--output', outTmpl,
          '--format', safeFmt,
          '--print', 'after_move:filepath',
        ];
        if (type === 'audio') {
          args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
          job.status = 'extracting';
        }
        args.push(resolvedUrl);

        const proc = spawn('yt-dlp', args, { shell: true });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', code => {
          if (code === 0) {
            // Pick last printed filepath
            const lines = stdout.trim().split('\n').filter(Boolean);
            const lastPath = lines.pop()?.trim();
            if (lastPath) {
              job.filename = path.basename(lastPath);
              job.savePath = type === 'video'
                ? `Project > Backgrounds > ${job.filename}`
                : `Project > Music > ${job.filename}`;
            }
            resolve();
          } else {
            // Friendlier error messages
            const out = stderr || stdout;
            let friendly = '';
            if (/Private video|This video is private/i.test(out)) friendly = 'This video is private';
            else if (/HTTP Error 404/i.test(out)) friendly = 'Video not found (deleted or invalid URL)';
            else if (/Sign in to confirm|age-restricted/i.test(out)) friendly = 'Age-restricted or login required';
            else if (/Unable to extract|Unsupported URL/i.test(out)) friendly = 'URL format not supported by yt-dlp';
            else if (/HTTP Error 403/i.test(out)) friendly = 'Access blocked (try again or check URL)';
            else friendly = out.slice(-300) || `yt-dlp exit ${code}`;
            reject(new Error(friendly));
          }
        });
        proc.on('error', reject);
      });

      job.status = 'complete';
      job.completedAt = Date.now();
    } catch (e) {
      job.status = 'failed';
      job.error = (e as Error).message;
      job.completedAt = Date.now();
    }
  })();
});

// ─── Stock Media Browser ────────────────────────────────────────────────────

// GET /api/stock/videos?q=cosmos&page=1
app.get('/api/stock/videos', async (req, res) => {
  const key = (process.env.PEXELS_API_KEY ?? '').trim();
  if (!key) {
    res.json({ error: 'no_key', provider: 'pexels' });
    return;
  }
  const q    = String(req.query.q   || 'cosmos mystical stars');
  const page = String(req.query.page || '1');
  try {
    const resp = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=15&page=${page}&orientation=portrait`,
      { headers: { Authorization: key } }
    );
    const data = await resp.json() as any;
    const videos = ((data.videos ?? []) as any[]).map(v => {
      const files: any[] = v.video_files ?? [];
      // prefer portrait HD <= 1080 wide, else first file
      const pick = files.find(f => f.height > f.width && f.width <= 1080 && f.quality === 'hd')
                ?? files.find(f => f.height > f.width)
                ?? files.find(f => f.quality === 'hd')
                ?? files[0];
      return {
        id:          String(v.id),
        thumb:       v.image ?? '',
        duration:    v.duration ?? 0,
        author:      v.user?.name ?? 'Pexels',
        downloadUrl: pick?.link ?? '',
        width:       pick?.width  ?? 0,
        height:      pick?.height ?? 0,
        source:      'pexels',
      };
    }).filter(v => v.downloadUrl);
    res.json({ videos, page: data.page ?? page, total: data.total_results ?? 0 });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// GET /api/stock/audio?q=ambient&page=1
app.get('/api/stock/audio', async (req, res) => {
  const clientId = (process.env.JAMENDO_CLIENT_ID ?? '').trim();
  if (!clientId) {
    res.json({ error: 'no_key', provider: 'jamendo' });
    return;
  }
  const q      = String(req.query.q || 'ambient').trim();
  const page   = Number(req.query.page || 1);
  const offset = (page - 1) * 20;

  // Map common mood words to Jamendo tag vocabulary
  const MOOD_MAP: Record<string, string> = {
    calm: 'ambient', chill: 'chillout', mystical: 'new+age',
    spiritual: 'new+age', meditation: 'new+age',
    cinematic: 'soundtrack', dramatic: 'soundtrack',
    fantasy: 'soundtrack', epic: 'orchestral',
    lofi: 'downtempo', dark: 'ambient',
    orchestral: 'orchestral', ambient: 'ambient',
    atmospheric: 'ambient', peaceful: 'new+age',
  };
  const mappedTag = MOOD_MAP[q.toLowerCase()] ?? null;

  const baseParams: Record<string, string> = {
    client_id:   clientId,
    format:      'json',
    limit:       '20',
    offset:      String(offset),
    audioformat: 'mp31',
    imagesize:   '100',
    include:     'musicinfo',
    order:       'popularity_month',
  };

  async function jamendoFetch(extra: Record<string, string>) {
    const p = new URLSearchParams({ ...baseParams, ...extra });
    const r = await fetch(`https://api.jamendo.com/v3.0/tracks/?${p}`);
    return r.json() as any;
  }

  try {
    // Stage 1 - exact/mapped tag search (best for mood chips)
    let data = mappedTag ? await jamendoFetch({ tags: mappedTag }) : null;

    // Detect auth/credential errors early
    if (data?.headers?.status === 'failed') {
      const code = data?.headers?.code;
      if (code === 5 || code === 2 || String(data?.headers?.error_message ?? '').toLowerCase().includes('credential')) {
        res.json({ error: 'no_key', provider: 'jamendo' });
        return;
      }
    }

    // Stage 2 - fuzzy tag search
    if (!data?.results?.length) {
      data = await jamendoFetch({ fuzzytags: q });
    }

    // Stage 3 - full-text name search
    if (!data?.results?.length) {
      data = await jamendoFetch({ namesearch: q });
    }

    // Stage 4 - last resort: popular ambient tracks
    if (!data?.results?.length) {
      data = await jamendoFetch({ tags: 'ambient' });
    }

    const tracks = ((data?.results ?? []) as any[]).map(t => {
      const rawDownload: string = t.audiodownload ?? t.audio ?? '';
      const downloadUrl = rawDownload
        ? (rawDownload.includes('?')
            ? `${rawDownload}&client_id=${clientId}`
            : `${rawDownload}?client_id=${clientId}`)
        : '';
      return {
        id:          String(t.id),
        title:       t.name ?? 'Track',
        author:      t.artist_name ?? '',
        duration:    t.duration ?? 0,
        thumb:       t.image ?? '',
        previewUrl:  t.audio ?? '',
        downloadUrl,
        tags:        (t.musicinfo?.tags?.genres ?? []).slice(0, 3).join(', '),
        source:      'jamendo',
      };
    });
    res.json({ tracks, page, total: data?.headers?.results_count ?? tracks.length });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Trend Vault Studio  —  http://localhost:${PORT}/trend-vault\n`);
});
