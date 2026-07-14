/**
 * ruleEngine.js — Constructor de condiciones (motor de reglas parametrizable).
 *
 * Backbone reutilizable por los módulos del sistema (asistencia, hora extra,
 * permisos, vacaciones, liquidación, …). Una regla es "cuando [condiciones]
 * entonces [acción]", definida por el administrador desde una pantalla —sin
 * tocar código— y almacenada en la tabla `condition_rules`.
 *
 * Este archivo provee:
 *  - REGISTRY: catálogo de módulos, sus campos (con tipo) y las acciones
 *    disponibles. Alimenta el builder de la UI y valida/evalúa server-side.
 *  - OPERATORS: operadores por tipo de dato (con aridad).
 *  - evaluateRule / evaluateRules: funciones PURAS y testeables que aplican
 *    las condiciones a un objeto de contexto (los "hechos" de una entidad).
 *  - validateRule: valida una regla contra el registro antes de guardarla.
 *
 * Nada de esto asume una BD: la persistencia vive en routes/rules.js.
 */

// ─── Operadores por tipo de dato ────────────────────────────────
// arity: cuántos valores necesita el operador (0 = ninguno, 1 = value, 2 = value+value2)
const OPERATORS = {
  number: [
    { op: 'eq', label: '=', arity: 1 },
    { op: 'ne', label: '≠', arity: 1 },
    { op: 'gt', label: '>', arity: 1 },
    { op: 'gte', label: '≥', arity: 1 },
    { op: 'lt', label: '<', arity: 1 },
    { op: 'lte', label: '≤', arity: 1 },
    { op: 'between', label: 'entre', arity: 2 },
  ],
  string: [
    { op: 'eq', label: 'es', arity: 1 },
    { op: 'ne', label: 'no es', arity: 1 },
    { op: 'contains', label: 'contiene', arity: 1 },
    { op: 'starts_with', label: 'empieza con', arity: 1 },
    { op: 'in', label: 'está en (lista)', arity: 1 },
  ],
  enum: [
    { op: 'eq', label: 'es', arity: 1 },
    { op: 'ne', label: 'no es', arity: 1 },
    { op: 'in', label: 'está en (lista)', arity: 1 },
  ],
  boolean: [
    { op: 'is_true', label: 'es verdadero', arity: 0 },
    { op: 'is_false', label: 'es falso', arity: 0 },
  ],
  time: [
    { op: 'before', label: 'antes de', arity: 1 },
    { op: 'after', label: 'después de', arity: 1 },
    { op: 'between', label: 'entre', arity: 2 },
  ],
};

// ─── Acciones disponibles ───────────────────────────────────────
// Efectos genéricos que el módulo consumidor interpreta. Los params son
// libres; aquí sólo se declaran para el builder.
const ACTIONS = [
  { type: 'flag', label: 'Marcar / alertar', params: [
    { key: 'severity', label: 'Severidad', type: 'enum', options: ['info', 'warning', 'critical'], default: 'warning' },
    { key: 'message', label: 'Mensaje', type: 'string' },
  ] },
  { type: 'require_approval', label: 'Requerir aprobación', params: [
    { key: 'roles', label: 'Roles que aprueban (coma)', type: 'string', placeholder: 'gth, manager' },
  ] },
  { type: 'notify', label: 'Notificar', params: [
    { key: 'channel', label: 'Canal', type: 'enum', options: ['app', 'email', 'webhook'], default: 'app' },
    { key: 'message', label: 'Mensaje', type: 'string' },
  ] },
  { type: 'block', label: 'Bloquear', params: [
    { key: 'message', label: 'Motivo', type: 'string' },
  ] },
  { type: 'set_value', label: 'Asignar valor', params: [
    { key: 'target', label: 'Campo destino', type: 'string' },
    { key: 'value', label: 'Valor', type: 'string' },
  ] },
  { type: 'adjust', label: 'Ajustar monto/valor', params: [
    { key: 'target', label: 'Campo destino', type: 'string' },
    { key: 'op', label: 'Operación', type: 'enum', options: ['add', 'sub', 'mul'], default: 'mul' },
    { key: 'amount', label: 'Cantidad', type: 'number' },
  ] },
];

