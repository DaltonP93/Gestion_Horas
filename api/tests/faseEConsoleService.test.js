/**
 * faseEConsoleService.test.js — Motor de la consola de FASE E (endurecido).
 *
 * Cubre lo NO negociable de la reversibilidad, el fail-safe y las correcciones
 * pre-Ready:
 *   · recalcApply RESPALDA antes de escribir una sola fila y usa la máquina de
 *     estados prepared→applying→applied (NUNCA applied antes de terminar);
 *   · un fallo inyectado en una fecha intermedia deja el lote 'failed', no 'applied';
 *   · RESTORE repone (existed=1)/borra (existed=0), verifica conteo de respaldos
 *     y NUNCA marca 'restored' ante ejecución parcial;
 *   · dry-run enumera las MISMAS celdas que recalcApply (spillover nocturno) y
 *     compara los 8 campos mutables (incl. overtime/break/notes);
 *   · dry-run reporta las fechas modificables FUERA del rango;
 *   · scope_kind inválido se rechaza (nunca cae a 'all');
 *   · forward/enable con esquema incompleto → NO_GO;
 *   · dos operaciones concurrentes → la 2ª recibe CONSOLE_BUSY;
 *   · applyMigrations corre el runner ACOTADO a 075 en proceso hijo ASÍNCRONO.
 */

const { EventEmitter } = require('events');

// spawn asíncrono mockeado: devuelve un child con stdout/stderr y emite 'close'.
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({ spawn: (...a) => mockSpawn(...a) }));

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
  DB_TIMEZONE: '-03:00',
}));

const mockResolveBatch = jest.fn();
jest.mock('../src/services/workdaySummaryService', () => {
  const actual = jest.requireActual('../src/services/workdaySummaryService');
  return { ...actual, resolveSummaryBatchForDate: (...a) => mockResolveBatch(...a) };
});

const { sequelize } = require('../src/config/database');
const svc = require('../src/services/faseEConsoleService');

beforeEach(() => {
  sequelize.query.mockReset();
  mockResolveBatch.mockReset();
  mockSpawn.mockReset();
});

