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
const mockLoadWorkdayConfig = jest.fn();
jest.mock('../src/services/workdayConfig', () => ({
  loadWorkdayConfig: (...a) => mockLoadWorkdayConfig(...a),
}));
jest.mock('../src/services/recalcLock', () => ({
  withDayRecalcLock: jest.fn(async (_date, fn) => fn('TX')),
  dayBounds: (d) => ({ start: `${d} 00:00:00`, next: `${d} 00:00:00` }),
}));

const { sequelize } = require('../src/config/database');
const svc = require('../src/services/workdaySummaryService');

beforeEach(() => {
  // Por defecto: sin config cargada → historical_fallback (estado real hoy). El
  // motor describe lo que dicen los marcajes sin inventar horario. Los tests que
  // necesitan un día laborable configurado usan conConfig().
  mockLoadWorkdayConfig.mockReset();
  mockLoadWorkdayConfig.mockResolvedValue({ forDate: () => null, historyFor: () => [] });
});

/** Fija la configuración efectiva que devolverá forDate para cualquier fecha. */
function conConfig(cfg) {
  mockLoadWorkdayConfig.mockResolvedValue({ forDate: () => cfg, historyFor: () => [] });
}

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

  test('el ancla también reconcilia el día civil POSTERIOR (huérfana absorbida)', async () => {
    // Carga fuera de orden: la marca ancla es el IN del 20 22:00, pero el OUT del
    // 21 02:00 ya pudo materializarse como una fila huérfana del 21. La jornada
    // correcta es del 20 (se fecha por su primera entrada), así que la ventana
    // debe incluir el 21 para reconciliar esa fila obsoleta en vez de duplicar
    // la actividad. affectedDates cubre {19, 20, 21}.
    conMarcajes([
      { id: 1, timestamp: '2025-08-20 22:00:00', type: 'in' },
      { id: 2, timestamp: '2025-08-21 02:00:00', type: 'out' },
    ]);
    const { rows, affectedDates } = await svc.resolveSummary(1, '2025-08-20 22:00:00', { apply: false });
    expect(affectedDates).toContain('2025-08-21');
    // La jornada nocturna queda fechada el 20, no el 21.
    const jornada = rows.find((r) => r.date === '2025-08-20');
    expect(jornada).toBeDefined();
    expect(jornada.first_in.slice(11, 16)).toBe('22:00');
    expect(jornada.last_out.slice(11, 16)).toBe('02:00');
    // El 21 se materializa como día vacío (sin jornada propia), listo para
    // pisar/borrar cualquier huérfana previa; no reclama la actividad del 20.
    const posterior = rows.find((r) => r.date === '2025-08-21');
    expect(posterior).toBeDefined();
    expect(posterior.workday_count || 0).toBe(0);
  });

  test('el día posterior es RECONCILE-ONLY: NUNCA inserta una fila nueva (P1)', async () => {
    // Día laborable configurado, marca ordinaria (IN+OUT del martes 10). La
    // ventana incluye el miércoles 11 SÓLO para reconciliar una huérfana previa.
    // Materializarlo como día vacío daría 'absent'; si el writer INSERTARA esa
    // fila, fabricaría una ausencia FUTURA en KPI/reportes. El 11 debe escribirse
    // por UPDATE (no-op si no hay fila), nunca por INSERT.
    conConfig({ source: 'schedule_history', check_in: '08:00', check_out: '17:00', tolerance_in: 5, work_days: [2, 3, 4, 5, 6] });
    conMarcajes([
      { id: 1, timestamp: '2025-06-10 08:00:00', type: 'in' },
      { id: 2, timestamp: '2025-06-10 17:00:00', type: 'out' },
    ]);
    await svc.resolveSummary(1, '2025-06-10 08:00:00', { apply: true });

    // Ningún INSERT apunta al día posterior (2025-06-11). El parámetro de fecha
    // del INSERT es el segundo replacement.
    const inserts = sequelize.query.mock.calls.filter((c) => /INSERT INTO daily_summary/i.test(c[0]));
    expect(inserts.length).toBeGreaterThan(0); // sí inserta el 09 y el 10
    for (const [, opts] of inserts) {
      expect(opts.replacements[1]).not.toBe('2025-06-11');
    }
    // El 11 se reconcilia por un UPDATE acotado a esa fecha (no-op si no existe).
    const updatePosterior = sequelize.query.mock.calls.find(
      (c) => /UPDATE daily_summary SET/i.test(c[0]) && c[1].replacements.includes('2025-06-11'),
    );
    expect(updatePosterior).toBeDefined();
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

  test('un día unconfigured RECONCILIA: restaura la justificación manual y borra el resto', async () => {
    // Sin marcas y sin config → unconfigured. Una fila con justificación MANUAL
    // sobrevive con su estado derivado (injustificada→absent, otra→permission);
    // las filas automáticas (sin justificación) se borran como config obsoleta.
    conMarcajes([]);
    await svc.resolveSummary(1, '2025-06-10 12:00:00', { apply: true });
    const upd = sequelize.query.mock.calls.find((c) => /UPDATE daily_summary/i.test(c[0]));
    const del = sequelize.query.mock.calls.find((c) => /DELETE FROM daily_summary/i.test(c[0]));
    expect(upd).toBeDefined();
    // El UPDATE restaura injustificada→absent, resto→permission, sólo si hay
    // justificación manual.
    expect(upd[0]).toMatch(/COALESCE\(justification_type, ''\) = 'injustificada'\s*\n?\s*THEN 'absent' ELSE 'permission'/);
    expect(upd[0]).toMatch(/justification IS NOT NULL OR justification_type IS NOT NULL/);
    // El DELETE sólo borra filas SIN justificación manual.
    expect(del).toBeDefined();
    expect(del[0]).toMatch(/justification IS NULL AND justification_type IS NULL/);
    // No inventa una fila para un día sin evidencia.
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

  test('el upsert deriva el estado de la justificación manual, no del status compartido', async () => {
    conMarcajes([
      { id: 1, timestamp: '2025-06-10 08:00:00', type: 'in' },
      { id: 2, timestamp: '2025-06-10 17:00:00', type: 'out' },
    ]);
    await svc.resolveSummary(1, '2025-06-10 17:00:00', { apply: true });
    const insert = sequelize.query.mock.calls.find((c) => /INSERT INTO daily_summary/i.test(c[0]))[0];
    // Una justificación manual gana en un día vacío, con su estado DERIVADO
    // (injustificada→absent, otra→permission). holiday/weekend son automáticos
    // (sin justificación) y el motor los recalcula.
    expect(insert).toMatch(/justification IS NOT NULL OR daily_summary\.justification_type IS NOT NULL/);
    expect(insert).toMatch(/'injustificada'\s*\n?\s*THEN 'absent' ELSE 'permission'/);
    expect(insert).not.toMatch(/IN \('holiday','weekend','permission'\)/);
  });

  test('un fichaje suelto que ningún bound cubre se conserva en notes (no como cierre)', async () => {
    // 08:00 IN, 17:00 OUT (jornada real) y 18:00 IN (entrada abierta posterior).
    // last_out NO se corre a 18:00 —eso sería un cierre artificial— pero la
    // evidencia del fichaje de las 18:00 se guarda en notes, que el writer sí
    // persiste (daily_summary no tiene columna de anomalías).
    conMarcajes([
      { id: 1, timestamp: '2025-06-10 08:00:00', type: 'in' },
      { id: 2, timestamp: '2025-06-10 17:00:00', type: 'out' },
      { id: 3, timestamp: '2025-06-10 18:00:00', type: 'in' },
    ]);
    await svc.resolveSummary(1, '2025-06-10 18:00:00', { apply: true });
    const call = sequelize.query.mock.calls.find(
      (c) => /INSERT INTO daily_summary/i.test(c[0]) && c[1].replacements[1] === '2025-06-10',
    );
    expect(call).toBeDefined();
    // La columna notes se persiste, con VALUES(notes) en el upsert.
    expect(call[0]).toMatch(/notes\s*=\s*VALUES\(notes\)/);
    const repl = call[1].replacements;
    // Orden: …, late(7), notes(8), status(9), esDiaVacio(10).
    expect(repl[3]).toBe('2025-06-10 17:00:00'); // last_out NO se corre a 18:00
    expect(repl[8]).toMatch(/entrada 18:00/);    // evidencia del fichaje suelto
    expect(repl[9]).toBe('present');
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
    expect(sql).toMatch(/WHEN \? = 1 AND \(daily_summary\.justification IS NOT NULL/);
    // La fila del 2025-06-10 SÍ tiene jornada (present) → flag esDiaVacio = 0.
    // Orden de replacements: …, notes(8), status(9), esDiaVacio(10).
    expect(repl[9]).toBe('present');   // status calculado
    expect(repl[10]).toBe(0);          // esDiaVacio: hay jornada, el estado nuevo gana
  });
});

describe('mapeo de estado y la migración 074', () => {
  const orig = process.env.WORKDAY_ENGINE_STATUS_074_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.WORKDAY_ENGINE_STATUS_074_ENABLED;
    else process.env.WORKDAY_ENGINE_STATUS_074_ENABLED = orig;
  });

  test('sin 074: non_working colapsa a weekend y unconfigured a null', () => {
    delete process.env.WORKDAY_ENGINE_STATUS_074_ENABLED;
    expect(svc.statusParaDb('non_working')).toBe('weekend');
    expect(svc.statusParaDb('unconfigured')).toBeNull();
  });

  test('con 074: se persisten los valores nuevos', () => {
    process.env.WORKDAY_ENGINE_STATUS_074_ENABLED = 'true';
    expect(svc.statusParaDb('non_working')).toBe('non_working');
    expect(svc.statusParaDb('unconfigured')).toBe('unconfigured');
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