// ─── Registro de módulos y sus campos ───────────────────────────
// Cada campo: { key, label, type, options? }. El `type` determina qué
// operadores ofrece el builder y cómo se coacciona el valor al evaluar.
const REGISTRY = {
  asistencia: {
    label: 'Asistencia (marcación diaria)',
    fields: [
      { key: 'worked_minutes', label: 'Minutos trabajados', type: 'number' },
      { key: 'late_minutes', label: 'Minutos de tardanza', type: 'number' },
      { key: 'overtime_minutes', label: 'Minutos de hora extra', type: 'number' },
      { key: 'early_in_minutes', label: 'Entrada anticipada (min)', type: 'number' },
      { key: 'late_out_minutes', label: 'Salida tardía (min)', type: 'number' },
      { key: 'status', label: 'Estado', type: 'enum',
        options: ['present', 'late', 'absent', 'holiday', 'weekend', 'permission'] },
      { key: 'is_holiday', label: 'Es feriado', type: 'boolean' },
      { key: 'is_weekend', label: 'Es fin de semana', type: 'boolean' },
      { key: 'dow', label: 'Día de la semana (1=Dom…7=Sáb)', type: 'enum',
        options: ['1', '2', '3', '4', '5', '6', '7'] },
    ],
  },
  hora_extra: {
    label: 'Hora extra',
    fields: [
      { key: 'overtime_minutes', label: 'Minutos de hora extra', type: 'number' },
      { key: 'is_holiday', label: 'Es feriado', type: 'boolean' },
      { key: 'is_weekend', label: 'Es fin de semana', type: 'boolean' },
      { key: 'is_night', label: 'Es nocturna', type: 'boolean' },
      { key: 'requested', label: 'Fue solicitada', type: 'boolean' },
    ],
  },
  permiso: {
    label: 'Permisos / licencias',
    fields: [
      { key: 'type', label: 'Tipo', type: 'enum',
        options: ['permiso', 'vacacion', 'enfermedad', 'reposo', 'maternidad', 'otro'] },
      { key: 'days', label: 'Cantidad de días', type: 'number' },
      { key: 'with_pay', label: 'Con goce de salario', type: 'boolean' },
    ],
  },
  empleado: {
    label: 'Empleado',
    fields: [
      { key: 'antiguedad_years', label: 'Antigüedad (años)', type: 'number' },
      { key: 'pay_type', label: 'Tipo de pago', type: 'enum', options: ['mensualizado', 'jornalero'] },
      { key: 'children_count', label: 'Cantidad de hijos', type: 'number' },
      { key: 'department', label: 'Departamento', type: 'string' },
      { key: 'salary_base', label: 'Salario base', type: 'number' },
    ],
  },
};

// ─── Helpers ────────────────────────────────────────────────────
const MODULE_KEYS = Object.keys(REGISTRY);
const ACTION_TYPES = ACTIONS.map(a => a.type);

function fieldDef(moduleKey, fieldKey) {
  return REGISTRY[moduleKey]?.fields.find(f => f.key === fieldKey) || null;
}

function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : NaN; }

// "HH:MM" → minutos desde medianoche (o NaN).
function toMin(v) {
  const m = String(v ?? '').match(/(\d{1,2}):(\d{2})/);
  if (!m) { const n = toNum(v); return Number.isFinite(n) ? n : NaN; }
  return (+m[1]) * 60 + (+m[2]);
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'si' || s === 'sí' || s === 'yes';
}

