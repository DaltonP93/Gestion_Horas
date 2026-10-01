'use strict';

/**
 * appraisalValidation.test.js — validación estricta (pura) de /api/appraisals
 * y la ruta con base simulada (rechazos sin consultar). La conducta HTTP con
 * MySQL real (alcance, estados, carreras, escrituras y auditoría) está en
 * tests/it/appraisals.it.test.js.
 */
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn(), transaction: jest.fn() } }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_r, _s, n) => n(),
  authorize: () => (_r, _s, n) => n(),
}));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const { sequelize } = require('../src/config/database');
const V = require('../src/services/appraisalValidation');

beforeEach(() => jest.clearAllMocks());

describe('validateListQuery', () => {
  test('por defecto y válidos', () => {
    expect(V.validateListQuery({})).toEqual({ ok: true, value: { limit: 50, offset: 0 } });
    expect(V.validateListQuery({ status: 'hr_review', employee_id: '7', period: '2026', limit: '100', offset: '0' }))
      .toEqual({ ok: true, value: { status: 'hr_review', employeeId: 7, period: '2026', limit: 100, offset: 0 } });
    expect(V.validateListQuery({ status: '', employee_id: '', period: '' })).toEqual({ ok: true, value: { limit: 50, offset: 0 } });
  });
  test.each([
    [{ status: 'bogus' }], [{ status: ['self_pending'] }], [{ employee_id: '1e2' }], [{ employee_id: '0' }],
    [{ limit: '0' }], [{ limit: '101' }], [{ limit: '5.5' }], [{ limit: ['5'] }], [{ offset: '-1' }], [{ offset: '01' }],
    [{ period: 'x'.repeat(61) }], [{ period: { a: 1 } }],
  ])('%j → rechazado', (q) => {
    expect(V.validateListQuery(q).ok).toBe(false);
  });
});

describe('validateCreate', () => {
  const ok = { template_id: 3, employee_id: '7', reviewer_id: 9, period_label: ' 2026-S1 ', due_date: '2026-12-31' };
  test('válido y normalizado; reviewer y fecha opcionales', () => {
    expect(V.validateCreate(ok)).toEqual({ ok: true, value: { templateId: 3, employeeId: 7, reviewerId: 9, periodLabel: '2026-S1', dueDate: '2026-12-31' } });
    expect(V.validateCreate({ ...ok, reviewer_id: undefined, due_date: undefined }).value).toMatchObject({ reviewerId: null, dueDate: null });
    expect(V.validateCreate({ ...ok, reviewer_id: null, due_date: '' }).value).toMatchObject({ reviewerId: null, dueDate: null });
  });
  test.each([
    ['cuerpo no objeto', []],
    ['campo desconocido', { ...ok, status: 'closed' }],
    ['template exponencial', { ...ok, template_id: '1e2' }],
    ['template negativo', { ...ok, template_id: -1 }],
    ['employee cero', { ...ok, employee_id: 0 }],
    ['employee texto', { ...ok, employee_id: 'abc' }],
    ['reviewer hexadecimal', { ...ok, reviewer_id: '0x10' }],
    ['period ausente', { ...ok, period_label: undefined }],
    ['period vacío', { ...ok, period_label: '  ' }],
    ['period largo', { ...ok, period_label: 'x'.repeat(61) }],
    ['period no texto', { ...ok, period_label: 2026 }],
    ['fecha inexistente', { ...ok, due_date: '2026-02-30' }],
    ['fecha formato', { ...ok, due_date: '30/12/2026' }],
    ['fecha antes del mínimo', { ...ok, due_date: '1999-12-31' }],
    ['fecha después del máximo', { ...ok, due_date: '2101-01-01' }],
  ])('%s → rechazado', (_l, body) => {
    expect(V.validateCreate(body).ok).toBe(false);
  });
});

