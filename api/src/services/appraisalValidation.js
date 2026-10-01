'use strict';

/**
 * appraisalValidation.js — validación ESTRICTA (pura, sin base) de las
 * entradas de /api/appraisals y reglas puras del flujo.
 *
 * Todas las validaciones devuelven `{ ok: true, value }` o `{ ok: false, error }`
 * y nunca reinterpretan la entrada: ids por utils/strictId (sin '1e2',
 * '0x10', '-1', '0'…), fechas civiles reales y acotadas, enums cerrados y
 * sólo los campos permitidos. Ninguna entrada inválida se omite en silencio.
 */

const { parsePositiveId } = require('../utils/strictId');
const { parseCivilDate } = require('./onboardingValidation');

const APPRAISAL_STATUSES = new Set(['draft', 'self_pending', 'manager_pending', 'hr_review', 'closed']);
const SCORER_ROLES = new Set(['self', 'manager', 'hr']);
/** Estado en el que cada rol puede puntuar, y al que avanza. */
const SCORE_STATE = {
  self: { from: 'self_pending', to: 'manager_pending' },
  manager: { from: 'manager_pending', to: 'hr_review' },
  hr: { from: 'hr_review', to: 'hr_review' },
};
/** Estados desde los que se puede cerrar y qué puntajes usa el cálculo. */
const CLOSE_FROM = { manager_pending: 'self', hr_review: 'manager' };

const PERIOD_MAX = 60;           // appraisals.period_label VARCHAR(60)
const COMMENT_MAX = 2000;
const DATE_MIN = '2000-01-01';
const DATE_MAX = '2100-12-31';
const LIST_LIMIT_MAX = 100;
const LIST_LIMIT_DEFAULT = 50;

const CREATE_FIELDS = new Set(['template_id', 'employee_id', 'reviewer_id', 'period_label', 'due_date']);
const SCORE_FIELDS = new Set(['scorer_role', 'scores']);
const SCORE_ITEM_FIELDS = new Set(['criteria_id', 'score', 'comment']);
const CLOSE_FIELDS = new Set(['hr_comment']);

const fail = (error) => ({ ok: false, error });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.has(k));