// Lista separada por comas (para operador `in`), normalizada a string.
function toList(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim().toLowerCase());
  return String(v ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

// ─── Evaluación de una condición ────────────────────────────────
// cond: { field, op, value, value2 }. Devuelve booleano. Si el campo del
// contexto es undefined/null, la condición no matchea (salvo is_false).
function evaluateCondition(cond, context, type) {
  const actual = context[cond.field];
  const { op } = cond;

  switch (type) {
    case 'number': {
      const a = toNum(actual), v = toNum(cond.value);
      if (Number.isNaN(a)) return false;
      switch (op) {
        case 'eq': return a === v;
        case 'ne': return a !== v;
        case 'gt': return a > v;
        case 'gte': return a >= v;
        case 'lt': return a < v;
        case 'lte': return a <= v;
        case 'between': { const v2 = toNum(cond.value2); return a >= Math.min(v, v2) && a <= Math.max(v, v2); }
        default: return false;
      }
    }
    case 'time': {
      const a = toMin(actual), v = toMin(cond.value);
      if (Number.isNaN(a)) return false;
      switch (op) {
        case 'before': return a < v;
        case 'after': return a > v;
        case 'between': { const v2 = toMin(cond.value2); return a >= Math.min(v, v2) && a <= Math.max(v, v2); }
        default: return false;
      }
    }
    case 'boolean': {
      const a = toBool(actual);
      switch (op) {
        case 'is_true': return a === true;
        case 'is_false': return a === false;
        default: return false;
      }
    }
    case 'string':
    case 'enum': {
      const a = String(actual ?? '').toLowerCase().trim();
      if (actual == null && op !== 'ne') return false;
      const v = String(cond.value ?? '').toLowerCase().trim();
      switch (op) {
        case 'eq': return a === v;
        case 'ne': return a !== v;
        case 'contains': return a.includes(v);
        case 'starts_with': return a.startsWith(v);
        case 'in': return toList(cond.value).includes(a);
        default: return false;
      }
    }
    default: return false;
  }
}

// ─── Evaluación de una regla completa ───────────────────────────
// rule: { module, match_type: 'all'|'any', conditions: [...], action_type, action_params }
// Devuelve { matched, action_type, action_params, rule }.
function evaluateRule(rule, context) {
  const conds = Array.isArray(rule.conditions) ? rule.conditions : [];
  const results = conds.map(c => {
    const def = fieldDef(rule.module, c.field);
    if (!def) return false;
    return evaluateCondition(c, context, def.type);
  });
  const matched = conds.length === 0
    ? false
    : (rule.match_type === 'any' ? results.some(Boolean) : results.every(Boolean));
  return {
    matched,
    action_type: matched ? rule.action_type : null,
    action_params: matched ? (rule.action_params || {}) : null,
    rule_id: rule.id ?? null,
    rule_name: rule.name ?? null,
  };
}

// Evalúa varias reglas (mismo módulo) en orden de prioridad, devolviendo las
// que matchean. El consumidor decide cómo combinar las acciones.
function evaluateRules(rules, context) {
  return (rules || [])
    .slice()
    .sort((a, b) => (a.priority || 0) - (b.priority || 0))
    .map(r => evaluateRule(r, context))
    .filter(r => r.matched);
}

// ─── Validación de una regla contra el registro ─────────────────
// Devuelve { valid, errors: [] }. Usado antes de persistir.
function validateRule(rule) {
  const errors = [];
  if (!rule || typeof rule !== 'object') return { valid: false, errors: ['Regla inválida'] };
  if (!rule.name || !String(rule.name).trim()) errors.push('Falta el nombre');
  if (!MODULE_KEYS.includes(rule.module)) errors.push(`Módulo inválido: ${rule.module}`);
  if (!ACTION_TYPES.includes(rule.action_type)) errors.push(`Acción inválida: ${rule.action_type}`);
  if (rule.match_type && !['all', 'any'].includes(rule.match_type)) errors.push('match_type debe ser all|any');
  const conds = Array.isArray(rule.conditions) ? rule.conditions : null;
  if (!conds || conds.length === 0) {
    errors.push('Al menos una condición es requerida');
  } else if (MODULE_KEYS.includes(rule.module)) {
    conds.forEach((c, i) => {
      const def = fieldDef(rule.module, c.field);
      if (!def) { errors.push(`Condición ${i + 1}: campo desconocido '${c.field}'`); return; }
      const ops = OPERATORS[def.type] || [];
      const opDef = ops.find(o => o.op === c.op);
      if (!opDef) { errors.push(`Condición ${i + 1}: operador '${c.op}' no válido para ${def.type}`); return; }
      if (opDef.arity >= 1 && (c.value === undefined || c.value === null || c.value === '')) {
        errors.push(`Condición ${i + 1}: falta el valor`);
      }
      if (opDef.arity === 2 && (c.value2 === undefined || c.value2 === null || c.value2 === '')) {
        errors.push(`Condición ${i + 1}: falta el segundo valor`);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

// Esquema para el builder de la UI (módulos, campos, operadores, acciones).
function getSchema() {
  return {
    modules: MODULE_KEYS.map(k => ({ key: k, label: REGISTRY[k].label, fields: REGISTRY[k].fields })),
    operators: OPERATORS,
    actions: ACTIONS,
    match_types: [
      { key: 'all', label: 'Se cumplen TODAS (Y)' },
      { key: 'any', label: 'Se cumple ALGUNA (O)' },
    ],
  };
}

module.exports = {
  REGISTRY, OPERATORS, ACTIONS, MODULE_KEYS, ACTION_TYPES,
  evaluateCondition, evaluateRule, evaluateRules, validateRule, getSchema, fieldDef,
};
