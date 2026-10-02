'use strict';

/**
 * appraisalTemplateValidation.test.js — validación ESTRICTA (pura) del CRUD de
 * plantillas de Evaluaciones y de la ruta con base simulada (rechazos sin
 * consultar, 500 genérico con rollback). La conducta HTTP con MySQL real
 * (roles, escrituras, auditoría, carreras) está en
 * tests/it/appraisalTemplates.it.test.js.
 *
 * Límites derivados del esquema (migración 034):
 *   appraisal_templates.name / appraisal_template_criteria.name VARCHAR(120)
 *   description TEXT (65535 bytes) · weight DECIMAL(5,2) · scale_* TINYINT
 */
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn(), transaction: jest.fn() } }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_r, _s, n) => n(),
  authorize: () => (_r, _s, n) => n(),
}));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const { sequelize } = require('../src/config/database');
const audit = require('../src/services/audit');
const T = require('../src/services/appraisalTemplateValidation');

beforeEach(() => jest.clearAllMocks());

describe('límites (compatibles con el esquema)', () => {
  test('constantes', () => {
    expect(T.TEMPLATE_NAME_MAX).toBe(120);
    expect(T.CRITERION_NAME_MAX).toBe(120);
    expect(T.TEXT_MAX_BYTES).toBe(65535);
    expect([T.SCALE_LOWER, T.SCALE_UPPER]).toEqual([0, 10]);
    expect([T.SCALE_DEFAULT_MIN, T.SCALE_DEFAULT_MAX]).toEqual([1, 5]);
    expect(T.CRITERIA_MAX).toBe(50);
    expect([T.WEIGHT_MIN, T.WEIGHT_MAX, T.WEIGHT_DEFAULT]).toEqual([0.01, 999.99, 1]);
  });
});

describe('validateTemplateListQuery', () => {
  test('sin parámetros → sólo activas; all=1 → todas', () => {
    expect(T.validateTemplateListQuery({})).toEqual({ ok: true, value: { all: false } });
    expect(T.validateTemplateListQuery(undefined)).toEqual({ ok: true, value: { all: false } });
    expect(T.validateTemplateListQuery({ all: '1' })).toEqual({ ok: true, value: { all: true } });
  });
  test.each([
    [{ all: '0' }], [{ all: 'true' }], [{ all: '' }], [{ all: ' 1' }], [{ all: '01' }], [{ all: 1 }],
    [{ all: ['1', '1'] }], [{ all: { x: '1' } }], [{ foo: '1' }], [{ all: '1', status: 'x' }],
  ])('%j → rechazado', (q) => {
    expect(T.validateTemplateListQuery(q).ok).toBe(false);
  });
});

