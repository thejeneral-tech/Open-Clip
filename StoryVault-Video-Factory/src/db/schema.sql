-- StoryVault Video Factory schema (spec §20).
-- Large media (MP4/WAV) is NEVER stored in the DB; rows hold file paths + metadata.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Sources & stories
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,          -- reddit | reddit_url | quora_url | pasted | file | csv | rss | website
  label         TEXT,
  url           TEXT,
  community     TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stories (
  id                 TEXT PRIMARY KEY,
  source_id          TEXT,
  source_type        TEXT NOT NULL,
  external_id        TEXT,              -- reddit post id etc.
  url                TEXT,
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  author             TEXT,
  community          TEXT,              -- subreddit / site
  category           TEXT,
  created_utc        INTEGER,           -- unix seconds of original post
  upvotes            INTEGER DEFAULT 0,
  num_comments       INTEGER DEFAULT 0,
  upvote_ratio       REAL,
  awards             INTEGER DEFAULT 0,
  word_count         INTEGER DEFAULT 0,
  reading_seconds    INTEGER DEFAULT 0,
  est_video_seconds  INTEGER DEFAULT 0,
  -- scoring breakdown
  score_overall      REAL DEFAULT 0,
  score_popularity   REAL DEFAULT 0,
  score_engagement   REAL DEFAULT 0,
  score_quality      REAL DEFAULT 0,
  score_hook         REAL DEFAULT 0,
  score_conflict     REAL DEFAULT 0,
  score_ending       REAL DEFAULT 0,
  score_video        REAL DEFAULT 0,
  score_originality  REAL DEFAULT 0,
  score_recency      REAL DEFAULT 0,
  score_reasons      TEXT,              -- JSON array of human-readable reasons
  warnings           TEXT,              -- JSON array of content warnings
  analysis           TEXT,              -- JSON analysis blob (spec §7)
  duplicate_of       TEXT,              -- story id this duplicates, if any
  duplicate_score    REAL DEFAULT 0,
  status             TEXT DEFAULT 'new',-- new | saved | approved | excluded | used
  created_at         TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status);
CREATE INDEX IF NOT EXISTS idx_stories_category ON stories(category);
CREATE INDEX IF NOT EXISTS idx_stories_external ON stories(external_id);

