'use strict';
// Additive, non-destructive migrations. Runs on every boot after schema.sql.
// NEVER drops or rewrites user data: only `CREATE TABLE IF NOT EXISTS` and guarded
// `ALTER TABLE ADD COLUMN`. Each migration is idempotent. (Phase 1 data-safety rule.)

const templatesData = require('../templates-data');

function tableColumns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name); }
  catch { return []; }
}
function ensureColumn(db, table, col, ddl) {
  if (!tableColumns(db, table).includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function run(db, nowIso) {
  // --- new tables (additive) ------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS templates (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      builtin    INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      data       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id          TEXT PRIMARY KEY,
      platform    TEXT NOT NULL,            -- reddit | quora
      label       TEXT,
      method      TEXT,                     -- oauth | anonymous | manual_import | cookie_session
      username    TEXT,
      status      TEXT DEFAULT 'disconnected',
      token_enc   TEXT,                     -- encrypted secret blob (never plaintext, never logged)
      token_expires_at TEXT,
      scopes      TEXT,
      last_ok_at  TEXT,
      last_error  TEXT,
      meta        TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform);
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    -- Persistent, stage-based jobs (survive restart, resume from last completed stage).
    CREATE TABLE IF NOT EXISTS jobs (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL DEFAULT 'video',
      batch_id        TEXT,
      story_id        TEXT,
      video_id        TEXT,
      status          TEXT NOT NULL DEFAULT 'queued',  -- queued|running|paused|done|failed|dead|cancelled
      stage           TEXT,                            -- last/current stage name
      priority        INTEGER DEFAULT 100,
      attempts        INTEGER DEFAULT 0,
      max_attempts    INTEGER DEFAULT 3,
      params          TEXT,                            -- JSON: settings for the run
      state           TEXT,                            -- JSON: produced artefact ids (resume context)
      idempotency_key TEXT,
      error           TEXT,
      lease_owner     TEXT,
      lease_expires_at TEXT,
      next_run_at     TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      started_at      TEXT,
      finished_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_idem ON jobs(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_jobs_next ON jobs(status, next_run_at);

    CREATE TABLE IF NOT EXISTS job_stages (
      id          TEXT PRIMARY KEY,
      job_id      TEXT NOT NULL,
      name        TEXT NOT NULL,
      ordinal     INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',     -- pending|running|done|failed|skipped
      attempts    INTEGER DEFAULT 0,
      error       TEXT,
      output      TEXT,
      started_at  TEXT,
      finished_at TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobstages_job ON job_stages(job_id);

    CREATE TABLE IF NOT EXISTS workers (
      id             TEXT PRIMARY KEY,
      type           TEXT,
      status         TEXT,
      host           TEXT,
      pid            INTEGER,
      current_job_id TEXT,
      last_heartbeat TEXT,
      started_at     TEXT
    );

    -- Voice presets (SAPI + Fish Speech) and cloned voices.
    CREATE TABLE IF NOT EXISTS voice_presets (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      engine       TEXT NOT NULL DEFAULT 'sapi',  -- sapi | fish | fish-clone
      voice        TEXT,                          -- engine voice id / SAPI voice name
      icon         TEXT,
      speed        REAL DEFAULT 1.0,
      temperature  REAL,
      pitch        REAL DEFAULT 0,
      style        TEXT,
      clone_id     TEXT,                          -- → voice_clones.id when engine = fish-clone
      settings     TEXT,                          -- JSON: extra knobs
      preview_path TEXT,
      is_default   INTEGER DEFAULT 0,
      builtin      INTEGER DEFAULT 0,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS voice_clones (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      reference_path TEXT NOT NULL,                -- uploaded reference WAV
      transcript     TEXT,
      status         TEXT DEFAULT 'ready',
      created_at     TEXT NOT NULL
    );
  `);

  // --- additive columns on existing tables ----------------------------------
  ensureColumn(db, 'videos', 'template_id', 'template_id TEXT');
  ensureColumn(db, 'videos', 'final_audio_path', 'final_audio_path TEXT');
  ensureColumn(db, 'videos', 'overlay_ass_path', 'overlay_ass_path TEXT');
  ensureColumn(db, 'videos', 'total_duration', 'total_duration REAL');
  ensureColumn(db, 'videos', 'intro_meta', 'intro_meta TEXT');
  // verified/estimated/unavailable provenance for engagement metrics (Phase 4 scoring)
  ensureColumn(db, 'stories', 'metrics_provenance', 'metrics_provenance TEXT');
  ensureColumn(db, 'stories', 'views', 'views INTEGER');
  ensureColumn(db, 'stories', 'score_breakdown', 'score_breakdown TEXT');
  ensureColumn(db, 'stories', 'score_label', 'score_label TEXT');
  // Phase 5: link each batch item to its persistent job + track retry attempts/backoff.
  ensureColumn(db, 'batch_items', 'job_id', 'job_id TEXT');
  ensureColumn(db, 'batch_items', 'attempts', 'attempts INTEGER DEFAULT 0');
  ensureColumn(db, 'batch_items', 'next_run_at', 'next_run_at TEXT');
  // Exports: structured filename + JSON sidecar metadata (spec §20 deliverable).
  ensureColumn(db, 'exports', 'filename', 'filename TEXT');
  ensureColumn(db, 'exports', 'sidecar_path', 'sidecar_path TEXT');
  // Soft-delete (trash bin) across the user-facing libraries.
  ensureColumn(db, 'stories', 'deleted_at', 'deleted_at TEXT');
  ensureColumn(db, 'backgrounds', 'deleted_at', 'deleted_at TEXT');
  ensureColumn(db, 'templates', 'deleted_at', 'deleted_at TEXT');
  ensureColumn(db, 'exports', 'deleted_at', 'deleted_at TEXT');
  // Voice presets (custom + cloned) — Fish Speech / SAPI.
  ensureColumn(db, 'voice_presets', 'deleted_at', 'deleted_at TEXT');

  // --- seed built-in templates (idempotent by id) ---------------------------
  const exists = db.prepare('SELECT id FROM templates WHERE id = ?');
  const insert = db.prepare('INSERT INTO templates (id, name, builtin, is_default, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const t of templatesData.BUILTIN_TEMPLATES) {
    if (!exists.get(t.id)) {
      insert.run(t.id, t.name, 1, t.isDefault ? 1 : 0, JSON.stringify(t), nowIso(), nowIso());
    }
  }
}

module.exports = { run, ensureColumn, tableColumns };
