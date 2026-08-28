/**
 * workdaySummaryService.test.js — El writer de daily_summary basado en el motor.
 *
 * Cubre: recalc por el MOTOR (no cálculo propio), fechas afectadas (una marca de
 * madrugada recalcula el día anterior), cruces de mes/año, dry-run que NO
 * escribe, y el feature flag OFF por defecto.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
  DB_TIMEZONE: '-03:00',
}));
jest.mock('../src/services/workdayConfig', () => ({
  // Sin config cargada: historical_fallback (estado real hoy). El motor describe
  // lo que dicen los marcajes sin inventar horario.
  loadWorkdayConfig: jest.fn(async () => ({ forDate: () => null, historyFor: () => [] })),
}));
jest.mock('../src/services/recalcLock', () => ({
  withDayRecalcLock: jest.fn(async (_date, fn) => fn('TX')),
  dayBounds: (d) => ({ start: `${d} 00:00:00`, next: `${d} 00:00:00` }),
}));

const { sequelize } = require('../src/config/database');
const svc = require('../src/services/workdaySummaryService');

/** Programa los marcajes que devolverá la lectura de la ventana. */
function conMarcajes(rows) {
  sequelize.query.mockReset();
  sequelize.query.mockImplementation(async (sql) => {
    if (/FROM attendance_logs/i.test(sql)) return [rows];
    if (/FROM holidays/i.test(sql)) return [[]];
    if (/INSERT INTO daily_summary/i.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
}

describe('resolveSummary — fechas afectadas', () => {
  test('una salida de madrugada recalcula la work_date ANTERIOR', async () => {
    // Jornada nocturna: entra 01/12 18:30, sale 02/12 07:04. La marca ancla es
    // el OUT del 02/12, pero la jornada pertenece al 01/12.
    conMarcajes([
      { id: 1, timestamp: '2024-12-01 18:30:00', type: 'in' },
      { id: 2, timestamp: '2024-12-02 07:04:00', type: 'out' },
    ]);
    const { rows, affectedDates } = await svc.resolveSummary(1, '2024-12-02 07:04:00', { apply: false });
    expect(affectedDates).toContain('2024-12-01');
    const fila = rows.find((r) => r.date === '2024-12-01');
    expect(fila).toBeDefined();
    expect(fila.first_in.slice(11, 16)).toBe('18:30');
    expect(fila.last_out.slice(11, 16)).toBe('07:04');
    expect(fila.worked_minutes).toBe(754); // 18:30 → 07:04 = 12:34 permanencia
  });

  test('marca del 01/02 que cierra jornada del 31/01 (cruce de mes)', async () => {
    conMarcajes([
      { id: 1, timestamp: '2025-01-31 21:00:00', type: 'in' },
      { id: 2, timestamp: '2025-02-01 05:00:00', type: 'out' },
    ]);
    const { rows, affectedDates } = await svc.resolveSummary(1, '2025-02-01 05:00:00', { apply: false });
    expect(affectedDates).toContain('2025-01-31');
    expect(rows.find((r) => r.date === '2025-01-31').worked_minutes).toBe(480);
  });

  test('cruce de año: 01/01 cierra jornada del 31/12', async () => {
    conMarcajes([
      { id: 1, timestamp: '2024-12-31 22:00:00', type: 'in' },
      { id: 2, timestamp: '2025-01-01 06:00:00', type: 'out' },
    ]);
    const { affectedDates } = await svc.resolveSummary(1, '2025-01-01 06:00:00', { apply: false });
    expect(affectedDates).toContain('2024-12-31');
  });

  test('múltiples pares nocturnos quedan en una sola jornada', async () => {
    conMarcajes([
      { id: 1, timestamp: '2025-01-02 21:32:00', type: 'in' },
      { id: 2, timestamp: '2025-01-03 00:05:00', type: 'out' },
      { id: 3, timestamp: '2025-01-03 01:02:00', type: 'in' },
      { id: 4, timestamp: '2025-01-03 05:29:00', type: 'out' },
    ]);
    const { rows } = await svc.resolveSummary(1, '2025-01-03 05:29:00', { apply: false });
    const fila = rows.find((r) => r.date === '2025-01-02');
    expect(fila).toBeDefined();
    expect(fila.net_worked_minutes).toBe(420); // 2:33 + 4:27 = 7:00 netos
  });
});

describe('dry-run vs apply', () => {
  test('apply:false NO escribe daily_summary', async () => {
    conMarcajes([
      { id: 1, timestamp: '2025-06-10 08:00:00', type: 'in' },
      { id: 2, timestamp: '2025-06-10 17:00:00', type: 'out' },
    ]);
    await svc.resolveSummary(1, '2025-06-10 17:00:00', { apply: false });
    const insertó = sequelize.query.mock.calls.some((c) => /INSERT INTO daily_summary/i.test(c[0]));
    expect(insertó).toBe(false);
  });

  test('apply:true SÍ escribe (bajo el lock por fecha)', async () => {
    conMarcajes([
      { id: 1, timestamp: '2025-06-10 08:00:00', type: 'in' },
      { id: 2, timestamp: '2025-06-10 17:00:00', type: 'out' },
    ]);
    await svc.resolveSummary(1, '2025-06-10 17:00:00', { apply: true });
    const insertó = sequelize.query.mock.calls.some((c) => /INSERT INTO daily_summary/i.test(c[0]));
    expect(insertó).toBe(true);
  });

  test('el upsert PRESERVA los estados manuales (holiday/weekend/permission)', async () => {
    conMarcajes([
      { id: 1, timestamp: '2025-06-10 08:00:00', type: 'in' },
      { id: 2, timestamp: '2025-06-10 17:00:00', type: 'out' },
    ]);
    await svc.resolveSummary(1, '2025-06-10 17:00:00', { apply: true });
    const insert = sequelize.query.mock.calls.find((c) => /INSERT INTO daily_summary/i.test(c[0]))[0];
    // Un permiso ya cargado no se pisa: recalcular ayer por una marca de hoy no
    // puede borrar un permission que sigue justificado.
    expect(insert).toMatch(/daily_summary\.status IN \('holiday','weekend','permission'\)/);
  });

  test('el upsert materializa TODOS los derivados (break y overtime), no sólo algunos', async () => {
    conMarcajes([
      { id: 1, timestamp: '2025-06-10 08:00:00', type: 'in' },
      { id: 2, timestamp: '2025-06-10 17:00:00', type: 'out' },
    ]);
    await svc.resolveSummary(1, '2025-06-10 17:00:00', { apply: true });
    const insert = sequelize.query.mock.calls.find((c) => /INSERT INTO daily_summary/i.test(c[0]))[0];
    // Sin escribir overtime, un valor legacy positivo seguiría acreditándose.
    expect(insert).toMatch(/break_minutes\s*=\s*VALUES\(break_minutes\)/);
    expect(insert).toMatch(/overtime_minutes\s*=\s*VALUES\(overtime_minutes\)/);
  });

  test('la preservación de estado se limita a los días SIN jornada', async () => {
    // La guarda de preservación va condicionada a ?=1: sólo se conserva el
    // holiday/weekend/permission viejo cuando la fila recalculada NO tiene
    // jornada. Un domingo ahora laborable con marcas reales no queda 'weekend'.
    conMarcajes([
      { id: 1, timestamp: '2025-06-10 08:00:00', type: 'in' },
      { id: 2, timestamp: '2025-06-10 17:00:00', type: 'out' },
    ]);
    await svc.resolveSummary(1, '2025-06-10 17:00:00', { apply: true });
    const call = sequelize.query.mock.calls.find((c) => /INSERT INTO daily_summary/i.test(c[0]));
    const sql = call[0];
    const repl = call[1].replacements;
    expect(sql).toMatch(/WHEN \? = 1 AND daily_summary\.status IN/);
    // La fila del 2025-06-10 SÍ tiene jornada (present) → flag esDiaVacio = 0.
    expect(repl[8]).toBe('present');   // status calculado
    expect(repl[9]).toBe(0);           // esDiaVacio: hay jornada, el estado nuevo gana
  });
});

describe('feature flag', () => {
  const orig = process.env.WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED;
  afterEach(() => { process.env.WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED = orig; });

  test('default OFF', () => {
    delete process.env.WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED;
    expect(svc.isEngineSummaryWriteEnabled()).toBe(false);
  });

  test('ON sólo con el string exacto "true"', () => {
    process.env.WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED = 'true';
    expect(svc.isEngineSummaryWriteEnabled()).toBe(true);
    process.env.WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED = '1';
    expect(svc.isEngineSummaryWriteEnabled()).toBe(false);
  });
});
