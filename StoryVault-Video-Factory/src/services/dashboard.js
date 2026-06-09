'use strict';
// Dashboard analytics (spec §24) + Command Center pipeline/resource/throughput stats.
const fs = require('node:fs');
const os = require('node:os');
const db = require('../db/database');
const { PATHS } = require('../config');
const segSvc = require('./segments');
const dedup = require('./dedup');

function count(sql, p = []) { return db.get(sql, p)?.c || 0; }

function topRow(sql) { return db.get(sql); }

function dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = require('node:path').join(dir, f.name);
      if (f.isDirectory()) total += dirSize(full);
      else { try { total += fs.statSync(full).size; } catch { /* */ } }
    }
  } catch { /* */ }
  return total;
}

function summary() {
  const reuse = segSvc.reuseStats();
  const mostCategory = topRow("SELECT category, count(*) c FROM stories WHERE category IS NOT NULL GROUP BY category ORDER BY c DESC LIMIT 1");
  const mostLength = topRow("SELECT duration_target d, count(*) c FROM scripts GROUP BY duration_target ORDER BY c DESC LIMIT 1");
  const mostBg = topRow("SELECT original_name, times_used FROM backgrounds ORDER BY times_used DESC LIMIT 1");
  const storageBytes = dirSize(PATHS.data);

  return {
    storiesDiscovered: count('SELECT count(*) c FROM stories'),
    storiesSaved: count("SELECT count(*) c FROM stories WHERE status IN ('saved','approved','used')"),
    videosCreated: count('SELECT count(*) c FROM videos'),
    videosApproved: count("SELECT count(*) c FROM videos WHERE status IN ('approved','complete','exported')"),
    videosExported: count('SELECT count(*) c FROM exports'),
    mostSuccessfulCategory: mostCategory ? `${mostCategory.category} (${mostCategory.c})` : '—',
    mostSuccessfulLength: mostLength ? `${mostLength.d}s (${mostLength.c})` : '—',
    mostUsedBackground: mostBg && mostBg.times_used ? `${mostBg.original_name} (${mostBg.times_used}×)` : '—',
    segmentReusePercent: reuse.reusePercent,
    duplicatesPrevented: count('SELECT count(*) c FROM stories WHERE duplicate_of IS NOT NULL'),
    failedTasks: count('SELECT count(*) c FROM errors') + count("SELECT count(*) c FROM videos WHERE status = 'failed'"),
    storageUsed: humanBytes(storageBytes),
    storageBytes,
    historyTracked: dedup.historyCount(),
    recentExports: db.all('SELECT e.*, v.title FROM exports e LEFT JOIN videos v ON v.id = e.video_id ORDER BY e.created_at DESC LIMIT 8'),
    pipeline: pipelineStats(),
    resources: resourceStats(storageBytes),
    throughput: throughputStats(),
  };
}

// Live pipeline stage counts for the Command Center (Discover → … → Export).
function pipelineStats() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    discovered: count('SELECT count(*) c FROM stories'),
    scored: count('SELECT count(*) c FROM stories WHERE score_overall > 0'),
    accepted: count("SELECT count(*) c FROM stories WHERE status IN ('saved','approved','used')"),
    rejected: count("SELECT count(*) c FROM stories WHERE status = 'excluded'"),
    scriptsReady: count('SELECT count(*) c FROM scripts'),
    narrationsReady: count('SELECT count(*) c FROM narration'),
    captionsReady: count('SELECT count(*) c FROM captions'),
    queued: count("SELECT count(*) c FROM batch_items WHERE status = 'Waiting'"),
    rendering: count("SELECT count(*) c FROM videos WHERE status = 'rendering'"),
    review: count("SELECT count(*) c FROM videos WHERE status = 'ready_for_review'"),
    exported: count('SELECT count(*) c FROM exports'),
    failed: count("SELECT count(*) c FROM videos WHERE status = 'failed'"),
    retried: count("SELECT count(*) c FROM render_jobs WHERE status = 'queued' AND started_at IS NOT NULL"),
    completedToday: count('SELECT count(*) c FROM exports WHERE substr(created_at,1,10) = ?', [today]),
  };
}

function resourceStats(storageBytes) {
  let diskFree = null;
  try { const s = fs.statfsSync(PATHS.data); diskFree = s.bavail * s.bsize; } catch { /* older node / unsupported */ }
  return {
    cpus: os.cpus().length,
    loadAvg: Math.round((os.loadavg()[0] || 0) * 100) / 100,
    ramTotal: humanBytes(os.totalmem()),
    ramUsedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    gpu: 'n/a (not measured)',
    storageUsed: humanBytes(storageBytes),
    storageFree: diskFree != null ? humanBytes(diskFree) : 'unknown',
    activeWorkers: count("SELECT count(*) c FROM render_jobs WHERE status = 'running'"),
  };
}

// Honest, MEASURED throughput from completed render jobs (single-worker). Never claims
// 1000/day unless real timings support it.
function throughputStats() {
  const jobs = db.all("SELECT started_at, finished_at FROM render_jobs WHERE status = 'done' AND started_at IS NOT NULL AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 50");
  const durs = jobs.map((j) => (new Date(j.finished_at) - new Date(j.started_at)) / 1000).filter((x) => x > 0.2);
  const avg = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0;
  const perHour = avg > 0 ? Math.floor(3600 / avg) : 0;
  return {
    sampleSize: durs.length,
    avgRenderSeconds: avg ? Math.round(avg * 10) / 10 : null,
    measuredVideosPerHour: perHour || null,
    measuredVideosPerDay: perHour ? perHour * 24 : null,
    note: durs.length ? 'Measured from completed renders (single worker).' : 'No completed renders yet — run a video to measure.',
  };
}

function humanBytes(b) {
  if (b < 1024) return b + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1; do { b /= 1024; i++; } while (b >= 1024 && i < units.length - 1);
  return b.toFixed(1) + ' ' + units[i];
}

module.exports = { summary, humanBytes };
