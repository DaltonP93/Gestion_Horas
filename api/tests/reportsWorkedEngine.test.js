/**
 * reportsWorkedEngine.test.js
 *
 * /weekly, /daily-detail y /employee/:id/analytics leían
 * `daily_summary.worked_minutes` (motor LEGACY por fecha civil), que parte un
 * turno nocturno en dos días. Ahora sobrescriben worked_minutes con el MOTOR de
 * jornada (atribuido al día de inicio), igual que /monthly (#196), sólo lectura.
 *
 * Se testea el helper `overrideWorkedFromEngine` con el motor MOCKEADO (no hay
 * BD ni servicios en CI): el nocturno se atribuye entero a su día de inicio y la
 * degradación es fail-safe (si el motor no está, conserva legacy y lo marca).
 */

// El motor se mockea: controlamos exactamente qué minutos devuelve por día.
jest.mock('../src/services/monthlyWorkedFromEngine', () => ({
  monthlyWorkedByEmployee: jest.fn(),
}));
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { monthlyWorkedByEmployee } = require('../src/services/monthlyWorkedFromEngine');
const { __testables } = require('../src/routes/reports');
const { overrideWorkedFromEngine, ymd } = __testables;

beforeEach(() => jest.clearAllMocks());

describe('ymd', () => {
  test('Date y string se normalizan a YYYY-MM-DD', () => {
    expect(ymd(new Date('2026-01-14T21:00:00Z'))).toBe('2026-01-14');
    expect(ymd('2026-01-14')).toBe('2026-01-14');
    expect(ymd('2026-01-14 21:00:00')).toBe('2026-01-14');
    expect(ymd(null)).toBe('');
  });
});

describe('overrideWorkedFromEngine — turno nocturno que cruza medianoche', () => {
  test('atribuye la jornada entera al día de inicio; el día siguiente queda en 0', async () => {
    // Empleado 7: entra miércoles 14 21:00, sale jueves 15 06:00 (pausa 00:00-00:30).
    // Legacy partía: mié=180min, jue=330min. El motor atribuye TODO al miércoles.
    monthlyWorkedByEmployee.mockResolvedValueOnce(new Map([
      [7, { workedMinutes: 510, byDate: new Map([['2026-01-14', 510]]) }],
    ]));

    const rows = [
      { employee_id: 7, date: '2026-01-14', worked_minutes: 180 }, // legacy (parcial)
      { employee_id: 7, date: '2026-01-15', worked_minutes: 330 }, // legacy (parcial)
    ];
    await overrideWorkedFromEngine(rows, {
      from: '2026-01-14', to: '2026-01-15', route: 'test',
      idOf: (r) => r.employee_id, dateOf: (r) => r.date,
    });

    expect(rows[0].worked_minutes).toBe(510);   // miércoles: jornada completa
    expect(rows[0].worked_source).toBe('engine');
    expect(rows[1].worked_minutes).toBe(0);      // jueves: la jornada NO se cuenta acá
    expect(rows[1].worked_source).toBe('engine');
    // El total ahora cierra en 510 (no 180+330=510 por casualidad: la clave es
    // que el jueves quede en 0 para no duplicar si otro turno empieza ese día).
  });

  test('empleado sin jornadas en el motor → 0 (no NaN)', async () => {
    monthlyWorkedByEmployee.mockResolvedValueOnce(new Map([
      [9, { workedMinutes: 0, byDate: new Map() }],
    ]));
    const rows = [{ employee_id: 9, date: '2026-01-14', worked_minutes: 111 }];
    await overrideWorkedFromEngine(rows, {
      from: '2026-01-14', to: '2026-01-14', route: 'test',
      idOf: (r) => r.employee_id, dateOf: (r) => r.date,
    });
    expect(rows[0].worked_minutes).toBe(0);
    expect(rows[0].worked_source).toBe('engine');
  });

  test('fail-safe: si el motor no está disponible, conserva legacy y lo marca', async () => {
    const err = new Error('demasiados marcajes');
    err.code = 'MONTHLY_TOO_MANY_PUNCHES';
    monthlyWorkedByEmployee.mockRejectedValueOnce(err);

    const rows = [
      { employee_id: 7, date: '2026-01-14', worked_minutes: 180 },
      { employee_id: 7, date: '2026-01-15', worked_minutes: 330 },
    ];
    await overrideWorkedFromEngine(rows, {
      from: '2026-01-14', to: '2026-01-15', route: 'test',
      idOf: (r) => r.employee_id, dateOf: (r) => r.date,
    });
    expect(rows[0].worked_minutes).toBe(180);   // legacy intacto
    expect(rows[1].worked_minutes).toBe(330);
    expect(rows[0].worked_source).toBe('legacy_fallback');
    expect(rows[1].worked_source).toBe('legacy_fallback');
  });

  test('rows vacío → no llama al motor', async () => {
    await overrideWorkedFromEngine([], {
      from: '2026-01-14', to: '2026-01-14', route: 'test',
      idOf: (r) => r.employee_id, dateOf: (r) => r.date,
    });
    expect(monthlyWorkedByEmployee).not.toHaveBeenCalled();
  });
});
