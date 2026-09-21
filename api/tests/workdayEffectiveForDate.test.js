'use strict';

/**
 * workdayEffectiveForDate.test.js — cableado de la precedencia completa en
 * getEffectiveForDate (empleado + fecha), con BD y forDate mockeados.
 *
 * Cubre lo exigido por el requisito: precedencia, vigencias, CAMBIO DE
 * DEPARTAMENTO as-of-date, nocturnos y determinismo de fecha civil
 * (independiente de timezone; la matriz de CI corre esta suite en
 * UTC/America-Asuncion/Asia-Tokyo).
 */

jest.mock('../src/config/database', () => {
  const query = jest.fn();
  const transaction = jest.fn(async (cb) => cb('TX'));
  return { sequelize: { query, transaction } };
});

jest.mock('../src/utils/mysqlRetry', () => ({
  withDeadlockRetry: jest.fn(async (fn) => ({ result: await fn(1), attempts: 1, retries: 0 })),
}));

const mockLoad = jest.fn();
jest.mock('../src/services/workdayConfig', () => ({
  loadWorkdayConfig: (...a) => mockLoad(...a),
}));

const { sequelize } = require('../src/config/database');
const svc = require('../src/services/workdayConfigDefaultsService');

const COMPLETE = (over = {}) => ({ check_in: '08:00:00', check_out: '17:00:00', work_days: '2,3,4,5,6', ...over });

/** Configura la BD mockeada de forma consciente de la sentencia y parámetros. */
function mockDb({ assignments = [], employeesDept = null, costCenters = {}, defaults = {}, contracts = [] } = {}) {
  sequelize.query.mockImplementation(async (sql, opts) => {
    const repl = (opts && opts.replacements) || [];
    if (/FROM employee_assignments/.test(sql)) return [assignments];
    if (/FROM employees WHERE id/.test(sql)) return [employeesDept == null ? [] : [{ department_id: employeesDept }]];
    if (/FROM cost_centers WHERE id/.test(sql)) {
      const cc = costCenters[repl[0]];
      return [cc == null ? [] : [{ company_id: cc }]];
    }
    if (/FROM workday_config_defaults WHERE scope_key/.test(sql)) {
      return [defaults[repl[0]] || []];
    }
    if (/FROM employee_contracts/.test(sql)) return [contracts];
    return [[]];
  });
}

/** forDate por defecto: null (sin turnera ni ESH). */
function forDate(result) {
  mockLoad.mockResolvedValue({ forDate: () => result });
}

beforeEach(() => {
  sequelize.query.mockReset();
  mockLoad.mockReset();
  forDate(null);
});