// ─── router de mock de sequelize.query ───────────────────────────────────
// Default "todo sano": esquema GO, lock libre (se toma), sin overlap. Cada
// prueba puede sobreescribir vía cfg. `events` guarda el orden observado.
function installQueryMock(cfg = {}) {
  const c = {
    employees: [{ id: 1 }, { id: 2 }],
    storedRows: [],           // filas existentes de daily_summary (span)
    migrationsRecorded: [
      '072_employee_schedule_history.sql', '073_workday_profile_and_overlap_guard.sql',
      '074_daily_summary_status_unknown.sql', '075_workday_configuration_phase_c.sql',
      '083_fase_e_activation_console.sql',
    ],
    has074: true,
    tablesExist: {            // por defecto todas existen
      schema_migrations: true, daily_summary: true,
      daily_summary_recalc_batch: true, daily_summary_backup: true,
      employee_schedule_history: true, fase_e_console_lock: true,
    },
    lockAcquired: true,       // affectedRows de la UPDATE del lock
    overlapBatch: null,       // fila de batch superpuesto, o null
    batchRecord: undefined,   // para restore: {batch_id, status, rows_backed_up}
    backupRows: [],           // para restore
    backupCount: undefined,   // COUNT(*) de daily_summary_backup (default = backupRows.length)
    ...cfg,
  };
  const events = c.events || [];
  sequelize.query.mockImplementation(async (sql, opt) => {
    const p = (opt && opt.replacements) || [];
    // introspección de tablas
    if (/INFORMATION_SCHEMA\.TABLES/i.test(sql)) {
      const name = p[0];
      return [c.tablesExist[name] ? [{ ok: 1 }] : []];
    }
    if (/SELECT filename FROM schema_migrations WHERE filename IN/i.test(sql)) {
      const set = new Set(c.migrationsRecorded);
      return [p.filter((f) => set.has(f)).map((f) => ({ filename: f }))];
    }
    if (/INFORMATION_SCHEMA\.COLUMNS/i.test(sql) && /daily_summary/i.test(sql)) {
      return [[{ type: c.has074
        ? "enum('present','absent','late','weekend','holiday','permission','non_working','unconfigured')"
        : "enum('present','absent','late','weekend','holiday','permission')" }]];
    }
    if (/COUNT\(\*\) AS n FROM employee_schedule_history/i.test(sql)) return [[{ n: 0 }]];
    // lock
    if (/UPDATE fase_e_console_lock/i.test(sql) && /SET held = 1/i.test(sql)) {
      events.push('lock.acquire');
      return [{ affectedRows: c.lockAcquired ? 1 : 0 }];
    }
    if (/UPDATE fase_e_console_lock/i.test(sql)) { events.push('lock.release'); return [{ affectedRows: 1 }]; }
    // alcance
    if (/FROM employees WHERE status = 'active'/i.test(sql)) return [c.employees];
    if (/FROM employees WHERE department_id/i.test(sql)) return [c.employees];
    // overlap
    if (/FROM daily_summary_recalc_batch\s+WHERE status <> 'restored'/i.test(sql)) {
      return [c.overlapBatch ? [c.overlapBatch] : []];
    }
    // existentes (span)
    if (/FROM daily_summary\b/i.test(sql) && /date >= \? AND date <= \?/i.test(sql)) {
      return [c.storedRows];
    }
    // recalc: estados
    if (/INSERT INTO daily_summary_recalc_batch/i.test(sql)) { events.push('header.prepared'); return [{ affectedRows: 1 }]; }
    if (/UPDATE daily_summary_recalc_batch SET rows_backed_up/i.test(sql)) { events.push('set.rows_backed_up'); return [{ affectedRows: 1 }]; }
    if (/UPDATE daily_summary_recalc_batch SET status = 'applying'/i.test(sql)) { events.push('status.applying'); return [{ affectedRows: 1 }]; }
    if (/UPDATE daily_summary_recalc_batch SET status = 'applied'/i.test(sql)) { events.push('status.applied'); return [{ affectedRows: 1 }]; }
    if (/UPDATE daily_summary_recalc_batch SET status = 'failed'/i.test(sql)) { events.push('status.failed'); return [{ affectedRows: 1 }]; }
    if (/INSERT INTO daily_summary_backup/i.test(sql)) { events.push('backup'); return [{ affectedRows: 1 }]; }
    // restore
    if (/SELECT batch_id, status, rows_backed_up FROM daily_summary_recalc_batch/i.test(sql)) {
      return [c.batchRecord ? [c.batchRecord] : []];
    }
    if (/COUNT\(\*\) AS n FROM daily_summary_backup/i.test(sql)) {
      return [[{ n: c.backupCount != null ? c.backupCount : c.backupRows.length }]];
    }
    if (/FROM daily_summary_backup WHERE batch_id/i.test(sql)) { return [c.backupRows]; }
    if (/UPDATE daily_summary_recalc_batch SET status = 'restoring'/i.test(sql)) { events.push('status.restoring'); return [{ affectedRows: 1 }]; }
    if (/UPDATE daily_summary_recalc_batch SET status = 'restored'/i.test(sql)) { events.push('status.restored'); return [{ affectedRows: 1 }]; }
    if (/INSERT INTO daily_summary\b/i.test(sql)) { events.push('ds.upsert'); return [{ affectedRows: 1 }]; }
    if (/DELETE FROM daily_summary\b/i.test(sql)) { events.push('ds.delete'); return [{ affectedRows: 1 }]; }
    return [[]];
  });
  return { c, events };
}

// motor: para la fecha ancla devuelve filas de {d-1, d}. Campos de los 8 mutables.
function motorRow(date, over = {}) {
  return {
    date,
    first_in: null, last_out: null,
    worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0,
    status: 'present', notes: null, ...over,
  };
}

