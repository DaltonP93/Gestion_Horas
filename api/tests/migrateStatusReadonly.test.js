'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'migrate.js'),
  'utf8',
);

describe('migrate --status es estrictamente read-only', () => {
  test('sale del camino --status antes de cualquier CREATE de schema_migrations', () => {
    const statusBranch = SRC.indexOf('if (statusOnly) {');
    const createControlTable = SRC.indexOf('CREATE TABLE IF NOT EXISTS schema_migrations');

    expect(statusBranch).toBeGreaterThan(-1);
    expect(createControlTable).toBeGreaterThan(-1);
    expect(statusBranch).toBeLessThan(createControlTable);
  });

  test('si schema_migrations no existe, primero inspecciona INFORMATION_SCHEMA', () => {
    expect(SRC).toMatch(/INFORMATION_SCHEMA\.TABLES/);
    expect(SRC).toMatch(/schemaMigrationsExists/);
    expect(SRC).toMatch(/--status no la crea \(modo read-only\)/);
  });
});
