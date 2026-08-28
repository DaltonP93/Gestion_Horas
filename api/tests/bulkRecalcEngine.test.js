/**
 * bulkRecalcEngine.test.js — El recálculo en bloque por el motor incluye a los
 * empleados SIN marcas.
 *
 * Con el flag ON, un empleado sin fichajes igual necesita que su día vacío se
 * materialice desde la config histórica (holiday/weekend/permission/absent) y que
 * una fila 'absent' vieja se corrija. Por eso el lote es la UNIÓN de los activos
 * con los que marcaron, no sólo `attendance_logs`.
 */

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() }, DB_TIMEZONE: '-03:00' }));
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {} }));

const mockBatch = jest.fn(async () => ({ rowsByEmployee: new Map() }));
jest.mock('../src/services/workdaySummaryService', () => ({
  isEngineSummaryWriteEnabled: () => true, // flag ON para este test
  resolveSummaryBatchForDate: (...a) => mockBatch(...a),
  shiftDate: (d, n) => `${d}#${n}`, // no importa el valor exacto para este test
}));

const { sequelize } = require('../src/config/database');
const { bulkRecalcDailySummary, materializeAbsents } = require('../src/services/scheduler');

test('el lote del motor toma la UNIÓN de activos + marcadores y procesa POR LOTE', async () => {
  sequelize.query.mockReset();
  sequelize.query.mockImplementation(async () => [[{ employee_id: 1 }, { employee_id: 2 }, { employee_id: 3 }]]);
  mockBatch.mockClear();

  await bulkRecalcDailySummary('2025-06-15');

  // Una sola llamada batch con TODOS los ids (incluye empleados sin marcas), no
  // una por empleado.
  expect(mockBatch).toHaveBeenCalledTimes(1);
  expect(mockBatch).toHaveBeenCalledWith([1, 2, 3], '2025-06-15', { apply: true });
  const loteSql = sequelize.query.mock.calls.map((c) => c[0]).join('\n');
  expect(loteSql).toMatch(/FROM employees WHERE status = 'active'/);
  expect(loteSql).toMatch(/UNION/);
  // También los empleados con fila de resumen en las fechas afectadas (incluye a
  // inactivos sin marcas, cuyas filas viejas hay que reconciliar).
  expect(loteSql).toMatch(/FROM daily_summary WHERE date IN/);
});

test('con el flag ON, materializeAbsents es un no-op (no fabrica ausencias)', async () => {
  // El motor deja un día unconfigured SIN fila a propósito; materializeAbsents
  // usaría el horario actual y lo pisaría con 'absent'. En el camino nuevo no corre.
  sequelize.query.mockReset();
  const n = await materializeAbsents('2025-06-15');
  expect(n).toBe(0);
  const insertó = sequelize.query.mock.calls.some((c) => /INSERT INTO daily_summary/i.test(c[0]));
  expect(insertó).toBe(false);
});
