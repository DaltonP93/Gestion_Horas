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

  // ── 079 calendarios ──
  test('079: labor_calendars versionado (UNIQUE por alcance+code+valid_from) con work_days', async () => {
    expect(await hasTable('labor_calendars')).toBe(true);
    expect(await hasColumn('labor_calendars', 'work_days')).toBe(true);
    const [rows] = await conn.query(
      `SELECT index_name AS iname, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
         FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'labor_calendars' AND non_unique = 0
        GROUP BY index_name`,
    );
    const uniques = Object.fromEntries(rows.map((r) => [r.iname, r.cols]));
    // Unicidad por ALCANCE: dos empresas/sucursales pueden repetir el mismo code.
    // scope_key (columna generada) + code + valid_from.
    expect(uniques.uq_labor_calendars_scope_code_from).toBe('scope_key,code,valid_from');
    // No debe haber una UNIQUE sólo por code (impediría versiones/otras empresas).
    expect(Object.values(uniques)).not.toContain('code');
  });

  test('079: calendar_exceptions CASCADE al calendario; FKs de alcance SET NULL', async () => {
    expect(await fkRule('calendar_exceptions', 'fk_cal_exc_calendar')).toBe('CASCADE');
    expect(await fkRule('labor_calendars', 'fk_labor_cal_company')).toBe('SET NULL');
  });
});
