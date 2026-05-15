/**
 * render-worker.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Standalone Zodiac Render Worker — runs on port 4000.
 *
 * PURPOSE
 *   This process handles ONLY the CPU-heavy Remotion rendering step.
 *   The dashboard (port 3001) handles TTS, AssemblyAI alignment, and timing,
 *   then POSTs the fully-prepared job here for frame rendering.
 *
 * LOCAL TEST MODE (both on same machine)
 *   npm start              → dashboard on :3001
 *   npm run dev:worker     → render worker on :4000
 *   .env: RENDER_WORKER_URL=http://localhost:4000
 *
 * REMOTE MODE (home computer as render worker)
 *   .env on dashboard: RENDER_WORKER_URL=http://192.168.x.x:4000
 *   Files shared via local network or sync-worker.js
 *
 * API
 *   GET  /api/render/health           — worker health check
 *   POST /api/render/job              — submit a render job
 *   GET  /api/render/job/:id          — get job status + logs snapshot
 *   GET  /api/render/job/:id/stream   — SSE real-time log stream
 *   GET  /api/render/jobs             — list recent jobs (last 50)
 *   POST /api/render/job/:id/cancel   — cancel a running job
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';

// ── Config ───────────────────────────────────────────────────────────────────

const WORKER_PORT      = Number(process.env.RENDER_WORKER_PORT ?? 4000);
const MAX_CONCURRENT   = 1; // only one render at a time — Remotion is CPU-bound
const ROOT             = path.resolve('.');
const ZODIAC_OUT       = path.join(ROOT, 'zodiac-output');
const JOB_HISTORY_FILE = path.join(ZODIAC_OUT, '.worker-job-history.json');

// Ensure output dir exists
fs.mkdirSync(ZODIAC_OUT, { recursive: true });

// ── Job state ────────────────────────────────────────────────────────────────

type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

interface WorkerJob {
  id:           string;
  status:       JobStatus;
  submittedAt:  number;
  startedAt?:   number;
  finishedAt?:  number;
  pct:          number;
  stage:        string;
  outputFolder: string;
  outputFile?:  string;
  logs:         string[];
  error?:       string;
}

const jobs      = new Map<string, WorkerJob>();
const processes = new Map<string, ChildProcess>();
const sseClients = new Map<string, Set<express.Response>>();

function broadcast(jobId: string, payload: object) {
  const msg = 'data: ' + JSON.stringify(payload) + '\n\n';
  sseClients.get(jobId)?.forEach(c => { try { c.write(msg); } catch { /* ignore */ } });
}

function activeCount(): number {
  return [...jobs.values()].filter(j => j.status === 'running').length;
}

function queuedJobs(): WorkerJob[] {
  return [...jobs.values()].filter(j => j.status === 'queued')
    .sort((a, b) => a.submittedAt - b.submittedAt);
}

// Persist job history to disk so restarts can show recent completions
function saveHistory() {
  try {
    const recent = [...jobs.values()]
      .filter(j => j.status !== 'queued' && j.status !== 'running')
      .sort((a, b) => b.submittedAt - a.submittedAt)
      .slice(0, 50)
      .map(j => ({ ...j, logs: j.logs.slice(-20) })); // keep last 20 log lines only
    fs.writeFileSync(JOB_HISTORY_FILE, JSON.stringify(recent, null, 2));
  } catch { /* non-fatal */ }
}

function loadHistory() {
  try {
    if (!fs.existsSync(JOB_HISTORY_FILE)) return;
    const past = JSON.parse(fs.readFileSync(JOB_HISTORY_FILE, 'utf8')) as WorkerJob[];
    for (const j of past) jobs.set(j.id, j);
  } catch { /* non-fatal */ }
}

// ── Render runner ─────────────────────────────────────────────────────────────

const LOG_CAP = 500;

