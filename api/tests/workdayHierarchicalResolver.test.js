'use strict';

/**
 * workdayHierarchicalResolver.test.js — Integración de la jerarquía de defaults
 * (general/empresa/departamento) en el ÚNICO resolvedor del motor
 * (`workdayConfig.loadWorkdayConfig().forDate`), el mismo que consumen
 * workdaySummaryService, el scheduler y el endpoint administrativo.
 *
 * Cubre (Correcciones A/B/C/G): default depto/empresa/general aplicado por el
 * motor; turnera y override de empleado ganando al default; degradación idéntica
 * sin defaults; PROHIBIDO usar employees.department_id actual para fabricar
 * historia; derivación de empresa as-of-date (branch/cost_center) con conflicto;
 * y endpoint === motor.
 */

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn(), transaction: jest.fn(async (cb) => cb('TX')) } }));
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../src/utils/mysqlRetry', () => ({ withDeadlockRetry: jest.fn(async (fn) => ({ result: await fn(1), attempts: 1, retries: 0 })) }));

const { sequelize } = require('../src/config/database');
const workdayConfig = require('../src/services/workdayConfig');
const defaultsSvc = require('../src/services/workdayConfigDefaultsService');

const RANGO = { from: '2026-09-01', to: '2026-09-30' };
const DAYS = '1,2,3,4,5,6,7';
const complete = (over = {}) => ({ check_in: '08:00:00', check_out: '17:00:00', work_days: DAYS, break_mode: 'punched', ...over });

/**
 * Mock de BD consciente de la sentencia. `defaults` es un array de filas con
 * scope_key; se devuelven las que estén en el IN pedido.
 */
function mockDb({ history = [], shifts = [], contracts = [], assignments = [], branches = {}, costCenters = {}, defaults = [] } = {}) {
  sequelize.query.mockReset();
  sequelize.query.mockImplementation(async (sql, opts) => {
    const repl = (opts && opts.replacements) || [];
    if (/employee_schedule_history/.test(sql)) return [history];
    if (/shift_assignments/.test(sql)) return [shifts];
    if (/employee_contracts/.test(sql)) return [contracts];
    if (/FROM employee_assignments/.test(sql)) return [assignments];
    if (/FROM branches/.test(sql)) return [repl.map(id => ({ id, company_id: branches[id] ?? null })).filter(r => branches[r.id] !== undefined)];
    if (/FROM cost_centers/.test(sql)) return [repl.map(id => ({ id, company_id: costCenters[id] ?? null })).filter(r => costCenters[r.id] !== undefined)];
    if (/FROM workday_config_defaults/.test(sql)) {
      const keys = new Set(repl);
      return [defaults.filter(d => keys.has(d.scope_key))];
    }
    return [[]];
  });
}

const asg = (over) => ({ employee_id: 1, branch_id: null, department_id: null, cost_center_id: null, valid_from: '2026-01-01', valid_to: null, ...over });
const def = (scope_key, over = {}) => ({ scope_key, valid_from: '2026-01-01', valid_to: null, ...complete(), ...over });

