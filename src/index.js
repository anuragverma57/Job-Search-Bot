'use strict';

const config = require('./config');
const logger = require('./logger');
const db = require('./db');

const NOT_YET_BUILT = {
  discover: 'Phase 1',
  evaluate: 'Phase 3',
  apply: 'Phase 6',
  dashboard: 'Phase 2',
  status: 'Phase 8',
};

function showStatus() {
  const queries = require('./db/queries');
  const summary = queries.getSummary(config.followUp.daysUntilFollowUp);

  logger.info('Configuration', {
    dryRun: config.safety.dryRun,
    maxApplicationsPerDay: config.safety.maxApplicationsPerDay,
    killSwitchActive: config.isKillSwitchActive(),
    database: config.paths.database,
    tier1Platforms: config.platforms.tier1,
    blockedCompanies: (config.blocklist.companies || []).length,
    aiConfigured: Boolean(config.ai.apiKey),
    notificationsConfigured: config.notifications.enabled,
  });

  logger.info('Database', summary);

  if (!config.safety.dryRun) {
    logger.warn('DRY_RUN is disabled — live submission is enabled.');
  }
}

function main() {
  const command = process.argv[2] || 'status';

  logger.info(`Running: ${command}`);

  try {
    switch (command) {
      case 'migrate':
        db.migrate();
        break;

      case 'status':
        db.migrate();
        showStatus();
        break;

      default:
        if (NOT_YET_BUILT[command]) {
          logger.warn(`"${command}" is not implemented yet — arrives in ${NOT_YET_BUILT[command]}.`);
          break;
        }
        logger.error(`Unknown command: ${command}`);
        logger.info(`Available: migrate, status, ${Object.keys(NOT_YET_BUILT).join(', ')}`);
        process.exitCode = 1;
    }
  } catch (err) {
    logger.error('Command failed', { command, error: err });
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
