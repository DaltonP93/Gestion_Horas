/**
 * faseEConsoleService.test.js — lógica de la consola de FASE E (mockeada).
 *
 * Las pruebas REALES de concurrencia (co-lock por fecha + FOR UPDATE, fencing
 * DB-side del lease, backup atómico, restore seguro, conteos) viven en
 * tests/it/faseEConsole.it.test.js (MySQL efímero, IT_DB=1, con barreras
 * deterministas). Acá se cubre la lógica pura/mockeada:
 *   · scope_kind estricto → INVALID_SCOPE sin consultar ni escribir;
 *   · [B3] resultado EFECTIVO en preview/digest (misma función pura del writer);
 *   · [P1-F] digest CANÓNICO: getImpact lo devuelve; recalcApply lo exige y responde
 *     PLAN_CHANGED si difiere; multi-fecha last-write-wins;
 *   · [B1] apply NO recomputa el motor (apply:true) y escribe vía applyEffectiveWrite;
 *   · [B4] conteos inequívocos (inserted/updated/deleted/unchanged);
 *   · GO/NO-GO, fecha civil real, restore validado.
 */

jest.mock('../src/config/database', () => {
  const query = jest.fn();
  // transacción en forma de CALLBACK: corre el cuerpo con t='TX' y propaga errores
  // (rollback real). También soporta la forma imperativa por compat.
  const transaction = jest.fn(async (cb) => (typeof cb === 'function'
    ? cb('TX')
    : { commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}) }));
  return { sequelize: { query, transaction }, DB_TIMEZONE: '-03:00' };
});

const mockResolveBatch = jest.fn();
jest.mock('../src/services/workdaySummaryService', () => {
  const actual = jest.requireActual('../src/services/workdaySummaryService');
  // Sólo el motor (lectura) se mockea; effectiveDailySummary/classifyEffective/
  // readDailySummaryRow/applyEffectiveWrite son REALES (corren contra el mock de sequelize).
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
  return { date, first_in: null, last_out: null, worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null, workday_count: 1, ...over };
}
/** Motor mock read-only (apply:false); apply:true nunca debe ocurrir. */
function motorReadOnly(rowsFor) {
  return async (_ids, d, opts) => {
    if (opts && opts.apply === true) throw new Error('SEGUNDO_RECALCULO_PROHIBIDO');
    return { rowsByEmployee: rowsFor(d) };
  };
}

function installQueryMock(cfg = {}) {
  const c = {
    employees: [{ id: 1 }, { id: 2 }],
    storedRows: [],           // filas previas de daily_summary (snapshot)
    migrationsRecorded: ['072_employee_schedule_history.sql', '073_workday_profile_and_overlap_guard.sql', '074_daily_summary_status_unknown.sql', '075_workday_configuration_phase_c.sql', '083_fase_e_activation_console.sql'],
    has074: true,
    tablesExist: { schema_migrations: true, daily_summary: true, daily_summary_recalc_batch: true, daily_summary_backup: true, fase_e_console_lock: true, employee_schedule_history: true },
    lockAcquired: true,
    overlapBatch: null,
    batchRecord: undefined,
    backupRows: [],
    backupCount: undefined,
    ...cfg,
  };
  const events = c.events || [];
  const storedByCell = new Map();
  for (const r of c.storedRows) storedByCell.set(`${r.employee_id}|${r.date}`, r);
  let heldToken = null;
  let backupInserted = 0;
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
    // lock de consola (acquire captura el token; heartbeat/release; fence lee el token)
    if (/UPDATE fase_e_console_lock/i.test(sql) && /SET lock_token = \?/i.test(sql)) { events.push('lock.acquire'); if (c.lockAcquired) heldToken = p[0]; return [{ affectedRows: c.lockAcquired ? 1 : 0 }]; }
    if (/UPDATE fase_e_console_lock/i.test(sql) && /heartbeat_seq = heartbeat_seq \+ 1/i.test(sql)) { events.push('lock.heartbeat'); return [{ affectedRows: 1 }]; }
    if (/UPDATE fase_e_console_lock/i.test(sql) && /SET lock_token = NULL/i.test(sql)) { events.push('lock.release'); heldToken = null; return [{ affectedRows: 1 }]; }
    if (/SELECT lock_token FROM fase_e_console_lock/i.test(sql)) { events.push('lease.fence'); return [[{ lock_token: c.stolen ? 'OTRO' : heldToken }]]; }
    // locks por fecha compartidos
    if (/GET_LOCK/i.test(sql)) { events.push('date.lock'); return [[{ ok: 1 }]]; }
    if (/RELEASE_LOCK/i.test(sql)) { events.push('date.release'); return [[{}]]; }
    if (/FROM employees WHERE status = 'active'/i.test(sql)) return [c.employees];
    if (/FROM employees WHERE department_id/i.test(sql)) return [c.employees];
    if (/FROM daily_summary_recalc_batch\s+WHERE status <> 'restored'/i.test(sql)) return [c.overlapBatch ? [c.overlapBatch] : []];
    // re-lectura FOR UPDATE (bajo el lock) por celda
    if (/FROM daily_summary WHERE employee_id = \? AND date = \? FOR UPDATE/i.test(sql)) {
      const row = storedByCell.get(`${p[0]}|${p[1]}`);
      return [row ? [row] : []];
    }
    // snapshot del rango (loadExistingRows)
    if (/FROM daily_summary\b/i.test(sql) && /date >= \? AND date <= \?/i.test(sql)) return [c.storedRows];
    if (/INSERT INTO daily_summary_recalc_batch/i.test(sql)) { events.push('header'); return [{ affectedRows: 1 }]; }
    if (/INSERT INTO daily_summary_backup/i.test(sql)) { events.push('backup'); backupInserted += 1; return [{ affectedRows: 1 }]; }
    if (/COUNT\(\*\) AS n FROM daily_summary_backup/i.test(sql)) return [[{ n: c.backupCount != null ? c.backupCount : (backupInserted || c.backupRows.length) }]];
    if (/SELECT batch_id, status, rows_backed_up FROM daily_summary_recalc_batch/i.test(sql)) return [c.batchRecord ? [c.batchRecord] : []];
    if (/FROM daily_summary_backup WHERE batch_id/i.test(sql)) return [c.backupRows];
    if (/UPDATE daily_summary_recalc_batch SET status = 'restored'/i.test(sql)) { events.push('restored'); return [{ affectedRows: 1 }]; }
    if (/INSERT INTO daily_summary\b/i.test(sql)) { events.push('ds.upsert'); return [{ affectedRows: 1 }]; }
    if (/UPDATE daily_summary SET/i.test(sql)) { events.push('ds.update'); return [{ affectedRows: 1 }]; }
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
      expect(mockResolveBatch).not.toHaveBeenCalled();
      const q = sequelize.query.mock.calls.map((cc) => cc[0]).join('\n');
      expect(/FROM employees/i.test(q)).toBe(false);
      expect(/SET lock_token = \?/i.test(q)).toBe(false);
    });
  test.each([['""', ''], ['null', null]])('getImpact con scope %s → INVALID_SCOPE', async (_l, val) => {
    installQueryMock();
    await expect(svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: val })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
  });
});