CREATE TABLE IF NOT EXISTS searches (
  id          TEXT PRIMARY KEY,
  params      TEXT NOT NULL,            -- JSON of the search request
  result_ids  TEXT,                     -- JSON array of story ids
  count       INTEGER DEFAULT 0,
  saved       INTEGER DEFAULT 0,
  name        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  custom      INTEGER DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  story_ids   TEXT,                     -- JSON array
  created_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Originality / duplicate prevention (spec §9)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fingerprints (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,            -- story_url | post_id | title | story_text | semantic | script | hook | ending | bg_sequence | voice | caption_style | music | render
  ref_id      TEXT,                     -- story/video id this fingerprint belongs to
  hash        TEXT,                     -- exact hash (sha256)
  shingles    TEXT,                     -- JSON array of minhash signature for semantic similarity
  value       TEXT,                     -- raw value for short fields (hook/ending)
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fp_kind_hash ON fingerprints(kind, hash);
CREATE INDEX IF NOT EXISTS idx_fp_ref ON fingerprints(ref_id);

-- ---------------------------------------------------------------------------
-- Scripts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scripts (
  id              TEXT PRIMARY KEY,
  story_id        TEXT NOT NULL,
  duration_target INTEGER,             -- seconds
  hook_style      TEXT,
  hook            TEXT,
  setup           TEXT,
  conflict        TEXT,
  escalation      TEXT,
  ending          TEXT,
  audience_question TEXT,
  full_text       TEXT,                -- the narration-ready text
  word_count      INTEGER,
  est_seconds     REAL,
  drama_level     INTEGER DEFAULT 3,   -- 1..5
  safe_mode       INTEGER DEFAULT 0,
  source_attribution TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scripts_story ON scripts(story_id);

-- ---------------------------------------------------------------------------
-- Background videos & segments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backgrounds (
  id            TEXT PRIMARY KEY,
  filename      TEXT NOT NULL,
  original_name TEXT,
  path          TEXT NOT NULL,         -- absolute path to ORIGINAL (never overwritten)
  category      TEXT,
  tags          TEXT,                  -- JSON array
  duration      REAL,
  width         INTEGER,
  height        INTEGER,
  fps           REAL,
  aspect        TEXT,
  size_bytes    INTEGER,
  thumbnail     TEXT,                  -- path to thumbnail jpg
  favorite      INTEGER DEFAULT 0,
  archived      INTEGER DEFAULT 0,
  times_used    INTEGER DEFAULT 0,
  last_used     TEXT,
  quality_score REAL DEFAULT 0,
  analyzed      INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bg_category ON backgrounds(category);

CREATE TABLE IF NOT EXISTS segments (
  id            TEXT PRIMARY KEY,
  background_id TEXT NOT NULL,
  start_sec     REAL NOT NULL,
  end_sec       REAL NOT NULL,
  duration      REAL NOT NULL,
  name          TEXT,
  tags          TEXT,                  -- JSON array
  usable        INTEGER DEFAULT 1,     -- 0 = marked unusable
  quality_score REAL DEFAULT 0,
  times_used    INTEGER DEFAULT 0,
  last_used     TEXT,
  thumbnail     TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (background_id) REFERENCES backgrounds(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_seg_bg ON segments(background_id);
CREATE INDEX IF NOT EXISTS idx_seg_usable ON segments(usable);

CREATE TABLE IF NOT EXISTS segment_usage (
  id          TEXT PRIMARY KEY,
  segment_id  TEXT NOT NULL,
  video_id    TEXT,
  used_at     TEXT NOT NULL,
  FOREIGN KEY (segment_id) REFERENCES segments(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Narration & captions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS narration (
  id          TEXT PRIMARY KEY,
  script_id   TEXT NOT NULL,
  provider    TEXT,
  voice       TEXT,
  speed       REAL DEFAULT 1.0,
  style       TEXT,
  path        TEXT,                    -- wav/m4a path
  duration    REAL,
  settings_hash TEXT,                  -- so we skip regenerating identical narration
  word_timings TEXT,                   -- JSON of word-level timings
  created_at  TEXT NOT NULL,
  FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS captions (
  id          TEXT PRIMARY KEY,
  narration_id TEXT NOT NULL,
  style       TEXT,
  position    TEXT,
  size        INTEGER,
  ass_path    TEXT,                    -- ASS subtitle file for burn-in
  srt_path    TEXT,
  censored    INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (narration_id) REFERENCES narration(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Videos (projects), render jobs, exports
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS videos (
  id            TEXT PRIMARY KEY,
  story_id      TEXT,
  script_id     TEXT,
  narration_id  TEXT,
  caption_id    TEXT,
  batch_id      TEXT,
  title         TEXT,
  duration      REAL,
  segment_plan  TEXT,                  -- JSON: ordered [{segmentId, backgroundId, start, end}]
  voice         TEXT,
  caption_style TEXT,
  status        TEXT DEFAULT 'draft',  -- draft | preview | ready_for_review | approved | rendering | complete | failed | rejected | exported
  preview_path  TEXT,
  render_path   TEXT,
  duplicate_score REAL DEFAULT 0,
  warnings      TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_batch ON videos(batch_id);

CREATE TABLE IF NOT EXISTS render_jobs (
  id          TEXT PRIMARY KEY,
  video_id    TEXT NOT NULL,
  preset      TEXT,
  status      TEXT DEFAULT 'queued',   -- queued | running | done | failed
  progress    REAL DEFAULT 0,
  stage       TEXT,
  output_path TEXT,
  error       TEXT,
  started_at  TEXT,
  finished_at TEXT,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS exports (
  id          TEXT PRIMARY KEY,
  video_id    TEXT NOT NULL,
  platform    TEXT,
  path        TEXT,
  size_bytes  INTEGER,
  width       INTEGER,
  height      INTEGER,
  duration    REAL,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Batch jobs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batches (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  params      TEXT NOT NULL,           -- JSON of batch config
  status      TEXT DEFAULT 'Waiting',
  total       INTEGER DEFAULT 0,
  completed   INTEGER DEFAULT 0,
  failed      INTEGER DEFAULT 0,
  paused      INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batch_items (
  id          TEXT PRIMARY KEY,
  batch_id    TEXT NOT NULL,
  position    INTEGER,
  story_id    TEXT,
  video_id    TEXT,
  status      TEXT DEFAULT 'Waiting',
  stage_detail TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Misc: preferences, presets, errors, activity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS preferences (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  data        TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS presets (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,           -- voice | caption | batch | search
  name        TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS errors (
  id          TEXT PRIMARY KEY,
  scope       TEXT,
  message     TEXT,
  detail      TEXT,
  ref_id      TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id          TEXT PRIMARY KEY,
  tag         TEXT,                    -- STORIES | SCRIPT | AUDIO | VIDEO | CAPTIONS | PREVIEW | RENDER | SYSTEM
  message     TEXT NOT NULL,
  level       TEXT DEFAULT 'info',     -- info | warn | error | success
  ref_id      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);
