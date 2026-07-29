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
 */

const GENDERS  = new Set(['', 'M', 'F', 'O']);
const PAYTYPES = new Set(['mensualizado', 'jornalero']);
const STATUSES = new Set(['active', 'inactive', 'suspended']);

// Documento (C.I.) y N° IPS: sólo dígitos y guiones, longitud razonable.
const REX_DOC  = /^[0-9.\-\s]{4,20}$/;
const REX_IPS  = /^[0-9\-\s]{3,20}$/;
const REX_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REX_MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REX_PHONE = /^[+()\d\s\-.]{4,30}$/;

function isBlank(v) { return v === undefined || v === null || v === ''; }
function trim(v) { return typeof v === 'string' ? v.trim() : v; }

// Columnas NOT NULL en `employees` (init.sql + migraciones 043/044): no
// pueden limpiarse. Se rechaza blank aquí para evitar 500 desde el driver.
const NOT_NULLABLE = new Set([
  'first_name', 'last_name',
  'pay_type', 'children_count', 'antiguedad_rate',
]);

function validate(field, value) {
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
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return err('salario debe ser ≥ 0');
      if (n > 1e12) return err('salario fuera de rango');
      return { ok: true, value: n };
    }

    case 'children_count': {
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 30) return err('hijos: entero 0..30');
      return { ok: true, value: n };
    }

    case 'antiguedad_rate': {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) return err('antigüedad: 0..100');
      return { ok: true, value: n };
    }

    case 'gender':
      if (!GENDERS.has(String(v))) return err('género inválido');
      return { ok: true, value: String(v) || null };

    case 'pay_type':
      if (!PAYTYPES.has(String(v))) return err('tipo de pago inválido');
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
};
function labelOf(field) { return LABELS[field] || field; }

// Campo cuyo valor es sensible y NUNCA debe ir a logs con el valor claro.
const SENSITIVE_VALUE = new Set(['salary_base']);
function auditValueOf(field, value) {
  if (SENSITIVE_VALUE.has(field)) return null;
  return value;
}

module.exports = { validate, auditValueOf, SENSITIVE_VALUE, trim, NOT_NULLABLE };
