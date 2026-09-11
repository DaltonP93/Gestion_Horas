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

/** Programa los marcajes que devolverá la lectura de la ventana. `stored` es un
 *  mapa fecha→fila previa que devuelve la lectura FOR UPDATE de daily_summary. */
function conMarcajes(rows, stored = {}) {
  sequelize.query.mockReset();
  sequelize.query.mockImplementation(async (sql, opts) => {
    if (/FROM attendance_logs/i.test(sql)) return [rows];
    if (/FROM holidays/i.test(sql)) return [[]];
    // Lectura del estado previo (FOR UPDATE) por (empleado, fecha).
    if (/FROM daily_summary WHERE employee_id = \? AND date = \? FOR UPDATE/i.test(sql)) {
      const date = opts?.replacements?.[1];
      return [stored[date] ? [stored[date]] : []];
    }
    if (/INSERT INTO daily_summary/i.test(sql)) return [{ affectedRows: 1 }];
    if (/UPDATE daily_summary/i.test(sql)) return [{ affectedRows: 1 }];
    if (/DELETE FROM daily_summary/i.test(sql)) return [{ affectedRows: 1 }];
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
    // fila, fabricaría una ausencia FUTURA. Sin fila previa el 11 es NOOP; con
    // una huérfana previa, se ACTUALIZA (nunca INSERT).
    conConfig({ source: 'schedule_history', check_in: '08:00', check_out: '17:00', tolerance_in: 5, work_days: [2, 3, 4, 5, 6] });
    // El 11 ya tiene una fila huérfana (que un recalc previo materializó).
    conMarcajes([
      { id: 1, timestamp: '2025-06-10 08:00:00', type: 'in' },
      { id: 2, timestamp: '2025-06-10 17:00:00', type: 'out' },
    ], { '2025-06-11': { worked_minutes: 120, status: 'present', justification: null, justification_type: null } });
    await svc.resolveSummary(1, '2025-06-10 08:00:00', { apply: true });

    // Ningún upsert (INSERT) apunta al 2025-06-11: replacements[1] es la fecha.
    const upserts = sequelize.query.mock.calls.filter((c) => /INSERT INTO daily_summary/i.test(c[0]));
    expect(upserts.length).toBeGreaterThan(0); // sí materializa el 09 y el 10
    for (const [, opts] of upserts) {
      expect(opts.replacements[1]).not.toBe('2025-06-11');
    }
    // El 11 se reconcilia por un UPDATE puro acotado a esa fecha.
    const updatePosterior = sequelize.query.mock.calls.find(
      (c) => /^\s*UPDATE daily_summary SET/i.test(c[0]) && c[1].replacements.includes('2025-06-11'),
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

  test('un día unconfigured RECONCILIA: restaura la justificación manual (update) y borra el resto (delete)', async () => {
    // Sin marcas y sin config → unconfigured. Una fila con justificación MANUAL
    // sobrevive con su estado derivado; una sin justificación se borra.
    // Caso A: fila previa justificada → UPDATE (no DELETE).
    conMarcajes([], { '2025-06-10': { status: 'holiday', justification: 'X', justification_type: 'medica', worked_minutes: 0 } });
    await svc.resolveSummary(1, '2025-06-10 12:00:00', { apply: true });
    const updA = sequelize.query.mock.calls.find((c) => /^\s*UPDATE daily_summary/i.test(c[0]) && c[1].replacements.includes('2025-06-10'));
    expect(updA).toBeDefined();
    expect(sequelize.query.mock.calls.some((c) => /DELETE FROM daily_summary/i.test(c[0]))).toBe(false);
    // No inventa una fila para un día sin evidencia.
    expect(sequelize.query.mock.calls.some((c) => /INSERT INTO daily_summary/i.test(c[0]))).toBe(false);

    // Caso B: fila previa SIN justificación → DELETE (config automática obsoleta).
    conMarcajes([], { '2025-06-10': { status: 'weekend', justification: null, justification_type: null } });
    await svc.resolveSummary(1, '2025-06-10 12:00:00', { apply: true });
    const delB = sequelize.query.mock.calls.find((c) => /DELETE FROM daily_summary/i.test(c[0]) && c[1].replacements.includes('2025-06-10'));
    expect(delB).toBeDefined();
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
    // Con jornada real (present), aunque exista una justificación manual previa,
    // el estado trabajado GANA (la preservación es sólo para días vacíos).
    conMarcajes([
      { id: 1, timestamp: '2025-06-10 08:00:00', type: 'in' },
      { id: 2, timestamp: '2025-06-10 17:00:00', type: 'out' },
    ], { '2025-06-10': { status: 'permission', justification: 'X', justification_type: 'permiso', worked_minutes: 0 } });
    await svc.resolveSummary(1, '2025-06-10 17:00:00', { apply: true });
    // El upsert del 10 escribe el status calculado 'present' (col status = 10º valor),
    // no el 'permission' preservado: hay jornada real.
    const call = sequelize.query.mock.calls.find((c) => /INSERT INTO daily_summary/i.test(c[0]) && c[1].replacements[1] === '2025-06-10');
    expect(call).toBeDefined();
    expect(call[1].replacements[9]).toBe('present');
  });
});

describe('[B3] effectiveDailySummary — semántica de escritura pura y compartida', () => {
  const eng = (over = {}) => ({ date: '2025-06-10', first_in: '2025-06-10 08:00:00', last_out: '2025-06-10 17:00:00', worked_minutes: 480, break_minutes: 0, overtime_minutes: 0, late_minutes: 0, notes: null, status: 'present', workday_count: 1, ...over });
  const justRow = (type) => ({ status: 'x', justification: 'manual', justification_type: type, worked_minutes: 99 });

  test('status null (unconfigured): sin fila → noop; justificada → update a estado derivado y ceros; sin justificación → delete', () => {
    const r = eng({ status: 'unconfigured' });
    expect(svc.effectiveDailySummary(r, null).action).toBe('noop');
    const injust = svc.effectiveDailySummary(r, justRow('injustificada'));
    expect(injust.action).toBe('update');
    expect(injust.row.status).toBe('absent');
    expect(injust.row.worked_minutes).toBe(0);
    expect(injust.row.first_in).toBeNull();
    const permiso = svc.effectiveDailySummary(r, justRow('medica'));
    expect(permiso.row.status).toBe('permission');
    expect(svc.effectiveDailySummary(r, { status: 'weekend', justification: null, justification_type: null }).action).toBe('delete');
  });

  test('día vacío (workday_count 0): una justificación manual gana con estado derivado; sin justificación gana el status del motor', () => {
    const vacio = eng({ workday_count: 0, status: 'absent', worked_minutes: 0, first_in: null, last_out: null });
    expect(svc.effectiveDailySummary(vacio, justRow('injustificada')).row.status).toBe('absent');
    expect(svc.effectiveDailySummary(vacio, justRow('permiso')).row.status).toBe('permission');
    expect(svc.effectiveDailySummary(vacio, null).row.status).toBe('absent'); // status del motor
  });

  test('día con jornada real: el status trabajado gana aunque haya justificación previa', () => {
    const eff = svc.effectiveDailySummary(eng(), justRow('permiso'));
    expect(eff.action).toBe('update'); // había fila
    expect(eff.row.status).toBe('present'); // NO se preserva el permiso: hay jornada
  });

  test('insert vs update según exista la fila previa; reconcileOnly nunca inserta', () => {
    expect(svc.effectiveDailySummary(eng(), null).action).toBe('insert');
    expect(svc.effectiveDailySummary(eng(), { status: 'present' }).action).toBe('update');
    expect(svc.effectiveDailySummary(eng(), null, { reconcileOnly: true }).action).toBe('noop');
    expect(svc.effectiveDailySummary(eng(), { status: 'x' }, { reconcileOnly: true }).action).toBe('update');
  });

  test('classifyEffective: inserted/updated/deleted/unchanged inequívocos', () => {
    expect(svc.classifyEffective({ action: 'insert', row: {} }, null)).toBe('inserted');
    expect(svc.classifyEffective({ action: 'delete' }, { status: 'x' })).toBe('deleted');
    expect(svc.classifyEffective({ action: 'delete' }, null)).toBe('unchanged');
    expect(svc.classifyEffective({ action: 'noop' }, null)).toBe('unchanged');
    const target = { first_in: null, last_out: null, worked_minutes: 480, break_minutes: 0, overtime_minutes: 0, late_minutes: 0, notes: null, status: 'present' };
    // update que NO cambia nada → unchanged
    expect(svc.classifyEffective({ action: 'update', row: target }, { ...target })).toBe('unchanged');
    // update que sí cambia → updated
    expect(svc.classifyEffective({ action: 'update', row: { ...target, worked_minutes: 999 } }, { ...target })).toBe('updated');
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
