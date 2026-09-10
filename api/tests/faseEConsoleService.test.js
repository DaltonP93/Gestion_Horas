/**
 * faseEConsoleService.test.js — lógica de la consola de FASE E (mockeada).
 *
 * Las pruebas REALES de lock (concurrencia/expiración/heartbeat>TTL), backup
 * atómico y restore transaccional/reintentable viven en tests/it/faseEConsole.it.test.js
 * (MySQL efímero, IT_DB=1). Acá se cubre la lógica pura/mockeada:
 *   · scope_kind estricto: "", null, false, 0, undefined → INVALID_SCOPE sin
 *     consultar empleados ni escribir;
 *   · paridad dry-run/apply: getImpact devuelve plan_digest; recalcApply exige el
 *     digest y responde PLAN_CHANGED si difiere; multi-fecha last-write-wins;
 *   · dry-run compara los 8 campos mutables + reporta fuera de rango;
 *   · fecha civil real (rechaza 2025-02-30);
 *   · GO/NO-GO backend en forward/enable y recalc/apply;
 *   · máquina de estados prepared→applying→applied (nunca applied antes);
 *   · restore verifica conteo y no marca restored ante ejecución parcial.
 */

jest.mock('../src/config/database', () => {
  const query = jest.fn();
  const transaction = jest.fn(async () => ({ commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}) }));
  return { sequelize: { query, transaction }, DB_TIMEZONE: '-03:00' };
});

const mockResolveBatch = jest.fn();
jest.mock('../src/services/workdaySummaryService', () => {
  const actual = jest.requireActual('../src/services/workdaySummaryService');
  return { ...actual, resolveSummaryBatchForDate: (...a) => mockResolveBatch(...a) };
});

const { sequelize } = require('../src/config/database');
const svc = require('../src/services/faseEConsoleService');

beforeEach(() => {
  sequelize.query.mockReset();
  sequelize.transaction.mockClear();
  mockResolveBatch.mockReset();
});

function motorRow(date, over = {}) {
  return { date, first_in: null, last_out: null, worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null, ...over };
}

