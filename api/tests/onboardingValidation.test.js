'use strict';

/**
 * onboardingValidation.test.js — validación estricta (pura) de las entradas
 * de /api/onboarding. La conducta HTTP con MySQL real (roles, alcance,
 * carreras, escrituras y auditoría) está en tests/it/onboarding.it.test.js.
 */
const V = require('../src/services/onboardingValidation');

describe('parseCivilDate / addDaysCivil', () => {
  test('acepta sólo fechas civiles reales YYYY-MM-DD', () => {
    expect(V.parseCivilDate('2026-12-31')).toBe('2026-12-31');
    expect(V.parseCivilDate('2028-02-29')).toBe('2028-02-29');
    for (const bad of ['2026-02-30', '2027-02-29', '30/12/2026', '2026-1-05', '2026-13-01', '', null, 20261231, '2026-12-31T00:00:00Z']) {
      expect([bad, V.parseCivilDate(bad)]).toEqual([bad, null]);
    }
  });
  test('suma días sin corrimiento por zona horaria (incluye fin de mes y año bisiesto)', () => {
    expect(V.addDaysCivil('2026-03-01', 3)).toBe('2026-03-04');
    expect(V.addDaysCivil('2026-03-01', 30)).toBe('2026-03-31');
    expect(V.addDaysCivil('2028-02-27', 2)).toBe('2028-02-29');
    expect(V.addDaysCivil('2026-12-30', 3)).toBe('2027-01-02');
  });
});

describe('validateTaskPatch', () => {
  test('acepta los campos permitidos con valores válidos (y null donde corresponde)', () => {
    expect(V.validateTaskPatch({ status: 'in_progress' })).toEqual({ ok: true, value: { status: 'in_progress' } });
    expect(V.validateTaskPatch({ assignee_id: '12', due_date: '2026-12-31', notes: 'ok' }))
      .toEqual({ ok: true, value: { assignee_id: 12, due_date: '2026-12-31', notes: 'ok' } });
    expect(V.validateTaskPatch({ assignee_id: null, due_date: null, notes: null }))
      .toEqual({ ok: true, value: { assignee_id: null, due_date: null, notes: null } });
  });
  test.each([
    ['cuerpo no objeto', []],
    ['cuerpo nulo', null],
    ['sin cambios', {}],
    ['campo no permitido', { status: 'done', process_id: 3 }],
    ['estado inválido', { status: 'bogus' }],
    ['estado no texto', { status: 1 }],
    ['responsable no entero', { assignee_id: 'abc' }],
    ['responsable exponencial', { assignee_id: '1e2' }],
    ['responsable hexadecimal', { assignee_id: '0x10' }],
    ['responsable negativo', { assignee_id: -3 }],
    ['responsable decimal', { assignee_id: 1.5 }],
    ['fecha inexistente', { due_date: '2026-02-30' }],
    ['fecha en otro formato', { due_date: '30/12/2026' }],
    ['notas objeto', { notes: { x: 1 } }],
    ['notas demasiado largas', { notes: 'x'.repeat(V.NOTES_MAX + 1) }],
  ])('%s → rechazado', (_label, body) => {
    expect(V.validateTaskPatch(body).ok).toBe(false);
  });
});

describe('validateProcessCreate', () => {
  const ok = { template_id: 3, employee_id: '7', start_date: '2026-03-01' };
  test('válido: ids canónicos, fecha real y mapa de responsables', () => {
    const r = V.validateProcessCreate({ ...ok, assignees: { 11: '5', 12: null } });
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ templateId: 3, employeeId: 7, startDate: '2026-03-01' });
    expect([...r.value.assignees]).toEqual([[11, 5]]);
  });
  test.each([
    ['empleado no canónico', { ...ok, employee_id: '1e2' }],
    ['plantilla ausente', { ...ok, template_id: undefined }],
    ['fecha inexistente', { ...ok, start_date: '2026-02-30' }],
    ['assignees no objeto', { ...ok, assignees: [1] }],
    ['assignees con tarea no canónica', { ...ok, assignees: { '07': 5 } }],
    ['assignees con responsable inválido', { ...ok, assignees: { 11: 'abc' } }],
  ])('%s → rechazado', (_label, body) => {
    expect(V.validateProcessCreate(body).ok).toBe(false);
  });
});

describe('validateProcessListQuery', () => {
  test('status ausente → active (contrato actual); vacío → todos', () => {
    expect(V.validateProcessListQuery({})).toEqual({ ok: true, value: { status: 'active' } });
    expect(V.validateProcessListQuery({ status: '' })).toEqual({ ok: true, value: {} });
    expect(V.validateProcessListQuery({ status: 'completed', type: 'offboarding', employee_id: '9' }))
      .toEqual({ ok: true, value: { status: 'completed', type: 'offboarding', employeeId: 9 } });
  });
  test.each([
    [{ status: 'bogus' }], [{ status: ['active'] }], [{ type: 'otro' }], [{ employee_id: '1e2' }],
  ])('%j → rechazado', (q) => {
    expect(V.validateProcessListQuery(q).ok).toBe(false);
  });
});

describe('validateTemplateUpdate', () => {
  test('válido y normalizado', () => {
    expect(V.validateTemplateUpdate({ name: '  Ingreso  ', active: true })).toEqual({ ok: true, value: { name: 'Ingreso', active: 1 } });
    expect(V.validateTemplateUpdate({ active: 0 })).toEqual({ ok: true, value: { active: 0 } });
  });
  test.each([
    [{}], [{ active: 'si' }], [{ name: '' }], [{ name: 'x'.repeat(121) }], [{ description: 5 }], [{ type: 'offboarding' }],
  ])('%j → rechazado', (body) => {
    expect(V.validateTemplateUpdate(body).ok).toBe(false);
  });
});
