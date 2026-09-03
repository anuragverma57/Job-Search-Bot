'use strict';

const config = require('./config');
const logger = require('./logger');
const queries = require('./db/queries');
const filter = require('./filter');
const { evaluateJobs } = require('./ai/evaluate');

/**
 * Full pipeline: deterministic filter over everything, then AI scoring on the
 * survivors only. The filter is free and the AI is not, so the ordering here
 * is the main cost control.
 */
async function evaluate(options = {}) {
  const { dryRun = false, limit = null } = options;

  const problems = config.validate(['ai']);
  if (problems.length && !dryRun) {
    for (const problem of problems) logger.error(problem);
    throw new Error('AI is not configured');
  }

  const runId = queries.startRun('evaluate', config.safety.dryRun);

  try {
    // Only jobs never scored before — re-running must not re-bill already
    // evaluated jobs.
    const candidates = queries.getJobsByStatus('discovered', 10000);
    logger.info(`Filtering ${candidates.length} unevaluated jobs`);

    const { passed, reasonCounts } = filter.apply(candidates);

    for (const [reason, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
      logger.debug(`  rejected ${count}: ${reason}`);
    }

    // Mark rejects so they are not re-filtered every run.
    const rejectedIds = new Set(passed.map((job) => job.id));
    let markedOut = 0;
    for (const job of candidates) {
      if (rejectedIds.has(job.id)) continue;
      const result = filter.evaluate(job);
      queries.setJobStatus(job.id, 'filtered_out', result.reason);
      markedOut += 1;
    }

    const maxToEvaluate = limit || config.filter.maxJobsPerRunToEvaluate;
    // Best deterministic signal first, so a truncated run scores the most
    // promising jobs rather than an arbitrary slice.
    const toEvaluate = passed
      .sort((a, b) => (b.signals.skillMatches + b.signals.niceToHaveMatches)
                    - (a.signals.skillMatches + a.signals.niceToHaveMatches))
      .slice(0, maxToEvaluate);

    logger.info(`Filter: ${passed.length} passed, ${markedOut} rejected`);

    if (dryRun) {
      logger.info('Dry run — no AI calls made. Would evaluate:');
      for (const job of toEvaluate) {
        logger.info(`  ${job.company} — ${job.title}`, {
          location: job.location,
          skills: job.signals.skillMatches,
        });
      }
      queries.finishRun(runId, { filtered_out: markedOut, evaluated: 0 });
      return { filtered: passed.length, evaluated: 0, results: [] };
    }

    if (toEvaluate.length === 0) {
      logger.info('Nothing to evaluate.');
      queries.finishRun(runId, { filtered_out: markedOut, evaluated: 0 });
      return { filtered: 0, evaluated: 0, results: [] };
    }

    logger.info(`Scoring ${toEvaluate.length} jobs with ${config.ai.cheapModel}…`);

    const { results, failures } = await evaluateJobs(toEvaluate, {
      onProgress: (job, evaluation, index, total) => {
        logger.info(`  [${index}/${total}] ${evaluation.score.toFixed(1)}  ${job.company} — ${job.title.slice(0, 50)}`, {
          reason: evaluation.reason,
        });
      },
    });

    const tokens = results.reduce((sum, r) => sum + r.tokensUsed, 0);
    const cost = results.reduce((sum, r) => sum + r.costUsd, 0);
    const shortlisted = results.filter((r) => r.score >= config.filter.minScoreToPrepare);

    queries.finishRun(runId, {
      filtered_out: markedOut,
      evaluated: results.length,
      failed: failures,
      tokens_used: tokens,
      cost_usd: cost,
    });

    logger.info('Evaluation complete', {
      evaluated: results.length,
      shortlisted: shortlisted.length,
      failures,
      tokens,
      costUsd: cost.toFixed(4),
    });

    return { filtered: passed.length, evaluated: results.length, results };
  } catch (err) {
    queries.finishRun(runId, {}, err.message);
    throw err;
  }
}

module.exports = { evaluate };
