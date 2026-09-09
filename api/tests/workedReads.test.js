/**
 * workedReads.test.js — helpers de lectura con el MOTOR (compartidos por
 * reports.js y me.js). Motor MOCKEADO (no hay BD ni servicios en CI).
 *
 * Cubre: override por (empleado, día) con atribución del nocturno al día de
 * inicio; total por empleado (usado por /me/dashboard); fail-safe a legacy;
 * normalización de fecha.
 */

jest.mock('../src/services/monthlyWorkedFromEngine', () => ({
  monthlyWorkedByEmployee: jest.fn(),
}));
jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { monthlyWorkedByEmployee } = require('../src/services/monthlyWorkedFromEngine');
const {
  engineWorkedByDate, engineWorkedTotal, ymd, overrideWorkedFromEngine,
} = require('../src/services/workedReads');

beforeEach(() => jest.clearAllMocks());

describe('ymd', () => {
  test('Date/string → YYYY-MM-DD; null → ""', () => {
    expect(ymd(new Date('2026-01-14T23:30:00Z'))).toBe('2026-01-14');
    expect(ymd('2026-01-14 21:00:00')).toBe('2026-01-14');
    expect(ymd(null)).toBe('');
  });
});

describe('overrideWorkedFromEngine — nocturno atribuido al día de inicio', () => {
  test('miércoles = jornada completa; jueves = 0', async () => {
    monthlyWorkedByEmployee.mockResolvedValueOnce(new Map([
      [7, { workedMinutes: 510, byDate: new Map([['2026-01-14', 510]]) }],
    ]));
    const rows = [
      { employee_id: 7, date: '2026-01-14', worked_minutes: 180 },
      { employee_id: 7, date: '2026-01-15', worked_minutes: 330 },
    ];
    await overrideWorkedFromEngine(rows, {
      from: '2026-01-14', to: '2026-01-15', route: 'test',
      idOf: (r) => r.employee_id, dateOf: (r) => r.date,
    });
    expect(rows[0].worked_minutes).toBe(510);
    expect(rows[1].worked_minutes).toBe(0);
    expect(rows.every((r) => r.worked_source === 'engine')).toBe(true);
  });

  test('fail-safe: motor caído → conserva legacy y lo marca', async () => {
    monthlyWorkedByEmployee.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'BOOM' }));
    const rows = [{ employee_id: 7, date: '2026-01-14', worked_minutes: 180 }];
    await overrideWorkedFromEngine(rows, {
      from: '2026-01-14', to: '2026-01-14', route: 'test',
      idOf: (r) => r.employee_id, dateOf: (r) => r.date,
    });
    expect(rows[0].worked_minutes).toBe(180);
    expect(rows[0].worked_source).toBe('legacy_fallback');
  });

  test('rows vacío → no llama al motor', async () => {
    await overrideWorkedFromEngine([], { from: 'a', to: 'b', route: 't', idOf: (r) => r.id, dateOf: (r) => r.d });
    expect(monthlyWorkedByEmployee).not.toHaveBeenCalled();
  });
});

describe('engineWorkedTotal — total por empleado (/me/dashboard)', () => {
  test('devuelve workedMinutes del motor', async () => {
    monthlyWorkedByEmployee.mockResolvedValueOnce(new Map([
      [42, { workedMinutes: 2400, byDate: new Map() }],
    ]));
    expect(await engineWorkedTotal(42, '2026-01-12', '2026-01-18')).toBe(2400);
  });

  test('empleado sin jornadas → 0', async () => {
    monthlyWorkedByEmployee.mockResolvedValueOnce(new Map());
    expect(await engineWorkedTotal(99, '2026-01-12', '2026-01-18')).toBe(0);
  });
});

describe('engineWorkedByDate', () => {
  test('devuelve Map<id, Map<fecha, min>>', async () => {
    monthlyWorkedByEmployee.mockResolvedValueOnce(new Map([
      [1, { workedMinutes: 480, byDate: new Map([['2026-01-14', 480]]) }],
    ]));
    const m = await engineWorkedByDate([1], '2026-01-14', '2026-01-14');
    expect(m.get(1).get('2026-01-14')).toBe(480);
  });
});