function installQueryMock(cfg = {}) {
  const c = {
    employees: [{ id: 1 }, { id: 2 }],
    storedRows: [],
    migrationsRecorded: ['072_employee_schedule_history.sql', '073_workday_profile_and_overlap_guard.sql', '074_daily_summary_status_unknown.sql', '075_workday_configuration_phase_c.sql', '083_fase_e_activation_console.sql'],
    has074: true,
    tablesExist: { schema_migrations: true, daily_summary: true, daily_summary_recalc_batch: true, daily_summary_backup: true, fase_e_console_lock: true, employee_schedule_history: true },
    lockAcquired: true,
    heartbeatOk: true,
    overlapBatch: null,
    batchRecord: undefined,
    backupRows: [],
    backupCount: undefined,
    ...cfg,
  };
  const events = c.events || [];
  let backupInserted = 0; // filas de backup insertadas (para el conteo del recalc)
  sequelize.query.mockImplementation(async (sql, opt) => {
    const p = (opt && opt.replacements) || [];
    if (/INFORMATION_SCHEMA\.TABLES/i.test(sql)) return [c.tablesExist[p[0]] ? [{ ok: 1 }] : []];
    if (/SELECT filename FROM schema_migrations WHERE filename IN/i.test(sql)) {
      const set = new Set(c.migrationsRecorded);
      return [p.filter((f) => set.has(f)).map((f) => ({ filename: f }))];
    }
    if (/INFORMATION_SCHEMA\.COLUMNS/i.test(sql) && /daily_summary/i.test(sql)) {
      return [[{ type: c.has074 ? "enum('present','absent','late','weekend','holiday','permission','non_working','unconfigured')" : "enum('present','absent','late','weekend','holiday','permission')" }]];
    }
    if (/COUNT\(\*\) AS n FROM employee_schedule_history/i.test(sql)) return [[{ n: 0 }]];
    // lock con token
    if (/UPDATE fase_e_console_lock/i.test(sql) && /SET lock_token = \?/i.test(sql)) { events.push('lock.acquire'); return [{ affectedRows: c.lockAcquired ? 1 : 0 }]; }
    if (/UPDATE fase_e_console_lock/i.test(sql) && /SET lease_expires_at/i.test(sql)) { events.push('lock.heartbeat'); return [{ affectedRows: c.heartbeatOk ? 1 : 0 }]; }
    if (/UPDATE fase_e_console_lock/i.test(sql) && /SET lock_token = NULL/i.test(sql)) { events.push('lock.release'); return [{ affectedRows: 1 }]; }
    if (/FROM employees WHERE status = 'active'/i.test(sql)) return [c.employees];
    if (/FROM employees WHERE department_id/i.test(sql)) return [c.employees];
    if (/FROM daily_summary_recalc_batch\s+WHERE status <> 'restored'/i.test(sql)) return [c.overlapBatch ? [c.overlapBatch] : []];
    if (/FROM daily_summary\b/i.test(sql) && /date >= \? AND date <= \?/i.test(sql)) return [c.storedRows];
    if (/INSERT INTO daily_summary_recalc_batch/i.test(sql)) { events.push('header.prepared'); return [{ affectedRows: 1 }]; }
    if (/UPDATE daily_summary_recalc_batch SET status = 'applying'/i.test(sql)) { events.push('status.applying'); return [{ affectedRows: 1 }]; }
    if (/UPDATE daily_summary_recalc_batch SET status = 'applied'/i.test(sql)) { events.push('status.applied'); return [{ affectedRows: 1 }]; }
    if (/UPDATE daily_summary_recalc_batch SET status = 'failed'/i.test(sql)) { events.push('status.failed'); return [{ affectedRows: 1 }]; }
    if (/INSERT INTO daily_summary_backup/i.test(sql)) { events.push('backup'); backupInserted += Math.floor(p.length / 13); return [{ affectedRows: 1 }]; }
    if (/COUNT\(\*\) AS n FROM daily_summary_backup/i.test(sql)) return [[{ n: c.backupCount != null ? c.backupCount : (backupInserted || c.backupRows.length) }]];
    if (/SELECT batch_id, status, rows_backed_up FROM daily_summary_recalc_batch/i.test(sql)) return [c.batchRecord ? [c.batchRecord] : []];
    if (/FROM daily_summary_backup WHERE batch_id/i.test(sql)) return [c.backupRows];
    if (/UPDATE daily_summary_recalc_batch SET status = 'restored'/i.test(sql)) { events.push('status.restored'); return [{ affectedRows: 1 }]; }
    if (/INSERT INTO daily_summary\b/i.test(sql)) { events.push('ds.upsert'); return [{ affectedRows: 1 }]; }
    if (/DELETE FROM daily_summary\b/i.test(sql)) { events.push('ds.delete'); return [{ affectedRows: 1 }]; }
    return [[]];
  });
  return { c, events };
}

describe('[P1-B] scope estricto — nunca cae a all', () => {
  test.each([['""', ''], ['null', null], ['false', false], ['0', 0], ['undefined', undefined], ['"garbage"', 'garbage']])(
    'recalcApply con scope %s → INVALID_SCOPE sin consultar empleados ni escribir', async (_label, val) => {
      installQueryMock();
      await expect(svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: val, planDigestExpected: 'x' }))
        .rejects.toMatchObject({ code: 'INVALID_SCOPE' });
      // no consultó empleados, no tomó lock, no llamó al motor
      expect(mockResolveBatch).not.toHaveBeenCalled();
      const q = sequelize.query.mock.calls.map((cc) => cc[0]).join('\n');
      expect(/FROM employees/i.test(q)).toBe(false);
      expect(/SET lock_token = \?/i.test(q)).toBe(false);
    });
  test.each([['""', ''], ['null', null], ['false', false], ['0', 0]])('getImpact con scope %s → INVALID_SCOPE', async (_l, val) => {
    installQueryMock();
    await expect(svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: val })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
  });
});

