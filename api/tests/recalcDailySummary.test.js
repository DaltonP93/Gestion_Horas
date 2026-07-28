// Tests del recálculo por-empleado (bridge): lectura SARGABLE + upsert
// idempotente serializado por fecha, con reintento ante deadlock.
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {} }));
jest.mock('../src/socket/socketServer', () => ({ getIO: () => ({ to: () => ({ emit() {} }), emit() {} }), emitAttendance() {} }));
jest.mock('../src/routes/webhooks', () => ({ fireWebhooks: jest.fn() }));
jest.mock('../src/config/att2000', () => ({ writeCheckinOut: jest.fn() }));

const mockQuery = jest.fn();
const mockTransaction = jest.fn(async (cb) => cb('TX'));
jest.mock('../src/config/database', () => ({
  sequelize: { query: (...a) => mockQuery(...a), transaction: (...a) => mockTransaction(...a) },
}));

const { recalcDailySummary } = require('../src/controllers/attendanceController');

const deadlockErr = () => Object.assign(new Error('Deadlock found'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' });

// Router de respuestas por SQL. `onUpsert` permite inyectar comportamiento.
function wireQueries({ onUpsert } = {}) {
  mockQuery.mockImplementation(async (sql) => {
    if (/FROM attendance_logs/i.test(sql) && /SELECT\s+timestamp/i.test(sql)) {
      return [[
        { timestamp: '2026-07-28 08:05:00', type: 'in' },
        { timestamp: '2026-07-28 17:00:00', type: 'out' },
      ]];
    }
    if (/FROM holidays/i.test(sql)) return [[null]];
    if (/FROM employees/i.test(sql) && /schedules/i.test(sql)) return [[{ check_in: '08:00:00', tolerance_in: 5 }]];
    if (/GET_LOCK/i.test(sql)) return [[{ ok: 1 }]];
    if (/RELEASE_LOCK/i.test(sql)) return [[]];
    if (/INSERT INTO daily_summary/i.test(sql)) { if (onUpsert) return onUpsert(); return [{ affectedRows: 1 }]; }
    return [[]];
  });
}

beforeEach(() => { mockQuery.mockReset(); mockTransaction.mockClear(); });

describe('recalcDailySummary (sargable + lock por fecha)', () => {
  test('la lectura del día usa rango SARGABLE, no DATE(timestamp)', async () => {
    wireQueries();
    await recalcDailySummary(1, new Date('2026-07-28T12:00:00-03:00'));
    const readCall = mockQuery.mock.calls.find(c => /SELECT\s+timestamp,\s*type\s+FROM attendance_logs/i.test(c[0]));
    expect(readCall).toBeTruthy();
    expect(readCall[0]).toMatch(/timestamp >= \? AND timestamp < \?/);
    expect(readCall[0]).not.toMatch(/DATE\(timestamp\)/);
    // Los límites del rango son [inicio, díaSiguiente) de la fecha Paraguay.
    const repl = readCall[1].replacements;
    expect(repl[1]).toBe('2026-07-28 00:00:00');
    expect(repl[2]).toBe('2026-07-29 00:00:00');
  });

  test('el upsert corre bajo GET_LOCK/RELEASE_LOCK y es idempotente (ON DUPLICATE KEY)', async () => {
    wireQueries();
    await recalcDailySummary(1, new Date('2026-07-28T12:00:00-03:00'));
    const upsert = mockQuery.mock.calls.find(c => /INSERT INTO daily_summary/i.test(c[0]));
    expect(upsert).toBeTruthy();
    expect(upsert[0]).toMatch(/ON DUPLICATE KEY UPDATE/i);
    expect(upsert[1].transaction).toBe('TX'); // dentro de la transacción del lock
    // Hubo GET_LOCK antes y RELEASE_LOCK después.
    expect(mockQuery.mock.calls.some(c => /GET_LOCK/i.test(c[0]))).toBe(true);
    expect(mockQuery.mock.calls.some(c => /RELEASE_LOCK/i.test(c[0]))).toBe(true);
  });

  test('un deadlock en el upsert se reintenta sin releer el día ni duplicar', async () => {
    let upserts = 0;
    wireQueries({ onUpsert: () => { upserts++; if (upserts < 2) throw deadlockErr(); return [{ affectedRows: 1 }]; } });
    await recalcDailySummary(1, new Date('2026-07-28T12:00:00-03:00'));
    // El upsert (idempotente) se ejecutó 2 veces (1 deadlock + 1 éxito)…
    expect(upserts).toBe(2);
    // …pero la lectura de marcas del día NO se repitió (está fuera del lock).
    const reads = mockQuery.mock.calls.filter(c => /SELECT\s+timestamp,\s*type\s+FROM attendance_logs/i.test(c[0]));
    expect(reads.length).toBe(1);
  });
});
