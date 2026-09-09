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

  // ── 078 personas ──
  test('078: candidates y employee_assignments existen', async () => {
    expect(await hasTable('candidates')).toBe(true);
    expect(await hasTable('employee_assignments')).toBe(true);
  });

  test('078: historial NO se borra en cascada (fk_ea_emp = RESTRICT)', async () => {
    expect(await fkRule('employee_assignments', 'fk_ea_emp')).toBe('RESTRICT');
  });

  test('078: candidates.converted_employee_id SET NULL; access_level aditivo', async () => {
    expect(await fkRule('candidates', 'fk_candidates_employee')).toBe('SET NULL');
    expect(await hasColumn('employee_documents', 'access_level')).toBe(true);
  });

  test('078: candidates con alcance (company_id/branch_id) y FKs SET NULL', async () => {
    expect(await hasColumn('candidates', 'company_id')).toBe(true);
    expect(await hasColumn('candidates', 'branch_id')).toBe(true);
    expect(await fkRule('candidates', 'fk_candidates_company')).toBe('SET NULL');
    expect(await fkRule('candidates', 'fk_candidates_branch')).toBe('SET NULL');
  });
});
