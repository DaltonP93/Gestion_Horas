/**
 * faseEConsoleService.test.js — lógica de la consola de FASE E (mockeada).
 *
 * Las pruebas REALES de lock supervisado (concurrencia/expiración/heartbeat>TTL),
 * backup atómico vía recalcApply y restore transaccional/reintentable viven en
 * tests/it/faseEConsole.it.test.js (MySQL efímero, IT_DB=1). Acá se cubre la
 * lógica pura/mockeada:
 *   · scope_kind estricto: "", null, false, 0, undefined → INVALID_SCOPE sin
 *     consultar empleados ni escribir;
 *   · [P1-F] paridad dry-run/apply con digest CANÓNICO: getImpact devuelve
 *     plan_digest; recalcApply exige el digest, ESCRIBE EL PLAN VALIDADO con el
 *     ÚNICO escritor (applyResolvedRows) y NUNCA recomputa (apply:true) el motor;
 *     drift de asistencia/config O del estado previo → PLAN_CHANGED;
 *   · multi-fecha last-write-wins estable;
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
const mockApplyResolved = jest.fn(async () => {});
jest.mock('../src/services/workdaySummaryService', () => {
  const actual = jest.requireActual('../src/services/workdaySummaryService');
  return {
    ...actual,
    resolveSummaryBatchForDate: (...a) => mockResolveBatch(...a),
    // [P1-F] la primitiva que la consola usa para escribir el plan validado.
    applyResolvedRows: (...a) => mockApplyResolved(...a),
  };
});

const { sequelize } = require('../src/config/database');
const svc = require('../src/services/faseEConsoleService');

beforeEach(() => {
  sequelize.query.mockReset();
  sequelize.transaction.mockClear();
  mockResolveBatch.mockReset();
  mockApplyResolved.mockReset();
  mockApplyResolved.mockImplementation(async () => {});
});

function motorRow(date, over = {}) {
  return { date, first_in: null, last_out: null, worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null, workday_count: 1, ...over };
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
    if (/UPDATE fase_e_console_lock/i.test(sql) && /heartbeat_seq = heartbeat_seq \+ 1/i.test(sql)) { events.push('lock.heartbeat'); return [{ affectedRows: c.heartbeatOk ? 1 : 0 }]; }
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

/** Motor mock read-only (apply:false); si alguien pide apply:true, lo marca. */
function motorReadOnly(rowsFor) {
  return async (_ids, d, opts) => {
    if (opts && opts.apply === true) throw new Error('SEGUNDO_RECALCULO_PROHIBIDO'); // apply:true nunca debe ocurrir
    return { rowsByEmployee: rowsFor(d) };
  };
}

describe('[P1-B] scope estricto — nunca cae a all', () => {
  test.each([['""', ''], ['null', null], ['false', false], ['0', 0], ['undefined', undefined], ['"garbage"', 'garbage']])(
    'recalcApply con scope %s → INVALID_SCOPE sin consultar empleados ni escribir', async (_label, val) => {
      installQueryMock();
      await expect(svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: val, planDigestExpected: 'x' }))
        .rejects.toMatchObject({ code: 'INVALID_SCOPE' });
      // no consultó empleados, no tomó lock, no llamó al motor ni al escritor
      expect(mockResolveBatch).not.toHaveBeenCalled();
      expect(mockApplyResolved).not.toHaveBeenCalled();
      const q = sequelize.query.mock.calls.map((cc) => cc[0]).join('\n');
      expect(/FROM employees/i.test(q)).toBe(false);
      expect(/SET lock_token = \?/i.test(q)).toBe(false);
    });
  test.each([['""', ''], ['null', null], ['false', false], ['0', 0]])('getImpact con scope %s → INVALID_SCOPE', async (_l, val) => {
    installQueryMock();
    await expect(svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: val })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
  });
});

