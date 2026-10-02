'use strict';

/**
 * appraisalTemplateValidation.js — validación ESTRICTA (pura, sin base) del
 * CRUD de plantillas de Evaluaciones (/api/appraisals/templates).
 *
 * Límites derivados del esquema real (database/migrations/034_appraisals.sql):
 *   - appraisal_templates.name y appraisal_template_criteria.name VARCHAR(120)
 *     → hasta 120 caracteres (code points, como cuenta MySQL);
 *   - description TEXT → hasta 65535 bytes UTF-8;
 *   - weight DECIMAL(5,2) → 0.01 a 999.99, con hasta 2 decimales (más
 *     decimales se rechazan en lugar de redondearse en silencio);
 *   - scale_min/scale_max TINYINT → enteros; además se acotan a 0–10 porque
 *     la UI de puntuación muestra un botón por valor (el formulario ya usaba
 *     hasta 10) y la escala no es editable después del alta.
 * El máximo de 50 criterios responde al modelo: cada puntuación debe enviar
 * exactamente todos los criterios de la plantilla (un formulario por criterio).
 *
 * Todas las funciones devuelven `{ ok: true, value }` o `{ ok: false, error }`;
 * nada inválido se omite ni se reinterpreta.
 */

const TEMPLATE_NAME_MAX = 120;
const CRITERION_NAME_MAX = 120;
const TEXT_MAX_BYTES = 65535;
const SCALE_LOWER = 0;
const SCALE_UPPER = 10;
const SCALE_DEFAULT_MIN = 1;   // DEFAULT del esquema
const SCALE_DEFAULT_MAX = 5;   // DEFAULT del esquema
const CRITERIA_MAX = 50;
const WEIGHT_MIN = 0.01;
const WEIGHT_MAX = 999.99;
const WEIGHT_DEFAULT = 1;      // DEFAULT del esquema y contrato previo

const LIST_FIELDS = new Set(['all']);
const CREATE_FIELDS = new Set(['name', 'description', 'scale_min', 'scale_max', 'criteria']);
const CRITERION_FIELDS = new Set(['name', 'description', 'weight']);
/** Edición: sólo metadatos. Criterios y escala requieren un diseño separado. */
const UPDATE_FIELDS = new Set(['name', 'description', 'active']);

const fail = (error) => ({ ok: false, error });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.has(k));
const codePoints = (s) => [...s].length;

/** Nombre obligatorio: texto recortado de 1 a `max` caracteres, o null. */
function requiredName(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && codePoints(s) <= max ? s : null;
}

/** Texto opcional para columnas TEXT: ausente/null/'' → null; si no es texto o excede → error. */
function optionalText(v) {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string' || Buffer.byteLength(v, 'utf8') > TEXT_MAX_BYTES) return fail('invalid_text');
  return { ok: true, value: v };
}

