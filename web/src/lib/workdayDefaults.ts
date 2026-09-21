/**
 * workdayDefaults.ts — tipos y helpers PUROS para la Configuración Laboral
 * Histórica y Jerárquica (defaults general/empresa/departamento) que consume la
 * página /configuracion/laboral. La validación de negocio la impone la API
 * (fail-closed); aquí sólo se normaliza el formulario y se etiqueta la
 * precedencia, sin acceso a red, para poder testearse en aislamiento.
 */

export type DefaultScope = 'general' | 'company' | 'department'

export interface WorkdayDefaultRow {
  id: number
  scope: DefaultScope
  company_id: number | null
  department_id: number | null
  label: string | null
  valid_from: string
  valid_to: string | null
  check_in: string | null
  check_out: string | null
  tolerance_in: number | null
  tolerance_out: number | null
  break_mode: string | null
  break_minutes: number | null
  break_after_minutes: number | null
  weekly_target_minutes: number | null
  daily_target_minutes: number | null
  work_regime: string | null
  night_start: string | null
  night_end: string | null
  work_days: string | null
  config_version: number | null
  change_reason: string | null
  active: number
}

export interface EffectiveHierarchical {
  employee_id: number
  date: string
  layer: string
  calculation_mode: 'configured' | 'non_working' | 'historical_fallback'
  config: Record<string, unknown> | null
  contract_id: number | null
  precedence_considered: string[]
  scope: { department_id: number | null; company_id: number | null; scope_source: string | null }
  precedence: string[]
}

export interface DefaultForm {
  scope: DefaultScope
  company_id: string
  department_id: string
  label: string
  valid_from: string
  valid_to: string
  check_in: string
  check_out: string
  tolerance_in: string
  tolerance_out: string
  work_days: number[]
  night_start: string
  night_end: string
  change_reason: string
}

// Formas REALES de las APIs (Corrección F):
//   GET /api/companies   → { data: [{ id, code, legal_name, trade_name, ... }] }  (NO existe company.name)
//   GET /api/departments → [{ id, name, ... }]  (array DIRECTO, no { data: [...] })
export interface CompanyRef { id: number; code?: string | null; legal_name?: string | null; trade_name?: string | null }
export interface DeptRef { id: number; name: string }

/** Nombre visible de una empresa: trade_name || legal_name || code || #id. */
export function companyLabel(c: CompanyRef): string {
  return c.trade_name || c.legal_name || c.code || `#${c.id}`
}

/** Normaliza una respuesta que puede venir como array directo o como { data: [...] }. */
export function unwrapList<T = unknown>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[]
  const data = (payload as { data?: unknown } | null | undefined)?.data
  return Array.isArray(data) ? (data as T[]) : []
}

export const SCOPE_LABEL: Record<DefaultScope, string> = {
  general: 'General (organización)',
  company: 'Empresa',
  department: 'Departamento',
}

/** Etiquetas legibles para cada capa de la precedencia. */
export const LAYER_LABEL: Record<string, string> = {
  published_shift_assignment: 'Turnera publicada',
  employee_historical_override: 'Override histórico del empleado',
  department_historical_default: 'Default histórico de departamento',
  company_historical_default: 'Default histórico de empresa',
  general_historical_default: 'Default histórico general',
  employee_contract_trace: 'Traza de contrato',
  historical_fallback: 'Fallback histórico (sin configurar)',
}

export const DAY_LABELS: Record<number, string> = {
  1: 'Dom', 2: 'Lun', 3: 'Mar', 4: 'Mié', 5: 'Jue', 6: 'Vie', 7: 'Sáb',
}

export function layerLabel(layer: string | undefined | null): string {
  if (!layer) return '—'
  return LAYER_LABEL[layer] || layer
}

export function scopeSummary(row: Pick<WorkdayDefaultRow, 'scope' | 'company_id' | 'department_id'>): string {
  if (row.scope === 'company') return `Empresa #${row.company_id ?? '?'}`
  if (row.scope === 'department') return `Departamento #${row.department_id ?? '?'}`
  return 'General'
}

export function emptyDefaultForm(today: string): DefaultForm {
  return {
    scope: 'general',
    company_id: '',
    department_id: '',
    label: '',
    valid_from: today,
    valid_to: '',
    check_in: '08:00',
    check_out: '17:00',
    tolerance_in: '10',
    tolerance_out: '10',
    work_days: [2, 3, 4, 5, 6],
    night_start: '',
    night_end: '',
    change_reason: '',
  }
}

function isCivilDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''))
  if (!m) return false
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1) return false
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
  return d <= dim
}

function isClockTime(v: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(v || ''))
}

/** Valida el formulario en cliente (mismos criterios que la API, sin red). */
export function validateDefaultForm(form: DefaultForm): string[] {
  const errors: string[] = []
  if (form.scope === 'company' && !form.company_id) errors.push('Empresa: seleccioná una empresa.')
  if (form.scope === 'department' && !form.department_id) errors.push('Departamento: seleccioná un departamento.')
  if (form.scope === 'general' && (form.company_id || form.department_id)) {
    errors.push('El alcance general no admite empresa ni departamento.')
  }
  if (!isCivilDate(form.valid_from)) errors.push('"Vigente desde" debe ser una fecha real.')
  if (form.valid_to && !isCivilDate(form.valid_to)) errors.push('"Vigente hasta" debe ser una fecha real.')
  if (form.valid_to && isCivilDate(form.valid_from) && isCivilDate(form.valid_to) && form.valid_to < form.valid_from) {
    errors.push('"Vigente hasta" no puede ser anterior a "Vigente desde".')
  }
  if (!isClockTime(form.check_in)) errors.push('La hora de entrada debe ser HH:mm válida.')
  if (!isClockTime(form.check_out)) errors.push('La hora de salida debe ser HH:mm válida.')
  if (!form.work_days.length) errors.push('Seleccioná al menos un día laborable.')
  if ((form.night_start && !form.night_end) || (!form.night_start && form.night_end)) {
    errors.push('La franja nocturna requiere inicio y fin.')
  } else if (form.night_start && (!isClockTime(form.night_start) || !isClockTime(form.night_end))) {
    errors.push('La franja nocturna debe usar horas HH:mm válidas.')
  }
  return [...new Set(errors)]
}

/** Construye el cuerpo para POST /defaults; lanza con el primer error. */
export function defaultPayload(form: DefaultForm) {
  const errors = validateDefaultForm(form)
  if (errors.length) throw new Error(errors[0])
  return {
    scope: form.scope,
    company_id: form.scope === 'company' ? Number(form.company_id) : null,
    department_id: form.scope === 'department' ? Number(form.department_id) : null,
    label: form.label.trim() || null,
    valid_from: form.valid_from,
    valid_to: form.valid_to || null,
    check_in: form.check_in,
    check_out: form.check_out,
    tolerance_in: Number(form.tolerance_in || 0),
    tolerance_out: Number(form.tolerance_out || 0),
    work_days: [...form.work_days].sort((a, b) => a - b),
    night_start: form.night_start || null,
    night_end: form.night_end || null,
    change_reason: form.change_reason.trim() || null,
  }
}

/**
 * Filas de un preview masivo que BLOQUEAN la aplicación: inválidas, incompletas
 * o solapadas. `bulkApply` en el backend exige config completa (requireComplete),
 * así que una fila `incomplete` también impide aplicar (Corrección J).
 */
export function bulkBlockingCount(results: Array<{ status?: string }> | null | undefined): number {
  if (!Array.isArray(results)) return 0
  return results.filter(r => r.status === 'invalid' || r.status === 'incomplete' || r.status === 'overlap').length
}

// ── Append-only en la UI (Corrección N): sólo versiones ABIERTAS se mutan ──

/** Una versión está ABIERTA si su vigencia no está cerrada (valid_to null). */
export function versionIsOpen(row: Pick<WorkdayDefaultRow, 'valid_to'>): boolean {
  return row.valid_to == null || row.valid_to === ''
}

/** ¿Se pueden ofrecer acciones de mutación (supersede/close) sobre esta versión? */
export function canMutateVersion(
  row: Pick<WorkdayDefaultRow, 'valid_to'>,
  opts: { canWrite: boolean; writesEnabled: boolean },
): boolean {
  return !!opts.canWrite && !!opts.writesEnabled && versionIsOpen(row)
}