describe('[P1-F] paridad dry-run/apply con plan_digest', () => {
  test('el digest del dry-run habilita el apply; un digest viejo → PLAN_CHANGED', async () => {
    const setup = () => installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    setup();
    mockResolveBatch.mockImplementation(async (_ids, d, opts) => {
      if (opts && opts.apply) return { rowsByEmployee: new Map() };
      return { rowsByEmployee: new Map([[1, [motorRow(d)]]]) };
    });
    const imp = await svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' });
    expect(typeof imp.plan_digest).toBe('string');
    expect(imp.plan_digest).toHaveLength(64);

    setup();
    const out = await svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', planDigestExpected: imp.plan_digest });
    expect(out.status).toBe('applied');
    expect(out.plan_digest).toBe(imp.plan_digest);

    setup();
    await expect(svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', planDigestExpected: 'deadbeef' }))
      .rejects.toMatchObject({ code: 'PLAN_CHANGED', status: 409 });

    setup();
    await expect(svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', planDigestExpected: null }))
      .rejects.toMatchObject({ code: 'PLAN_DIGEST_REQUIRED' });
  });

  test('multi-fecha: una celda en dos ventanas con resultados distintos → last-write-wins estable', async () => {
    // Al evaluar 2025-01-10, el motor toca 01-09 y 01-10 (worked 100).
    // Al evaluar 2025-01-11, toca 01-10 (worked 999, distinto!) y 01-11.
    // buildPlan itera ascendente → gana la 2ª computación de (1,01-10): 999.
    installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(async (_ids, d, opts) => {
      if (opts && opts.apply) return { rowsByEmployee: new Map() };
      if (d === '2025-01-10') return { rowsByEmployee: new Map([[1, [motorRow('2025-01-09', { worked_minutes: 50 }), motorRow('2025-01-10', { worked_minutes: 100 })]]]) };
      return { rowsByEmployee: new Map([[1, [motorRow('2025-01-10', { worked_minutes: 999 }), motorRow('2025-01-11', { worked_minutes: 70 })]]]) };
    });
    const { plan } = await svc.buildPlan([1], '2025-01-10', '2025-01-11');
    expect(plan.get('1|2025-01-10').worked_minutes).toBe(999); // last-write-wins
    const d1 = svc.planDigest(plan);
    // reconstruir con el mismo mock → mismo digest (estable)
    const { plan: plan2 } = await svc.buildPlan([1], '2025-01-10', '2025-01-11');
    expect(svc.planDigest(plan2)).toBe(d1);
  });
});

describe('[P1-D/estados] recalcApply — backup antes de escribir + máquina de estados', () => {
  test('prepared→applying→applied; heartbeat del lock; backup en transacción', async () => {
    const motor = async (_ids, d, opts) => {
      if (opts && opts.apply) return { rowsByEmployee: new Map() };
      return { rowsByEmployee: new Map([[1, [motorRow(d)]]]) };
    };
    // 1º dry-run para obtener el digest (mock sin registro de eventos).
    installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(motor);
    const imp = await svc.getImpact({ from: '2025-01-10', to: '2025-01-11', scopeKind: 'all' });
    // 2º apply con un mock nuevo que registra el orden de eventos.
    const events = [];
    installQueryMock({ events, employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(async (_ids, d, opts) => {
      if (opts && opts.apply) { events.push('apply'); return { rowsByEmployee: new Map() }; }
      return { rowsByEmployee: new Map([[1, [motorRow(d)]]]) };
    });
    const out = await svc.recalcApply({ from: '2025-01-10', to: '2025-01-11', scopeKind: 'all', planDigestExpected: imp.plan_digest });
    expect(out.status).toBe('applied');
    // header y backup ocurren en transacción, ANTES del primer apply.
    expect(events.indexOf('header.prepared')).toBeLessThan(events.indexOf('apply'));
    expect(events.indexOf('backup')).toBeLessThan(events.indexOf('apply'));
    expect(events.indexOf('status.applying')).toBeLessThan(events.indexOf('apply'));
    expect(events.indexOf('status.applied')).toBeGreaterThan(events.lastIndexOf('apply'));
    // se usó transacción y hubo heartbeat por fecha.
    expect(sequelize.transaction).toHaveBeenCalled();
    expect(events.filter((e) => e === 'lock.heartbeat').length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1]).toBe('lock.release');
  });

  test('lock ocupado → CONSOLE_BUSY (unidad; el caso real está en IT)', async () => {
    installQueryMock({ lockAcquired: false, employees: [{ id: 1 }] });
    mockResolveBatch.mockResolvedValue({ rowsByEmployee: new Map() });
    await expect(svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', planDigestExpected: 'x' }))
      .rejects.toMatchObject({ code: 'CONSOLE_BUSY' });
  });

  test('esquema incompleto (074) → NO_GO; rango/fecha inválidos rechazados', async () => {
    installQueryMock({ has074: false });
    await expect(svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', planDigestExpected: 'x' }))
      .rejects.toMatchObject({ code: 'NO_GO_SCHEMA_INCOMPLETE' });
    installQueryMock();
    await expect(svc.recalcApply({ from: '2025-02-30', to: '2025-02-30', scopeKind: 'all', planDigestExpected: 'x' }))
      .rejects.toMatchObject({ code: 'INVALID_RANGE' }); // fecha civil irreal
  });
});

describe('[P1-E] restore verificado + transaccional', () => {
  test('conteo != rows_backed_up → BACKUP_COUNT_MISMATCH; no marca restored', async () => {
    const events = [];
    installQueryMock({ events, batchRecord: { batch_id: 'B1', status: 'applied', rows_backed_up: 3 }, backupRows: [{ employee_id: 1, date: '2025-01-10', existed: 1 }], backupCount: 1 });
    await expect(svc.restoreBatch({ batchId: 'B1' })).rejects.toMatchObject({ code: 'BACKUP_COUNT_MISMATCH' });
    expect(events).not.toContain('status.restored');
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });
  test('restore completo en transacción: upsert/delete + restored', async () => {
    const events = [];
    installQueryMock({ events, batchRecord: { batch_id: 'B1', status: 'applied', rows_backed_up: 2 }, backupRows: [
      { employee_id: 1, date: '2025-01-10', existed: 1, worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null },
      { employee_id: 2, date: '2025-01-10', existed: 0 },
    ] });
    const out = await svc.restoreBatch({ batchId: 'B1', userId: 9 });
    expect(out.status).toBe('restored');
    expect(out.rows_restored).toBe(1);
    expect(out.rows_deleted).toBe(1);
    expect(sequelize.transaction).toHaveBeenCalledTimes(1);
    expect(events).toContain('status.restored');
  });
  test('fallo a mitad → rollback, NO marca restored (reintentable)', async () => {
    const events = [];
    const { c } = installQueryMock({ events, batchRecord: { batch_id: 'B1', status: 'applied', rows_backed_up: 2 }, backupRows: [
      { employee_id: 1, date: '2025-01-10', existed: 1, worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null },
      { employee_id: 2, date: '2025-01-11', existed: 1, worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null },
    ] });
    const rollback = jest.fn(async () => {});
    sequelize.transaction.mockResolvedValueOnce({ commit: jest.fn(async () => {}), rollback });
    let upserts = 0;
    const prev = sequelize.query.getMockImplementation();
    sequelize.query.mockImplementation(async (sql, opt) => {
      if (/INSERT INTO daily_summary\b/i.test(sql)) { upserts++; if (upserts === 2) throw new Error('fallo a mitad del restore'); }
      return prev(sql, opt);
    });
    await expect(svc.restoreBatch({ batchId: 'B1' })).rejects.toThrow(/a mitad/);
    expect(rollback).toHaveBeenCalled();
    expect(events).not.toContain('status.restored');
    expect(c).toBeDefined();
  });
  test('lote ya restaurado / inexistente / no restaurable', async () => {
    installQueryMock({ batchRecord: { batch_id: 'B1', status: 'restored', rows_backed_up: 0 } });
    await expect(svc.restoreBatch({ batchId: 'B1' })).rejects.toMatchObject({ code: 'BATCH_ALREADY_RESTORED' });
    installQueryMock({ batchRecord: undefined });
    await expect(svc.restoreBatch({ batchId: 'x' })).rejects.toMatchObject({ code: 'BATCH_NOT_FOUND' });
    installQueryMock({ batchRecord: { batch_id: 'B1', status: 'applying', rows_backed_up: 0 } });
    await expect(svc.restoreBatch({ batchId: 'B1' })).rejects.toMatchObject({ code: 'BATCH_NOT_RESTORABLE' });
  });
});

describe('[P1-A datos] dry-run: 8 campos + fuera de rango', () => {
  test('detecta overtime/break/notes; reporta fecha from-1 fuera de rango', async () => {
    installQueryMock({ employees: [{ id: 1 }], storedRows: [
      { employee_id: 1, date: '2025-01-10', first_in: null, last_out: null, worked_minutes: 480, break_minutes: 30, late_minutes: 0, overtime_minutes: 60, status: 'present', notes: 'viejo' },
    ] });
    mockResolveBatch.mockImplementation(async (_ids, d) => ({
      rowsByEmployee: new Map([[1, [motorRow('2025-01-09'), motorRow('2025-01-10', { break_minutes: 0, overtime_minutes: 0, notes: null })]]]),
    }));
    const rep = await svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' });
    expect(rep.cells_evaluated).toBe(2);
    expect(rep.dates_outside_range).toContain('2025-01-09');
    expect(rep.rows_differ_outside_range).toBe(1);
    const ex = rep.examples.find((e) => e.date === '2025-01-10');
    expect(ex.changed_fields.sort()).toEqual(['break_minutes', 'notes', 'overtime_minutes']);
    const wrote = sequelize.query.mock.calls.some((cc) => /(INSERT INTO|UPDATE|DELETE FROM)\s+daily_summary\b/i.test(cc[0]));
    expect(wrote).toBe(false);
  });
});

describe('setForwardEnabled — GO/NO-GO en enable, no en disable', () => {
  test('enable con esquema incompleto → NO_GO; disable siempre pasa', async () => {
    installQueryMock({ migrationsRecorded: ['072_employee_schedule_history.sql'] });
    await expect(svc.setForwardEnabled(true)).rejects.toMatchObject({ code: 'NO_GO_SCHEMA_INCOMPLETE' });
    installQueryMock({ has074: false });
    const off = await svc.setForwardEnabled(false);
    expect(off.forward_db_setting).toBe(false);
  });
});

describe('isRealCivilDate [P2]', () => {
  test('rechaza fechas irreales aunque cumplan el patrón', () => {
    expect(svc.isRealCivilDate('2025-01-31')).toBe(true);
    expect(svc.isRealCivilDate('2025-02-30')).toBe(false);
    expect(svc.isRealCivilDate('2025-13-01')).toBe(false);
    expect(svc.isRealCivilDate('2025-00-10')).toBe(false);
    expect(svc.isRealCivilDate('not-a-date')).toBe(false);
  });
});

describe('master-flag', () => {
  const orig = process.env.FASE_E_ACTIVATION_ENABLED;
  afterEach(() => { if (orig === undefined) delete process.env.FASE_E_ACTIVATION_ENABLED; else process.env.FASE_E_ACTIVATION_ENABLED = orig; });
  test('default OFF; sólo "true" habilita', () => {
    delete process.env.FASE_E_ACTIVATION_ENABLED;
    expect(svc.isActivationEnabled()).toBe(false);
    process.env.FASE_E_ACTIVATION_ENABLED = 'true';
    expect(svc.isActivationEnabled()).toBe(true);
  });
});
