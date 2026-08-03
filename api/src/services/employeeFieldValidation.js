/**
 * employeeFieldValidation.js — validación y normalización de campos
 * editables de la ficha del empleado.
 *
 * Contrato:
 *   validate(field, value) → { ok: true, value }
 *                          | { ok: false, error }
 *
 * - value === '' o null/undefined = intención de limpiar el campo (NULL).
 * - No confía en el cliente: cada campo tiene reglas explícitas.
 *
 * Notas de diseño (PR-B):
 * - `antiguedad_rate` deja de ser editable: se calcula al leer desde
 *   `hire_date` (services/antiguedad.js). Cualquier intento de update
 *   se rechaza aquí para que la superficie legacy quede sellada.
 * - `pay_type` valida sólo el formato del código; la existencia y el
 *   estado activo se comprueban en el handler contra el catálogo
 *   administrable `payment_types` (services/paymentTypes.js).
 * - `salary_base` exige entero no-negativo (nada de decimales) y admite
 *   null / vacío cuando el permiso lo autorice.
 */

const GENDERS  = new Set(['', 'M', 'F', 'O']);
const STATUSES = new Set(['active', 'inactive', 'suspended']);

// Documento (C.I.) y N° IPS: sólo dígitos y guiones, longitud razonable.
const REX_DOC       = /^[0-9.\-\s]{4,20}$/;
const REX_IPS       = /^[0-9\-\s]{3,20}$/;
const REX_DATE      = /^\d{4}-\d{2}-\d{2}$/;
const REX_MAIL      = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REX_PHONE     = /^[+()\d\s\-.]{4,30}$/;
const REX_PAY_CODE  = /^[a-z][a-z0-9_]{0,39}$/; // slug administrable
const REX_INT_ONLY  = /^-?\d+$/;                // dígitos, sin separadores

// Normaliza el salario a entero PYG. Acepta number entero o string de
// dígitos. Cualquier punto o coma se rechaza: en es-PY "1.000" son mil
// guaraníes pero en un DECIMAL de MySQL es uno — la ambigüedad no se
// resuelve mirando el string, así que el contrato de la API es entero
// limpio y el cliente normaliza antes de enviar.
function normalizeSalary(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && Number.isInteger(raw) ? raw : null;
  }
  const s = String(raw).trim();
  if (!REX_INT_ONLY.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

function isBlank(v) { return v === undefined || v === null || v === ''; }

// Columnas NOT NULL en `employees` (init.sql + migraciones 043/044/068).
const NOT_NULLABLE = new Set([
  'first_name', 'last_name',
  'pay_type', 'children_count',
]);

// Campos que NO pueden editarse desde la ficha: se derivan/calculan.
// `antiguedad_rate` queda cerrado desde PR-B; se computa en runtime
// a partir de `hire_date`. Se conserva la columna por compatibilidad
// pero no admite escritura por la API pública.
const READ_ONLY_FIELDS = new Set([
  'antiguedad_rate',
]);

function validate(field, value) {
  if (READ_ONLY_FIELDS.has(field)) {
    return err(`${labelOf(field)} se calcula automáticamente desde la fecha de ingreso`);
  }

  if (isBlank(value)) {
    if (NOT_NULLABLE.has(field)) return err(`${labelOf(field)} es requerido`);
    return { ok: true, value: null };
  }
  const v = typeof value === 'string' ? value.trim() : value;

  switch (field) {
    case 'first_name':
    case 'last_name':
      if (String(v).length < 1 || String(v).length > 80) return err('longitud 1..80');
      return { ok: true, value: String(v) };

    case 'employee_number':
    case 'position':
      if (String(v).length > 120) return err('máximo 120 caracteres');
      return { ok: true, value: String(v) };

    case 'email':
      if (!REX_MAIL.test(String(v))) return err('email inválido');
      if (String(v).length > 120) return err('email demasiado largo');
      return { ok: true, value: String(v) };

    case 'phone':
      if (!REX_PHONE.test(String(v))) return err('teléfono inválido');
      return { ok: true, value: String(v) };

    case 'birth_date':
    case 'hire_date':
      if (!REX_DATE.test(String(v))) return err('formato esperado YYYY-MM-DD');
      return { ok: true, value: String(v) };

    case 'status':
      if (!STATUSES.has(String(v))) return err('estado inválido');
      return { ok: true, value: String(v) };

    // ── Legales (MTESS / IPS) ───────────────────────────────────
    case 'document_number':
      if (!REX_DOC.test(String(v))) return err('C.I. inválida');
      return { ok: true, value: String(v).replace(/\s+/g, '') };

    case 'ips_number':
      if (!REX_IPS.test(String(v))) return err('N° IPS inválido');
      return { ok: true, value: String(v).replace(/\s+/g, '') };

    case 'salary_base': {
      // Entero no-negativo. Rechaza separadores de miles ("3.500.000",
      // "1,000"), centavos reales y strings no numéricas. La UI envía el
      // entero limpio; el formato con puntos es sólo visualización.
      const n = normalizeSalary(v);
      if (n === null) return err('salario: entero sin separadores (≥ 0)');
      if (n < 0) return err('salario debe ser ≥ 0');
      if (n > 1e12) return err('salario fuera de rango');
      return { ok: true, value: n };
    }

    case 'children_count': {
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 30) return err('hijos: entero 0..30');
      return { ok: true, value: n };
    }

    case 'gender':
      if (!GENDERS.has(String(v))) return err('género inválido');
      return { ok: true, value: String(v) || null };

    case 'pay_type':
      // Sólo comprueba formato del código (slug). La existencia + estado
      // activo se validan contra el catálogo en el handler (paymentTypes.js).
      if (!REX_PAY_CODE.test(String(v))) return err('tipo de pago inválido');
      return { ok: true, value: String(v) };

    // schedule_id se maneja aparte (viene como número/opción).
    case 'schedule_id': {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) return err('horario inválido');
      return { ok: true, value: n };
    }

    default:
      return { ok: false, error: `campo no editable: ${field}` };
  }
}

function err(msg) { return { ok: false, error: msg }; }

const LABELS = {
  first_name: 'Nombre', last_name: 'Apellido',
  pay_type: 'Tipo de pago', children_count: 'N° de hijos',
  antiguedad_rate: 'Antigüedad',
  salary_base:     'Salario base',
};
function labelOf(field) { return LABELS[field] || field; }

// Campo cuyo valor es sensible y NUNCA debe ir a logs con el valor claro.
const SENSITIVE_VALUE = new Set(['salary_base']);
function auditValueOf(field, value) {
  if (SENSITIVE_VALUE.has(field)) return null;
  return value;
}

module.exports = {
  validate, auditValueOf, SENSITIVE_VALUE,
  NOT_NULLABLE, READ_ONLY_FIELDS,
  normalizeSalary,
};
