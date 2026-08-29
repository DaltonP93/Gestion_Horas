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

  test('un deadlock reejecuta el bloque: relee el día bajo el lock y no duplica', async () => {
    let upserts = 0;
    wireQueries({ onUpsert: () => { upserts++; if (upserts < 2) throw deadlockErr(); return [{ affectedRows: 1 }]; } });
    await recalcDailySummary(1, new Date('2026-07-28T12:00:00-03:00'));
    // El upsert (idempotente por ON DUPLICATE KEY) se ejecutó 2 veces (1 deadlock
    // + 1 éxito), sin duplicar filas.
    expect(upserts).toBe(2);
    // La lectura del día está DENTRO del lock: el reintento reejecuta el bloque y
    // relee, para que lo que se persiste salga de una lectura consistente (no de
    // una vista vieja que podría pisar datos de un recálculo concurrente).
    const reads = mockQuery.mock.calls.filter(c => /SELECT\s+timestamp,\s*type\s+FROM attendance_logs/i.test(c[0]));
    expect(reads.length).toBe(2);
    // Y esas lecturas corren dentro de la transacción del lock.
    expect(reads.every(c => c[1].transaction === 'TX')).toBe(true);
  });

});

// Marcas sin tipo ('unknown', p. ej. móvil sin contexto): la actividad prueba
// PRESENCIA pero no que sea in/out. El legacy no debe dejar el día 'absent' ni
// inventar bordes/permanencia desde un unknown. Corrige SÓLO el camino flag-OFF.
describe('recalcDailySummary (legacy) — marcas sin tipo no fabrican jornada', () => {
  // Devuelve [first_in, last_out, worked, late, status] del upsert.
  async function recalcConLogs(rows) {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM attendance_logs/i.test(sql) && /SELECT\s+timestamp/i.test(sql)) return [rows];
      if (/FROM holidays/i.test(sql)) return [[null]];
      if (/FROM employees/i.test(sql) && /schedules/i.test(sql)) return [[{ check_in: '08:00:00', tolerance_in: 5 }]];
      if (/GET_LOCK/i.test(sql)) return [[{ ok: 1 }]];
      if (/RELEASE_LOCK/i.test(sql)) return [[]];
      if (/INSERT INTO daily_summary/i.test(sql)) return [{ affectedRows: 1 }];
      return [[]];
    });
    await recalcDailySummary(1, new Date('2026-07-28T12:00:00-03:00'));
    const upsert = mockQuery.mock.calls.find(c => /INSERT INTO daily_summary/i.test(c[0]) && c[1].replacements.length === 7);
    const r = upsert[1].replacements; // [emp, date, first_in, last_out, worked, late, status]
    return { first_in: r[2], last_out: r[3], worked: r[4], late: r[5], status: r[6] };
  }

  test('Caso A: 1 unknown → present, sin bordes ni permanencia inventados', async () => {
    const r = await recalcConLogs([{ timestamp: '2026-07-28 08:00:00', type: 'unknown' }]);
    expect(r).toEqual({ first_in: null, last_out: null, worked: 0, late: 0, status: 'present' });
  });

  test('Caso B: 2 unknown NO se interpretan como 9 h de jornada', async () => {
    const r = await recalcConLogs([
      { timestamp: '2026-07-28 08:00:00', type: 'unknown' },
      { timestamp: '2026-07-28 17:00:00', type: 'unknown' },
    ]);
    expect(r).toEqual({ first_in: null, last_out: null, worked: 0, late: 0, status: 'present' });
  });

  test('Caso C: IN + unknown → first_in real, last_out NULL, worked 0 (late permitido)', async () => {
    const r = await recalcConLogs([
      { timestamp: '2026-07-28 08:00:00', type: 'in' },
      { timestamp: '2026-07-28 17:00:00', type: 'unknown' },
    ]);
    expect(r.first_in).toBe('2026-07-28 08:00:00');
    expect(r.last_out).toBeNull();      // falta el OUT explícito
    expect(r.worked).toBe(0);           // sin permanencia sin OUT
    expect(r.status).toBe('present');
  });

  test('Caso D: unknown + OUT → first_in NULL, last_out real, worked 0', async () => {
    const r = await recalcConLogs([
      { timestamp: '2026-07-28 08:00:00', type: 'unknown' },
      { timestamp: '2026-07-28 17:00:00', type: 'out' },
    ]);
    expect(r).toEqual({ first_in: null, last_out: '2026-07-28 17:00:00', worked: 0, late: 0, status: 'present' });
  });

  test('Caso E: IN + OUT → comportamiento legacy intacto (permanencia real)', async () => {
    const r = await recalcConLogs([
      { timestamp: '2026-07-28 08:00:00', type: 'in' },
      { timestamp: '2026-07-28 17:00:00', type: 'out' },
    ]);
    expect(r.first_in).toBe('2026-07-28 08:00:00');
    expect(r.last_out).toBe('2026-07-28 17:00:00');
    expect(r.worked).toBe(540);         // 9 h reales (in→out explícitos)
    expect(r.status).toBe('present');
  });

  test('Caso F: IN + unknown + OUT → sólo los bordes explícitos, el unknown no altera nada', async () => {
    const r = await recalcConLogs([
      { timestamp: '2026-07-28 08:00:00', type: 'in' },
      { timestamp: '2026-07-28 12:00:00', type: 'unknown' },
      { timestamp: '2026-07-28 17:00:00', type: 'out' },
    ]);
    expect(r.first_in).toBe('2026-07-28 08:00:00');
    expect(r.last_out).toBe('2026-07-28 17:00:00');
    expect(r.worked).toBe(540);         // idéntico al par IN/OUT sin el unknown
    expect(r.status).toBe('present');
  });

  test('el upsert REEMPLAZA first_in (no COALESCE): un NULL recalculado borra un first_in fabricado', async () => {
    // Un día que el legacy viejo dejó con first_in fabricado desde un 'unknown'
    // debe poder LIMPIARSE al reprocesar: con VALUES(first_in) NULL, el upsert
    // tiene que reemplazar (no conservar) el valor obsoleto. Se verifica sobre la
    // cláusula ON DUPLICATE KEY UPDATE, no sólo sobre los replacements.
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM attendance_logs/i.test(sql) && /SELECT\s+timestamp/i.test(sql)) {
        return [[{ timestamp: '2026-07-28 08:00:00', type: 'unknown' }]];
      }
      if (/FROM holidays/i.test(sql)) return [[null]];
      if (/FROM employees/i.test(sql) && /schedules/i.test(sql)) return [[{ check_in: '08:00:00', tolerance_in: 5 }]];
      if (/GET_LOCK/i.test(sql)) return [[{ ok: 1 }]];
      if (/RELEASE_LOCK/i.test(sql)) return [[]];
      if (/INSERT INTO daily_summary/i.test(sql)) return [{ affectedRows: 1 }];
      return [[]];
    });
    await recalcDailySummary(1, new Date('2026-07-28T12:00:00-03:00'));
    const upsert = mockQuery.mock.calls.find(c => /INSERT INTO daily_summary/i.test(c[0]) && c[1].replacements.length === 7);
    // La cláusula reemplaza first_in con VALUES(first_in); NO usa COALESCE.
    expect(upsert[0]).toMatch(/first_in\s*=\s*VALUES\(first_in\)/);
    expect(upsert[0]).not.toMatch(/COALESCE\(VALUES\(first_in\)/);
    // Y el valor recalculado que reemplaza es NULL (día sin `in` explícito).
    expect(upsert[1].replacements[2]).toBeNull();
  });
});