describe('jerarquía en el motor — defaults por alcance', () => {
  test('default de DEPARTAMENTO lo usa el motor cuando no hay turnera ni override', async () => {
    mockDb({
      assignments: [asg({ department_id: 5 })],
      defaults: [def('department:0:5', { check_in: '07:00:00' })],
    });
    const cfg = await workdayConfig.loadWorkdayConfig([1], RANGO);
    const r = cfg.forDate(1, '2026-09-15');
    expect(r).not.toBeNull();
    expect(r.check_in).toBe('07:00:00');
    expect(r.source).toBe('department_historical_default');
  });

  test('default de EMPRESA (empresa derivada del branch as-of-date)', async () => {
    mockDb({
      assignments: [asg({ branch_id: 30 })],
      branches: { 30: 3 },
      defaults: [def('company:3:0', { check_in: '09:00:00' })],
    });
    const cfg = await workdayConfig.loadWorkdayConfig([1], RANGO);
    const r = cfg.forDate(1, '2026-09-15');
    expect(r.check_in).toBe('09:00:00');
    expect(r.source).toBe('company_historical_default');
  });

  test('default GENERAL cuando no hay depto ni empresa', async () => {
    mockDb({ assignments: [], defaults: [def('general:0:0', { check_in: '08:30:00' })] });
    const cfg = await workdayConfig.loadWorkdayConfig([1], RANGO);
    const r = cfg.forDate(1, '2026-09-15');
    expect(r.check_in).toBe('08:30:00');
    expect(r.source).toBe('general_historical_default');
  });

  test('turnera publicada GANA al default (su horario manda; el default aporta perfil)', async () => {
    mockDb({
      shifts: [{ employee_id: 1, work_date: '2026-09-15', segment: 1, kind: 'work', start_time: '14:00:00', end_time: '22:00:00', minutes: 480, break_minutes: 0, shift_schedule_id: 9, weekly_target_minutes: 2400 }],
      assignments: [asg({ department_id: 5 })],
      defaults: [def('department:0:5', { check_in: '07:00:00', weekly_target_minutes: 2160 })],
    });
    const cfg = await workdayConfig.loadWorkdayConfig([1], RANGO);
    const r = cfg.forDate(1, '2026-09-15');
    expect(r.source).toBe('shift_assignment');
    expect(r.check_in).toBe('14:00:00');                 // horario de la turnera
    expect(r.weekly_target_minutes).toBe(2160);          // perfil tomado del default
  });

  test('override de EMPLEADO (historial completo) gana al default', async () => {
    mockDb({
      history: [{ employee_id: 1, valid_from: '2026-01-01', valid_to: null, check_in: '10:00:00', check_out: '18:00:00', work_days: DAYS, break_mode: 'none' }],
      assignments: [asg({ department_id: 5 })],
      defaults: [def('department:0:5', { check_in: '07:00:00' })],
    });
    const cfg = await workdayConfig.loadWorkdayConfig([1], RANGO);
    const r = cfg.forDate(1, '2026-09-15');
    expect(r.source).toBe('schedule_history');
    expect(r.check_in).toBe('10:00:00');
  });

  test('SIN defaults el comportamiento es IDÉNTICO al previo (fallback = null)', async () => {
    mockDb({ assignments: [asg({ department_id: 5 })], defaults: [] });
    const cfg = await workdayConfig.loadWorkdayConfig([1], RANGO);
    expect(cfg.forDate(1, '2026-09-15')).toBeNull();
  });

  test('CAMBIO DE DEPARTAMENTO as-of-date: distinta fecha → distinto default', async () => {
    mockDb({
      assignments: [
        asg({ department_id: 10, valid_from: '2026-01-01', valid_to: '2026-06-30' }),
        asg({ department_id: 20, valid_from: '2026-07-01', valid_to: null }),
      ],
      defaults: [def('department:0:10', { check_in: '06:00:00' }), def('department:0:20', { check_in: '14:00:00' })],
    });
    const cfg = await workdayConfig.loadWorkdayConfig([1], { from: '2026-06-01', to: '2026-08-01' });
    expect(cfg.forDate(1, '2026-06-30').check_in).toBe('06:00:00');
    expect(cfg.forDate(1, '2026-07-01').check_in).toBe('14:00:00');
  });
});