describe('recalcApply — respaldo antes de escribir + máquina de estados', () => {
  test('prepared→applying→applied; backup y header ANTES de todo apply del motor', async () => {
    const events = [];
    installQueryMock({
      events,
      storedRows: [{ employee_id: 1, date: '2025-01-10', first_in: null, last_out: null,
        worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null }],
    });
    mockResolveBatch.mockImplementation(async (_ids, d, opts) => {
      if (opts && opts.apply) { events.push('apply'); return { rowsByEmployee: new Map() }; }
      return { rowsByEmployee: new Map([
        [1, [{ ...motorRow('2025-01-09') }, { ...motorRow('2025-01-10') }]],
        [2, [{ ...motorRow('2025-01-10') }]],
      ]) };
    });

    const out = await svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', userId: 7 });
    expect(out.batch_id).toBeTruthy();
    expect(out.status).toBe('applied');
    expect(out.employees).toBe(2);
    expect(out.rows_backed_up).toBe(3);   // (1,09),(1,10),(2,10)
    expect(out.rows_written).toBe(3);
    // Orden fail-safe: header.prepared < backup < set.rows_backed_up < status.applying < apply < status.applied
    const order = ['header.prepared', 'backup', 'set.rows_backed_up', 'status.applying', 'apply', 'status.applied'];
    const idx = order.map((e) => events.indexOf(e));
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    // NUNCA 'applied' antes de escribir.
    expect(events.indexOf('status.applied')).toBeGreaterThan(events.indexOf('apply'));
    // El lock se toma y se libera.
    expect(events).toContain('lock.acquire');
    expect(events[events.length - 1]).toBe('lock.release');
    // existed=1 para (1,2025-01-10).
    const backupCall = sequelize.query.mock.calls.find((c) => /INSERT INTO daily_summary_backup/i.test(c[0]));
    const repl = backupCall[1].replacements;
    const i = repl.findIndex((v, k) => repl[k] === 1 && repl[k + 1] === '2025-01-10');
    expect(repl[i + 2]).toBe(1);
  });

  test('fallo inyectado en una fecha intermedia → lote FAILED, nunca applied', async () => {
    const events = [];
    installQueryMock({ events, employees: [{ id: 1 }] });
    let applyCount = 0;
    mockResolveBatch.mockImplementation(async (_ids, d, opts) => {
      if (opts && opts.apply) {
        applyCount++;
        if (applyCount === 2) throw new Error('fallo del motor en la 2ª fecha');
        return { rowsByEmployee: new Map() };
      }
      return { rowsByEmployee: new Map([[1, [{ ...motorRow(d) }]]]) };
    });
    await expect(
      svc.recalcApply({ from: '2025-01-10', to: '2025-01-12', scopeKind: 'all' }),
    ).rejects.toThrow(/2ª fecha/);
    expect(events).toContain('status.failed');
    expect(events).not.toContain('status.applied');
    expect(events[events.length - 1]).toBe('lock.release'); // el lock SIEMPRE se libera
  });

  test('scope_kind inválido se rechaza (NUNCA cae a all) y no toma lock ni escribe', async () => {
    installQueryMock();
    await expect(
      svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'todos' }),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    expect(mockResolveBatch).not.toHaveBeenCalled();
    const tookLock = sequelize.query.mock.calls.some((c) => /UPDATE fase_e_console_lock/i.test(c[0]) && /SET held = 1/i.test(c[0]));
    expect(tookLock).toBe(false);
  });

  test('esquema incompleto (074 ausente) → NO_GO antes de tocar nada', async () => {
    installQueryMock({ has074: false });
    await expect(
      svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' }),
    ).rejects.toMatchObject({ code: 'NO_GO_SCHEMA_INCOMPLETE', status: 409 });
    expect(mockResolveBatch).not.toHaveBeenCalled();
  });

  test('rango superpuesto con lote no restaurado → RANGE_OVERLAP (libera lock)', async () => {
    const events = [];
    installQueryMock({ events, overlapBatch: { batch_id: 'B0', status: 'applied', from_date: '2025-01-05', to_date: '2025-01-15' } });
    mockResolveBatch.mockResolvedValue({ rowsByEmployee: new Map() });
    await expect(
      svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' }),
    ).rejects.toMatchObject({ code: 'RANGE_OVERLAP', status: 409 });
    expect(events).toContain('lock.acquire');
    expect(events[events.length - 1]).toBe('lock.release');
  });

  test('dos operaciones concurrentes: la 2ª recibe CONSOLE_BUSY', async () => {
    installQueryMock({ lockAcquired: false }); // el lock ya está tomado por otra operación
    await expect(
      svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' }),
    ).rejects.toMatchObject({ code: 'CONSOLE_BUSY', status: 409 });
  });

  test('rango demasiado ancho / from>to se rechazan sin tocar el motor', async () => {
    installQueryMock();
    await expect(svc.recalcApply({ from: '2000-01-01', to: '2030-01-01' })).rejects.toMatchObject({ code: 'RANGE_TOO_WIDE' });
    await expect(svc.recalcApply({ from: '2025-02-01', to: '2025-01-01' })).rejects.toMatchObject({ code: 'INVALID_RANGE' });
    expect(mockResolveBatch).not.toHaveBeenCalled();
  });
});

