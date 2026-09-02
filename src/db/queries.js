'use strict';

const db = require('./index');

/**
 * Query helpers used across phases. Kept in one file so the SQL surface is
 * greppable; better-sqlite3 is synchronous so none of these are async.
 */

// ---- Jobs ------------------------------------------------------------------

function insertJob(job) {
  const stmt = db.raw.prepare(`
    INSERT INTO jobs (canonical_key, platform, company, title, location, url, description, salary_text, posted_at)
    VALUES (@canonical_key, @platform, @company, @title, @location, @url, @description, @salary_text, @posted_at)
    ON CONFLICT (canonical_key) DO NOTHING
  `);

  const result = stmt.run({
    location: null,
    description: null,
    salary_text: null,
    posted_at: null,
    ...job,
  });

  // changes === 0 means the canonical key already existed: a duplicate.
  return { inserted: result.changes > 0, id: result.lastInsertRowid };
}

function jobExists(canonicalKey) {
  return Boolean(
    db.raw.prepare('SELECT 1 FROM jobs WHERE canonical_key = ?').get(canonicalKey)
  );
}

function getJob(id) {
  return db.raw.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function getJobsByStatus(status, limit = 100) {
  return db.raw
    .prepare('SELECT * FROM jobs WHERE status = ? ORDER BY discovered_at DESC LIMIT ?')
    .all(status, limit);
}

function setJobStatus(id, status, filterReason = null) {
  return db.raw
    .prepare('UPDATE jobs SET status = ?, filter_reason = ? WHERE id = ?')
    .run(status, filterReason, id);
}

// ---- Applications ----------------------------------------------------------

function insertApplication(application) {
  const stmt = db.raw.prepare(`
    INSERT INTO applications (job_id, status, resume_version, resume_path, cover_letter_path, dry_run)
    VALUES (@job_id, @status, @resume_version, @resume_path, @cover_letter_path, @dry_run)
  `);

  const result = stmt.run({
    status: 'prepared',
    resume_version: null,
    resume_path: null,
    cover_letter_path: null,
    dry_run: 1,
    ...application,
  });

  return result.lastInsertRowid;
}

function setApplicationStatus(id, status, fields = {}) {
  const columns = Object.keys(fields);
  const assignments = ['status = @status', "last_status_change = datetime('now')"]
    .concat(columns.map((column) => `${column} = @${column}`))
    .join(', ');

  return db.raw
    .prepare(`UPDATE applications SET ${assignments} WHERE id = @id`)
    .run({ id, status, ...fields });
}

/**
 * Enforces the daily cap. Counts real submissions only — dry runs don't
 * consume quota.
 */
function countApplicationsToday() {
  const row = db.raw
    .prepare(`
      SELECT COUNT(*) AS count FROM applications
      WHERE dry_run = 0
        AND applied_at IS NOT NULL
        AND date(applied_at) = date('now')
    `)
    .get();
  return row.count;
}

function getPendingApproval() {
  return db.raw
    .prepare(`
      SELECT a.*, j.company, j.title, j.url, j.location, j.platform,
             (SELECT score  FROM ai_evaluations e WHERE e.job_id = j.id ORDER BY e.created_at DESC LIMIT 1) AS score,
             (SELECT reason FROM ai_evaluations e WHERE e.job_id = j.id ORDER BY e.created_at DESC LIMIT 1) AS reason
      FROM applications a
      JOIN jobs j ON j.id = a.job_id
      WHERE a.status = 'prepared'
      ORDER BY score DESC NULLS LAST, a.prepared_at DESC
    `)
    .all();
}

function getFollowUpsDue(afterDays) {
  return db.raw
    .prepare(`
      SELECT a.*, j.company, j.title, j.url
      FROM applications a
      JOIN jobs j ON j.id = a.job_id
      WHERE a.status = 'applied'
        AND a.followed_up_at IS NULL
        AND julianday('now') - julianday(a.applied_at) >= ?
      ORDER BY a.applied_at ASC
    `)
    .all(afterDays);
}

/**
 * Keeps "awaiting response" honest by aging out silent applications.
 */
function markGhosted(afterDays) {
  return db.raw
    .prepare(`
      UPDATE applications
      SET status = 'ghosted', last_status_change = datetime('now')
      WHERE status = 'applied'
        AND julianday('now') - julianday(applied_at) >= ?
    `)
    .run(afterDays).changes;
}

function getRecentApplications(limit = 30) {
  return db.raw
    .prepare(`
      SELECT a.*, j.company, j.title, j.url, j.platform, j.location
      FROM applications a
      JOIN jobs j ON j.id = a.job_id
      ORDER BY COALESCE(a.applied_at, a.prepared_at) DESC
      LIMIT ?
    `)
    .all(limit);
}

// ---- AI evaluations --------------------------------------------------------

function insertEvaluation(evaluation) {
  return db.raw
    .prepare(`
      INSERT INTO ai_evaluations (job_id, score, reason, model, tokens_used, cost_usd)
      VALUES (@job_id, @score, @reason, @model, @tokens_used, @cost_usd)
    `)
    .run({ tokens_used: 0, cost_usd: 0, ...evaluation }).lastInsertRowid;
}

function getMonthlySpend() {
  const row = db.raw
    .prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS total
      FROM ai_evaluations
      WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `)
    .get();
  return row.total;
}

// ---- Runs ------------------------------------------------------------------

function startRun(command, dryRun) {
  return db.raw
    .prepare('INSERT INTO runs (command, dry_run) VALUES (?, ?)')
    .run(command, dryRun ? 1 : 0).lastInsertRowid;
}

function finishRun(id, counts = {}, error = null) {
  const columns = Object.keys(counts);
  const assignments = ["finished_at = datetime('now')", 'error = @error']
    .concat(columns.map((column) => `${column} = @${column}`))
    .join(', ');

  return db.raw
    .prepare(`UPDATE runs SET ${assignments} WHERE id = @id`)
    .run({ id, error, ...counts });
}

// ---- Platform health -------------------------------------------------------

function recordPlatformSuccess(platform) {
  return db.raw
    .prepare(`
      INSERT INTO platform_health (platform, consecutive_failures, last_success_at)
      VALUES (?, 0, datetime('now'))
      ON CONFLICT (platform) DO UPDATE
        SET consecutive_failures = 0, last_success_at = datetime('now'), last_error = NULL
    `)
    .run(platform);
}

function recordPlatformFailure(platform, error) {
  db.raw
    .prepare(`
      INSERT INTO platform_health (platform, consecutive_failures, last_failure_at, last_error)
      VALUES (?, 1, datetime('now'), ?)
      ON CONFLICT (platform) DO UPDATE
        SET consecutive_failures = consecutive_failures + 1,
            last_failure_at = datetime('now'),
            last_error = excluded.last_error
    `)
    .run(platform, String(error));

  const row = db.raw
    .prepare('SELECT consecutive_failures FROM platform_health WHERE platform = ?')
    .get(platform);

  return row.consecutive_failures;
}

// ---- Dashboard summary -----------------------------------------------------

function getSummary(followUpDays) {
  const one = (sql, ...params) => db.raw.prepare(sql).get(...params).count;

  return {
    appliedThisWeek: one(
      "SELECT COUNT(*) AS count FROM applications WHERE status != 'prepared' AND applied_at >= date('now', '-7 days')"
    ),
    awaitingResponse: one("SELECT COUNT(*) AS count FROM applications WHERE status = 'applied'"),
    followUpsDue: one(
      `SELECT COUNT(*) AS count FROM applications
       WHERE status = 'applied' AND followed_up_at IS NULL
         AND julianday('now') - julianday(applied_at) >= ?`,
      followUpDays
    ),
    responses: one(
      "SELECT COUNT(*) AS count FROM applications WHERE status IN ('responded', 'interviewing', 'offer')"
    ),
    pendingApproval: one("SELECT COUNT(*) AS count FROM applications WHERE status = 'prepared'"),
    needsAttention: one(
      "SELECT COUNT(*) AS count FROM applications WHERE status IN ('needs_manual', 'failed')"
    ),
    totalJobs: one('SELECT COUNT(*) AS count FROM jobs'),
  };
}

module.exports = {
  insertJob,
  jobExists,
  getJob,
  getJobsByStatus,
  setJobStatus,
  insertApplication,
  setApplicationStatus,
  countApplicationsToday,
  getPendingApproval,
  getFollowUpsDue,
  markGhosted,
  getRecentApplications,
  insertEvaluation,
  getMonthlySpend,
  startRun,
  finishRun,
  recordPlatformSuccess,
  recordPlatformFailure,
  getSummary,
};
