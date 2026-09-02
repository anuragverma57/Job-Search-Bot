'use strict';

const config = require('./config');
const logger = require('./logger');
const queries = require('./db/queries');

const greenhouse = require('./collectors/greenhouse');
const lever = require('./collectors/lever');
const ashby = require('./collectors/ashby');

const COLLECTORS = { greenhouse, lever, ashby };

/**
 * Coarse title pre-filter, used only to limit Ashby's per-posting detail
 * fetches. This is NOT the real filter — that arrives in Phase 3 and runs on
 * full descriptions. Kept deliberately loose so nothing relevant is dropped.
 */
function buildTitleFilter() {
  const keywords = (config.search.keywords || []).map((k) => k.toLowerCase());
  const excludes = (config.search.excludeKeywords || []).map((k) => k.toLowerCase());

  // Individual words from the configured keywords, so "backend engineer"
  // also matches "Backend Developer".
  const words = new Set();
  for (const keyword of keywords) {
    for (const word of keyword.split(/\s+/)) {
      if (word.length > 2) words.add(word);
    }
  }

  if (words.size === 0) return null;

  return (title) => {
    const lower = String(title || '').toLowerCase();
    if (excludes.some((term) => lower.includes(term))) return false;
    return [...words].some((word) => lower.includes(word));
  };
}

async function runCollector(name, slugs, options) {
  if (!slugs || slugs.length === 0) {
    logger.debug(`No boards configured for ${name}, skipping`);
    return { platform: name, jobs: [], deadSlugs: [], errors: [] };
  }

  try {
    const result = await COLLECTORS[name].search(slugs, options);

    // A collector that returns nothing from every board is indistinguishable
    // from a broken one, so it counts as a platform failure.
    if (result.jobs.length === 0 && result.deadSlugs.length === slugs.length) {
      const failures = queries.recordPlatformFailure(name, 'all configured boards returned 404');
      logger.warn(`${name}: all boards dead`, { consecutiveFailures: failures });
    } else if (result.errors.length === slugs.length) {
      const failures = queries.recordPlatformFailure(name, result.errors[0]?.error || 'all boards errored');
      logger.warn(`${name}: all boards errored`, { consecutiveFailures: failures });
    } else {
      queries.recordPlatformSuccess(name);
    }

    return result;
  } catch (err) {
    const failures = queries.recordPlatformFailure(name, err.message);
    logger.error(`${name} collector threw`, { error: err, consecutiveFailures: failures });

    if (failures >= 3) {
      logger.error(`ALERT: ${name} has failed ${failures} runs in a row — selectors or API likely changed`);
    }

    return { platform: name, jobs: [], deadSlugs: [], errors: [{ error: err.message }] };
  }
}

async function discover() {
  const runId = queries.startRun('discover', config.safety.dryRun);
  const startedAt = Date.now();

  const titleFilter = buildTitleFilter();
  const boards = config.platforms.boards || {};

  let discovered = 0;
  let duplicates = 0;
  const allDeadSlugs = [];
  const allErrors = [];

  try {
    // Sequential rather than parallel: this is a personal tool polling a
    // handful of boards, and being a well-behaved client matters more than
    // shaving seconds.
    for (const name of config.platforms.tier1 || []) {
      if (!COLLECTORS[name]) {
        logger.warn(`No collector for configured platform: ${name}`);
        continue;
      }

      const slugs = boards[name] || [];
      const result = await runCollector(name, slugs, { titleFilter });

      for (const job of result.jobs) {
        const { inserted } = queries.insertJob(job);
        if (inserted) discovered += 1;
        else duplicates += 1;
      }

      if (result.deadSlugs.length) allDeadSlugs.push(...result.deadSlugs.map((s) => `${name}/${s}`));
      if (result.errors.length) allErrors.push(...result.errors.map((e) => `${name}/${e.slug}: ${e.error}`));

      logger.info(`${name}: ${result.jobs.length} fetched`, {
        dead: result.deadSlugs.length,
        errors: result.errors.length,
      });
    }

    queries.finishRun(runId, { discovered, duplicates });

    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    logger.info(`Discovery complete in ${elapsedSeconds}s`, {
      new: discovered,
      duplicates,
      deadSlugs: allDeadSlugs,
    });

    if (allDeadSlugs.length) {
      logger.warn('Dead board slugs — remove them from config.json', { slugs: allDeadSlugs });
    }
    if (allErrors.length) {
      logger.warn('Board errors this run', { errors: allErrors });
    }

    return { discovered, duplicates, deadSlugs: allDeadSlugs, errors: allErrors };
  } catch (err) {
    queries.finishRun(runId, { discovered, duplicates }, err.message);
    throw err;
  }
}

module.exports = { discover, buildTitleFilter };