async function runJob(job: WorkerJob, jobFilePath: string): Promise<void> {
  job.status    = 'running';
  job.startedAt = Date.now();
  job.stage     = 'Starting Remotion...';
  broadcast(job.id, { status: 'running', stage: job.stage, progress: 0 });

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('npx tsx scripts/zodiac-render.ts', [], {
      cwd:   ROOT,
      shell: true,
      env:   { ...process.env, ZODIAC_JOB_FILE: jobFilePath },
    });

    processes.set(job.id, proc);

    const onLine = (line: string) => {
      const clean = line.replace(/\x1B\[[0-9;]*m/g, '').trim();
      if (!clean) return;

      job.logs.push(clean);
      if (job.logs.length > LOG_CAP) job.logs.splice(0, job.logs.length - LOG_CAP);

      // Parse progress from Remotion stdout
      const pctMatch = clean.match(/^(\d+)%/);
      if (pctMatch) job.pct = Math.round(18 + parseInt(pctMatch[1]) * 0.82);

      const fMatch = clean.match(/(\d+)%\s*\((\d+)\/(\d+)\s*frames?\)/i);
      if (fMatch) {
        job.pct   = Math.round(32 + parseInt(fMatch[1]) * 0.6);
        job.stage = fMatch[2] + ' / ' + fMatch[3] + ' frames';
      }

      if (/bundling remotion/i.test(clean))        { job.stage = 'Bundling...';         job.pct = 22; }
      if (/bundle ready/i.test(clean))             { job.stage = 'Launching renderer...'; job.pct = 28; }
      if (/rendering \d+ frames/i.test(clean))     { job.stage = 'Rendering frames...';  job.pct = 32; }
      if (/render complete|ok render/i.test(clean)){ job.stage = 'Encoding MP4...';      job.pct = 95; }
      if (/using system browser/i.test(clean))     { job.stage = 'Browser ready';        job.pct = 20; }

      broadcast(job.id, { log: clean, progress: job.pct, stage: job.stage });
    };

    proc.stdout.on('data', (d: Buffer) => d.toString().split('\n').forEach(onLine));
    proc.stderr.on('data', (d: Buffer) => d.toString().split('\n').forEach(onLine));

    proc.on('close', code => {
      processes.delete(job.id);
      if (code === 0) resolve();
      else reject(new Error('zodiac-render.ts exited with code ' + code));
    });
    proc.on('error', reject);
  });
}

async function startJob(job: WorkerJob, jobFilePath: string): Promise<void> {
  try {
    await runJob(job, jobFilePath);
    // Confirm output exists
    const outFile = path.join(ZODIAC_OUT, job.outputFolder, 'video.mp4');
    if (!fs.existsSync(outFile)) throw new Error('video.mp4 not found after render');
    job.status     = 'done';
    job.pct        = 100;
    job.stage      = 'Done';
    job.outputFile = 'video.mp4';
    job.finishedAt = Date.now();
    broadcast(job.id, { done: true, success: true, outputFile: job.outputFile, progress: 100 });
    console.log('[worker] job done: ' + job.id + ' -> ' + outFile);
  } catch (e) {
    job.status     = 'error';
    job.error      = (e as Error).message;
    job.finishedAt = Date.now();
    broadcast(job.id, { done: true, success: false, error: job.error });
    console.error('[worker] job failed: ' + job.id + ' ' + job.error);
  } finally {
    // Close all SSE clients for this job
    sseClients.get(job.id)?.forEach(c => { try { c.end(); } catch { /* ignore */ } });
    sseClients.delete(job.id);
    // Clean up temp job file
    try { if (fs.existsSync(jobFilePath)) fs.unlinkSync(jobFilePath); } catch { /* ignore */ }
    saveHistory();
    // Start next queued job if any
    const next = queuedJobs()[0];
    if (next) {
      const nextFile = path.join(ZODIAC_OUT, 'worker_job_' + next.id + '.json');
      setImmediate(() => startJob(next, nextFile));
    }
  }
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '4mb' }));

// CORS — allow dashboard on any port to call the worker
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  next();
});

// ── GET /api/render/health ────────────────────────────────────────────────────
app.get('/api/render/health', (_req, res) => {
  const running   = activeCount();
  const queued    = queuedJobs().length;
  const zodiacOk  = fs.existsSync(ZODIAC_OUT);
  const renderOk  = fs.existsSync(path.join(ROOT, 'scripts', 'zodiac-render.ts'));
  const tsxOk     = fs.existsSync(path.join(ROOT, 'node_modules', '.bin', 'tsx')) ||
                    fs.existsSync(path.join(ROOT, 'node_modules', 'tsx'));

  const status = (!zodiacOk || !renderOk || !tsxOk) ? 'failed'
               : running >= MAX_CONCURRENT            ? 'busy'
               : 'ready';

  res.json({
    status,
    port:             WORKER_PORT,
    maxConcurrent:    MAX_CONCURRENT,
    activeRenders:    running,
    queuedJobs:       queued,
    zodiacOutputOk:   zodiacOk,
    renderScriptOk:   renderOk,
    tsxAvailable:     tsxOk,
    uptime:           Math.round(process.uptime()),
    timestamp:        new Date().toISOString(),
    node:             process.version,
    platform:         process.platform,
    arch:             os.arch(),
    cpus:             os.cpus().length,
    freeMem:          Math.round(os.freemem() / 1024 / 1024) + ' MB',
  });
});

