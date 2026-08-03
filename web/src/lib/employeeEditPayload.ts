/**
 * employeeEditPayload.ts — helpers puros para el modal de edición del empleado.
 *
 * Todo lo que no requiere DOM/React vive acá para que Jest pueda cubrirlo sin
 * tests de rendering. El modal (`EmployeeEditModal.tsx`) los importa y los
 * arma sobre la UI.
 *
 * Contrato:
 *   - `snapshotOf(emp)` produce el estado inicial (strings) desde una ficha
 *     que llegó del backend.
 *   - `normalizeForField(field, str)` convierte el string del formulario al
 *     tipo que espera el validador del backend.
 *   - `buildPayload(form)` valida todos los campos y arma el payload PUT.
 *     Devuelve `{ ok, payload, fieldErrors }`.
 *   - `filterByCaps(payload, caps)` elimina los campos que el rol no puede
 *     escribir (defensa en profundidad; el backend valida igualmente).
 */

import { parseDecimalPYG, stripThousands } from './currency'
import { validateEmployeeField } from './employeeFieldValidation'

export type Caps = {
  personal_update?: boolean
  legal_view?: boolean
  legal_update?: boolean
}

export type FieldName =
  | 'first_name' | 'last_name' | 'email' | 'phone' | 'birth_date'
  | 'position' | 'department_id' | 'branch_id' | 'schedule_id' | 'hire_date'
  | 'document_number' | 'ips_number'
  | 'salary_base' | 'pay_type'
  | 'gender' | 'children_count'

export type FormState = Record<FieldName, string>

export const ALL_FIELDS: FieldName[] = [
  'first_name', 'last_name', 'email', 'phone', 'birth_date',
  'position', 'department_id', 'branch_id', 'schedule_id', 'hire_date',
  'document_number', 'ips_number',
  'salary_base', 'pay_type',
  'gender', 'children_count',
]

const CLIENT_VALIDATED: ReadonlySet<FieldName> = new Set<FieldName>([
  'first_name', 'last_name', 'email', 'phone', 'birth_date',
  'position', 'hire_date',
  'document_number', 'ips_number',
  'salary_base', 'pay_type',
  'gender', 'children_count',
])

const FK_FIELDS: ReadonlySet<FieldName> = new Set<FieldName>([
  'department_id', 'branch_id', 'schedule_id',
])

const LEGAL: ReadonlySet<string> = new Set([
  'document_number', 'ips_number', 'salary_base', 'pay_type', 'gender', 'children_count',
])

function toForm(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v)
}

export function snapshotOf(emp: Record<string, unknown> | null | undefined): FormState {
  const e = (emp || {}) as Record<string, unknown>
  const dateOnly = (v: unknown): string =>
    v ? String(v).slice(0, 10) : ''
  const intOrEmpty = (v: unknown): string =>
    v == null || v === '' ? '' : String(v)
  return {
    first_name:      toForm(e.first_name),
    last_name:       toForm(e.last_name),
    email:           toForm(e.email),
    phone:           toForm(e.phone),
    birth_date:      dateOnly(e.birth_date),
    hire_date:       dateOnly(e.hire_date),
    position:        toForm(e.position),
    department_id:   intOrEmpty(e.department_id),
    branch_id:       intOrEmpty(e.branch_id),
    schedule_id:     intOrEmpty(e.schedule_id),
    document_number: toForm(e.document_number),
    ips_number:      toForm(e.ips_number),
    // El backend serializa DECIMAL como "3500000.00". Debe entrar al
    // formulario ya como entero canónico ("3500000"): si se guardara el
    // string crudo, el formateo de miles interpretaría el punto decimal
    // como separador y multiplicaría el salario por 100 en cada ciclo.
    salary_base:     parseDecimalPYG(e.salary_base),
    pay_type:        toForm(e.pay_type || 'mensualizado'),
    gender:          toForm(e.gender),
    children_count:  e.children_count != null ? String(e.children_count) : '0',
  }
}

export function normalizeForField(field: FieldName, str: string): unknown {
  if (field === 'salary_base') return stripThousands(str)
  if (field === 'children_count') return str === '' ? '' : Number(str)
  if (FK_FIELDS.has(field)) return str === '' ? '' : Number(str)
  return str
}

export type BuildResult =
  | { ok: true;  payload: Record<string, unknown>; fieldErrors?: undefined }
  | { ok: false; payload: Record<string, unknown>; fieldErrors: Record<string, string> }

export function buildPayload(form: FormState): BuildResult {
  const fieldErrors: Record<string, string> = {}
  const payload: Record<string, unknown> = {}

  for (const field of ALL_FIELDS) {
    const raw = form[field] ?? ''
    const normalized = normalizeForField(field, raw)

    if (CLIENT_VALIDATED.has(field)) {
      const r = validateEmployeeField(field, normalized)
      if (!r.ok) { fieldErrors[field] = r.error!; continue }
      payload[field] = r.value
    } else if (FK_FIELDS.has(field)) {
      if (raw === '' || raw == null) {
        payload[field] = null
      } else {
        const n = Number(raw)
        if (!Number.isInteger(n) || n <= 0) { fieldErrors[field] = 'seleccione una opción válida'; continue }
        payload[field] = n
      }
    } else {
      payload[field] = raw
    }
  }

  if (Object.keys(fieldErrors).length) return { ok: false, payload, fieldErrors }
  return { ok: true, payload }
}

// Deja pasar sólo los campos que el rol puede escribir. El backend siempre
// valida, pero esta función evita mandar valores ya masqueados que la UI
// pinta en modo readonly (por ejemplo, salario para roles con legal_view
// pero sin legal_update).
export function filterByCaps(
  payload: Record<string, unknown>,
  caps: Caps
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const canPersonal = !!caps.personal_update
  const canLegal    = !!caps.legal_update
  for (const [k, v] of Object.entries(payload)) {
    const isLegal = LEGAL.has(k)
    const canWrite = isLegal ? canLegal : canPersonal
    if (canWrite) out[k] = v
  }
  return out
}
