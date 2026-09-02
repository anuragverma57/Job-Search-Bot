'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const activeLevel = LEVELS[config.logging.level] ?? LEVELS.info;

const COLORS = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[90m',
  reset: '\x1b[0m',
};

fs.mkdirSync(config.paths.logs, { recursive: true });

function logFilePath() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(config.paths.logs, `${day}.log`);
}

/**
 * Context objects get appended as JSON so failures stay greppable. Errors are
 * unwrapped to message + stack, since JSON.stringify drops those otherwise.
 */
function formatContext(context) {
  if (!context || Object.keys(context).length === 0) return '';

  const safe = {};
  for (const [key, value] of Object.entries(context)) {
    safe[key] = value instanceof Error
      ? { message: value.message, stack: value.stack }
      : value;
  }

  try {
    return ' ' + JSON.stringify(safe);
  } catch {
    return ' [uninspectable context]';
  }
}

function write(level, message, context) {
  if (LEVELS[level] > activeLevel) return;

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}${formatContext(context)}`;

  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${COLORS[level]}${line}${COLORS.reset}\n`);

  // A logger that throws takes the whole run down with it, so file failures
  // are swallowed after one warning to stderr.
  try {
    fs.appendFileSync(logFilePath(), `${line}\n`);
  } catch (err) {
    process.stderr.write(`Log file write failed: ${err.message}\n`);
  }
}

module.exports = {
  error: (message, context) => write('error', message, context),
  warn: (message, context) => write('warn', message, context),
  info: (message, context) => write('info', message, context),
  debug: (message, context) => write('debug', message, context),
};
