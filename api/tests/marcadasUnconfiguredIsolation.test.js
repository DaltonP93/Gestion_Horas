'use strict';

/**
 * marcadasUnconfiguredIsolation.test.js
 *
 * Contrato de transición:
 * Mientras un empleado NO tenga un snapshot histórico completo y vigente para
 * la fecha del reporte, Marcadas debe seguir exactamente en
 * historical_fallback aunque existan datos de planificación (Turnera),
 * contratos o snapshots futuros/incompletos.
 *
 * Esta prueba usa el scheduler REAL + workdayConfig REAL y sólo mockea la base.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const { sequelize } = require('../src/config/database');
const { generateMarcadasReport } = require('../src/services/scheduler');

const EMP = {
  employee_id: 1,
  employee_name: 'Empleado Histórico',
  code: 'E001',
  department: 'Pruebas',
};

const LOGS = [
  { id: 1, employee_id: 1, timestamp: '2025-03-09 21:32:00', type: 'in' },
  { id: 2, employee_id: 1, timestamp: '2025-03-10 00:05:00', type: 'out' },
  { id: 3, employee_id: 1, timestamp: '2025-03-10 01:02:00', type: 'in' },
  { id: 4, employee_id: 1, timestamp: '2025-03-10 05:29:00', type: 'out' },
];

function wireDb({ history = [], assignments = [], contracts = [] } = {}) {
  sequelize.query.mockReset();
  sequelize.query.mockImplementation(async (sql) => {
    if (/FROM employees e/.test(sql) && /LEFT JOIN departments/.test(sql)) return [[EMP]];
    if (/FROM attendance_logs al/.test(sql)) return [LOGS];
    if (/FROM employee_schedule_history h/.test(sql)) return [history];
    if (/FROM shift_assignments a/.test(sql)) return [assignments];
    if (/FROM employee_contracts c/.test(sql)) return [contracts];
    return [[]];
  });
}

async function run() {
  return generateMarcadasReport({
    dateFrom: '2025-03-01',
    dateTo: '2025-03-31',
    employeeId: 1,
  });
}

function expectFallback(out) {
  expect(out.data).toHaveLength(1);
  expect(out.data[0].rows).toHaveLength(1);
  expect(out.data[0].rows[0].date).toBe('09/03/2025');
  expect(out.data[0].rows[0].pairs).toEqual([
    { entrada: '21:32', salida: '00:05' },
    { entrada: '01:02', salida: '05:29' },
  ]);
  expect(out.data[0].rows[0].total).toBe('7:00');
  expect(out.data[0].rows[0].calculation_mode).toBe('historical_fallback');
}

describe('Marcadas — aislamiento de empleados no configurados', () => {
  test('sin configuración: 2025 se reconstruye sólo desde attendance_logs', async () => {
    wireDb();
    expectFallback(await run());
  });

  test('Turnera publicada existente NO cambia 2025 si el empleado no tiene snapshot', async () => {
    wireDb({
      assignments: [{
        employee_id: 1,
        work_date: '2025-03-09',
        segment: 1,
        kind: 'work',
        start_time: '08:00:00',
        end_time: '17:00:00',
        minutes: 480,
        break_minutes: 60,
        shift_schedule_id: 99,
        weekly_target_minutes: 2880,
      }],
    });

    expectFallback(await run());
  });

  test('snapshot FUTURO no contamina el reporte de 2025', async () => {
    wireDb({
      history: [{
        history_id: 5,
        employee_id: 1,
        schedule_id: 10,
        valid_from: '2026-09-01',
        valid_to: null,
        check_in: '07:00:00',
        check_out: '15:00:00',
        work_days: '2,3,4,5,6',
        break_mode: 'fixed_unpaid',
        break_minutes: 30,
        weekly_target_minutes: 2160,
      }],
    });

    expectFallback(await run());
  });

  test('snapshot vigente pero INCOMPLETO no contamina 2025', async () => {
    wireDb({
      history: [{
        history_id: 6,
        employee_id: 1,
        schedule_id: 10,
        valid_from: '2025-01-01',
        valid_to: null,
        check_in: null,
        check_out: null,
        work_days: null,
        weekly_target_minutes: 2160,
      }],
    });

    expectFallback(await run());
  });

  test('Turnera 2025 + snapshot recién desde 2026 sigue en fallback para 2025', async () => {
    wireDb({
      history: [{
        history_id: 7,
        employee_id: 1,
        schedule_id: 10,
        valid_from: '2026-09-01',
        valid_to: null,
        check_in: '07:00:00',
        check_out: '15:00:00',
        work_days: '2,3,4,5,6',
        break_mode: 'fixed_unpaid',
        break_minutes: 30,
        weekly_target_minutes: 2160,
      }],
      assignments: [{
        employee_id: 1,
        work_date: '2025-03-09',
        segment: 1,
        kind: 'work',
        start_time: '08:00:00',
        end_time: '17:00:00',
        minutes: 480,
        break_minutes: 60,
        shift_schedule_id: 99,
        weekly_target_minutes: 2880,
      }],
    });

    expectFallback(await run());
  });

  test('Turnera 2025 + snapshot incompleto tampoco activa configured', async () => {
    wireDb({
      history: [{
        history_id: 8,
        employee_id: 1,
        schedule_id: 10,
        valid_from: '2025-01-01',
        valid_to: null,
        check_in: '07:00:00',
        check_out: null,
        work_days: '2,3,4,5,6',
        weekly_target_minutes: 2160,
      }],
      assignments: [{
        employee_id: 1,
        work_date: '2025-03-09',
        segment: 1,
        kind: 'work',
        start_time: '08:00:00',
        end_time: '17:00:00',
        minutes: 480,
        break_minutes: 60,
        shift_schedule_id: 99,
        weekly_target_minutes: 2880,
      }],
    });

    expectFallback(await run());
  });

  test('contrato vigente sin snapshot tampoco activa configured', async () => {
    wireDb({
      contracts: [{
        contract_id: 3,
        employee_id: 1,
        start_date: '2025-01-01',
        end_date: null,
      }],
    });

    expectFallback(await run());
  });
});
