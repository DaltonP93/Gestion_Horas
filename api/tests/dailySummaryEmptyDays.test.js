/**
 * dailySummaryEmptyDays.test.js — Días sin marcaje y jornadas múltiples.
 *
 * El principio que estos tests protegen: NO fabricar ausencias. Un día sin
 * marca sólo es 'absent' cuando la configuración dice que debía trabajar; sin
 * configuración es 'unconfigured', y la valorización de eso es de RRHH, no del
 * motor. Y ninguna jornada real puede perderse por compartir fecha con otra.
 */

const {
  buildDailySummaryRows, STATUS,
} = require('../src/services/dailySummaryEngine');

const marcas = (...ts) => ts.map((t) => ({ timestamp: t }));

// Horario lunes-viernes en la convención DAYOFWEEK (2..6).
const LV = { source: 'schedule_history', check_in: '08:00', check_out: '17:00', work_days: [2, 3, 4, 5, 6] };
const un = (date, opts) => buildDailySummaryRows([], { from: date, to: date, ...opts })[0];

describe('precedencia del estado en un día sin marcaje', () => {
  test('vacaciones de turnera → permission', () => {
    const f = un('2025-06-11', { resolveConfig: () => ({ non_working: true, kind: 'vacation', source: 'shift_assignment' }) });
    expect(f.status).toBe(STATUS.PERMISSION);
    expect(f.expected_workday).toBe(false);
  });

  test('permiso de turnera → permission', () => {
    const f = un('2025-06-11', { resolveConfig: () => ({ non_working: true, kind: 'permiso', source: 'shift_assignment' }) });
    expect(f.status).toBe(STATUS.PERMISSION);
  });

  test('off de turnera → non_working', () => {
    const f = un('2025-06-11', { resolveConfig: () => ({ non_working: true, kind: 'off', source: 'shift_assignment' }) });
    expect(f.status).toBe(STATUS.NON_WORKING);
    expect(f.expected_workday).toBe(false);
  });

  test('día esperado por work_days sin marca → absent', () => {
    // 2025-06-11 es miércoles, incluido en L-V.
    const f = un('2025-06-11', { resolveConfig: () => LV });
    expect(f.status).toBe(STATUS.ABSENT);
    expect(f.expected_workday).toBe(true);
  });

  test('domingo esperado (empleado que trabaja domingo) sin marca → absent', () => {
    const todos = { source: 'schedule_history', check_in: '08:00', check_out: '12:00', work_days: [1, 2, 3, 4, 5, 6, 7] };
    const f = un('2025-06-15', { resolveConfig: () => todos }); // domingo
    expect(f.status).toBe(STATUS.ABSENT);
  });

  test('día no laboral por work_days sin marca → non_working (no weekend hardcodeado)', () => {
    const f = un('2025-06-15', { resolveConfig: () => LV }); // domingo, no en L-V
    expect(f.status).toBe(STATUS.NON_WORKING);
    expect(f.expected_workday).toBe(false);
  });

  test('sin configuración y sin marca → unconfigured, NUNCA absent', () => {
    const f = un('2024-03-05');
    expect(f.status).toBe(STATUS.UNCONFIGURED);
    expect(f.expected_workday).toBeNull();
  });

  test('feriado sin marca → holiday, aunque fuera día esperado', () => {
    const f = un('2025-05-01', { resolveConfig: () => LV, holidays: new Set(['2025-05-01']) });
    expect(f.status).toBe(STATUS.HOLIDAY);
    // No pierde que era laborable.
    expect(f.expected_workday).toBe(true);
  });
});

describe('Turnera gana sobre work_days habitual (precedencia)', () => {
  test('turnera work en un día que el horario habitual marca libre → esperado', () => {
    // Domingo: L-V lo marca libre, pero la turnera asigna trabajo ese día.
    const cfg = {
      source: 'shift_assignment', check_in: '08:00', check_out: '12:00', shift_schedule_id: 3,
    };
    const f = un('2025-06-15', { resolveConfig: () => cfg });
    expect(f.expected_workday).toBe(true);
    expect(f.status).toBe(STATUS.ABSENT); // esperado y sin marca
  });

  test('turnera off en un día que el horario habitual marca laborable → no esperado', () => {
    const cfg = { non_working: true, kind: 'off', source: 'shift_assignment' };
    const f = un('2025-06-11', { resolveConfig: () => cfg }); // miércoles
    expect(f.expected_workday).toBe(false);
    expect(f.status).toBe(STATUS.NON_WORKING);
  });
});

describe('dos jornadas con la misma work_date no se pierden', () => {
  test('06-10 y 16-20 el mismo día suman sin perder las 4 horas de la segunda', () => {
    const filas = buildDailySummaryRows(
      marcas(
        '2025-06-10 06:00:00', '2025-06-10 10:00:00',
        '2025-06-10 16:00:00', '2025-06-10 20:00:00',
      ),
      { from: '2025-06-10', to: '2025-06-10' },
    );
    expect(filas).toHaveLength(1);
    const f = filas[0];
    expect(f.workday_count).toBe(2);
    // Tramos: 4 h + 4 h = 480 min de trabajo neto (sin descontar el hueco).
    expect(f.net_worked_minutes).toBe(480);
    // Presencia: span total 06:00 → 20:00 = 840 min.
    expect(f.presence_minutes).toBe(840);
    expect(f.first_in).toBe('2025-06-10 06:00:00');
    expect(f.last_out).toBe('2025-06-10 20:00:00');
    expect(f.anomalies).toContain('multiple_workdays_same_date');
  });

  test('dos jornadas nocturnas raras del mismo día quedan marcadas para revisión', () => {
    // Dos bloques nocturnos separados por más que la pausa máxima.
    const filas = buildDailySummaryRows(
      marcas(
        '2025-06-10 00:30:00', '2025-06-10 03:00:00',
        '2025-06-10 20:00:00', '2025-06-10 23:30:00',
      ),
      { from: '2025-06-10', to: '2025-06-10' },
    );
    expect(filas).toHaveLength(1);
    expect(filas[0].workday_count).toBe(2);
    expect(filas[0].anomalies).toContain('multiple_workdays_same_date');
    // Ninguna de las dos se descartó: 2:30 + 3:30 = 6:00 = 360 min.
    expect(filas[0].net_worked_minutes).toBe(360);
  });
});
