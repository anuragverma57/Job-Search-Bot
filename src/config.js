'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');

/**
 * Env booleans are strings. Anything that isn't an explicit "false" is treated
 * as true for DRY_RUN, so a typo or a missing value fails safe rather than
 * enabling live submission.
 */
function boolFromEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return String(value).trim().toLowerCase() !== 'false';
}

function intFromEnv(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floatFromEnv(value, fallback) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadPreferences() {
  const file = path.join(ROOT, 'config.json');
  if (!fs.existsSync(file)) {
    throw new Error('config.json not found. Copy it from the repo root template.');
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }
}

const preferences = loadPreferences();

const config = {
  root: ROOT,

  safety: {
    // Defaults to true. Live submission requires an explicit DRY_RUN=false.
    dryRun: boolFromEnv(process.env.DRY_RUN, true),
    maxApplicationsPerDay: intFromEnv(process.env.MAX_APPLICATIONS_PER_DAY, 10),
    killSwitchFile: path.resolve(ROOT, process.env.KILL_SWITCH_FILE || './STOP'),
  },

  ai: {
    // Provider is explicit if AI_PROVIDER is set, otherwise inferred from
    // whichever key is present. Gemini wins a tie: it has a free tier.
    provider: (() => {
      const explicit = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
      if (explicit) return explicit;
      if (process.env.GEMINI_API_KEY) return 'gemini';
      if (process.env.OPENAI_API_KEY) return 'openai';
      return '';
    })(),
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    cheapModel: process.env.AI_MODEL_CHEAP || 'gemini-2.0-flash',
    smartModel: process.env.AI_MODEL_SMART || 'gemini-2.5-pro',
    monthlyBudgetUsd: floatFromEnv(process.env.AI_MONTHLY_BUDGET_USD, 20),
    // Free-tier Gemini allows ~15 req/min, so calls are paced.
    requestDelayMs: intFromEnv(process.env.AI_REQUEST_DELAY_MS, 4500),
    get apiKey() {
      return this.provider === 'openai' ? this.openaiApiKey : this.geminiApiKey;
    },
  },

  notifications: {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    get enabled() {
      return Boolean(this.telegramBotToken && this.telegramChatId);
    },
  },

  dashboard: {
    port: intFromEnv(process.env.DASHBOARD_PORT, 3000),
  },

  paths: {
    database: path.resolve(ROOT, process.env.DATABASE_PATH || './data/jobs.db'),
    screenshots: path.resolve(ROOT, process.env.SCREENSHOT_DIR || './screenshots'),
    logs: path.resolve(ROOT, process.env.LOG_DIR || './logs'),
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },

  // Everything from config.json
  profile: preferences.profile || {},
  search: preferences.search || {},
  filter: preferences.filter || {},
  blocklist: preferences.blocklist || { companies: [] },
  platforms: preferences.platforms || { tier1: [], tier2: [], boards: {} },
  answerBank: preferences.answerBank || {},
  followUp: preferences.followUp || { daysUntilFollowUp: 7, daysUntilGhosted: 30 },
};

/**
 * The kill switch is checked at submit time, not at startup, so creating the
 * file stops an already-running process.
 */
config.isKillSwitchActive = function isKillSwitchActive() {
  return fs.existsSync(config.safety.killSwitchFile);
};

config.isBlocked = function isBlocked(company) {
  if (!company) return false;
  const normalized = String(company).trim().toLowerCase();
  return (config.blocklist.companies || []).some(
    (blocked) => String(blocked).trim().toLowerCase() === normalized
  );
};

/**
 * Validates config for a given phase. Phase 0 only needs paths to be writable;
 * later phases need keys that don't exist yet, so validation is scoped.
 */
config.validate = function validate(requirements = []) {
  const problems = [];

  if (requirements.includes('ai')) {
    if (!config.ai.provider) {
      problems.push('No AI key set — add GEMINI_API_KEY (free tier) or OPENAI_API_KEY to .env.');
    } else if (!config.ai.apiKey) {
      problems.push(`AI_PROVIDER is "${config.ai.provider}" but its API key is not set.`);
    }
  }

  if (requirements.includes('notifications') && !config.notifications.enabled) {
    problems.push('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set (needed from Phase 4).');
  }

  if (requirements.includes('profile')) {
    for (const field of ['name', 'email', 'phone']) {
      if (!config.profile[field]) {
        problems.push(`profile.${field} is empty in config.json (needed from Phase 6).`);
      }
    }
  }

  return problems;
};

module.exports = config;
