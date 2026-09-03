/**
 * faseEConsoleService.test.js — Motor de la consola de FASE E.
 *
 * Cubre lo NO negociable de la reversibilidad y el fail-safe:
 *   · recalcApply RESPALDA antes de escribir una sola fila;
 *   · RESTORE repone (existed=1) y borra lo que el recálculo creó (existed=0);
 *   · el dry-run/impacto NO escribe;
 *   · rango inválido/demasiado ancho se rechaza;
 *   · applyMigrations invoca el runner real ACOTADO a 075 (--upto).
 */

const mockSpawnSync = jest.fn(() => ({ status: 0, stdout: 'ok', stderr: '' }));
jest.mock('child_process', () => ({ spawnSync: (...a) => mockSpawnSync(...a) }));

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
  mockSpawnSync.mockClear();
});

describe('recalcApply — respalda ANTES de sobrescribir; es reversible', () => {
  test('backup precede a toda escritura del motor y cuenta existed 0/1', async () => {
    const events = [];
    // 2 empleados en alcance.
    sequelize.query.mockImplementation(async (sql) => {
      if (/FROM employees WHERE status = 'active'/i.test(sql)) return [[{ id: 1 }, { id: 2 }]];
      if (/FROM daily_summary\b/i.test(sql) && /date >= \? AND date <= \?/i.test(sql)) {
        // Sólo existe la fila (1, 2025-01-10). Las demás celdas se crearán.
        return [[{ employee_id: 1, date: '2025-01-10', first_in: null, last_out: null,
          worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0,
          status: 'present', notes: null }]];
      }
      if (/INSERT INTO daily_summary_backup/i.test(sql)) { events.push('backup'); return [{}]; }
      if (/INSERT INTO daily_summary_recalc_batch/i.test(sql)) { events.push('header'); return [{}]; }
      if (/UPDATE daily_summary_recalc_batch/i.test(sql)) { events.push('finalize'); return [{}]; }
      return [[]];
    });
    // El motor: para la fecha ancla devuelve filas de {d-1, d}.
    mockResolveBatch.mockImplementation(async (_ids, d, opts) => {
      if (opts && opts.apply) { events.push('apply'); return { rowsByEmployee: new Map() }; }
      // dry-run de enumeración
      return {
        rowsByEmployee: new Map([
          [1, [{ date: '2025-01-09' }, { date: '2025-01-10' }]],
          [2, [{ date: '2025-01-10' }]],
        ]),
      };
    });

    const out = await svc.recalcApply({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all', userId: 7 });

    expect(out.batch_id).toBeTruthy();
    expect(out.employees).toBe(2);
    // 3 celdas objetivo: (1,09),(1,10),(2,10).
    expect(out.rows_backed_up).toBe(3);
    expect(out.rows_written).toBe(3);
    // El respaldo y la cabecera ocurren ANTES de cualquier apply del motor.
    expect(events.indexOf('backup')).toBeLessThan(events.indexOf('apply'));
    expect(events.indexOf('header')).toBeLessThan(events.indexOf('apply'));
    // Se llamó al motor con apply:true al menos una vez (la escritura real).
    const applyCalls = mockResolveBatch.mock.calls.filter((c) => c[2] && c[2].apply);
    expect(applyCalls.length).toBeGreaterThan(0);

    // El INSERT de respaldo lleva existed=1 para (1,2025-01-10) y existed=0 para las creadas.
    const backupCall = sequelize.query.mock.calls.find((c) => /INSERT INTO daily_summary_backup/i.test(c[0]));
    const repl = backupCall[1].replacements;
    // Cada fila: [batch, emp, date, existed, ...13]. Buscamos la celda (1,'2025-01-10').
    const idx = repl.findIndex((v, i) => repl[i] === 1 && repl[i + 1] === '2025-01-10');
    expect(repl[idx + 2]).toBe(1); // existed=1 (había fila)
  });

  test('un rango demasiado ancho se rechaza (no escribe)', async () => {
    await expect(
      svc.recalcApply({ from: '2000-01-01', to: '2030-01-01' }),
    ).rejects.toMatchObject({ code: 'RANGE_TOO_WIDE' });
    expect(mockResolveBatch).not.toHaveBeenCalled();
  });

  test('from > to se rechaza', async () => {
    await expect(svc.recalcApply({ from: '2025-02-01', to: '2025-01-01' }))
      .rejects.toMatchObject({ code: 'INVALID_RANGE' });
  });
});

describe('restoreBatch — repone existed=1 y borra existed=0', () => {
  test('upsert para las que existían, delete para las creadas, marca restored', async () => {
    const seen = { upsert: 0, del: 0, mark: 0 };
    sequelize.query.mockImplementation(async (sql) => {
      if (/FROM daily_summary_recalc_batch WHERE batch_id/i.test(sql)) {
        return [[{ batch_id: 'B1', status: 'applied' }]];
      }
      if (/FROM daily_summary_backup WHERE batch_id/i.test(sql)) {
        return [[
          { employee_id: 1, date: '2025-01-10', existed: 1, first_in: null, last_out: null,
            worked_minutes: 480, break_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'present', notes: null },
          { employee_id: 2, date: '2025-01-10', existed: 0, first_in: null, last_out: null,
            worked_minutes: null, break_minutes: null, late_minutes: null, overtime_minutes: null, status: null, notes: null },
        ]];
      }
      if (/INSERT INTO daily_summary\b/i.test(sql)) { seen.upsert++; return [{}]; }
      if (/DELETE FROM daily_summary\b/i.test(sql)) { seen.del++; return [{}]; }
      if (/UPDATE daily_summary_recalc_batch\s+SET status = 'restored'/i.test(sql)) { seen.mark++; return [{}]; }
      return [[]];
    });

    const out = await svc.restoreBatch({ batchId: 'B1', userId: 9 });
    expect(out.rows_restored).toBe(1);
    expect(out.rows_deleted).toBe(1);
    expect(seen.upsert).toBe(1);
    expect(seen.del).toBe(1);
    expect(seen.mark).toBe(1);
  });

  test('un lote ya restaurado se rechaza', async () => {
    sequelize.query.mockImplementation(async (sql) => {
      if (/FROM daily_summary_recalc_batch WHERE batch_id/i.test(sql)) {
        return [[{ batch_id: 'B1', status: 'restored' }]];
      }
      return [[]];
    });
    await expect(svc.restoreBatch({ batchId: 'B1' }))
      .rejects.toMatchObject({ code: 'BATCH_ALREADY_RESTORED' });
  });

  test('batch inexistente → BATCH_NOT_FOUND', async () => {
    sequelize.query.mockImplementation(async () => [[]]);
    await expect(svc.restoreBatch({ batchId: 'nope' }))
      .rejects.toMatchObject({ code: 'BATCH_NOT_FOUND' });
  });
});

describe('getImpact — SOLO LECTURA', () => {
  test('nunca llama al motor con apply:true ni escribe daily_summary', async () => {
    sequelize.query.mockImplementation(async (sql) => {
      if (/FROM employees WHERE status = 'active'/i.test(sql)) return [[{ id: 1 }]];
      if (/FROM daily_summary\b/i.test(sql)) return [[]]; // sin fila guardada
      return [[]];
    });
    mockResolveBatch.mockImplementation(async (_ids, d) => ({
      rowsByEmployee: new Map([[1, [{ date: d, status: 'present', worked_minutes: 480, late_minutes: 0 }]]]),
    }));

    const rep = await svc.getImpact({ from: '2025-01-10', to: '2025-01-10', scopeKind: 'all' });
    expect(rep.read_only).toBe(true);
    expect(rep.rows_evaluated).toBe(1);
    // Fila nueva (no había guardada) → difiere.
    expect(rep.rows_differ).toBe(1);
    expect(rep.rows_new).toBe(1);
    // Ningún apply:true, ningún INSERT/UPDATE/DELETE sobre daily_summary.
    expect(mockResolveBatch.mock.calls.every((c) => !(c[2] && c[2].apply))).toBe(true);
    const escribió = sequelize.query.mock.calls.some((c) =>
      /(INSERT INTO|UPDATE|DELETE FROM)\s+daily_summary\b/i.test(c[0]));
    expect(escribió).toBe(false);
  });
});

describe('applyMigrations — runner real acotado a 075', () => {
  test('invoca migrate.js con --upto=075 y no otra migración', () => {
    const out = svc.applyMigrations();
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    const [, args] = mockSpawnSync.mock.calls[0];
    expect(args.some((a) => /migrate\.js$/.test(a))).toBe(true);
    expect(args).toContain('--upto=075_workday_configuration_phase_c.sql');
    expect(out.ok).toBe(true);
    expect(out.upto).toBe('075_workday_configuration_phase_c.sql');
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