describe('validateScoreBody / checkScoresAgainstTemplate', () => {
  const item = (criteria_id, score, extra = {}) => ({ criteria_id, score, ...extra });
  test('válido: comentario opcional normalizado', () => {
    expect(V.validateScoreBody({ scorer_role: 'self', scores: [item(1, 3, { comment: 'ok' }), item(2, 4, { comment: '' })] }))
      .toEqual({ ok: true, value: { scorerRole: 'self', scores: [{ criteriaId: 1, score: 3, comment: 'ok' }, { criteriaId: 2, score: 4, comment: null }] } });
  });
  test.each([
    ['cuerpo no objeto', null],
    ['campo desconocido', { scorer_role: 'self', scores: [item(1, 3)], status: 'x' }],
    ['scorer_role inválido', { scorer_role: 'boss', scores: [item(1, 3)] }],
    ['scores vacío', { scorer_role: 'self', scores: [] }],
    ['scores no arreglo', { scorer_role: 'self', scores: { 0: item(1, 3) } }],
    ['item no objeto', { scorer_role: 'self', scores: [3] }],
    ['item con campo desconocido', { scorer_role: 'self', scores: [item(1, 3, { weight: 2 })] }],
    ['criteria_id no canónico', { scorer_role: 'self', scores: [item('1e2', 3)] }],
    ['criterio duplicado', { scorer_role: 'self', scores: [item(1, 3), item(1, 4)] }],
    ['puntaje fraccionario', { scorer_role: 'self', scores: [item(1, 2.5)] }],
    ['puntaje textual', { scorer_role: 'self', scores: [item(1, '3')] }],
    ['puntaje nulo', { scorer_role: 'self', scores: [item(1, null)] }],
    ['comentario largo', { scorer_role: 'self', scores: [item(1, 3, { comment: 'x'.repeat(V.COMMENT_MAX + 1) })] }],
    ['comentario no texto', { scorer_role: 'self', scores: [item(1, 3, { comment: 5 })] }],
  ])('%s → rechazado', (_l, body) => {
    expect(V.validateScoreBody(body).ok).toBe(false);
  });

  const s = (pairs) => pairs.map(([criteriaId, score]) => ({ criteriaId, score, comment: null }));
  test('criterios exactos y dentro de escala', () => {
    expect(V.checkScoresAgainstTemplate(s([[1, 1], [2, 5]]), [1, 2], 1, 5).ok).toBe(true);
  });
  test.each([
    ['criterio ajeno', [[1, 3], [9, 3]]],
    ['criterio faltante', [[1, 3]]],
    ['criterio de más', [[1, 3], [2, 3], [3, 3]]],
    ['sobre la escala', [[1, 6], [2, 3]]],
    ['bajo la escala', [[1, 0], [2, 3]]],
  ])('%s → rechazado', (_l, pairs) => {
    expect(V.checkScoresAgainstTemplate(s(pairs), [1, 2], 1, 5).ok).toBe(false);
  });
});

describe('validateCloseBody / computeFinalScore / estados', () => {
  test('cierre: cuerpo vacío o comentario; rechaza campos desconocidos y textos largos', () => {
    expect(V.validateCloseBody(undefined)).toEqual({ ok: true, value: { hrComment: null } });
    expect(V.validateCloseBody({})).toEqual({ ok: true, value: { hrComment: null } });
    expect(V.validateCloseBody({ hr_comment: 'ok' })).toEqual({ ok: true, value: { hrComment: 'ok' } });
    expect(V.validateCloseBody({ final_score: 5 }).ok).toBe(false);
    expect(V.validateCloseBody({ hr_comment: 'x'.repeat(V.COMMENT_MAX + 1) }).ok).toBe(false);
    expect(V.validateCloseBody([]).ok).toBe(false);
  });
  test('promedio ponderado como antes', () => {
    expect(V.computeFinalScore([{ score: 4, weight: '1.00' }, { score: 2, weight: '2.00' }])).toBe(2.67);
    expect(V.computeFinalScore([])).toBeNull();
  });
  test('flujo: estado requerido y avance por rol; cierre sólo desde manager_pending/hr_review', () => {
    expect(V.SCORE_STATE).toEqual({
      self: { from: 'self_pending', to: 'manager_pending' },
      manager: { from: 'manager_pending', to: 'hr_review' },
      hr: { from: 'hr_review', to: 'hr_review' },
    });
    expect(V.CLOSE_FROM).toEqual({ manager_pending: 'self', hr_review: 'manager' });
  });
});

describe('ruta (base simulada): entradas inválidas → 400 sin consultar ni abrir transacción', () => {
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
  test.each([
    ['get', '/', { query: { limit: '1000' } }],
    ['get', '/:id', { params: { id: '1e2' } }],
    ['get', '/employee/:empId', { params: { empId: '-1' } }],
    ['post', '/', { body: { template_id: 1, employee_id: 1, period_label: 'x', extra: 1 } }],
    ['post', '/:id/score', { params: { id: '7' }, body: { scorer_role: 'self', scores: [{ criteria_id: 1, score: '3' }] } }],
    ['post', '/:id/close', { params: { id: '0' }, body: {} }],
  ])('%s %s', async (method, path, req) => {
    const res = mkRes();
    await handler(method, path)({ user: USER, query: {}, params: {}, body: undefined, ...req }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: expect.any(String), code: 'INVALID_INPUT' });
    expect(sequelize.query).not.toHaveBeenCalled();
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });
});
