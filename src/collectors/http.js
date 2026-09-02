'use strict';

const logger = require('../logger');

const USER_AGENT = 'job-apply-bot/0.1 (personal use)';
const DEFAULT_TIMEOUT_MS = 20000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch with a timeout and one retry on transient failure.
 *
 * A 404 is a permanent answer (dead board slug) and must NOT be retried — it
 * is returned to the caller so the collector can report the slug as dead.
 */
async function request(url, options = {}, attempt = 1) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxAttempts = 2, ...fetchOptions } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, ...(fetchOptions.headers || {}) },
    });

    if (response.status === 404) {
      return { ok: false, status: 404, notFound: true };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return { ok: true, status: response.status, json: await response.json() };
  } catch (err) {
    if (attempt < maxAttempts) {
      const backoffMs = 1000 * attempt;
      logger.debug(`Request failed, retrying in ${backoffMs}ms`, { url, error: err.message });
      await sleep(backoffMs);
      return request(url, options, attempt + 1);
    }
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, options = {}) {
  return request(url, options);
}

async function postJson(url, body, options = {}) {
  return request(url, {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: JSON.stringify(body),
  });
}

module.exports = { getJson, postJson, sleep };
