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
