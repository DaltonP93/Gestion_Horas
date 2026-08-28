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

const mockResolveSummary = jest.fn(async () => ({ rows: [], affectedDates: [] }));
jest.mock('../src/services/workdaySummaryService', () => ({
  isEngineSummaryWriteEnabled: () => true, // flag ON para este test
  resolveSummary: (...a) => mockResolveSummary(...a),
}));

const { sequelize } = require('../src/config/database');
const { bulkRecalcDailySummary } = require('../src/services/scheduler');

test('el lote del motor toma la UNIÓN de activos + marcadores, no sólo attendance_logs', async () => {
  sequelize.query.mockReset();
  sequelize.query.mockImplementation(async () => [[{ employee_id: 1 }, { employee_id: 2 }, { employee_id: 3 }]]);
  mockResolveSummary.mockClear();

  await bulkRecalcDailySummary('2025-06-15');

  // Un empleado sin marcas (2, 3) también pasa por el motor.
  expect(mockResolveSummary).toHaveBeenCalledTimes(3);
  const loteSql = sequelize.query.mock.calls.map((c) => c[0]).join('\n');
  expect(loteSql).toMatch(/FROM employees WHERE status = 'active'/);
  expect(loteSql).toMatch(/UNION/);
});
