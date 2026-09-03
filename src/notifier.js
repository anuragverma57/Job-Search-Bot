'use strict';

const config = require('./config');
const logger = require('./logger');

/**
 * Telegram notifications. A scheduled bot with no notifications is a bot whose
 * breakage goes unnoticed, so this ships in v1 rather than as a nicety.
 *
 * Every failure here is swallowed and logged: a notification that cannot be
 * delivered must never abort a pipeline run that otherwise succeeded.
 */

const API = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4096;

/** Telegram's HTML mode rejects bare &, <, > in text nodes. */
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function send(text, options = {}) {
  if (!config.notifications.enabled) {
    logger.debug('Notifications not configured, skipping');
    return { sent: false, reason: 'not configured' };
  }

  const { silent = false } = options;
  const body = text.length > MAX_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_MESSAGE_LENGTH - 20)}\n…(truncated)`
    : text;

  try {
    const response = await fetch(
      `${API}/bot${config.notifications.telegramBotToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.notifications.telegramChatId,
          text: body,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          disable_notification: silent,
        }),
        signal: AbortSignal.timeout(20000),
      }
    );

    const json = await response.json().catch(() => null);

    if (!json?.ok) {
      logger.error('Telegram send failed', {
        code: json?.error_code,
        description: json?.description,
      });
      return { sent: false, reason: json?.description || `HTTP ${response.status}` };
    }

    return { sent: true, messageId: json.result.message_id };
  } catch (err) {
    logger.error('Telegram send threw', { error: err.message });
    return { sent: false, reason: err.message };
  }
}

function formatScore(score) {
  if (score === null || score === undefined) return '—';
  const value = Number(score);
  const marker = value >= 7 ? '🟢' : value >= 5 ? '🟡' : '⚪';
  return `${marker} ${value.toFixed(1)}`;
}

/**
 * The per-run summary. Leads with what needs action, because that is the only
 * part worth reading on a phone at 8am.
 */
function buildRunSummary(data) {
  const {
    discovered = 0,
    duplicates = 0,
    filtered = 0,
    evaluated = 0,
    shortlisted = [],
    failures = 0,
    deadSlugs = [],
    platformAlerts = [],
    dryRun = true,
    elapsedSeconds = null,
  } = data;

  const lines = [];
  const date = new Date().toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  });

  lines.push(`<b>Job Bot — ${escapeHtml(date)}</b>`);
  lines.push('');

  if (shortlisted.length) {
    lines.push(`<b>${shortlisted.length} worth a look</b>`);
    for (const job of shortlisted.slice(0, 10)) {
      lines.push('');
      lines.push(`${formatScore(job.score)}  <a href="${escapeHtml(job.url)}">${escapeHtml(job.title)}</a>`);
      lines.push(`<i>${escapeHtml(job.company)}${job.location ? ` · ${escapeHtml(job.location)}` : ''}</i>`);
      if (job.reason) {
        // The "[risk: …]" suffix is dropped here — it belongs on the
        // dashboard, not in a phone notification.
        const summary = String(job.reason).split('[risk:')[0].trim();
        lines.push(escapeHtml(summary));
      }
    }
    if (shortlisted.length > 10) {
      lines.push('');
      lines.push(`<i>…and ${shortlisted.length - 10} more on the dashboard</i>`);
    }
  } else if (evaluated > 0) {
    lines.push(`Scored ${evaluated}, none cleared ${config.filter.minScoreToPrepare}.`);
  } else {
    lines.push('No new jobs to score.');
  }

  lines.push('');
  lines.push('———');
  lines.push(
    `<i>${discovered} new · ${duplicates} dup · ${filtered} passed filter · ${evaluated} scored</i>`
  );

  const warnings = [];
  if (failures) warnings.push(`${failures} evaluation failure${failures > 1 ? 's' : ''}`);
  if (deadSlugs.length) warnings.push(`${deadSlugs.length} dead board${deadSlugs.length > 1 ? 's' : ''}`);
  if (warnings.length) lines.push(`<i>⚠️ ${escapeHtml(warnings.join(' · '))}</i>`);

  // Three consecutive failures on a platform means selectors or an API broke.
  for (const alert of platformAlerts) {
    lines.push(`<b>⚠️ ${escapeHtml(alert.platform)} has failed ${alert.consecutive_failures} runs in a row</b>`);
  }

  if (!dryRun) lines.push('<i>⚠️ LIVE MODE — submissions enabled</i>');
  if (elapsedSeconds) lines.push(`<i>took ${elapsedSeconds}s</i>`);

  return lines.join('\n');
}

async function notifyRun(data) {
  return send(buildRunSummary(data));
}

async function notifyError(context, error) {
  return send(
    `<b>❌ Job Bot failed</b>\n\n<i>${escapeHtml(context)}</i>\n\n<code>${escapeHtml(String(error).slice(0, 500))}</code>`
  );
}

async function test() {
  return send(
    '<b>Job Apply Bot</b>\n\nNotifications are working.\n\n<i>Sent by npm run notify:test</i>'
  );
}

module.exports = { send, notifyRun, notifyError, test, buildRunSummary, escapeHtml };
