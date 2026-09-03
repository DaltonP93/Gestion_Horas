/**
 * workdayConfigDegradation.test.js — el invariante CENTRAL del rollout FASE E:
 * cómo degrada `loadWorkdayConfig` según el estado del esquema.
 *
 * El resto de la suite de workdayConfig asume que la tabla y sus columnas
 * existen; acá se ejercitan explícitamente los cuatro estados que decide el
 * GO/NO-GO (ver docs/workday-engine-rollout-status.md §Gates):
 *
 *   (a) tabla AUSENTE (42S02)              → historial vacío → historical_fallback.
 *   (b) 072/073 presentes, 075 PENDIENTE   → degrada: resuelve 072/073 SIN la
 *                                            metadata FASE C (NO es fallback).
 *   (c) tabla presente, columna 073 FALTA  → NO degrada: PROPAGA el error
 *                                            (estado parcial peligroso = NO-GO).
 *   (d) todo aplicado                      → resuelve `configured`.
 *
 * Con mocks (sin base), como el resto de la suite.
 */

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const { sequelize } = require('../src/config/database');
const { loadWorkdayConfig, resetPhaseCMetadataCacheForTests } = require('../src/services/workdayConfig');

afterEach(() => resetPhaseCMetadataCacheForTests());

const RANGO = { from: '2024-12-01', to: '2024-12-31' };

// Fila de historial CONFIGURADA (con check_in snapshoteado → no config_incomplete).
const CONFIGURED_ROW = {
  employee_id: 1, schedule_id: 5, valid_from: '2024-01-01', valid_to: null,
  check_in: '07:00:00', check_out: '15:00:00', work_days: '2,3,4,5,6',
  tolerance_in: 10, tolerance_out: 0,
  break_mode: 'fixed_unpaid', break_minutes: 30, break_after_minutes: 0,
  weekly_target_minutes: 2880, daily_target_minutes: null,
};

function mkErr(code, sqlState, message) {
  const e = new Error(message);
  e.code = code; e.sqlState = sqlState;
  e.original = { code, sqlState, sqlMessage: message };
  return e;
}

// Enruta por tabla; `onHistory(sql)` decide qué hace la consulta de historial.
function mockDb(onHistory) {
  sequelize.query.mockReset();
  sequelize.query.mockImplementation(async (sql) => {
    if (/employee_schedule_history/.test(sql)) return [await onHistory(sql)];
    if (/shift_assignments/.test(sql)) return [[]];
    if (/employee_contracts/.test(sql)) return [[]];
    return [[]];
  });
}

test('(a) tabla de historial AUSENTE (42S02) → historical_fallback', async () => {
  mockDb(() => { throw mkErr('ER_NO_SUCH_TABLE', '42S02', "Table 'asistencia.employee_schedule_history' doesn't exist"); });
  const cfg = await loadWorkdayConfig([1], RANGO);
  // Sin historial no hay configuración: el motor cae al fallback histórico.
  expect(cfg.forDate(1, '2024-12-15')).toBeNull();
});

test('(b) 072/073 presentes pero 075 PENDIENTE → degrada y resuelve configured sin metadata', async () => {
  mockDb((sql) => {
    // La variante CON metadata FASE C selecciona la columna real `h.snapshot_version`;
    // la degradada la aliasea como `1 AS snapshot_version`, así que hay que
    // distinguir por el prefijo `h.` para no romper también el reintento.
    if (/h\.snapshot_version/.test(sql)) {
      throw mkErr('ER_BAD_FIELD_ERROR', '42S22', "Unknown column 'h.snapshot_version' in 'field list'");
    }
    return [CONFIGURED_ROW]; // reintento sin metadata
  });
  const cfg = await loadWorkdayConfig([1], RANGO);
  const r = cfg.forDate(1, '2024-12-15');
  expect(r).not.toBeNull();
  expect(r.source).toBe('schedule_history');
  expect(r.check_in).toBe('07:00:00');
});

test('(c) columna 073 FALTA (esquema parcial peligroso) → PROPAGA, no degrada a fallback', async () => {
  // `work_regime` NO es una columna de metadata 075: un ER_BAD_FIELD sobre ella
  // es un fallo real de esquema, no algo que se pueda degradar silenciosamente.
  mockDb(() => { throw mkErr('ER_BAD_FIELD_ERROR', '42S22', "Unknown column 'h.work_regime' in 'field list'"); });
  await expect(loadWorkdayConfig([1], RANGO)).rejects.toThrow(/work_regime/);
});

test('(d) esquema completo → resuelve configured', async () => {
  mockDb(() => [CONFIGURED_ROW]);
  const cfg = await loadWorkdayConfig([1], RANGO);
  const r = cfg.forDate(1, '2024-12-15');
  expect(r.source).toBe('schedule_history');
  expect(r.weekly_target_minutes).toBe(2880);
});
