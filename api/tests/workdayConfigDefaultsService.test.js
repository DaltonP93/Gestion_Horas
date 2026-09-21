'use strict';

/**
 * workdayConfigDefaultsService.test.js — defaults jerárquicos de jornada
 * (general/empresa/departamento) con vigencia histórica.
 *
 * Cubre: validadores puros (alcance, cuerpo, solapes), compuerta de escritura
 * fail-closed (no toca BD con el flag OFF), preview/dry-run masivo SIN escrituras
 * y sin N+1, y el camino feliz de createDefault con BD mockeada.
 */

jest.mock('../src/config/database', () => {
  const query = jest.fn();
  const transaction = jest.fn(async (cb) => cb('TX'));
  return { sequelize: { query, transaction } };
});

jest.mock('../src/utils/mysqlRetry', () => ({
  withDeadlockRetry: jest.fn(async (fn) => ({ result: await fn(1), attempts: 1, retries: 0 })),
}));

// workdayConfig sólo lo usa getEffectiveForDate (probado en otra suite). Aquí
// se mockea para que requerir el servicio no arrastre dependencias de BD.
jest.mock('../src/services/workdayConfig', () => ({
  loadWorkdayConfig: jest.fn(),
}));

const { sequelize } = require('../src/config/database');
const svc = require('../src/services/workdayConfigDefaultsService');

const FLAG = 'WORKDAY_CONFIG_WRITE_ENABLED';
const ORIGINAL = process.env[FLAG];

beforeEach(() => {
  process.env[FLAG] = 'true';
  sequelize.query.mockReset();
  sequelize.transaction.mockClear();
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env[FLAG];
  else process.env[FLAG] = ORIGINAL;
});

const BASE = { check_in: '08:00', check_out: '17:00', work_days: '2,3,4,5,6' };

/** Ejecuta fn (que debe lanzar) y afirma el `code` del error httpError. */
function expectCode(fn, code) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  expect(err).not.toBeNull();
  expect(err.code).toBe(code);
}

describe('scopeKey — clave determinista (paridad con la columna generada 085)', () => {
  test('normaliza nulos a 0', () => {
    expect(svc.scopeKey('general', null, null)).toBe('general:0:0');
    expect(svc.scopeKey('company', 5, null)).toBe('company:5:0');
    expect(svc.scopeKey('department', null, 9)).toBe('department:0:9');
  });
});

describe('normalizeScopeTarget — coherencia de alcance', () => {
  test('general no admite company/department', () => {
    expectCode(() => svc.normalizeScopeTarget({ scope: 'general', company_id: 1 }), 'SCOPE_MISMATCH');
    expect(svc.normalizeScopeTarget({ scope: 'general' })).toEqual({ scope: 'general', company_id: null, department_id: null });
  });
  test('company requiere company_id y rechaza department_id', () => {
    expectCode(() => svc.normalizeScopeTarget({ scope: 'company' }), 'SCOPE_MISMATCH');
    expectCode(() => svc.normalizeScopeTarget({ scope: 'company', company_id: 3, department_id: 4 }), 'SCOPE_MISMATCH');
    expect(svc.normalizeScopeTarget({ scope: 'company', company_id: 3 })).toEqual({ scope: 'company', company_id: 3, department_id: null });
  });
  test('department requiere department_id (company_id opcional)', () => {
    expectCode(() => svc.normalizeScopeTarget({ scope: 'department' }), 'SCOPE_MISMATCH');
    expect(svc.normalizeScopeTarget({ scope: 'department', department_id: 9, company_id: 3 }))
      .toEqual({ scope: 'department', company_id: 3, department_id: 9 });
  });
  test('scope inválido → 400', () => {
    expectCode(() => svc.normalizeScopeTarget({ scope: 'zonal' }), 'INVALID_SCOPE');
  });
});

describe('normalizeDefaultBody — validación de cuerpo y vigencia', () => {
  test('exige valid_from y respeta la fecha como string (no boolean)', () => {
    expectCode(() => svc.normalizeDefaultBody({ scope: 'general', ...BASE }), 'INVALID_VALID_FROM');
    const row = svc.normalizeDefaultBody({ scope: 'general', valid_from: '2026-09-01', ...BASE });
    expect(row.valid_from).toBe('2026-09-01');
    expect(row.valid_to).toBeNull();
    expect(row.scope_key).toBe('general:0:0');
    expect(row.config_complete).toBe(true);
    expect(row.work_days).toBe('2,3,4,5,6');
    expect(row.break_mode).toBe('punched');
  });
  test('valid_to < valid_from → 400', () => {
    expectCode(() => svc.normalizeDefaultBody({ scope: 'general', valid_from: '2026-09-10', valid_to: '2026-09-01', ...BASE }), 'INVALID_VALIDITY');
  });
  test('regime y break_mode inválidos → 400 (Set.has, no Array.includes)', () => {
    expectCode(() => svc.normalizeDefaultBody({ scope: 'general', valid_from: '2026-09-01', work_regime: 'X', ...BASE }), 'INVALID_REGIME');
    expectCode(() => svc.normalizeDefaultBody({ scope: 'general', valid_from: '2026-09-01', break_mode: 'X', ...BASE }), 'INVALID_BREAK_MODE');
    // Valores válidos aceptados.
    expect(svc.normalizeDefaultBody({ scope: 'general', valid_from: '2026-09-01', work_regime: 'night', break_mode: 'none', ...BASE }).work_regime).toBe('night');
  });
  test('config incompleta NO lanza salvo requireComplete', () => {
    const partial = { scope: 'general', valid_from: '2026-09-01', check_in: '08:00' };
    const row = svc.normalizeDefaultBody(partial);
    expect(row.config_complete).toBe(false);
    expectCode(() => svc.normalizeDefaultBody(partial, { requireComplete: true }), 'INCOMPLETE_CONFIG');
  });
});

