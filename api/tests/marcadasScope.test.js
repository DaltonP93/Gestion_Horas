/**
 * Cubre el scope de departamento aplicado en generateMarcadasReport (PR 7).
 *
 * No probamos el SQL contra una base real; mockeamos `sequelize.query` para
 * inspeccionar el fragmento inyectado y los params concatenados. Es
 * complementario al test de `applyDepartmentScope` (que ya cubre la unidad
 * `where/params`).
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));

const { sequelize } = require('../src/config/database');
const { generateMarcadasReport } = require('../src/services/scheduler');

function capturedSql() {
  const call = sequelize.query.mock.calls[0];
  return { sql: call[0], replacements: call[1].replacements };
}

describe('generateMarcadasReport — scope de departamento', () => {
  beforeEach(() => {
    sequelize.query.mockReset();
    // Devolvemos "sin logs" para acortar el flujo — sólo nos interesa el SQL.
    sequelize.query.mockResolvedValue([[]]);
  });

  test('sin scope: no inyecta cláusula IN', async () => {
    await generateMarcadasReport({ dateFrom: '2026-07-01', dateTo: '2026-07-31' });
    const { sql, replacements } = capturedSql();
    expect(sql).not.toMatch(/department_id IN/);
    expect(replacements).toEqual(['2026-07-01', '2026-07-31']);
  });

  test('scope unrestricted: sigue siendo no-op', async () => {
    await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31',
      scope: { unrestricted: true },
    });
    const { sql } = capturedSql();
    expect(sql).not.toMatch(/department_id IN/);
  });

  test('scope con ids: inyecta IN y concatena params al final', async () => {
    await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31',
      scope: { unrestricted: false, ids: [3, 5] },
    });
    const { sql, replacements } = capturedSql();
    expect(sql).toMatch(/e\.department_id IN \(\?,\?\)/);
    expect(replacements).toEqual(['2026-07-01', '2026-07-31', 3, 5]);
  });

  test('scope con deptId manual + ids: ambos filtros presentes', async () => {
    await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31',
      deptId: 3,
      scope: { unrestricted: false, ids: [3, 4] },
    });
    const { sql, replacements } = capturedSql();
    expect(sql).toMatch(/e\.department_id = \?/);
    expect(sql).toMatch(/e\.department_id IN \(\?,\?\)/);
    expect(replacements).toEqual(['2026-07-01', '2026-07-31', 3, 3, 4]);
  });

  test('scope sin ids (rol scoped sin depto vinculado): devuelve vacío sin tocar DB', async () => {
    const out = await generateMarcadasReport({
      dateFrom: '2026-07-01', dateTo: '2026-07-31',
      scope: { unrestricted: false, ids: [] },
    });
    expect(out.data).toEqual([]);
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});
