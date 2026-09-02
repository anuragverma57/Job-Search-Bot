-- Job Apply Bot schema (v1)
--
-- Status vocabulary is enforced with CHECK constraints so a typo in code
-- fails at write time instead of silently creating a status nothing queries.

-- Jobs discovered from any platform.
CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- normalized company + title + location. The dedup key: the same role
  -- appears on several boards under different URLs, so URL is not enough.
  canonical_key   TEXT NOT NULL UNIQUE,

  platform        TEXT NOT NULL,
  company         TEXT NOT NULL,
  title           TEXT NOT NULL,
  location        TEXT,
  url             TEXT NOT NULL,
  description     TEXT,
  salary_text     TEXT,

  posted_at       TEXT,
  discovered_at   TEXT NOT NULL DEFAULT (datetime('now')),

  status          TEXT NOT NULL DEFAULT 'discovered'
                  CHECK (status IN (
                    'discovered',
                    'filtered_out',
                    'shortlisted',
                    'prepared',
                    'applied',
                    'needs_manual',
                    'failed'
                  )),

  -- why the deterministic filter rejected it, for tuning
  filter_reason   TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_platform ON jobs (platform);
CREATE INDEX IF NOT EXISTS idx_jobs_company  ON jobs (company);
CREATE INDEX IF NOT EXISTS idx_jobs_found    ON jobs (discovered_at);


-- One row per application attempt.
CREATE TABLE IF NOT EXISTS applications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id             INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,

  status             TEXT NOT NULL DEFAULT 'prepared'
                     CHECK (status IN (
                       'prepared',
                       'applied',
                       'responded',
                       'interviewing',
                       'offer',
                       'rejected',
                       'ghosted',
                       'needs_manual',
                       'failed'
                     )),

  resume_version     TEXT,
  resume_path        TEXT,
  cover_letter_path  TEXT,

  -- 0/1. 'applied' requires confirmed = 1: a click that did not throw is
  -- not proof of submission.
  confirmed          INTEGER NOT NULL DEFAULT 0,
  confirmation_text  TEXT,
  screenshot_path    TEXT,

  dry_run            INTEGER NOT NULL DEFAULT 1,

  failure_reason     TEXT,
  -- verbatim question text when routed to needs_manual, so it can be
  -- added to the answer bank
  unanswered_question TEXT,

  contact_email      TEXT,

  prepared_at        TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at         TEXT,
  followed_up_at     TEXT,
  last_status_change TEXT NOT NULL DEFAULT (datetime('now')),

  notes              TEXT
);

CREATE INDEX IF NOT EXISTS idx_apps_status  ON applications (status);
CREATE INDEX IF NOT EXISTS idx_apps_job     ON applications (job_id);
CREATE INDEX IF NOT EXISTS idx_apps_applied ON applications (applied_at);

-- One live application per job. Failed attempts are retryable, so they are
-- excluded from the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_one_per_job
  ON applications (job_id)
  WHERE status NOT IN ('failed', 'needs_manual');


-- AI scoring history. Kept append-only so re-scoring after a prompt change
-- can be compared against the old result.
CREATE TABLE IF NOT EXISTS ai_evaluations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,

  score        REAL NOT NULL CHECK (score >= 0 AND score <= 10),
  reason       TEXT NOT NULL,

  model        TEXT NOT NULL,
  tokens_used  INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,

  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evals_job   ON ai_evaluations (job_id);
CREATE INDEX IF NOT EXISTS idx_evals_score ON ai_evaluations (score);


-- Learned answers to application questions. Seeded from config.json, then
-- grown as unknown questions are encountered and answered.
CREATE TABLE IF NOT EXISTS answer_bank (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  question_pattern  TEXT NOT NULL UNIQUE,
  answer            TEXT NOT NULL,
  field_type        TEXT NOT NULL DEFAULT 'text'
                    CHECK (field_type IN ('text', 'textarea', 'select', 'radio', 'checkbox')),
  times_used        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);


-- One row per pipeline run. This is what the notifier summarizes and what
-- reveals a platform that has silently stopped returning results.
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  command       TEXT NOT NULL,

  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,

  discovered    INTEGER NOT NULL DEFAULT 0,
  duplicates    INTEGER NOT NULL DEFAULT 0,
  filtered_out  INTEGER NOT NULL DEFAULT 0,
  evaluated     INTEGER NOT NULL DEFAULT 0,
  prepared      INTEGER NOT NULL DEFAULT 0,
  submitted     INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  needs_manual  INTEGER NOT NULL DEFAULT 0,

  tokens_used   INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,

  dry_run       INTEGER NOT NULL DEFAULT 1,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at);


-- Consecutive failures per platform. Three in a row means the selectors
-- broke, which is an alert rather than a log line.
CREATE TABLE IF NOT EXISTS platform_health (
  platform             TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at      TEXT,
  last_failure_at      TEXT,
  last_error           TEXT
);
