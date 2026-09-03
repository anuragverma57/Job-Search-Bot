'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const queries = require('../db/queries');
const greenhouse = require('./greenhouse');

const COLLECTORS = { greenhouse };

/**
 * Application orchestration.
 *
 * Every safety control from the PRD is enforced here, before a browser opens:
 * kill switch, dry run, daily cap, and the company blocklist. Phase 6 fills
 * forms and screenshots them; it never clicks submit.
 */

function screenshotPath(job, suffix) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeCompany = String(job.company).replace(/[^a-zA-Z0-9]/g, '');
  return path.join(config.paths.screenshots, `${stamp}_${safeCompany}_${job.id}_${suffix}.png`);
}

/**
 * Gate checks, cheapest and most important first. Returns a blocking reason
 * or null.
 */
function checkGates(job) {
  if (config.isKillSwitchActive()) {
    return `kill switch active (${config.safety.killSwitchFile})`;
  }
  if (config.isBlocked(job.company)) {
    return `${job.company} is on the blocklist — apply manually`;
  }
  if (!config.safety.dryRun) {
    const today = queries.countApplicationsToday();
    if (today >= config.safety.maxApplicationsPerDay) {
      return `daily cap reached (${today}/${config.safety.maxApplicationsPerDay})`;
    }
  }
  return null;
}

async function prepare(job, options = {}) {
  const { headless = true, keepOpen = false } = options;

  const blocked = checkGates(job);
  if (blocked) {
    logger.warn(`Skipping ${job.company} — ${blocked}`);
    return { status: 'skipped', reason: blocked };
  }

  const platform = COLLECTORS[job.platform];
  if (!platform) {
    return { status: 'skipped', reason: `no form filler for platform: ${job.platform}` };
  }

  // Resume is generated before the browser opens: a failure here should not
  // leave a half-filled form behind.
  const { tailorFor } = require('../resume/tailor');
  const { generate } = require('../resume/render');

  const tailored = await tailorFor(job);
  const resume = await generate({
    resume: tailored.resume,
    company: job.company,
    role: job.title,
  });

  logger.info(`Resume ready: ${resume.filename}`, { tailored: tailored.tailored });

  fs.mkdirSync(config.paths.screenshots, { recursive: true });

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless });
  let result;

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    const captcha = await platform.detectCaptcha(page);
    if (captcha.interactive) {
      // An interactive challenge is a hard stop: nothing is solved or bypassed.
      const shot = screenshotPath(job, 'captcha');
      await page.screenshot({ path: shot, fullPage: true });
      return { status: 'needs_manual', reason: 'interactive captcha present', screenshot: shot };
    }

    const outcome = await platform.fill(page, {
      resumePath: resume.path,
      coverLetterPath: null,
    });

    const shot = screenshotPath(job, config.safety.dryRun ? 'dryrun' : 'filled');
    await page.screenshot({ path: shot, fullPage: true });

    const status = outcome.unanswered.length ? 'needs_manual' : 'prepared';

    result = {
      status,
      screenshot: shot,
      resumePath: resume.path,
      resumeVersion: resume.filename,
      filled: outcome.filled,
      skipped: outcome.skipped,
      unanswered: outcome.unanswered,
      captchaPresent: captcha.present,
      tailored: tailored.tailored,
    };

    if (keepOpen) {
      logger.info('Leaving the browser open for inspection — press Ctrl+C when done.');
      await page.waitForTimeout(300000);
    }
  } catch (err) {
    result = { status: 'failed', reason: err.message, resumePath: resume.path };
    logger.error(`Form filling failed for ${job.company}`, { error: err.message });
  } finally {
    if (!keepOpen) await browser.close();
  }

  return result;
}

/** Records the outcome against the job, creating an application row. */
function record(job, result) {
  if (result.status === 'skipped') return null;

  const applicationId = queries.insertApplication({
    job_id: job.id,
    status: result.status === 'prepared' ? 'prepared' : result.status,
    resume_version: result.resumeVersion || null,
    resume_path: result.resumePath || null,
    dry_run: config.safety.dryRun ? 1 : 0,
  });

  const fields = { screenshot_path: result.screenshot || null };
  if (result.unanswered?.length) {
    fields.unanswered_question = result.unanswered.map((q) => q.label).join(' | ');
  }
  if (result.reason) fields.failure_reason = result.reason;

  queries.setApplicationStatus(applicationId, result.status, fields);
  queries.setJobStatus(job.id, result.status === 'failed' ? 'failed' : 'prepared');

  return applicationId;
}

async function applyToJob(jobId, options = {}) {
  const job = queries.getJob(jobId);
  if (!job) throw new Error(`no job with id ${jobId}`);

  logger.info(`${config.safety.dryRun ? '[DRY RUN] ' : '[LIVE] '}${job.company} — ${job.title}`);

  const result = await prepare(job, options);
  const applicationId = record(job, result);

  if (result.status === 'prepared') {
    logger.info(`Form filled: ${result.filled.length} fields`, {
      screenshot: result.screenshot,
      skipped: result.skipped.length,
    });
  } else if (result.status === 'needs_manual') {
    logger.warn(`Needs manual input — ${result.unanswered?.length || 0} unanswered question(s)`);
    for (const question of result.unanswered || []) {
      logger.warn(`  unanswered: "${question.label}"`, { options: question.options });
    }
  }

  return { ...result, applicationId };
}

module.exports = { applyToJob, prepare, checkGates, record };
