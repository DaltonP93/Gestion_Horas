/**
 * reconciliation — validación de `date` y consulta parametrizada a att2000 (B).
 *
 * `date` llega desde POST /api/sync/reconcile. Antes se interpolaba crudo en la
 * consulta a SQL Server (inyección hacia una fuente READ-ONLY). Ahora:
 *   - se valida como fecha civil real ANTES de tocar cualquier base → 400;
 *   - se pasa parametrizado (@date), nunca interpolado;
 *   - la consulta sigue siendo un SELECT (att2000 READ-ONLY).
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock('../src/config/att2000', () => ({
  queryAtt2000: jest.fn(),
}));
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const { sequelize } = require('../src/config/database');
const { queryAtt2000 } = require('../src/config/att2000');
const { runReconciliation } = require('../src/services/reconciliation');

beforeEach(() => {
  sequelize.query.mockReset();
  queryAtt2000.mockReset();
});

describe('validación de fecha (fail-closed, sin tocar att2000)', () => {
  test.each([
    'no-es-fecha',
    '2026-13-01',      // mes inexistente
    '2026-02-30',      // día inexistente
    "2026-01-01'; DROP TABLE CHECKINOUT; --",  // intento de inyección
    '2026/07/01',
  ])('fecha inválida %p → 400 y att2000 intacto', async (bad) => {
    await expect(runReconciliation(bad)).rejects.toMatchObject({ status: 400 });
    expect(queryAtt2000).not.toHaveBeenCalled();
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('fecha válida: consulta parametrizada y read-only', () => {
  test('la fecha viaja como parámetro @date, no interpolada; SELECT', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ cnt: 0 }]])   // count MySQL
      .mockResolvedValueOnce([[]])             // mysqlLogs
      .mockResolvedValue([{}]);                // persistencia report
    queryAtt2000.mockResolvedValue([]);

    await runReconciliation('2026-07-01');

    expect(queryAtt2000).toHaveBeenCalledTimes(1);
    const [sqlText, params] = queryAtt2000.mock.calls[0];
    expect(sqlText).toMatch(/@date/);
    expect(sqlText).not.toMatch(/'2026-07-01'/);      // no interpolado
    expect(sqlText).toMatch(/^\s*SELECT/i);            // sólo lectura
    expect(sqlText).not.toMatch(/INSERT|UPDATE|DELETE|DROP/i);
    expect(params).toEqual({ date: '2026-07-01' });
  });

  test('normaliza a YYYY-MM-DD canónico (un objeto Date entra igual)', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ cnt: 0 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValue([{}]);
    queryAtt2000.mockResolvedValue([]);

    await runReconciliation(new Date(Date.UTC(2026, 6, 1)));
    const [, params] = queryAtt2000.mock.calls[0];
    expect(params).toEqual({ date: '2026-07-01' });
  });
});