describe('rangesOverlap — inclusivo, abierto = infinito', () => {
  test('detecta solape y contigüidad inclusiva', () => {
    expect(svc.rangesOverlap('2026-01-01', '2026-06-30', '2026-06-30', null)).toBe(true); // tocan en el borde
    expect(svc.rangesOverlap('2026-01-01', '2026-05-31', '2026-06-01', null)).toBe(false);
    expect(svc.rangesOverlap('2026-01-01', null, '2030-01-01', null)).toBe(true); // ambos abiertos
  });
});

describe('detectBatchConflicts — solapes intra-lote por alcance', () => {
  test('marca sólo pares del MISMO scope_key que se solapan', () => {
    const rows = [
      svc.normalizeDefaultBody({ scope: 'general', valid_from: '2026-01-01', valid_to: '2026-06-30', ...BASE }),
      svc.normalizeDefaultBody({ scope: 'general', valid_from: '2026-06-01', ...BASE }),            // solapa con la 1ª
      svc.normalizeDefaultBody({ scope: 'department', department_id: 9, valid_from: '2026-01-01', ...BASE }), // otro alcance
    ];
    const conflicts = svc.detectBatchConflicts(rows);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].scope_key).toBe('general:0:0');
  });
});

describe('compuerta de escritura fail-closed', () => {
  test('isWriteEnabled sólo con el string exacto "true"', () => {
    for (const v of [undefined, '', 'false', '1', 'TRUE']) {
      if (v === undefined) delete process.env[FLAG]; else process.env[FLAG] = v;
      expect(svc.isWriteEnabled()).toBe(false);
    }
    process.env[FLAG] = 'true';
    expect(svc.isWriteEnabled()).toBe(true);
  });

  test('createDefault bloquea ANTES de tocar la BD con el flag OFF', async () => {
    process.env[FLAG] = 'false';
    await expect(svc.createDefault({ scope: 'general', valid_from: '2026-09-01', ...BASE }, 1))
      .rejects.toMatchObject({ status: 503 });
    expect(sequelize.query).not.toHaveBeenCalled();
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  test('bulkApply bloquea ANTES de tocar la BD con el flag OFF', async () => {
    process.env[FLAG] = 'false';
    await expect(svc.bulkApply([{ scope: 'general', valid_from: '2026-09-01', ...BASE }], 1))
      .rejects.toMatchObject({ status: 503 });
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('bulkPreview — dry-run SIN escrituras y sin N+1', () => {
  test('clasifica ok/incomplete/invalid/overlap y NO escribe', async () => {
    // Única consulta esperada: el SELECT de solapes existentes por scope_key.
    sequelize.query.mockResolvedValueOnce([[]]); // sin filas existentes en BD
    const items = [
      { scope: 'general', valid_from: '2026-01-01', valid_to: '2026-06-30', ...BASE }, // ok
      { scope: 'general', valid_from: '2026-06-01', ...BASE },                          // overlap intra-lote con la 1ª
      { scope: 'company', valid_from: '2026-01-01', check_in: '08:00' },                // incomplete (company_id falta → invalid)
      { scope: 'department', department_id: 5, valid_from: '2026-01-01', check_in: '08:00' }, // incomplete
    ];
    const out = await svc.bulkPreview(items);
    expect(out.dry_run).toBe(true);
    expect(out.total).toBe(4);
    expect(out.results[2].status).toBe('invalid');       // company sin company_id
    expect(out.results[3].status).toBe('incomplete');    // dept sin jornada completa
    const overlaps = out.results.filter(r => r.status === 'overlap');
    expect(overlaps.length).toBe(2);                      // las dos general se marcan
    // No hubo INSERT/UPDATE/DELETE: sólo el SELECT de solapes.
    const writes = sequelize.query.mock.calls.filter(c => /INSERT|UPDATE|DELETE/i.test(c[0]));
    expect(writes).toHaveLength(0);
    expect(sequelize.query).toHaveBeenCalledTimes(1);     // sin N+1: una sola consulta
  });

  test('detecta solape contra vigencia existente en BD', async () => {
    sequelize.query.mockResolvedValueOnce([[
      { id: 1, scope_key: 'general:0:0', valid_from: '2026-01-01', valid_to: null },
    ]]);
    const out = await svc.bulkPreview([{ scope: 'general', valid_from: '2026-09-01', ...BASE }]);
    expect(out.results[0].status).toBe('overlap');
    expect(out.results[0].messages.join(' ')).toMatch(/BD/);
  });
});

describe('createDefault — camino feliz con BD mockeada', () => {
  test('toma lock, verifica solape, inserta, relee y audita; devuelve la fila', async () => {
    const created = { id: 123, scope: 'general', valid_from: '2026-09-01' };
    sequelize.query.mockImplementation(async (sql) => {
      if (/GET_LOCK/.test(sql)) return [[{ ok: 1 }]];
      if (/SELECT id FROM workday_config_defaults/.test(sql)) return [[]]; // sin solape
      if (/^\s*INSERT INTO workday_config_defaults \(/.test(sql)) return [123, 1]; // insertId numérico
      if (/SELECT \* FROM workday_config_defaults WHERE id/.test(sql)) return [[created]];
      if (/workday_config_default_audit/.test(sql)) return [1, 1];
      if (/RELEASE_LOCK/.test(sql)) return [[{}]];
      return [[]];
    });
    const out = await svc.createDefault({ scope: 'general', valid_from: '2026-09-01', ...BASE }, 7);
    expect(out).toMatchObject({ id: 123 });
    const audited = sequelize.query.mock.calls.some(c => /workday_config_default_audit/.test(c[0]));
    expect(audited).toBe(true);
  });
});
