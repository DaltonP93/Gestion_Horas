'use strict';

/**
 * migrations.it.test.js — INTEGRACIÓN (MySQL real): verifica que las
 * migraciones de FASE F quedaron aplicadas con FKs y columnas correctas.
 *
 * El CI aplica las migraciones con el runner real antes de correr esto. Cada
 * PR encadenado extiende estas aserciones con sus propias tablas.
 */
const { describeIT, makeConn, closeAppDb } = require('./helper');

describeIT('migraciones FASE F (integración)', () => {
  let conn;
  beforeAll(async () => { conn = await makeConn(); });
  afterAll(async () => { if (conn) await conn.end(); await closeAppDb(); });

  async function fkRule(table, constraint) {
    const [rows] = await conn.query(
      `SELECT delete_rule AS dr FROM information_schema.referential_constraints
        WHERE constraint_schema = DATABASE() AND table_name = ? AND constraint_name = ?`,
      [table, constraint],
    );
    return rows[0]?.dr || null;
  }
  async function hasColumn(table, col) {
    const [rows] = await conn.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, col],
    );
    return rows.length > 0;
  }
  async function hasTable(table) {
    const [rows] = await conn.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
      [table],
    );
    return rows.length > 0;
  }

  // ── 076 gobierno ──
  test('076: companies y cost_centers existen', async () => {
    expect(await hasTable('companies')).toBe(true);
    expect(await hasTable('cost_centers')).toBe(true);
  });

  test('076: cost_centers.company_id FK SET NULL', async () => {
    expect(await fkRule('cost_centers', 'fk_cost_centers_company')).toBe('SET NULL');
  });

  test('076: enlaces aditivos nuleables', async () => {
    expect(await hasColumn('branches', 'company_id')).toBe(true);
    expect(await hasColumn('departments', 'cost_center_id')).toBe(true);
    expect(await fkRule('branches', 'fk_branches_company')).toBe('SET NULL');
    expect(await fkRule('departments', 'fk_departments_cost_center')).toBe('SET NULL');
  });

  // ── 077 auditoría ──
  test('077: audit_events.correlation_id existe', async () => {
    expect(await hasColumn('audit_events', 'correlation_id')).toBe(true);
  });
});
