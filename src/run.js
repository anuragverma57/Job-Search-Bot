'use strict';

const config = require('./config');
const logger = require('./logger');
const queries = require('./db/queries');
const notifier = require('./notifier');
const { discover } = require('./discover');
const { evaluate } = require('./evaluate');

/**
 * The full pipeline, as the scheduler will invoke it:
 *   discover -> evaluate -> notify
 *
 * Discovery and evaluation are independently guarded: a failure in one still
 * lets the other report, and any failure is notified rather than dying silently
 * in a log file nobody reads.
 */
async function run() {
  const startedAt = Date.now();

  let discovery = { discovered: 0, duplicates: 0, deadSlugs: [] };
  let evaluation = { filtered: 0, evaluated: 0, results: [] };
  let hardFailure = null;

  try {
    discovery = await discover();
  } catch (err) {
    logger.error('Discovery failed', { error: err });
    hardFailure = `Discovery: ${err.message}`;
  }

  // Evaluation still runs on jobs already in the DB even if discovery broke.
  try {
    evaluation = await evaluate();
  } catch (err) {
    logger.error('Evaluation failed', { error: err });
    hardFailure = hardFailure ? `${hardFailure}; Evaluation: ${err.message}` : `Evaluation: ${err.message}`;
  }

  const threshold = config.filter.minScoreToPrepare;
  const shortlisted = (evaluation.results || [])
    .filter((result) => result.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map((result) => ({
      score: result.score,
      reason: result.reason,
      title: result.job.title,
      company: result.job.company,
      location: result.job.location,
      url: result.job.url,
    }));

  const platformAlerts = queries
    .getPlatformHealth()
    .filter((row) => row.consecutive_failures >= 3);

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);

  const result = await notifier.notifyRun({
    discovered: discovery.discovered,
    duplicates: discovery.duplicates,
    filtered: evaluation.filtered,
    evaluated: evaluation.evaluated,
    shortlisted,
    failures: evaluation.failures || 0,
    deadSlugs: discovery.deadSlugs || [],
    platformAlerts,
    dryRun: config.safety.dryRun,
    elapsedSeconds,
  });

  if (!result.sent) {
    logger.warn('Run summary was not delivered', { reason: result.reason });
  }

  if (hardFailure) {
    await notifier.notifyError('Pipeline run', hardFailure);
    throw new Error(hardFailure);
  }

  logger.info(`Run complete in ${elapsedSeconds}s`, {
    discovered: discovery.discovered,
    evaluated: evaluation.evaluated,
    shortlisted: shortlisted.length,
    notified: result.sent,
  });

  return { discovery, evaluation, shortlisted, notified: result.sent };
}

module.exports = { run };