// ── POST /api/render/job ──────────────────────────────────────────────────────
// Body: { jobId, outputFolder, scriptLines, settings }
// (same shape as the zodiac-render.ts job file)
app.post('/api/render/job', (req, res) => {
  const body = req.body as {
    jobId?: string;
    outputFolder?: string;
    scriptLines?: unknown[];
    settings?: Record<string, unknown>;
  };

  if (!body.settings || !Array.isArray(body.scriptLines) || !body.outputFolder) {
    res.status(400).json({ error: 'settings, scriptLines, and outputFolder are required' });
    return;
  }

  const jobId = body.jobId ?? Date.now().toString();

  // Write job file so zodiac-render.ts can read it (same interface as server.ts)
  const jobFilePath = path.join(ZODIAC_OUT, 'worker_job_' + jobId + '.json');
  try {
    fs.writeFileSync(jobFilePath, JSON.stringify({
      jobId,
      outputFolder: body.outputFolder,
      scriptLines:  body.scriptLines,
      settings:     body.settings,
    }));
  } catch (e) {
    res.status(500).json({ error: 'Could not write job file: ' + (e as Error).message });
    return;
  }

  const job: WorkerJob = {
    id:           jobId,
    status:       'queued',
    submittedAt:  Date.now(),
    pct:          0,
    stage:        'Queued',
    outputFolder: body.outputFolder,
    logs:         [],
  };
  jobs.set(jobId, job);

  const busy = activeCount() >= MAX_CONCURRENT;
  if (busy) {
    broadcast(jobId, { status: 'queued', queuePosition: queuedJobs().length });
    console.log('[worker] job queued: ' + jobId + ' (worker busy)');
  } else {
    setImmediate(() => startJob(job, jobFilePath));
    console.log('[worker] job started: ' + jobId);
  }

  res.json({ ok: true, jobId, status: job.status, queued: busy });
});

// ── GET /api/render/job/:id ───────────────────────────────────────────────────
app.get('/api/render/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json({
    id:           job.id,
    status:       job.status,
    pct:          job.pct,
    stage:        job.stage,
    outputFolder: job.outputFolder,
    outputFile:   job.outputFile,
    error:        job.error,
    submittedAt:  job.submittedAt,
    startedAt:    job.startedAt,
    finishedAt:   job.finishedAt,
    logs:         job.logs.slice(-100), // last 100 log lines
  });
});

// ── GET /api/render/job/:id/stream (SSE) ─────────────────────────────────────
app.get('/api/render/job/:id/stream', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Register client
  if (!sseClients.has(job.id)) sseClients.set(job.id, new Set());
  sseClients.get(job.id)!.add(res);

  // Replay existing logs
  for (const log of job.logs) {
    res.write('data: ' + JSON.stringify({ log }) + '\n\n');
  }
  res.write('data: ' + JSON.stringify({ progress: job.pct, stage: job.stage }) + '\n\n');

  // If already finished, send done event and close
  if (job.status !== 'queued' && job.status !== 'running') {
    res.write('data: ' + JSON.stringify({
      done:    true,
      success: job.status === 'done',
      outputFile: job.outputFile,
      error:   job.error,
    }) + '\n\n');
    sseClients.get(job.id)?.delete(res);
    res.end();
    return;
  }

  // Heartbeat
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); } }, 15000);
  req.on('close', () => { clearInterval(hb); sseClients.get(job.id)?.delete(res); });
});

// ── GET /api/render/jobs ──────────────────────────────────────────────────────
app.get('/api/render/jobs', (_req, res) => {
  const list = [...jobs.values()]
    .sort((a, b) => b.submittedAt - a.submittedAt)
    .slice(0, 50)
    .map(j => ({
      id: j.id, status: j.status, pct: j.pct, stage: j.stage,
      outputFolder: j.outputFolder, outputFile: j.outputFile,
      submittedAt: j.submittedAt, finishedAt: j.finishedAt, error: j.error,
    }));
  res.json({ jobs: list, activeCount: activeCount(), queuedCount: queuedJobs().length });
});

// ── POST /api/render/job/:id/cancel ──────────────────────────────────────────
app.post('/api/render/job/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  if (job.status !== 'running' && job.status !== 'queued') {
    res.status(409).json({ error: 'Job is not running or queued' }); return;
  }
  // Kill process if running
  const proc = processes.get(job.id);
  if (proc) {
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    processes.delete(job.id);
  }
  job.status     = 'cancelled';
  job.finishedAt = Date.now();
  job.stage      = 'Cancelled';
  broadcast(job.id, { done: true, success: false, error: 'Cancelled' });
  sseClients.get(job.id)?.forEach(c => { try { c.end(); } catch { /* ignore */ } });
  sseClients.delete(job.id);
  saveHistory();
  res.json({ ok: true, jobId: job.id });
});

// ── Start ─────────────────────────────────────────────────────────────────────

loadHistory();

const server = app.listen(WORKER_PORT, () => {
  console.log('');
  console.log('  Zodiac Render Worker  —  Ready');
  console.log('  http://localhost:' + WORKER_PORT);
  console.log('  Max concurrent renders: ' + MAX_CONCURRENT);
  console.log('  Jobs in history: ' + jobs.size);
  console.log('');
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error('ERROR: Port ' + WORKER_PORT + ' already in use.');
    console.error('Stop the existing render worker first.');
    process.exit(1);
  } else {
    console.error('Worker server error:', err.message);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