describe('getImpact / dry-run — paridad de celdas y campos; SOLO LECTURA', () => {
  test('detecta cambios SÓLO de overtime/break/notes (los 8 campos, no sólo worked/late)', async () => {
    installQueryMock({
      employees: [{ id: 1 }],
      // guardada difiere del motor SÓLO en overtime, break y notes.
      storedRows: [{ employee_id: 1, date: '2025-01-10', first_in: null, last_out: null,
        worked_minutes: 480, break_minutes: 30, late_minutes: 0, overtime_minutes: 60, status: 'present', notes: 'viejo' }],
    });
    mockResolveBatch.mockImplementation(async (_ids, d) => ({
      rowsByEmployee: new Map([[1, [motorRow(d, { break_minutes: 0, overtime_minutes: 0, notes: null })]]]),
    }));
    const rep = await svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' });
    expect(rep.read_only).toBe(true);
    expect(rep.rows_differ).toBe(1);
    const ex = rep.examples.find((e) => e.date === '2025-01-10');
    expect(ex.changed_fields.sort()).toEqual(['break_minutes', 'notes', 'overtime_minutes']);
    // ninguna escritura
    const escribió = sequelize.query.mock.calls.some((c) => /(INSERT INTO|UPDATE|DELETE FROM)\s+daily_summary\b/i.test(c[0]));
    expect(escribió).toBe(false);
    expect(mockResolveBatch.mock.calls.every((cc) => !(cc[2] && cc[2].apply))).toBe(true);
  });

  test('ventana nocturna: la celda from-1 se enumera y se reporta FUERA de rango', async () => {
    installQueryMock({ employees: [{ id: 1 }], storedRows: [] });
    mockResolveBatch.mockImplementation(async (_ids, d) => ({
      // al evaluar 'from' (2025-01-10) el motor toca 2025-01-09 y 2025-01-10.
      rowsByEmployee: new Map([[1, [motorRow('2025-01-09'), motorRow('2025-01-10')]]]),
    }));
    const rep = await svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' });
    expect(rep.dates_outside_range).toContain('2025-01-09');
    expect(rep.rows_differ_outside_range).toBe(1);
    const ex = rep.examples.find((e) => e.date === '2025-01-09');
    expect(ex.outside_requested_range).toBe(true);
  });

  test('scope_kind inválido en dry-run → INVALID_SCOPE', async () => {
    installQueryMock();
    await expect(svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'x' }))
      .rejects.toMatchObject({ code: 'INVALID_SCOPE' });
  });
});

describe('restoreBatch — verificación de respaldo + estado', () => {
  test('conteo de respaldos != rows_backed_up → BACKUP_COUNT_MISMATCH, no marca restored', async () => {
    const events = [];
    installQueryMock({
      events,
      batchRecord: { batch_id: 'B1', status: 'applied', rows_backed_up: 3 },
      backupRows: [{ employee_id: 1, date: '2025-01-10', existed: 1 }], // sólo 1 respaldada
      backupCount: 1,
    });
    await expect(svc.restoreBatch({ batchId: 'B1' })).rejects.toMatchObject({ code: 'BACKUP_COUNT_MISMATCH' });
    expect(events).not.toContain('status.restored');
    expect(events[events.length - 1]).toBe('lock.release');
  });

  test('restore completo: upsert existed=1, delete existed=0, marca restored', async () => {
    const events = [];
    installQueryMock({
      events,
      batchRecord: { batch_id: 'B1', status: 'applied', rows_backed_up: 2 },
      backupRows: [
        { employee_id: 1, date: '2025-01-10', existed: 1, first_in: null, last_out: null,
          worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null },
        { employee_id: 2, date: '2025-01-10', existed: 0, first_in: null, last_out: null,
          worked_minutes: null, break_minutes: null, late_minutes: null, overtime_minutes: null, status: null, notes: null },
      ],
    });
    const out = await svc.restoreBatch({ batchId: 'B1', userId: 9 });
    expect(out.status).toBe('restored');
    expect(out.rows_restored).toBe(1);
    expect(out.rows_deleted).toBe(1);
    // restoring antes de restored
    expect(events.indexOf('status.restoring')).toBeLessThan(events.indexOf('status.restored'));
  });

  test('restore parcial (falla a mitad) → NO marca restored; queda restoring', async () => {
    const events = [];
    const base = installQueryMock({
      events,
      batchRecord: { batch_id: 'B1', status: 'applied', rows_backed_up: 2 },
      backupRows: [
        { employee_id: 1, date: '2025-01-10', existed: 1, worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null },
        { employee_id: 2, date: '2025-01-11', existed: 1, worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null },
      ],
    });
    // hacer que el 2º upsert falle
    let upserts = 0;
    const prev = sequelize.query.getMockImplementation();
    sequelize.query.mockImplementation(async (sql, opt) => {
      if (/INSERT INTO daily_summary\b/i.test(sql)) {
        upserts++;
        if (upserts === 2) throw new Error('fallo en la 2ª restauración');
      }
      return prev(sql, opt);
    });
    await expect(svc.restoreBatch({ batchId: 'B1' })).rejects.toThrow(/2ª restauración/);
    expect(events).toContain('status.restoring');
    expect(events).not.toContain('status.restored');
    expect(events[events.length - 1]).toBe('lock.release');
  });

  test('lote ya restaurado / inexistente / no restaurable', async () => {
    installQueryMock({ batchRecord: { batch_id: 'B1', status: 'restored', rows_backed_up: 0 } });
    await expect(svc.restoreBatch({ batchId: 'B1' })).rejects.toMatchObject({ code: 'BATCH_ALREADY_RESTORED' });
    installQueryMock({ batchRecord: undefined });
    await expect(svc.restoreBatch({ batchId: 'nope' })).rejects.toMatchObject({ code: 'BATCH_NOT_FOUND' });
    installQueryMock({ batchRecord: { batch_id: 'B1', status: 'applying', rows_backed_up: 0 } });
    await expect(svc.restoreBatch({ batchId: 'B1' })).rejects.toMatchObject({ code: 'BATCH_NOT_RESTORABLE' });
  });
});

