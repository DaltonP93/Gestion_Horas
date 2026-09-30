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
const TEMPLATE_CREATE_FIELDS = new Set(['name', 'type', 'description', 'tasks']);
const TEMPLATE_TASK_FIELDS = new Set(['title', 'description', 'default_assignee_role', 'due_days']);
const NOTES_MAX = 2000;
const TEMPLATE_NAME_MAX = 120;          // onboarding_templates.name VARCHAR(120)
const TEMPLATE_TASK_TITLE_MAX = 200;    // onboarding_template_tasks.title VARCHAR(200)
const TEMPLATE_TASK_ROLE_MAX = 60;      // default_assignee_role VARCHAR(60)
/** Plazo máximo de una tarea de plantilla (días desde start_date, ~10 años). */
const TEMPLATE_DUE_DAYS_MAX = 3650;
/** Plazo por defecto: sólo cuando el valor falta (0 es "el mismo día"). */
const DEFAULT_DUE_DAYS = 3;

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

/** Vencimiento de una tarea: start_date + due_days; 0 = el mismo día. */
function taskDueDate(startDate, dueDays) {
  return addDaysCivil(startDate, Number(dueDays ?? DEFAULT_DUE_DAYS));
}

/**
 * Metadatos de finalización para el UPDATE del PATCH de tarea:
 *   - a `done`: `completed_at = NOW()` y `completed_by = actor`;
 *   - a cualquier otro estado: ambos a NULL;
 *   - sin cambio de estado: no se tocan.
 */
function taskCompletionSets(patch, actorId) {
  if (!('status' in patch)) return { sets: [], vals: [] };
  if (patch.status === 'done') return { sets: ['completed_at = NOW()', 'completed_by = ?'], vals: [actorId] };
  return { sets: ['completed_at = NULL', 'completed_by = NULL'], vals: [] };
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

/** Texto opcional: `undefined`/`null`/'' → null; si no es texto → error. */
function optionalText(v, max) {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string' || (max && v.length > max)) return fail('invalid_text');
  return { ok: true, value: v };
}

function validateTemplateTask(task, i) {
  const at = `tasks[${i}]`;
  if (!isPlainObject(task)) return fail(`${at} debe ser un objeto`);
  const extra = Object.keys(task).filter((k) => !TEMPLATE_TASK_FIELDS.has(k));
  if (extra.length) return fail(`${at}: campos no permitidos: ${extra.join(', ')}`);
  const title = typeof task.title === 'string' ? task.title.trim() : '';
  if (!title || title.length > TEMPLATE_TASK_TITLE_MAX) return fail(`${at}.title inválido (texto de 1 a ${TEMPLATE_TASK_TITLE_MAX} caracteres)`);
  const description = optionalText(task.description);
  if (!description.ok) return fail(`${at}.description inválida`);
  const role = optionalText(task.default_assignee_role, TEMPLATE_TASK_ROLE_MAX);
  if (!role.ok) return fail(`${at}.default_assignee_role inválido (texto de hasta ${TEMPLATE_TASK_ROLE_MAX} caracteres)`);
  let dueDays = DEFAULT_DUE_DAYS;
  if (task.due_days !== undefined) {
    const d = task.due_days;
    if (!Number.isInteger(d) || d < 0 || d > TEMPLATE_DUE_DAYS_MAX) return fail(`${at}.due_days inválido (entero de 0 a ${TEMPLATE_DUE_DAYS_MAX})`);
    dueDays = d;
  }
  return { ok: true, value: { title, description: description.value, default_assignee_role: role.value, due_days: dueDays } };
}

/**
 * Alta de plantilla: valida TODO (plantilla y cada tarea) antes de escribir.
 * Ninguna tarea inválida se omite en silencio: un error rechaza el alta.
 */
function validateTemplateCreate(body) {
  if (!isPlainObject(body)) return fail('El cuerpo debe ser un objeto');
  const extra = Object.keys(body).filter((k) => !TEMPLATE_CREATE_FIELDS.has(k));
  if (extra.length) return fail(`Campos no permitidos: ${extra.join(', ')}`);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > TEMPLATE_NAME_MAX) return fail(`name inválido (texto de 1 a ${TEMPLATE_NAME_MAX} caracteres)`);
  const type = body.type === undefined ? 'onboarding' : body.type;
  if (typeof type !== 'string' || !PROCESS_TYPES.has(type)) return fail('type inválido (onboarding u offboarding)');
  const description = optionalText(body.description);
  if (!description.ok) return fail('description inválida');
  if (!Array.isArray(body.tasks) || !body.tasks.length) return fail('Se requiere al menos una tarea (tasks debe ser un arreglo)');
  const tasks = [];
  for (let i = 0; i < body.tasks.length; i += 1) {
    const r = validateTemplateTask(body.tasks[i], i);
    if (!r.ok) return r;
    tasks.push(r.value);
  }
  return { ok: true, value: { name, type, description: description.value, tasks } };
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
  TEMPLATE_DUE_DAYS_MAX, DEFAULT_DUE_DAYS,
  parseCivilDate, addDaysCivil, taskDueDate, taskCompletionSets,
  validateTaskPatch, validateProcessCreate, validateProcessListQuery,
  validateTemplateCreate, validateTemplateUpdate,
};
