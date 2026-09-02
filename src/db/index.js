'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('../logger');

let db = null;

function connect() {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.paths.database), { recursive: true });

  db = new Database(config.paths.database);

  // WAL lets the dashboard read while a run is writing.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

/**
 * The schema is written with IF NOT EXISTS throughout, so applying it is
 * idempotent and doubles as the migration step for v1. When a real migration
 * is needed later, add numbered files and track them with user_version.
 */
function migrate() {
  const database = connect();
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  database.exec(schema);

  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);

  logger.info('Schema applied', { tables, database: config.paths.database });
  return tables;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { connect, migrate, close, get raw() { return connect(); } };