describe('[P1-F] digest canónico dry-run ↔ apply', () => {
  const rowsFor = (d) => new Map([[1, [motorRow(d)]]]);

  test('el digest del dry-run habilita el apply; digest viejo → PLAN_CHANGED; falta → PLAN_DIGEST_REQUIRED', async () => {
    const setup = () => { installQueryMock({ employees: [{ id: 1 }], storedRows: [] }); mockResolveBatch.mockImplementation(motorReadOnly(rowsFor)); };
    setup();
    const imp = await svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' });
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

  test('[B1] apply NO recomputa el motor (apply:true) y escribe vía applyEffectiveWrite bajo el lock; conteos correctos', async () => {
    installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(motorReadOnly(rowsFor));
    const imp = await svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' });

    const { events } = installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(motorReadOnly(rowsFor));
    const out = await svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', planDigestExpected: imp.plan_digest });

    expect(out.status).toBe('applied');
    // el motor SÓLO en modo lectura
    expect(mockResolveBatch.mock.calls.every((cc) => !(cc[2] && cc[2].apply === true))).toBe(true);
    // se tomó el lock por fecha + fence del lease + backup + escritura, en ese orden lógico
    expect(events).toContain('date.lock');
    expect(events).toContain('lease.fence');
    expect(events).toContain('backup');
    expect(events).toContain('ds.upsert'); // insert de una fila nueva (no había prev)
    // conteos inequívocos: 1 celda nueva → inserted
    expect(out.cells_processed).toBe(1);
    expect(out.rows_inserted).toBe(1);
    expect(out.rows_updated).toBe(0);
    expect(out.rows_deleted).toBe(0);
    expect(out.rows_unchanged).toBe(0);
    expect(out.rows_written).toBe(1);
    expect(out.rows_backed_up).toBe(1);
    expect(events[events.length - 1]).toBe('lock.release');
  });

  test('multi-fecha: una celda en dos ventanas con resultados distintos → last-write-wins estable', async () => {
    installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(motorReadOnly((d) => {
      if (d === '2025-01-10') return new Map([[1, [motorRow('2025-01-09', { worked_minutes: 50 }), motorRow('2025-01-10', { worked_minutes: 100 })]]]);
      return new Map([[1, [motorRow('2025-01-10', { worked_minutes: 999 }), motorRow('2025-01-11', { worked_minutes: 70 })]]]);
    }));
    const { plan, existing } = await svc.buildPlan([1], '2025-01-10', '2025-01-11');
    expect(plan.get('1|2025-01-10').row.worked_minutes).toBe(999); // last-write-wins (fila engine conservada)
    const d1 = svc.planDigest(svc.canonicalPlan({ from: '2025-01-10', to: '2025-01-11', scopeKind: 'all', scopeId: null, ids: [1], plan, existing }));
    const { plan: p2, existing: e2 } = await svc.buildPlan([1], '2025-01-10', '2025-01-11');
    const d2 = svc.planDigest(svc.canonicalPlan({ from: '2025-01-10', to: '2025-01-11', scopeKind: 'all', scopeId: null, ids: [1], plan: p2, existing: e2 }));
    expect(d2).toBe(d1);
  });

  test('[B1] drift del prev bajo el lock (FOR UPDATE distinto del digestado) → PLAN_CHANGED', async () => {
    // dry-run con prev vacío
    installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(motorReadOnly(rowsFor));
    const imp = await svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' });
    // apply: el snapshot del rango sigue vacío (digest coincide) pero la RE-LECTURA
    // FOR UPDATE bajo el lock devuelve una fila nueva (otro writer la creó) → drift.
    const m = installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(motorReadOnly(rowsFor));
    // inyectar: la FOR UPDATE del 2025-01-10 devuelve una fila (cambio concurrente)
    const prev = sequelize.query.getMockImplementation();
    sequelize.query.mockImplementation(async (sql, opt) => {
      if (/FROM daily_summary WHERE employee_id = \? AND date = \? FOR UPDATE/i.test(sql) && opt.replacements[1] === '2025-01-10') {
        return [[{ first_in: null, last_out: null, worked_minutes: 7, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null, justification: null, justification_type: null }]];
      }
      return prev(sql, opt);
    });
    await expect(svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', planDigestExpected: imp.plan_digest }))
      .rejects.toMatchObject({ code: 'PLAN_CHANGED' });
    // no marcó header 'applied' (todo en una transacción; rollback)
    expect(m.events).not.toContain('header');
  });

  test('[B2] lease robado (token DB distinto) antes de escribir → LOCK_LOST, sin header', async () => {
    installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(motorReadOnly(rowsFor));
    const imp = await svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' });
    const m = installQueryMock({ employees: [{ id: 1 }], storedRows: [], stolen: true });
    mockResolveBatch.mockImplementation(motorReadOnly(rowsFor));
    await expect(svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', planDigestExpected: imp.plan_digest }))
      .rejects.toMatchObject({ code: 'LOCK_LOST' });
    expect(m.events).not.toContain('header');
  });
});

describe('[B4] conteos por categoría', () => {
  test('update-sin-cambio cuenta unchanged; update-con-cambio cuenta updated', async () => {
    // prev = exactamente lo que el motor produce (present/480) → unchanged
    const stored = { employee_id: 1, date: '2025-01-10', first_in: null, last_out: null, worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null, justification: null, justification_type: null };
    installQueryMock({ employees: [{ id: 1 }], storedRows: [stored] });
    mockResolveBatch.mockImplementation(motorReadOnly((d) => new Map([[1, [motorRow(d)]]])));
    const imp = await svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' });
    installQueryMock({ employees: [{ id: 1 }], storedRows: [stored] });
    mockResolveBatch.mockImplementation(motorReadOnly((d) => new Map([[1, [motorRow(d)]]])));
    const out = await svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', planDigestExpected: imp.plan_digest });
    expect(out.rows_unchanged).toBe(1);
    expect(out.rows_updated).toBe(0);
    expect(out.rows_written).toBe(0); // nada mutó
  });
});

describe('[GO/NO-GO] gates', () => {
  test('lock ocupado → CONSOLE_BUSY', async () => {
    installQueryMock({ lockAcquired: false, employees: [{ id: 1 }] });
    mockResolveBatch.mockImplementation(motorReadOnly((d) => new Map([[1, [motorRow(d)]]])));
    await expect(svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', planDigestExpected: 'x' }))
      .rejects.toMatchObject({ code: 'CONSOLE_BUSY' });
  });
  test('esquema incompleto (074) → NO_GO; fecha civil irreal → INVALID_RANGE', async () => {
    installQueryMock({ has074: false });
    await expect(svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', planDigestExpected: 'x' }))
      .rejects.toMatchObject({ code: 'NO_GO_SCHEMA_INCOMPLETE' });
    installQueryMock();
    await expect(svc.recalcApply({ from: '2025-02-30', to: '2025-02-30', scopeKind: 'all', planDigestExpected: 'x' }))
      .rejects.toMatchObject({ code: 'INVALID_RANGE' });
  });
});

describe('[P1-E/B1] restore validado', () => {
  test('conteo != rows_backed_up → BACKUP_COUNT_MISMATCH; no restaura', async () => {
    const { events } = installQueryMock({ batchRecord: { batch_id: 'B1', status: 'applied', rows_backed_up: 3 }, backupRows: [{ employee_id: 1, date: '2025-01-10', existed: 1 }], backupCount: 1 });
    await expect(svc.restoreBatch({ batchId: 'B1' })).rejects.toMatchObject({ code: 'BACKUP_COUNT_MISMATCH' });
    expect(events).not.toContain('restored');
  });
  test('restore repone (upsert/delete) bajo lock por fecha + fence; marca restored', async () => {
    const applied = { first_in: null, last_out: null, worked_minutes: 999, break_minutes: 0, overtime_minutes: 0, late_minutes: 0, notes: null, status: 'late' };
    const { events } = installQueryMock({
      batchRecord: { batch_id: 'B1', status: 'applied', rows_backed_up: 2 },
      backupRows: [
        { employee_id: 1, date: '2025-01-10', existed: 1, worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null, first_in: null, last_out: null, applied_json: applied },
        { employee_id: 2, date: '2025-01-10', existed: 0, applied_json: null },
      ],
      // la re-lectura FOR UPDATE devuelve lo que aplicamos (coincide) → se restaura
      storedRows: [{ employee_id: 1, date: '2025-01-10', ...applied, justification: null, justification_type: null }],
    });
    const out = await svc.restoreBatch({ batchId: 'B1', userId: 9 });
    expect(out.status).toBe('restored');
    expect(out.rows_restored).toBe(1);
    expect(out.rows_deleted).toBe(1);
    expect(out.rows_skipped).toBe(0);
    expect(events).toContain('date.lock');
    expect(events).toContain('lease.fence');
    expect(events).toContain('restored');
  });
  test('cambio concurrente tras el apply → SKIP (no pisa); cuenta skipped', async () => {
    const applied = { first_in: null, last_out: null, worked_minutes: 999, break_minutes: 0, overtime_minutes: 0, late_minutes: 0, notes: null, status: 'late' };
    installQueryMock({
      batchRecord: { batch_id: 'B1', status: 'applied', rows_backed_up: 1 },
      backupRows: [{ employee_id: 1, date: '2025-01-10', existed: 1, worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null, first_in: null, last_out: null, applied_json: applied }],
      // la fila actual ya NO es lo que aplicamos (alguien la cambió) → skip
      storedRows: [{ employee_id: 1, date: '2025-01-10', first_in: null, last_out: null, worked_minutes: 123, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null, justification: null, justification_type: null }],
    });
    const out = await svc.restoreBatch({ batchId: 'B1' });
    expect(out.rows_skipped).toBe(1);
    expect(out.rows_restored).toBe(0);
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

describe('[P1-A/B3] dry-run: resultado efectivo + fuera de rango', () => {
  test('changed_fields refleja el efectivo; una justificación preservada NO se anuncia como cambio de status', async () => {
    // Día vacío con justificación manual 'permiso': el writer preserva 'permission'.
    // El motor produce 'absent' pero el EFECTIVO es 'permission' → si el prev ya es
    // permission con esos minutos, NO hay cambio de status.
    const stored = { employee_id: 1, date: '2025-01-10', first_in: null, last_out: null, worked_minutes: 0, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'permission', notes: null, justification: 'x', justification_type: 'permiso' };
    installQueryMock({ employees: [{ id: 1 }], storedRows: [stored] });
    mockResolveBatch.mockImplementation(motorReadOnly((d) => new Map([[1, [motorRow('2025-01-09'), motorRow('2025-01-10', { status: 'absent', workday_count: 0, worked_minutes: 0 })]]])));
    const rep = await svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' });
    const ex = rep.examples.find((e) => e.date === '2025-01-10');
    // El efectivo del 10 = permission (preservado) = prev → NO difiere por status.
    expect(ex).toBeUndefined();
  });
});

describe('isRealCivilDate [P2]', () => {
  test('rechaza fechas irreales aunque cumplan el patrón', () => {
    expect(svc.isRealCivilDate('2025-01-31')).toBe(true);
    expect(svc.isRealCivilDate('2025-02-30')).toBe(false);
    expect(svc.isRealCivilDate('2025-13-01')).toBe(false);
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