describe('getEffectiveForDate — precedencia y vigencias', () => {
  test('validación de fecha civil', async () => {
    await expect(svc.getEffectiveForDate(1, 'no-date')).rejects.toMatchObject({ code: 'INVALID_DATE' });
  });

  test('sin capa empleado → default de departamento vigente', async () => {
    mockDb({
      assignments: [{ department_id: 5, cost_center_id: null, valid_from: '2026-01-01', valid_to: null }],
      defaults: { 'department:0:5': [{ ...COMPLETE({ check_in: '07:00:00' }), valid_from: '2026-01-01', valid_to: null, active: 1 }] },
    });
    const out = await svc.getEffectiveForDate(1, '2026-09-01');
    expect(out.layer).toBe('department_historical_default');
    expect(out.calculation_mode).toBe('configured');
    expect(out.config.check_in).toBe('07:00:00');
    expect(out.scope.department_id).toBe(5);
    expect(out.scope.scope_source).toBe('employee_assignments');
  });

  test('CAMBIO DE DEPARTAMENTO as-of-date: mismo empleado, distinta fecha → distinto default', async () => {
    mockDb({
      assignments: [
        { department_id: 10, cost_center_id: null, valid_from: '2026-01-01', valid_to: '2026-06-30' },
        { department_id: 20, cost_center_id: null, valid_from: '2026-07-01', valid_to: null },
      ],
      defaults: {
        'department:0:10': [{ ...COMPLETE({ check_in: '06:00:00' }), valid_from: '2026-01-01', valid_to: null, active: 1 }],
        'department:0:20': [{ ...COMPLETE({ check_in: '14:00:00' }), valid_from: '2026-01-01', valid_to: null, active: 1 }],
      },
    });
    const before = await svc.getEffectiveForDate(1, '2026-06-30'); // último día en depto 10 (borde inclusivo)
    const after = await svc.getEffectiveForDate(1, '2026-07-01');  // primer día en depto 20
    expect(before.scope.department_id).toBe(10);
    expect(before.config.check_in).toBe('06:00:00');
    expect(after.scope.department_id).toBe(20);
    expect(after.config.check_in).toBe('14:00:00');
  });

  test('empresa cuando no hay default de departamento; empresa vía cost_center', async () => {
    mockDb({
      assignments: [{ department_id: 5, cost_center_id: 77, valid_from: '2026-01-01', valid_to: null }],
      costCenters: { 77: 3 },
      defaults: { 'company:3:0': [{ ...COMPLETE({ check_in: '09:00:00' }), valid_from: '2026-01-01', valid_to: null, active: 1 }] },
    });
    const out = await svc.getEffectiveForDate(1, '2026-09-01');
    expect(out.layer).toBe('company_historical_default');
    expect(out.config.check_in).toBe('09:00:00');
    expect(out.scope.company_id).toBe(3);
  });

  test('general cuando no hay depto ni empresa', async () => {
    mockDb({
      assignments: [],
      employeesDept: null,
      defaults: { 'general:0:0': [{ ...COMPLETE({ check_in: '08:30:00' }), valid_from: '2026-01-01', valid_to: null, active: 1 }] },
    });
    const out = await svc.getEffectiveForDate(1, '2026-09-01');
    expect(out.layer).toBe('general_historical_default');
    expect(out.config.check_in).toBe('08:30:00');
  });

  test('NOCTURNO: el default preserva night_start/night_end y cruce de medianoche', async () => {
    mockDb({
      assignments: [{ department_id: 8, cost_center_id: null, valid_from: '2026-01-01', valid_to: null }],
      defaults: { 'department:0:8': [{ ...COMPLETE({ check_in: '22:00:00', check_out: '06:00:00', night_start: '21:00:00', night_end: '06:00:00' }), valid_from: '2026-01-01', valid_to: null, active: 1 }] },
    });
    const out = await svc.getEffectiveForDate(1, '2026-09-01');
    expect(out.config.night_start).toBe('21:00:00');
    expect(out.config.night_end).toBe('06:00:00');
    expect(out.config.check_in).toBe('22:00:00');
    expect(out.config.check_out).toBe('06:00:00');
  });

  test('override de empleado (schedule_history) gana al default de departamento', async () => {
    forDate({ source: 'schedule_history', check_in: '10:00:00', check_out: '18:00:00', work_days: '2,3,4,5,6' });
    mockDb({
      assignments: [{ department_id: 5, cost_center_id: null, valid_from: '2026-01-01', valid_to: null }],
      defaults: { 'department:0:5': [{ ...COMPLETE({ check_in: '07:00:00' }), valid_from: '2026-01-01', valid_to: null, active: 1 }] },
    });
    const out = await svc.getEffectiveForDate(1, '2026-09-01');
    expect(out.layer).toBe('employee_historical_override');
    expect(out.config.check_in).toBe('10:00:00');
  });

  test('turnera publicada (forDate sin source=schedule_history) es la capa 1', async () => {
    forDate({ source: 'shift_assignment', check_in: '05:00:00', check_out: '13:00:00', work_days: '2,3,4,5,6' });
    mockDb({ assignments: [], defaults: { 'general:0:0': [{ ...COMPLETE(), valid_from: '2026-01-01', valid_to: null, active: 1 }] } });
    const out = await svc.getEffectiveForDate(1, '2026-09-01');
    expect(out.layer).toBe('published_shift_assignment');
    expect(out.config.check_in).toBe('05:00:00');
  });

  test('sólo traza de contrato → historical_fallback con contract_id', async () => {
    mockDb({ assignments: [], employeesDept: null, defaults: {}, contracts: [{ id: 42 }] });
    const out = await svc.getEffectiveForDate(1, '2026-09-01');
    expect(out.layer).toBe('employee_contract_trace');
    expect(out.calculation_mode).toBe('historical_fallback');
    expect(out.contract_id).toBe(42);
    expect(out.config).toBeNull();
  });

  test('sin ninguna evidencia → historical_fallback', async () => {
    mockDb({ assignments: [], employeesDept: null, defaults: {}, contracts: [] });
    const out = await svc.getEffectiveForDate(1, '2026-09-01');
    expect(out.layer).toBe('historical_fallback');
    expect(out.config).toBeNull();
  });

  test('sin asignación vigente → department_id ACTUAL marcado current_fallback', async () => {
    mockDb({
      assignments: [],
      employeesDept: 99,
      defaults: { 'department:0:99': [{ ...COMPLETE({ check_in: '08:15:00' }), valid_from: '2026-01-01', valid_to: null, active: 1 }] },
    });
    const out = await svc.getEffectiveForDate(1, '2026-09-01');
    expect(out.scope.department_id).toBe(99);
    expect(out.scope.scope_source).toBe('current_fallback');
    expect(out.config.check_in).toBe('08:15:00');
  });

  test('la salida incluye la precedencia canónica y la fecha civil intacta', async () => {
    mockDb({ assignments: [], employeesDept: null, defaults: {}, contracts: [] });
    const out = await svc.getEffectiveForDate(7, '2026-09-20');
    expect(out.date).toBe('2026-09-20');
    expect(out.employee_id).toBe(7);
    expect(out.precedence).toEqual(svc.PRECEDENCE);
  });
});