describe('setForwardEnabled — GO/NO-GO en backend', () => {
  test('enable con esquema incompleto → NO_GO (no escribe el setting)', async () => {
    installQueryMock({ migrationsRecorded: ['072_employee_schedule_history.sql'] }); // faltan 073-075/083
    await expect(svc.setForwardEnabled(true)).rejects.toMatchObject({ code: 'NO_GO_SCHEMA_INCOMPLETE', status: 409 });
    const escribió = sequelize.query.mock.calls.some((c) => /INSERT INTO system_settings/i.test(c[0]));
    expect(escribió).toBe(false);
  });
  test('enable con esquema completo escribe el setting; disable NO exige GO', async () => {
    installQueryMock();
    const on = await svc.setForwardEnabled(true);
    expect(on.forward_db_setting).toBe(true);
    installQueryMock({ has074: false }); // esquema incompleto
    const off = await svc.setForwardEnabled(false); // disable siempre permitido
    expect(off.forward_db_setting).toBe(false);
  });
});

describe('applyMigrations — runner ACOTADO a 075, ASÍNCRONO (no bloquea el event loop)', () => {
  test('spawn (no spawnSync) de migrate.js con --upto=075; resuelve al cerrar', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      setImmediate(() => { child.stdout.emit('data', 'ok'); child.emit('close', 0); });
      return child;
    });
    const p = svc.applyMigrations();
    expect(typeof p.then).toBe('function'); // es una promesa (no bloquea)
    const out = await p;
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, args] = mockSpawn.mock.calls[0];
    expect(args.some((a) => /migrate\.js$/.test(a))).toBe(true);
    expect(args).toContain('--upto=075_workday_configuration_phase_c.sql');
    expect(out.ok).toBe(true);
    expect(out.upto).toBe('075_workday_configuration_phase_c.sql');
  });
  test('exit != 0 → ok:false', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      setImmediate(() => { child.stderr.emit('data', 'boom'); child.emit('close', 1); });
      return child;
    });
    const out = await svc.applyMigrations();
    expect(out.ok).toBe(false);
    expect(out.exit_code).toBe(1);
  });
});

describe('master-flag', () => {
  const orig = process.env.FASE_E_ACTIVATION_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.FASE_E_ACTIVATION_ENABLED;
    else process.env.FASE_E_ACTIVATION_ENABLED = orig;
  });
  test('default OFF; sólo "true" habilita', () => {
    delete process.env.FASE_E_ACTIVATION_ENABLED;
    expect(svc.isActivationEnabled()).toBe(false);
    process.env.FASE_E_ACTIVATION_ENABLED = '1';
    expect(svc.isActivationEnabled()).toBe(false);
    process.env.FASE_E_ACTIVATION_ENABLED = 'true';
    expect(svc.isActivationEnabled()).toBe(true);
  });
});
