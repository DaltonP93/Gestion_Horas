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

describe('taskDueDate (plazo de la tarea desde start_date)', () => {
  test('due_days = 0 vence el mismo día (no se convierte en el valor por defecto)', () => {
    expect(V.taskDueDate('2026-10-05', 0)).toBe('2026-10-05');
  });
  test('el valor por defecto sólo aplica cuando falta el valor', () => {
    expect(V.DEFAULT_DUE_DAYS).toBe(3);
    expect(V.taskDueDate('2026-10-05', null)).toBe('2026-10-08');
    expect(V.taskDueDate('2026-10-05', undefined)).toBe('2026-10-08');
    expect(V.taskDueDate('2026-10-05', 30)).toBe('2026-11-04');
    expect(V.taskDueDate('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('taskCompletionSets (metadatos de finalización en el PATCH)', () => {
  test.each(['pending', 'in_progress', 'skipped'])('%s → done: registra actor y fecha', (prev) => {
    expect(V.taskCompletionSets({ status: 'done' }, 42, prev))
      .toEqual({ sets: ['completed_at = NOW()', 'completed_by = ?'], vals: [42] });
  });
  test('done → done (reintento): conserva exactamente actor y fecha originales', () => {
    expect(V.taskCompletionSets({ status: 'done' }, 42, 'done')).toEqual({ sets: [], vals: [] });
    expect(V.taskCompletionSets({ status: 'done', notes: 'nueva' }, 42, 'done')).toEqual({ sets: [], vals: [] });
  });
  test('sin estado anterior conocido no se asume "done": registra', () => {
    expect(V.taskCompletionSets({ status: 'done' }, 42, undefined))
      .toEqual({ sets: ['completed_at = NOW()', 'completed_by = ?'], vals: [42] });
  });
  test.each([
    ['pending', 'done'], ['in_progress', 'done'], ['skipped', 'done'], ['pending', 'pending'], ['skipped', 'in_progress'],
  ])('a %s (desde %s): limpia ambos campos', (status, prev) => {
    expect(V.taskCompletionSets({ status }, 42, prev))
      .toEqual({ sets: ['completed_at = NULL', 'completed_by = NULL'], vals: [] });
  });
  test.each([
    [{ notes: 'n' }], [{ due_date: '2026-10-05' }], [{ assignee_id: 7 }], [{ assignee_id: null, notes: null, due_date: null }],
  ])('%j (sin cambio de estado): conserva los metadatos', (patch) => {
    expect(V.taskCompletionSets(patch, 42, 'done')).toEqual({ sets: [], vals: [] });
    expect(V.taskCompletionSets(patch, 42, 'pending')).toEqual({ sets: [], vals: [] });
  });
});

describe('validateTemplateCreate', () => {
  const task = (over = {}) => ({ title: 'Crear cuenta', ...over });
  const body = (over = {}) => ({ name: 'Ingreso', tasks: [task()], ...over });

  test('válido: normaliza, aplica defaults sólo ante ausencia y acepta cero días', () => {
    const r = V.validateTemplateCreate({
      name: '  Ingreso  ', type: 'offboarding', description: null,
      tasks: [
        { title: ' Día cero ', due_days: 0, description: '', default_assignee_role: '' },
        { title: 'Sin plazo', description: 'd', default_assignee_role: 'IT' },
        { title: 'Tope', due_days: V.TEMPLATE_DUE_DAYS_MAX, description: null, default_assignee_role: null },
      ],
    });
    expect(r).toEqual({ ok: true, value: {
      name: 'Ingreso', type: 'offboarding', description: null,
      tasks: [
        { title: 'Día cero', description: null, default_assignee_role: null, due_days: 0 },
        { title: 'Sin plazo', description: 'd', default_assignee_role: 'IT', due_days: 3 },
        { title: 'Tope', description: null, default_assignee_role: null, due_days: 3650 },
      ],
    } });
  });
  test('type ausente → onboarding (contrato actual)', () => {
    expect(V.validateTemplateCreate(body()).value.type).toBe('onboarding');
  });
  test('máximo de due_days documentado', () => {
    expect(V.TEMPLATE_DUE_DAYS_MAX).toBe(3650);
  });

  test.each([
    ['cuerpo no objeto', []],
    ['cuerpo nulo', null],
    ['campo desconocido en la plantilla', body({ active: 0 })],
    ['nombre ausente', body({ name: undefined })],
    ['nombre vacío', body({ name: '   ' })],
    ['nombre no texto', body({ name: 5 })],
    ['nombre demasiado largo', body({ name: 'x'.repeat(121) })],
    ['tipo inválido', body({ type: 'otro' })],
    ['tipo nulo', body({ type: null })],
    ['descripción no texto', body({ description: 5 })],
    ['tasks ausente', body({ tasks: undefined })],
    ['tasks no arreglo (texto)', body({ tasks: 'x' })],
    ['tasks no arreglo (objeto)', body({ tasks: { 0: task() } })],
    ['tasks vacío', body({ tasks: [] })],
    ['tarea no objeto', body({ tasks: ['x'] })],
    ['tarea nula', body({ tasks: [null] })],
    ['título ausente', body({ tasks: [{ due_days: 1 }] })],
    ['título vacío', body({ tasks: [task({ title: '  ' })] })],
    ['título demasiado largo', body({ tasks: [task({ title: 'x'.repeat(201) })] })],
    ['una tarea válida y otra inválida (no se omite)', body({ tasks: [task(), task({ title: '' })] })],
    ['descripción de tarea no texto', body({ tasks: [task({ description: 3 })] })],
    ['rol por defecto no texto', body({ tasks: [task({ default_assignee_role: 1 })] })],
    ['rol por defecto demasiado largo', body({ tasks: [task({ default_assignee_role: 'x'.repeat(61) })] })],
    ['due_days negativo', body({ tasks: [task({ due_days: -1 })] })],
    ['due_days fraccionario', body({ tasks: [task({ due_days: 1.5 })] })],
    ['due_days textual', body({ tasks: [task({ due_days: '5' })] })],
    ['due_days nulo', body({ tasks: [task({ due_days: null })] })],
    ['due_days fuera de rango', body({ tasks: [task({ due_days: 3651 })] })],
    ['due_days no finito', body({ tasks: [task({ due_days: Infinity })] })],
    ['campo desconocido en una tarea', body({ tasks: [task({ sort_order: 9 })] })],
  ])('%s → rechazado', (_label, b) => {
    expect(V.validateTemplateCreate(b).ok).toBe(false);
  });
});
