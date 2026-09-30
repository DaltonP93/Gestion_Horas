'use strict';

/**
 * onboardingValidation.js — validación ESTRICTA (pura, sin base) de las
 * entradas de /api/onboarding.
 *
 * Todas las funciones devuelven `{ ok: true, value }` o `{ ok: false, error }`
 * y nunca reinterpretan la entrada: ids por utils/strictId (sin '1e2', '0x10',
 * '007'…), fechas civiles `YYYY-MM-DD` que existen en el calendario, enums
 * cerrados y sólo los campos permitidos.
 */

const { parsePositiveId } = require('../utils/strictId');

const TASK_STATUSES = new Set(['pending', 'in_progress', 'done', 'skipped']);
const PROCESS_STATUSES = new Set(['active', 'completed', 'cancelled']);
const PROCESS_TYPES = new Set(['onboarding', 'offboarding']);
const TASK_PATCH_FIELDS = new Set(['status', 'assignee_id', 'notes', 'due_date']);
const TEMPLATE_UPDATE_FIELDS = new Set(['name', 'description', 'active']);
const NOTES_MAX = 2000;
const TEMPLATE_NAME_MAX = 120;

const fail = (error) => ({ ok: false, error });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Fecha civil `YYYY-MM-DD` que existe (rechaza 2026-02-30, 30/12/2026…). */
function parseCivilDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return v;
}

/** Suma días a una fecha civil sin depender de la zona horaria del proceso. */
function addDaysCivil(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** `null` o id canónico. */
function parseNullableId(v) {
  if (v === null) return { ok: true, value: null };
  const id = parsePositiveId(v);
  return id === null ? fail('invalid_id') : { ok: true, value: id };
}

function validateTaskPatch(body) {
  if (!isPlainObject(body)) return fail('El cuerpo debe ser un objeto');
  const keys = Object.keys(body);
  const extra = keys.filter((k) => !TASK_PATCH_FIELDS.has(k));
  if (extra.length) return fail(`Campos no permitidos: ${extra.join(', ')}`);
  if (!keys.length) return fail('Sin cambios');
  const value = {};
  if ('status' in body) {
    if (typeof body.status !== 'string' || !TASK_STATUSES.has(body.status)) return fail('Estado inválido');
    value.status = body.status;
  }
  if ('assignee_id' in body) {
    const r = parseNullableId(body.assignee_id);
    if (!r.ok) return fail('Responsable inválido');
    value.assignee_id = r.value;
  }
  if ('due_date' in body) {
    if (body.due_date === null) value.due_date = null;
    else {
      const d = parseCivilDate(body.due_date);
      if (!d) return fail('Fecha inválida (formato YYYY-MM-DD)');
      value.due_date = d;
    }
  }
  if ('notes' in body) {
    if (body.notes === null) value.notes = null;
    else if (typeof body.notes !== 'string' || body.notes.length > NOTES_MAX) return fail(`Notas inválidas (texto de hasta ${NOTES_MAX} caracteres)`);
    else value.notes = body.notes;
  }
  return { ok: true, value };
}

function validateProcessCreate(body) {
  if (!isPlainObject(body)) return fail('El cuerpo debe ser un objeto');
  const templateId = parsePositiveId(body.template_id);
  const employeeId = parsePositiveId(body.employee_id);
  if (templateId === null || employeeId === null) return fail('template_id y employee_id deben ser ids válidos');
  const startDate = parseCivilDate(body.start_date);
  if (!startDate) return fail('start_date inválida (formato YYYY-MM-DD)');
  const assignees = new Map();
  if (body.assignees !== undefined && body.assignees !== null) {
    if (!isPlainObject(body.assignees)) return fail('assignees debe ser un objeto');
    for (const [k, v] of Object.entries(body.assignees)) {
      const taskId = parsePositiveId(k);
      if (taskId === null) return fail('assignees con tarea inválida');
      const r = parseNullableId(v);
      if (!r.ok) return fail('assignees con responsable inválido');
      if (r.value !== null) assignees.set(taskId, r.value);
    }
  }
  return { ok: true, value: { templateId, employeeId, startDate, assignees } };
}

/** Filtros del listado. `status` ausente → 'active' (contrato actual); '' → todos. */
function validateProcessListQuery(query) {
  const q = query || {};
  const out = {};
  const status = q.status === undefined ? 'active' : q.status;
  if (typeof status !== 'string' || (status !== '' && !PROCESS_STATUSES.has(status))) return fail('status inválido');
  if (status) out.status = status;
  if (q.type !== undefined && q.type !== '') {
    if (typeof q.type !== 'string' || !PROCESS_TYPES.has(q.type)) return fail('type inválido');
    out.type = q.type;
  }
  if (q.employee_id !== undefined && q.employee_id !== '') {
    const id = parsePositiveId(q.employee_id);
    if (id === null) return fail('employee_id inválido');
    out.employeeId = id;
  }
  return { ok: true, value: out };
}

function validateTemplateUpdate(body) {
  if (!isPlainObject(body)) return fail('El cuerpo debe ser un objeto');
  const keys = Object.keys(body).filter((k) => body[k] !== undefined);
  const extra = keys.filter((k) => !TEMPLATE_UPDATE_FIELDS.has(k));
  if (extra.length) return fail(`Campos no permitidos: ${extra.join(', ')}`);
  if (!keys.length) return fail('Sin cambios');
  const value = {};
  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > TEMPLATE_NAME_MAX) return fail('name inválido');
    value.name = body.name.trim();
  }
  if ('description' in body) {
    if (body.description !== null && typeof body.description !== 'string') return fail('description inválida');
    value.description = body.description;
  }
  if ('active' in body) {
    const a = body.active;
    if (![0, 1, true, false].includes(a)) return fail('active debe ser 0/1');
    value.active = a === true || a === 1 ? 1 : 0;
  }
  return { ok: true, value };
}

module.exports = {
  TASK_STATUSES, PROCESS_STATUSES, PROCESS_TYPES, NOTES_MAX,
  parseCivilDate, addDaysCivil,
  validateTaskPatch, validateProcessCreate, validateProcessListQuery, validateTemplateUpdate,
};
