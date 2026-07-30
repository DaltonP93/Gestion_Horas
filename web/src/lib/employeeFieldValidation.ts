/**
 * employeeFieldValidation.ts — validaciones cliente para la ficha del
 * empleado. Espeja las reglas del backend (api/src/services/employeeFieldValidation.js)
 * para dar feedback inmediato sin depender del round-trip. El backend
 * sigue siendo la fuente de verdad.
 */

// Ambas variantes llevan las dos claves opcionales; permite discriminar el
// `ok` incluso cuando el proyecto compila sin `strict: true`.
export type ValidationResult =
  | { ok: true;  value: string | number | null; error?: undefined }
  | { ok: false; error: string; value?: undefined }

const GENDERS  = new Set(['', 'M', 'F', 'O'])
const PAYTYPES = new Set(['mensualizado', 'jornalero'])
const STATUSES = new Set(['active', 'inactive', 'suspended'])

const REX_DOC   = /^[0-9.\-\s]{4,20}$/
const REX_IPS   = /^[0-9\-\s]{3,20}$/
const REX_DATE  = /^\d{4}-\d{2}-\d{2}$/
const REX_MAIL  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const REX_PHONE = /^[+()\d\s\-.]{4,30}$/

// Columnas NOT NULL en `employees` (init.sql + migraciones 043/044). Espeja
// la allowlist del backend para evitar que la UI acepte un blank que luego
// el driver rechazaría con 500.
const NOT_NULLABLE = new Set([
  'first_name', 'last_name',
  'pay_type', 'children_count', 'antiguedad_rate',
])

const LABELS: Record<string, string> = {
  first_name: 'Nombre', last_name: 'Apellido',
  pay_type: 'Tipo de pago', children_count: 'N° de hijos',
  antiguedad_rate: 'Antigüedad (años)',
  salary_base:     'Salario base',
}
function labelOf(field: string): string { return LABELS[field] || field }

export function validateEmployeeField(field: string, raw: unknown): ValidationResult {
  // Cadena vacía y null → limpiar el campo (salvo NOT NULL).
  if (raw === undefined || raw === null || raw === '') {
    if (NOT_NULLABLE.has(field)) return err(`${labelOf(field)} es requerido`)
    return { ok: true, value: null }
  }
  const v = typeof raw === 'string' ? raw.trim() : raw

  switch (field) {
    case 'first_name':
    case 'last_name': {
      const s = String(v)
      if (s.length < 1 || s.length > 80) return err('longitud 1..80')
      return { ok: true, value: s }
    }
    case 'employee_number':
    case 'position': {
      const s = String(v)
      if (s.length > 120) return err('máximo 120 caracteres')
      return { ok: true, value: s }
    }
    case 'email':
      if (!REX_MAIL.test(String(v))) return err('email inválido')
      if (String(v).length > 120) return err('email demasiado largo')
      return { ok: true, value: String(v) }
    case 'phone':
      if (!REX_PHONE.test(String(v))) return err('teléfono inválido')
      return { ok: true, value: String(v) }
    case 'birth_date':
    case 'hire_date':
      if (!REX_DATE.test(String(v))) return err('formato esperado YYYY-MM-DD')
      return { ok: true, value: String(v) }
    case 'status':
      if (!STATUSES.has(String(v))) return err('estado inválido')
      return { ok: true, value: String(v) }

    // Legales
    case 'document_number':
      if (!REX_DOC.test(String(v))) return err('C.I. inválida')
      return { ok: true, value: String(v).replace(/\s+/g, '') }
    case 'ips_number':
      if (!REX_IPS.test(String(v))) return err('N° IPS inválido')
      return { ok: true, value: String(v).replace(/\s+/g, '') }
    case 'salary_base': {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) return err('salario debe ser ≥ 0')
      if (n > 1e12) return err('salario fuera de rango')
      return { ok: true, value: n }
    }
    case 'children_count': {
      const n = Number(v)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 30)
        return err('hijos: entero 0..30')
      return { ok: true, value: n }
    }
    case 'antiguedad_rate': {
      // PR-A: interpretado ahora como AÑOS de antigüedad (entero ≥ 0).
      const n = Number(v)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 80) {
        return err('antigüedad (años): entero 0..80')
      }
      return { ok: true, value: n }
    }
    case 'gender':
      if (!GENDERS.has(String(v))) return err('género inválido')
      return { ok: true, value: String(v) || null }
    case 'pay_type':
      if (!PAYTYPES.has(String(v))) return err('tipo de pago inválido')
      return { ok: true, value: String(v) }
    case 'schedule_id': {
      const n = Number(v)
      if (!Number.isInteger(n) || n <= 0) return err('horario inválido')
      return { ok: true, value: n }
    }
    default:
      return err(`campo no editable: ${field}`)
  }
}

const LEGAL_FIELDS = new Set([
  'document_number', 'ips_number', 'salary_base',
  'gender', 'pay_type', 'children_count', 'antiguedad_rate',
])
export function isLegalField(field: string): boolean {
  return LEGAL_FIELDS.has(field)
}

function err(msg: string): ValidationResult { return { ok: false, error: msg } }