describe('[P1-F] paridad dry-run/apply con digest canónico', () => {
  test('el digest del dry-run habilita el apply; digest viejo → PLAN_CHANGED; falta → PLAN_DIGEST_REQUIRED', async () => {
    const rowsFor = (d) => new Map([[1, [motorRow(d)]]]);
    const setup = () => installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    setup();
    mockResolveBatch.mockImplementation(motorReadOnly(rowsFor));
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

  test('apply ESCRIBE el plan validado con el escritor y NUNCA recomputa (apply:true)', async () => {
    const rowsFor = (d) => new Map([[1, [motorRow(d, { worked_minutes: 321 })]]]);
    installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(motorReadOnly(rowsFor));
    const imp = await svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' });

    installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(motorReadOnly(rowsFor));
    const out = await svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', planDigestExpected: imp.plan_digest });

    expect(out.status).toBe('applied');
    // el motor SÓLO se llamó en modo lectura (apply:false); jamás apply:true.
    expect(mockResolveBatch.mock.calls.every((cc) => !(cc[2] && cc[2].apply === true))).toBe(true);
    // se escribió exactamente el plan (una fila para el empleado 1) con la primitiva.
    expect(mockApplyResolved).toHaveBeenCalledTimes(1);
    const [emp, rows] = mockApplyResolved.mock.calls[0];
    expect(emp).toBe(1);
    expect(rows).toEqual([expect.objectContaining({ date: '2025-01-10', worked_minutes: 321 })]);
    expect(out.rows_written).toBe(1);
  });

  test('[P1-F] drift del ESTADO PREVIO de daily_summary entre dry-run y apply → PLAN_CHANGED, sin escribir', async () => {
    const rowsFor = (d) => new Map([[1, [motorRow(d)]]]);
    // dry-run con daily_summary vacío.
    installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(motorReadOnly(rowsFor));
    const imp = await svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' });

    // apply con una fila previa NUEVA (alguien editó daily_summary): el prev cambia
    // → el digest canónico difiere → PLAN_CHANGED antes de escribir.
    installQueryMock({ employees: [{ id: 1 }], storedRows: [
      { employee_id: 1, date: '2025-01-10', first_in: null, last_out: null, worked_minutes: 10, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null },
    ] });
    mockResolveBatch.mockImplementation(motorReadOnly(rowsFor));
    await expect(svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', planDigestExpected: imp.plan_digest }))
      .rejects.toMatchObject({ code: 'PLAN_CHANGED' });
    expect(mockApplyResolved).not.toHaveBeenCalled();
  });

  test('multi-fecha: una celda en dos ventanas con resultados distintos → last-write-wins estable', async () => {
    installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(motorReadOnly((d) => {
      if (d === '2025-01-10') return new Map([[1, [motorRow('2025-01-09', { worked_minutes: 50 }), motorRow('2025-01-10', { worked_minutes: 100 })]]]);
      return new Map([[1, [motorRow('2025-01-10', { worked_minutes: 999 }), motorRow('2025-01-11', { worked_minutes: 70 })]]]);
    }));
    const { plan, existing } = await svc.buildPlan([1], '2025-01-10', '2025-01-11');
    expect(plan.get('1|2025-01-10').norm.worked_minutes).toBe(999); // last-write-wins
    expect(plan.get('1|2025-01-10').row.worked_minutes).toBe(999);  // fila engine conservada
    const canon = svc.canonicalPlan({ from: '2025-01-10', to: '2025-01-11', scopeKind: 'all', scopeId: null, ids: [1], plan, existing });
    const d1 = svc.planDigest(canon);
    // reconstruir con el mismo mock → mismo digest (estable)
    const { plan: plan2, existing: ex2 } = await svc.buildPlan([1], '2025-01-10', '2025-01-11');
    const d2 = svc.planDigest(svc.canonicalPlan({ from: '2025-01-10', to: '2025-01-11', scopeKind: 'all', scopeId: null, ids: [1], plan: plan2, existing: ex2 }));
    expect(d2).toBe(d1);
  });

  test('[P1-F] el digest cambia si cambia el alcance de empleados', async () => {
    const rowsFor = (d) => new Map([[1, [motorRow(d)]], [2, [motorRow(d)]]]);
    installQueryMock({ employees: [{ id: 1 }, { id: 2 }], storedRows: [] });
    mockResolveBatch.mockImplementation(motorReadOnly(rowsFor));
    const { plan, existing } = await svc.buildPlan([1, 2], '2025-01-10', '2025-01-10');
    const dTwo = svc.planDigest(svc.canonicalPlan({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', scopeId: null, ids: [1, 2], plan, existing }));
    const dOne = svc.planDigest(svc.canonicalPlan({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', scopeId: null, ids: [1], plan, existing }));
    expect(dOne).not.toBe(dTwo); // el conjunto de empleados forma parte del digest
  });
});

describe('[P1-D/estados] recalcApply — backup antes de escribir + máquina de estados', () => {
  test('prepared→applying→(escritura del plan)→applied; backup en transacción; release al final', async () => {
    const rowsFor = (d) => new Map([[1, [motorRow(d)]]]);
    installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(motorReadOnly(rowsFor));
    const imp = await svc.getImpact({ from: '2025-01-10', to: '2025-01-11', scopeKind: 'all' });

    const events = [];
    installQueryMock({ events, employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(motorReadOnly(rowsFor));
    mockApplyResolved.mockImplementation(async () => { events.push('write'); });
    const out = await svc.recalcApply({ from: '2025-01-10', to: '2025-01-11', scopeKind: 'all', planDigestExpected: imp.plan_digest });
    expect(out.status).toBe('applied');
    // header y backup ocurren en transacción, ANTES de la primera escritura del plan.
    expect(events.indexOf('header.prepared')).toBeLessThan(events.indexOf('write'));
    expect(events.indexOf('backup')).toBeLessThan(events.indexOf('write'));
    expect(events.indexOf('status.applying')).toBeLessThan(events.indexOf('write'));
    expect(events.indexOf('status.applied')).toBeGreaterThan(events.lastIndexOf('write'));
    expect(sequelize.transaction).toHaveBeenCalled();
    // el lock se libera al final (el heartbeat es un supervisor de 2º plano, se
    // prueba en IT — no dispara en un test rápido).
    expect(events[events.length - 1]).toBe('lock.release');
  });

  test('lock ocupado → CONSOLE_BUSY (unidad; el caso real está en IT)', async () => {
    installQueryMock({ lockAcquired: false, employees: [{ id: 1 }] });
    mockResolveBatch.mockImplementation(motorReadOnly((d) => new Map([[1, [motorRow(d)]]])));
    await expect(svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', planDigestExpected: 'x' }))
      .rejects.toMatchObject({ code: 'CONSOLE_BUSY' });
    expect(mockApplyResolved).not.toHaveBeenCalled();
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
    mockResolveBatch.mockImplementation(motorReadOnly((d) => new Map([[1, [motorRow('2025-01-09'), motorRow('2025-01-10', { break_minutes: 0, overtime_minutes: 0, notes: null })]]])));
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