describe('validateTemplateCreate', () => {
  const crit = (name, extra = {}) => ({ name, ...extra });
  const ok = { name: '  Anual 2026  ', description: 'desc', scale_min: 1, scale_max: 5, criteria: [crit(' Calidad ', { weight: 2.5, description: 'd' }), crit('Equipo')] };

  test('válido: nombre recortado, defaults de escala y peso, orden conservado', () => {
    expect(T.validateTemplateCreate(ok)).toEqual({
      ok: true,
      value: {
        name: 'Anual 2026', description: 'desc', scaleMin: 1, scaleMax: 5,
        criteria: [{ name: 'Calidad', description: 'd', weight: 2.5 }, { name: 'Equipo', description: null, weight: 1 }],
      },
    });
    const min = T.validateTemplateCreate({ name: 'X', criteria: [crit('A')] });
    expect(min.value).toMatchObject({ description: null, scaleMin: 1, scaleMax: 5 });
    expect(T.validateTemplateCreate({ ...ok, description: '' }).value.description).toBeNull();
    expect(T.validateTemplateCreate({ ...ok, description: null }).value.description).toBeNull();
  });

  test('bordes aceptados: 120 caracteres (code points), 65535 bytes, escala 0–10, pesos 0.01 y 999.99, 50 criterios', () => {
    expect(T.validateTemplateCreate({ ...ok, name: 'é'.repeat(120) }).ok).toBe(true);
    expect(T.validateTemplateCreate({ ...ok, name: '😀'.repeat(120) }).ok).toBe(true);
    expect(T.validateTemplateCreate({ ...ok, description: 'x'.repeat(65535) }).ok).toBe(true);
    expect(T.validateTemplateCreate({ ...ok, scale_min: 0, scale_max: 10 }).ok).toBe(true);
    expect(T.validateTemplateCreate({ ...ok, criteria: [crit('A', { weight: 0.01 }), crit('B', { weight: 999.99 })] }).ok).toBe(true);
    const many = Array.from({ length: 50 }, (_, i) => crit(`C${i}`));
    expect(T.validateTemplateCreate({ ...ok, criteria: many }).ok).toBe(true);
    expect(T.validateTemplateCreate({ ...ok, criteria: [crit('é'.repeat(120))] }).ok).toBe(true);
  });

  test.each([
    ['cuerpo arreglo', []],
    ['cuerpo nulo', null],
    ['campo desconocido', { ...ok, active: 1 }],
    ['nombre ausente', { ...ok, name: undefined }],
    ['nombre vacío tras recortar', { ...ok, name: '   ' }],
    ['nombre demasiado largo', { ...ok, name: 'x'.repeat(121) }],
    ['nombre no texto', { ...ok, name: 5 }],
    ['descripción no texto', { ...ok, description: 5 }],
    ['descripción demasiado larga (bytes)', { ...ok, description: 'é'.repeat(32768) }],
    ['escala textual', { ...ok, scale_min: '1' }],
    ['escala fraccionaria', { ...ok, scale_max: 4.5 }],
    ['escala nula', { ...ok, scale_min: null }],
    ['escala bajo el límite', { ...ok, scale_min: -1 }],
    ['escala sobre el límite', { ...ok, scale_max: 11 }],
    ['mínimo igual al máximo', { ...ok, scale_min: 5, scale_max: 5 }],
    ['mínimo mayor que el máximo', { ...ok, scale_min: 6, scale_max: 5 }],
    ['criterios ausentes', { ...ok, criteria: undefined }],
    ['criterios no arreglo', { ...ok, criteria: { 0: crit('A') } }],
    ['criterios vacíos', { ...ok, criteria: [] }],
    ['demasiados criterios', { ...ok, criteria: Array.from({ length: 51 }, (_, i) => crit(`C${i}`)) }],
    ['criterio no objeto', { ...ok, criteria: ['Calidad'] }],
    ['criterio con clave desconocida', { ...ok, criteria: [crit('A', { sort_order: 1 })] }],
    ['criterio sin nombre', { ...ok, criteria: [{ weight: 1 }] }],
    ['criterio con nombre vacío', { ...ok, criteria: [crit('  ')] }],
    ['criterio con nombre largo', { ...ok, criteria: [crit('x'.repeat(121))] }],
    ['criterio con nombre no texto', { ...ok, criteria: [crit(7)] }],
    ['criterio con descripción no texto', { ...ok, criteria: [crit('A', { description: 1 })] }],
    ['peso cero', { ...ok, criteria: [crit('A', { weight: 0 })] }],
    ['peso negativo', { ...ok, criteria: [crit('A', { weight: -1 })] }],
    ['peso textual', { ...ok, criteria: [crit('A', { weight: '1' })] }],
    ['peso nulo (Infinity serializado)', { ...ok, criteria: [crit('A', { weight: null })] }],
    ['peso no finito', { ...ok, criteria: [crit('A', { weight: Infinity })] }],
    ['peso sobre DECIMAL(5,2)', { ...ok, criteria: [crit('A', { weight: 1000 })] }],
    ['peso con más de 2 decimales', { ...ok, criteria: [crit('A', { weight: 0.001 })] }],
    ['un criterio válido y otro inválido (no se omite)', { ...ok, criteria: [crit('A'), crit('')] }],
    ['nombres duplicados exactos', { ...ok, criteria: [crit('Calidad'), crit('Calidad')] }],
    ['duplicados por espacios y mayúsculas', { ...ok, criteria: [crit('Trabajo en equipo'), crit('  trabajo   EN equipo ')] }],
    ['duplicados por acentos', { ...ok, criteria: [crit('Comunicación'), crit('comunicacion')] }],
  ])('%s → rechazado', (_l, body) => {
    expect(T.validateTemplateCreate(body).ok).toBe(false);
  });
});