describe('Corrección B — estado actual NO fabrica historia', () => {
  test('sin employee_assignment vigente, un default de departamento NO se aplica aunque exista', async () => {
    // No hay asignación; el motor NO consulta employees.department_id. Existe un
    // default de departamento 99 y uno general: debe ganar el general, nunca el
    // department_historical_default.
    mockDb({
      assignments: [],
      defaults: [def('department:0:99', { check_in: '05:00:00' }), def('general:0:0', { check_in: '08:30:00' })],
    });
    const cfg = await workdayConfig.loadWorkdayConfig([1], RANGO);
    const r = cfg.forDate(1, '2026-09-15');
    expect(r.source).not.toBe('department_historical_default');
    expect(r.source).toBe('general_historical_default');
    expect(r.check_in).toBe('08:30:00');
  });

  test('el motor NO emite ninguna consulta a la tabla employees', async () => {
    mockDb({ assignments: [asg({ department_id: 5 })], defaults: [def('department:0:5')] });
    await workdayConfig.loadWorkdayConfig([1, 2, 3], RANGO);
    const sql = sequelize.query.mock.calls.map(c => c[0]).join('\n');
    expect(sql).not.toMatch(/FROM employees\b/);
  });
});

describe('Corrección C — derivación de empresa as-of-date', () => {
  const runCompany = async (over) => {
    mockDb({ assignments: [asg(over.asg)], branches: over.branches || {}, costCenters: over.costCenters || {},
      defaults: [def('company:7:0', { check_in: '09:09:00' }), def('general:0:0', { check_in: '08:00:00' })] });
    const cfg = await workdayConfig.loadWorkdayConfig([1], RANGO);
    return cfg.forDate(1, '2026-09-15');
  };

  test('empresa sólo por branch', async () => {
    const r = await runCompany({ asg: { branch_id: 30 }, branches: { 30: 7 } });
    expect(r.source).toBe('company_historical_default');
  });
  test('empresa sólo por cost_center', async () => {
    const r = await runCompany({ asg: { cost_center_id: 40 }, costCenters: { 40: 7 } });
    expect(r.source).toBe('company_historical_default');
  });
  test('branch y cost_center coinciden → empresa confiable', async () => {
    const r = await runCompany({ asg: { branch_id: 30, cost_center_id: 40 }, branches: { 30: 7 }, costCenters: { 40: 7 } });
    expect(r.source).toBe('company_historical_default');
  });
  test('branch y cost_center DIFIEREN → ambiguo, NO elige empresa (cae a general)', async () => {
    const r = await runCompany({ asg: { branch_id: 30, cost_center_id: 40 }, branches: { 30: 7 }, costCenters: { 40: 8 } });
    expect(r.source).toBe('general_historical_default');
  });
  test('ninguno → sin empresa (cae a general)', async () => {
    const r = await runCompany({ asg: { department_id: null } });
    expect(r.source).toBe('general_historical_default');
  });
});

describe('Corrección A/G — una sola resolución', () => {
  test('forDate === resolveForDate().config (misma fuente para motor y scheduler)', async () => {
    mockDb({ assignments: [asg({ department_id: 5 })], defaults: [def('department:0:5', { check_in: '07:00:00' })] });
    const cfg = await workdayConfig.loadWorkdayConfig([1], RANGO);
    const viaForDate = cfg.forDate(1, '2026-09-15');
    const viaResolve = cfg.resolveForDate(1, '2026-09-15');
    expect(viaForDate).toEqual(viaResolve.config);
    expect(viaResolve.layer).toBe('department_historical_default');
    expect(viaResolve.calculation_mode).toBe('configured');
  });

  test('el endpoint administrativo devuelve EXACTAMENTE lo que usa el motor', async () => {
    mockDb({ assignments: [asg({ department_id: 5 })], defaults: [def('department:0:5', { check_in: '07:00:00' })] });
    const engine = await workdayConfig.loadWorkdayConfig([1], { from: '2026-09-15', to: '2026-09-15' });
    const engineCfg = engine.forDate(1, '2026-09-15');
    const endpoint = await defaultsSvc.getEffectiveForDate(1, '2026-09-15');
    expect(endpoint.config).toEqual(engineCfg);
    expect(endpoint.layer).toBe('department_historical_default');
    expect(endpoint.precedence).toEqual(workdayConfig.PRECEDENCE);
  });
});
