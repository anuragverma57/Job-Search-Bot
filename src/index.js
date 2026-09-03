'use strict';

const config = require('./config');
const logger = require('./logger');
const db = require('./db');

const NOT_YET_BUILT = {
  apply: 'Phase 6',
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

async function main() {
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

      case 'discover': {
        db.migrate();
        const { discover } = require('./discover');
        await discover();
        break;
      }

      case 'evaluate': {
        db.migrate();
        const { evaluate } = require('./evaluate');
        // --dry-run shows what would be scored without spending any quota.
        await evaluate({ dryRun: process.argv.includes('--dry-run') });
        break;
      }

      case 'dashboard': {
        db.migrate();
        require('./dashboard/server').start();
        // The server owns the process from here; returning would close the DB.
        return;
      }

      default:
        if (NOT_YET_BUILT[command]) {
          logger.warn(`"${command}" is not implemented yet — arrives in ${NOT_YET_BUILT[command]}.`);
          break;
        }
        logger.error(`Unknown command: ${command}`);
        logger.info(`Available: migrate, status, discover, evaluate, dashboard, ${Object.keys(NOT_YET_BUILT).join(', ')}`);
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