describe('validateTemplateUpdate (sólo nombre, descripción y estado)', () => {
  test('válidos y normalizados', () => {
    expect(T.validateTemplateUpdate({ name: ' Nuevo ' })).toEqual({ ok: true, value: { name: 'Nuevo' } });
    expect(T.validateTemplateUpdate({ description: null })).toEqual({ ok: true, value: { description: null } });
    expect(T.validateTemplateUpdate({ description: '' })).toEqual({ ok: true, value: { description: null } });
    expect(T.validateTemplateUpdate({ active: true }).value).toEqual({ active: 1 });
    expect(T.validateTemplateUpdate({ active: 1 }).value).toEqual({ active: 1 });
    expect(T.validateTemplateUpdate({ active: false }).value).toEqual({ active: 0 });
    expect(T.validateTemplateUpdate({ active: 0 }).value).toEqual({ active: 0 });
    expect(T.validateTemplateUpdate({ name: 'A', description: 'B', active: 0 }).value).toEqual({ name: 'A', description: 'B', active: 0 });
  });
  test.each([
    ['cuerpo vacío', {}],
    ['cuerpo arreglo', [{ name: 'A' }]],
    ['cuerpo nulo', null],
    ['clave desconocida', { name: 'A', scale_min: 1 }],
    ['criterios (requiere diseño separado)', { criteria: [] }],
    ['escala (requiere diseño separado)', { scale_max: 7 }],
    ['nombre vacío', { name: '  ' }],
    ['nombre largo', { name: 'x'.repeat(121) }],
    ['nombre nulo', { name: null }],
    ['descripción no texto', { description: 3 }],
    ['descripción demasiado larga', { description: 'x'.repeat(65536) }],
    ['active textual', { active: '1' }],
    ['active 2', { active: 2 }],
    ['active nulo', { active: null }],
  ])('%s → rechazado', (_l, body) => {
    expect(T.validateTemplateUpdate(body).ok).toBe(false);
  });
});

describe('normalizeCriterionName / templateChanges', () => {
  test('normalización para detectar duplicados', () => {
    expect(T.normalizeCriterionName('  Trabajo   EN  Équipo ')).toBe('trabajo en equipo');
  });
  test('sólo los campos que cambian de verdad', () => {
    const row = { name: 'A', description: null, active: 1 };
    expect(T.templateChanges(row, { name: 'A', description: null, active: 1 })).toEqual([]);
    expect(T.templateChanges(row, { name: 'B' })).toEqual(['name']);
    expect(T.templateChanges(row, { description: 'x', active: 0 })).toEqual(['description', 'active']);
    expect(T.templateChanges({ ...row, active: '1' }, { active: 1 })).toEqual([]);
  });
});

describe('ruta /templates (base simulada)', () => {
  const router = require('../src/routes/appraisals');
  const handler = (method, path) => {
    const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
  };
  const mkRes = () => {
    const res = {};
    res.status = jest.fn(function () { return this; });
    res.json = jest.fn(function () { return this; });
    return res;
  };
  const USER = { id: 1, role: 'admin' };
  const validCreate = { name: 'X', criteria: [{ name: 'A' }] };

  test.each([
    ['get', '/templates', { query: { all: 'true' } }],
    ['get', '/templates', { query: { foo: '1' } }],
    ['get', '/templates/:id', { params: { id: '1e2' } }],
    ['get', '/templates/:id', { params: { id: '0x10' } }],
    ['post', '/templates', { body: { ...validCreate, criteria: [{ name: 'A' }, { name: '' }] } }],
    ['post', '/templates', { body: { ...validCreate, extra: 1 } }],
    ['put', '/templates/:id', { params: { id: '-1' }, body: { name: 'A' } }],
    ['put', '/templates/:id', { params: { id: '7' }, body: {} }],
    ['put', '/templates/:id', { params: { id: '7' }, body: { active: 'yes' } }],
    ['delete', '/templates/:id', { params: { id: '1.5' } }],
  ])('%s %s inválido → 400 INVALID_INPUT sin consultar ni abrir transacción', async (method, path, req) => {
    const res = mkRes();
    await handler(method, path)({ user: USER, query: {}, params: {}, body: undefined, ...req }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: expect.any(String), code: 'INVALID_INPUT' });
    expect(sequelize.query).not.toHaveBeenCalled();
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  test.each([
    ['post', '/templates', { body: validCreate }],
    ['put', '/templates/:id', { params: { id: '7' }, body: { name: 'B' } }],
    ['delete', '/templates/:id', { params: { id: '7' } }],
  ])('%s %s: error de base → 500 genérico, rollback y sin auditoría', async (method, path, req) => {
    const tx = { commit: jest.fn(), rollback: jest.fn().mockResolvedValue() };
    sequelize.transaction.mockResolvedValue(tx);
    sequelize.query.mockRejectedValue(new Error('ER_SECRET_DETAIL: host interno'));
    const res = mkRes();
    await handler(method, path)({ user: USER, query: {}, params: {}, body: undefined, ...req }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Error interno' });
    expect(tx.rollback).toHaveBeenCalled();
    expect(tx.commit).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