/** Entero >= 0 canónico ('0', '12'; no '012', '1e2', '-1'). */
function parseNonNegativeInt(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** Texto opcional: ausente/null/'' → null; si no es texto o excede → error. */
function optionalText(v, max) {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string' || v.length > max) return fail('invalid_text');
  return { ok: true, value: v };
}

/** Fecha civil acotada [DATE_MIN, DATE_MAX] o null. */
function boundedDate(v) {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  const d = parseCivilDate(v);
  if (!d || d < DATE_MIN || d > DATE_MAX) return fail('invalid_date');
  return { ok: true, value: d };
}

function validateListQuery(query) {
  const q = query || {};
  const out = { limit: LIST_LIMIT_DEFAULT, offset: 0 };
  if (q.status !== undefined && q.status !== '') {
    if (typeof q.status !== 'string' || !APPRAISAL_STATUSES.has(q.status)) return fail('status inválido');
    out.status = q.status;
  }
  if (q.employee_id !== undefined && q.employee_id !== '') {
    const id = parsePositiveId(q.employee_id);
    if (id === null) return fail('employee_id inválido');
    out.employeeId = id;
  }
  if (q.period !== undefined && q.period !== '') {
    if (typeof q.period !== 'string' || q.period.length > PERIOD_MAX) return fail('period inválido');
    out.period = q.period;
  }
  if (q.limit !== undefined) {
    const n = parseNonNegativeInt(q.limit);
    if (n === null || n < 1 || n > LIST_LIMIT_MAX) return fail(`limit inválido (1 a ${LIST_LIMIT_MAX})`);
    out.limit = n;
  }
  if (q.offset !== undefined) {
    const n = parseNonNegativeInt(q.offset);
    if (n === null) return fail('offset inválido');
    out.offset = n;
  }
  return { ok: true, value: out };
}

function validateCreate(body) {
  if (!isPlainObject(body)) return fail('El cuerpo debe ser un objeto');
  const extra = unknownKeys(body, CREATE_FIELDS);
  if (extra.length) return fail(`Campos no permitidos: ${extra.join(', ')}`);
  const templateId = parsePositiveId(body.template_id);
  const employeeId = parsePositiveId(body.employee_id);
  if (templateId === null || employeeId === null) return fail('template_id y employee_id deben ser ids válidos');
  let reviewerId = null;
  if (body.reviewer_id !== undefined && body.reviewer_id !== null && body.reviewer_id !== '') {
    reviewerId = parsePositiveId(body.reviewer_id);
    if (reviewerId === null) return fail('reviewer_id inválido');
  }
  const period = typeof body.period_label === 'string' ? body.period_label.trim() : '';
  if (!period || period.length > PERIOD_MAX) return fail(`period_label inválido (texto de 1 a ${PERIOD_MAX} caracteres)`);
  const due = boundedDate(body.due_date);
  if (!due.ok) return fail(`due_date inválida (YYYY-MM-DD entre ${DATE_MIN} y ${DATE_MAX})`);
  return { ok: true, value: { templateId, employeeId, reviewerId, periodLabel: period, dueDate: due.value } };
}

/**
 * Cuerpo del envío de puntajes. Formato y tipos; la correspondencia con los
 * criterios y la escala de la plantilla se verifica con `checkScoresAgainstTemplate`.
 */
function validateScoreBody(body) {
  if (!isPlainObject(body)) return fail('El cuerpo debe ser un objeto');
  const extra = unknownKeys(body, SCORE_FIELDS);
  if (extra.length) return fail(`Campos no permitidos: ${extra.join(', ')}`);
  if (typeof body.scorer_role !== 'string' || !SCORER_ROLES.has(body.scorer_role)) return fail('scorer_role inválido');
  if (!Array.isArray(body.scores) || !body.scores.length) return fail('scores[] es requerido');
  const scores = [];
  const seen = new Set();
  for (let i = 0; i < body.scores.length; i += 1) {
    const s = body.scores[i];
    const at = `scores[${i}]`;
    if (!isPlainObject(s)) return fail(`${at} debe ser un objeto`);
    const bad = unknownKeys(s, SCORE_ITEM_FIELDS);
    if (bad.length) return fail(`${at}: campos no permitidos: ${bad.join(', ')}`);
    const criteriaId = parsePositiveId(s.criteria_id);
    if (criteriaId === null) return fail(`${at}.criteria_id inválido`);
    if (seen.has(criteriaId)) return fail(`${at}: criterio duplicado`);
    seen.add(criteriaId);
    if (typeof s.score !== 'number' || !Number.isInteger(s.score)) return fail(`${at}.score debe ser un entero`);
    const comment = optionalText(s.comment, COMMENT_MAX);
    if (!comment.ok) return fail(`${at}.comment inválido (texto de hasta ${COMMENT_MAX} caracteres)`);
    scores.push({ criteriaId, score: s.score, comment: comment.value });
  }
  return { ok: true, value: { scorerRole: body.scorer_role, scores } };
}

/** Los criterios enviados deben ser EXACTAMENTE los de la plantilla y cada puntaje estar en escala. */
function checkScoresAgainstTemplate(scores, criteriaIds, scaleMin, scaleMax) {
  const expected = new Set(criteriaIds.map(Number));
  if (scores.length !== expected.size || scores.some((s) => !expected.has(s.criteriaId))) {
    return fail('Los criterios deben coincidir exactamente con los de la plantilla');
  }
  const min = Number(scaleMin); const max = Number(scaleMax);
  const out = scores.find((s) => s.score < min || s.score > max);
  if (out) return fail(`Puntaje fuera de escala (${min} a ${max})`);
  return { ok: true, value: scores };
}

function validateCloseBody(body) {
  if (body === undefined || body === null) return { ok: true, value: { hrComment: null } };
  if (!isPlainObject(body)) return fail('El cuerpo debe ser un objeto');
  const extra = unknownKeys(body, CLOSE_FIELDS);
  if (extra.length) return fail(`Campos no permitidos: ${extra.join(', ')}`);
  const c = optionalText(body.hr_comment, COMMENT_MAX);
  if (!c.ok) return fail(`hr_comment inválido (texto de hasta ${COMMENT_MAX} caracteres)`);
  return { ok: true, value: { hrComment: c.value } };
}

/** Promedio ponderado redondeado a 2 decimales (o null sin puntajes). Mismo cálculo que antes. */
function computeFinalScore(rows) {
  if (!rows.length) return null;
  const totalWeight = rows.reduce((acc, r) => acc + parseFloat(r.weight), 0);
  const weighted = rows.reduce((acc, r) => acc + Number(r.score) * parseFloat(r.weight), 0);
  return totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) / 100 : null;
}

module.exports = {
  APPRAISAL_STATUSES, SCORER_ROLES, SCORE_STATE, CLOSE_FROM,
  PERIOD_MAX, COMMENT_MAX, DATE_MIN, DATE_MAX, LIST_LIMIT_MAX,
  parseNonNegativeInt,
  validateListQuery, validateCreate, validateScoreBody, checkScoresAgainstTemplate,
  validateCloseBody, computeFinalScore,
};