/** Precarga un DefaultForm desde una versión existente (para el modal de supersede). */
export function formFromDefaultRow(row: WorkdayDefaultRow, today: string): DefaultForm {
  const base = emptyDefaultForm(today)
  const t5 = (v: string | null | undefined) => (v ? String(v).slice(0, 5) : '')
  const days = (row.work_days || '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n >= 1 && n <= 7)
  return {
    ...base,
    scope: row.scope,
    company_id: row.company_id == null ? '' : String(row.company_id),
    department_id: row.department_id == null ? '' : String(row.department_id),
    label: row.label || '',
    check_in: t5(row.check_in) || base.check_in,
    check_out: t5(row.check_out) || base.check_out,
    tolerance_in: row.tolerance_in == null ? base.tolerance_in : String(row.tolerance_in),
    tolerance_out: row.tolerance_out == null ? base.tolerance_out : String(row.tolerance_out),
    work_days: days.length ? days : base.work_days,
    night_start: t5(row.night_start),
    night_end: t5(row.night_end),
    change_reason: '',
  }
}

/**
 * Cuerpo para POST /defaults/:id/supersede: `effective_from` (obligatorio) + el
 * payload de jornada del formulario + change_reason. Reutiliza la validación del
 * formulario (horas/días/nocturno). NO envía scope: el alcance es inmutable.
 */
export function supersedePayload(effectiveFrom: string, form: DefaultForm) {
  const errors = validateDefaultForm({ ...form, scope: 'general', company_id: '', department_id: '', valid_from: effectiveFrom })
    .filter(e => !/alcance|Empresa|Departamento/i.test(e)) // el alcance no se edita en supersede
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) errors.unshift('"Vigente desde (nueva versión)" debe ser una fecha real.')
  if (errors.length) throw new Error(errors[0])
  return {
    effective_from: effectiveFrom,
    check_in: form.check_in,
    check_out: form.check_out,
    tolerance_in: Number(form.tolerance_in || 0),
    tolerance_out: Number(form.tolerance_out || 0),
    work_days: [...form.work_days].sort((a, b) => a - b),
    night_start: form.night_start || null,
    night_end: form.night_end || null,
    change_reason: form.change_reason.trim() || null,
  }
}

/** Cuerpo para POST /defaults/:id/close. */
export function closePayload(validTo: string, reason: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validTo)) throw new Error('"Vigente hasta" debe ser una fecha real.')
  return { valid_to: validTo, reason: (reason || '').trim() || null }
}

/** Mensaje legible para los 409 de mutación de defaults (para la UI). */
export function mutationErrorMessage(err: unknown): string {
  const anyErr = err as { response?: { status?: number; data?: { code?: string; error?: string } }; message?: string }
  const code = anyErr?.response?.data?.code
  const map: Record<string, string> = {
    IMMUTABLE_EFFECTIVE_CONFIG: 'No se puede editar la configuración de una versión; creá una versión nueva.',
    SUPERSEDE_REQUIRES_OPEN_VERSION: 'Sólo puede versionarse una vigencia abierta.',
    SUPERSEDE_NOT_FORWARD: 'La nueva vigencia debe empezar después del inicio de la versión actual.',
    DEFAULT_ALREADY_CLOSED: 'La versión ya está cerrada.',
    BULK_HAS_CONFLICTS: 'La importación tiene conflictos; resolvelos antes de aplicar.',
    WORKDAY_CONFIG_DEFAULT_OVERLAP: 'La vigencia se solapa con otra versión del mismo alcance.',
  }
  if (code && map[code]) return map[code]
  if (anyErr?.response?.status === 503) return 'Escrituras deshabilitadas (fail-closed).'
  return anyErr?.response?.data?.error || anyErr?.message || 'No se pudo completar la operación.'
}

/** Parsea el textarea de importación masiva (JSON array o NDJSON) a items. */
export function parseBulkItems(text: string): Record<string, unknown>[] {
  const s = String(text || '').trim()
  if (!s) return []
  // 1) JSON array.
  if (s.startsWith('[')) {
    const arr = JSON.parse(s)
    if (!Array.isArray(arr)) throw new Error('El JSON debe ser un array de objetos.')
    return arr
  }
  // 2) NDJSON (un objeto por línea).
  return s.split('\n').map(l => l.trim()).filter(Boolean).map((line, i) => {
    try { return JSON.parse(line) }
    catch { throw new Error(`Línea ${i + 1}: JSON inválido.`) }
  })
}
