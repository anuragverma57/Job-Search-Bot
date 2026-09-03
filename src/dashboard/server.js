'use strict';

const express = require('express');
const config = require('../config');
const logger = require('../logger');
const queries = require('../db/queries');
const { renderDashboard } = require('./render');

const PAGE_SIZE = 50;

/** Query params are user input: clamp and whitelist everything. */
function parseFilters(query) {
  const allowedSorts = ['discovered', 'posted', 'score', 'company'];

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const maxAge = parseInt(query.maxAgeDays, 10);

  return {
    q: String(query.q || '').slice(0, 100),
    platform: String(query.platform || '').slice(0, 40),
    status: String(query.status || '').slice(0, 40),
    location: String(query.location || '').slice(0, 60),
    maxAgeDays: Number.isFinite(maxAge) && maxAge > 0 ? Math.min(maxAge, 3650) : '',
    // Default to newest-posted: browsing is about what is currently open,
    // and a first run gives every row the same discovery timestamp.
    sort: allowedSorts.includes(query.sort) ? query.sort : 'posted',
    page,
  };
}

function createServer() {
  const app = express();

  // No auth by design: the server binds to loopback only (see start()).
  app.get('/', (req, res) => {
    const filters = parseFilters(req.query);

    const { rows, total } = queries.searchJobs({
      ...filters,
      maxAgeDays: filters.maxAgeDays || null,
      limit: PAGE_SIZE,
      offset: (filters.page - 1) * PAGE_SIZE,
    });

    res.set('Cache-Control', 'no-store').send(
      renderDashboard({
        summary: queries.getSummary(config.followUp.daysUntilFollowUp),
        jobs: rows,
        total,
        filters,
        filterOptions: queries.getFilterOptions(),
        lastRun: queries.getLastRun(),
        health: queries.getPlatformHealth(),
        page: filters.page,
        pageSize: PAGE_SIZE,
        dryRun: config.safety.dryRun,
      })
    );
  });

  // Cheap liveness check for scripts and for verifying the server is up.
  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      dryRun: config.safety.dryRun,
      jobs: queries.getSummary(config.followUp.daysUntilFollowUp).totalJobs,
    });
  });

  app.use((req, res) => {
    res.status(404).send('Not found');
  });

  // Four-arg signature is required for Express to treat this as an error
  // handler; a render failure must not take the server down.
  app.use((err, req, res, next) => {
    logger.error('Dashboard request failed', { path: req.path, error: err });
    res.status(500).send('Internal error — check the logs.');
  });

  return app;
}

function start() {
  const app = createServer();
  const port = config.dashboard.port;

  // Bound to 127.0.0.1, never 0.0.0.0: this page has no authentication and
  // must not be reachable from the local network.
  const server = app.listen(port, '127.0.0.1', () => {
    logger.info(`Dashboard running at http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${port} is already in use. Set DASHBOARD_PORT in .env to use another.`);
      process.exit(1);
    }
    throw err;
  });

  return server;
}

module.exports = { createServer, start, parseFilters };
