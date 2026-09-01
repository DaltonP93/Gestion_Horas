'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'migrate.js'),
  'utf8',
);

describe('migrate --status es estrictamente read-only', () => {
  test('sale del camino --status antes de cualquier CREATE de schema_migrations', () => {
    const main = SRC.slice(SRC.indexOf('async function main()'));
    const statusBranch = main.indexOf('if (statusOnly) {');
    const writeModes = main.indexOf('// Los modos que sí modifican estado');
    const createControlTable = main.indexOf('CREATE TABLE IF NOT EXISTS schema_migrations', writeModes);

    expect(statusBranch).toBeGreaterThan(-1);
    expect(writeModes).toBeGreaterThan(-1);
    expect(createControlTable).toBeGreaterThan(writeModes);
    expect(statusBranch).toBeLessThan(writeModes);
  });

  test('si schema_migrations no existe, primero inspecciona INFORMATION_SCHEMA', () => {
    expect(SRC).toMatch(/INFORMATION_SCHEMA\.TABLES/);
    expect(SRC).toMatch(/schemaMigrationsExists/);
    expect(SRC).toMatch(/--status no la crea \(modo read-only\)/);
  });
});