/** Clave para detectar criterios duplicados: sin acentos, espacios colapsados, minúsculas. */
function normalizeCriterionName(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function validateTemplateListQuery(query) {
  const q = query || {};
  const extra = unknownKeys(q, LIST_FIELDS);
  if (extra.length) return fail(`Parámetros no permitidos: ${extra.join(', ')}`);
  if (q.all === undefined) return { ok: true, value: { all: false } };
  if (q.all !== '1') return fail('all inválido (sólo all=1)');
  return { ok: true, value: { all: true } };
}

function scaleValue(v, fallback) {
  if (v === undefined) return fallback;
  return Number.isInteger(v) && v >= SCALE_LOWER && v <= SCALE_UPPER ? v : null;
}

function validateCriterion(c, i) {
  const at = `criteria[${i}]`;
  if (!isPlainObject(c)) return fail(`${at} debe ser un objeto`);
  const extra = unknownKeys(c, CRITERION_FIELDS);
  if (extra.length) return fail(`${at}: campos no permitidos: ${extra.join(', ')}`);
  const name = requiredName(c.name, CRITERION_NAME_MAX);
  if (name === null) return fail(`${at}.name inválido (texto de 1 a ${CRITERION_NAME_MAX} caracteres)`);
  const description = optionalText(c.description);
  if (!description.ok) return fail(`${at}.description inválida (texto de hasta ${TEXT_MAX_BYTES} bytes)`);
  let weight = WEIGHT_DEFAULT;
  if (c.weight !== undefined) {
    const w = c.weight;
    if (typeof w !== 'number' || !Number.isFinite(w) || w < WEIGHT_MIN || w > WEIGHT_MAX || Number(w.toFixed(2)) !== w) {
      return fail(`${at}.weight inválido (número de ${WEIGHT_MIN} a ${WEIGHT_MAX} con hasta 2 decimales)`);
    }
    weight = w;
  }
  return { ok: true, value: { name, description: description.value, weight } };
}

/**
 * Alta: valida TODO (plantilla y cada criterio) antes de escribir. Un criterio
 * inválido o duplicado rechaza el alta completa.
 */
function validateTemplateCreate(body) {
  if (!isPlainObject(body)) return fail('El cuerpo debe ser un objeto');
  const extra = unknownKeys(body, CREATE_FIELDS);
  if (extra.length) return fail(`Campos no permitidos: ${extra.join(', ')}`);
  const name = requiredName(body.name, TEMPLATE_NAME_MAX);
  if (name === null) return fail(`name inválido (texto de 1 a ${TEMPLATE_NAME_MAX} caracteres)`);
  const description = optionalText(body.description);
  if (!description.ok) return fail(`description inválida (texto de hasta ${TEXT_MAX_BYTES} bytes)`);
  const scaleMin = scaleValue(body.scale_min, SCALE_DEFAULT_MIN);
  const scaleMax = scaleValue(body.scale_max, SCALE_DEFAULT_MAX);
  if (scaleMin === null || scaleMax === null) return fail(`Escala inválida (enteros de ${SCALE_LOWER} a ${SCALE_UPPER})`);
  if (scaleMin >= scaleMax) return fail('La escala mínima debe ser menor que la máxima');
  if (!Array.isArray(body.criteria) || !body.criteria.length) return fail('Se requiere al menos un criterio (criteria debe ser un arreglo)');
  if (body.criteria.length > CRITERIA_MAX) return fail(`Demasiados criterios (máximo ${CRITERIA_MAX})`);
  const criteria = [];
  const seen = new Set();
  for (let i = 0; i < body.criteria.length; i += 1) {
    const r = validateCriterion(body.criteria[i], i);
    if (!r.ok) return r;
    const key = normalizeCriterionName(r.value.name);
    if (seen.has(key)) return fail(`criteria[${i}]: nombre de criterio duplicado`);
    seen.add(key);
    criteria.push(r.value);
  }
  return { ok: true, value: { name, description: description.value, scaleMin, scaleMax, criteria } };
}

/** Edición: nombre, descripción y estado activo (0/1/true/false, convención del API). */
function validateTemplateUpdate(body) {
  if (!isPlainObject(body)) return fail('El cuerpo debe ser un objeto');
  const extra = unknownKeys(body, UPDATE_FIELDS);
  if (extra.length) return fail(`Campos no permitidos: ${extra.join(', ')}`);
  const keys = Object.keys(body).filter((k) => body[k] !== undefined);
  if (!keys.length) return fail('Sin cambios');
  const value = {};
  if (body.name !== undefined) {
    const name = requiredName(body.name, TEMPLATE_NAME_MAX);
    if (name === null) return fail(`name inválido (texto de 1 a ${TEMPLATE_NAME_MAX} caracteres)`);
    value.name = name;
  }
  if (body.description !== undefined) {
    const d = optionalText(body.description);
    if (!d.ok) return fail(`description inválida (texto de hasta ${TEXT_MAX_BYTES} bytes)`);
    value.description = d.value;
  }
  if (body.active !== undefined) {
    const a = body.active;
    if (![0, 1, true, false].includes(a)) return fail('active debe ser 0/1');
    value.active = a === true || a === 1 ? 1 : 0;
  }
  return { ok: true, value };
}

/** Nombres de los campos que cambian de verdad respecto de la fila guardada. */
function templateChanges(row, value) {
  const out = [];
  if ('name' in value && value.name !== row.name) out.push('name');
  if ('description' in value && value.description !== (row.description ?? null)) out.push('description');
  if ('active' in value && value.active !== Number(row.active)) out.push('active');
  return out;
}

module.exports = {
  TEMPLATE_NAME_MAX, CRITERION_NAME_MAX, TEXT_MAX_BYTES,
  SCALE_LOWER, SCALE_UPPER, SCALE_DEFAULT_MIN, SCALE_DEFAULT_MAX,
  CRITERIA_MAX, WEIGHT_MIN, WEIGHT_MAX, WEIGHT_DEFAULT,
  normalizeCriterionName, templateChanges,
  validateTemplateListQuery, validateTemplateCreate, validateTemplateUpdate,
};
