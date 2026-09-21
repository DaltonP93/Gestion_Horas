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
  overtime_policy: string | null
  overtime_policy_version: number | null
  overtime_policy_config: Record<string, unknown> | null
  rounding_policy: string | null
  rounding_policy_version: number | null
  rounding_policy_config: Record<string, unknown> | null
  night_start: string | null
  night_end: string | null
  work_days: string | null
  config_version: number | null
  change_reason: string | null
  active: number
}

// Conjuntos válidos (paridad con el backend workdayConfigurationService).
export const BREAK_MODES = ['none', 'fixed_unpaid', 'punched'] as const
export const WORK_REGIMES = ['day', 'night', 'mixed', 'special', 'custom'] as const
export type BreakMode = (typeof BREAK_MODES)[number]

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
  // Descanso
  break_mode: BreakMode
  break_minutes: string
  break_after_minutes: string
  // Objetivos
  daily_target_minutes: string
  weekly_target_minutes: string
  work_regime: '' | (typeof WORK_REGIMES)[number]
  // Nocturno
  night_start: string
  night_end: string
  // Políticas avanzadas (config como texto JSON)
  overtime_policy: string
  overtime_policy_version: string
  overtime_policy_config: string
  rounding_policy: string
  rounding_policy_version: string
  rounding_policy_config: string
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
    // Descanso: defaults seguros y coherentes con el backend (break_mode default 'punched').
    break_mode: 'punched',
    break_minutes: '0',
    break_after_minutes: '0',
    // Objetivos/políticas: vacíos (null) — no se inventan.
    daily_target_minutes: '',
    weekly_target_minutes: '',
    work_regime: '',
    night_start: '',
    night_end: '',
    overtime_policy: '',
    overtime_policy_version: '',
    overtime_policy_config: '',
    rounding_policy: '',
    rounding_policy_version: '',
    rounding_policy_config: '',
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

const POLICY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i

/** true si `v` (string) es un entero dentro de [min,max]; '' cuenta como válido sólo si nullable. */
function isBoundedInt(v: string, min: number, max: number, nullable = true): boolean {
  const s = String(v ?? '').trim()
  if (!s) return nullable
  if (!/^-?\d+$/.test(s)) return false
  const n = Number(s)
  return Number.isInteger(n) && n >= min && n <= max
}

/** Parsea un JSON de config de policy: '' → null; debe ser objeto (no array). Lanza si inválido. */
function parsePolicyConfig(v: string, label: string): Record<string, unknown> | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  let parsed: unknown
  try { parsed = JSON.parse(s) } catch { throw new Error(`${label} debe ser JSON válido.`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} debe ser un objeto JSON (no un array).`)
  return parsed as Record<string, unknown>
}
function isPolicyConfigValid(v: string): boolean {
  try { parsePolicyConfig(v, 'x'); return true } catch { return false }
}
const intOrNull = (v: string): number | null => { const s = String(v ?? '').trim(); return s ? Number(s) : null }

/**
 * Valida los campos EFECTIVOS de jornada (compartido entre creación y supersede):
 * horario, días, descanso, objetivos, régimen, nocturno y políticas. Mismas
 * reglas que el backend (autoridad final).
 */
function validateJornadaFields(form: DefaultForm): string[] {
  const errors: string[] = []
  if (!isClockTime(form.check_in)) errors.push('La hora de entrada debe ser HH:mm válida.')
  if (!isClockTime(form.check_out)) errors.push('La hora de salida debe ser HH:mm válida.')
  if (!form.work_days.length) errors.push('Seleccioná al menos un día laborable.')
  if (!isBoundedInt(form.tolerance_in, 0, 1440, false)) errors.push('Tolerancia de entrada: entero entre 0 y 1440.')
  if (!isBoundedInt(form.tolerance_out, 0, 1440, false)) errors.push('Tolerancia de salida: entero entre 0 y 1440.')
  if (!BREAK_MODES.includes(form.break_mode)) errors.push('Modo de descanso inválido.')
  if (!isBoundedInt(form.break_minutes, 0, 1440, false)) errors.push('Minutos de descanso: entero entre 0 y 1440.')
  if (!isBoundedInt(form.break_after_minutes, 0, 1440, false)) errors.push('Umbral de descanso: entero entre 0 y 1440.')
  if (!isBoundedInt(form.daily_target_minutes, 0, 1440)) errors.push('Objetivo diario (min): entero entre 0 y 1440.')
  if (!isBoundedInt(form.weekly_target_minutes, 0, 10080)) errors.push('Objetivo semanal (min): entero entre 0 y 10080.')
  if (form.work_regime && !WORK_REGIMES.includes(form.work_regime as any)) errors.push('Régimen laboral inválido.')
  if ((form.night_start && !form.night_end) || (!form.night_start && form.night_end)) {
    errors.push('La franja nocturna requiere inicio y fin.')
  } else if (form.night_start && (!isClockTime(form.night_start) || !isClockTime(form.night_end))) {
    errors.push('La franja nocturna debe usar horas HH:mm válidas.')
  }
  if (form.overtime_policy.trim() && !POLICY_RE.test(form.overtime_policy.trim())) errors.push('Política de horas extra: código de hasta 40 caracteres (letras, números, _ o -).')
  if (form.rounding_policy.trim() && !POLICY_RE.test(form.rounding_policy.trim())) errors.push('Política de redondeo: código de hasta 40 caracteres (letras, números, _ o -).')
  if (!isBoundedInt(form.overtime_policy_version, 1, 100000)) errors.push('Versión de horas extra: entero positivo.')
  if (!isBoundedInt(form.rounding_policy_version, 1, 100000)) errors.push('Versión de redondeo: entero positivo.')
  if (!isPolicyConfigValid(form.overtime_policy_config)) errors.push('Config de horas extra debe ser un objeto JSON (no un array).')
  if (!isPolicyConfigValid(form.rounding_policy_config)) errors.push('Config de redondeo debe ser un objeto JSON (no un array).')
  return errors
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
  return [...new Set([...errors, ...validateJornadaFields(form)])]
}

/**
 * Campos EFECTIVOS de jornada listos para persistir (paridad exacta con
 * normalizeDefaultBody del backend). Compartido por creación y supersede.
 */
function jornadaPayload(form: DefaultForm) {
  return {
    check_in: form.check_in,
    check_out: form.check_out,
    tolerance_in: Number(form.tolerance_in || 0),
    tolerance_out: Number(form.tolerance_out || 0),
    work_days: [...form.work_days].sort((a, b) => a - b),
    break_mode: form.break_mode,
    break_minutes: Number(form.break_minutes || 0),
    break_after_minutes: Number(form.break_after_minutes || 0),
    daily_target_minutes: intOrNull(form.daily_target_minutes),
    weekly_target_minutes: intOrNull(form.weekly_target_minutes),
    work_regime: form.work_regime || null,
    night_start: form.night_start || null,
    night_end: form.night_end || null,
    overtime_policy: form.overtime_policy.trim() || null,
    overtime_policy_version: intOrNull(form.overtime_policy_version),
    overtime_policy_config: parsePolicyConfig(form.overtime_policy_config, 'Config de horas extra'),
    rounding_policy: form.rounding_policy.trim() || null,
    rounding_policy_version: intOrNull(form.rounding_policy_version),
    rounding_policy_config: parsePolicyConfig(form.rounding_policy_config, 'Config de redondeo'),
  }
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
    ...jornadaPayload(form),
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

/** Precarga un DefaultForm con el payload COMPLETO de una versión existente (supersede). */
export function formFromDefaultRow(row: WorkdayDefaultRow, today: string): DefaultForm {
  const base = emptyDefaultForm(today)
  const t5 = (v: string | null | undefined) => (v ? String(v).slice(0, 5) : '')
  const numStr = (v: number | null | undefined, fallback = '') => (v == null ? fallback : String(v))
  const jsonStr = (v: Record<string, unknown> | null | undefined) => (v == null ? '' : JSON.stringify(v))
  const days = (row.work_days || '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n >= 1 && n <= 7)
  return {
    ...base,
    scope: row.scope,
    company_id: row.company_id == null ? '' : String(row.company_id),
    department_id: row.department_id == null ? '' : String(row.department_id),
    label: row.label || '',
    check_in: t5(row.check_in) || base.check_in,
    check_out: t5(row.check_out) || base.check_out,
    tolerance_in: numStr(row.tolerance_in, base.tolerance_in),
    tolerance_out: numStr(row.tolerance_out, base.tolerance_out),
    work_days: days.length ? days : base.work_days,
    break_mode: (BREAK_MODES as readonly string[]).includes(row.break_mode || '') ? (row.break_mode as BreakMode) : base.break_mode,
    break_minutes: numStr(row.break_minutes, base.break_minutes),
    break_after_minutes: numStr(row.break_after_minutes, base.break_after_minutes),
    daily_target_minutes: numStr(row.daily_target_minutes),
    weekly_target_minutes: numStr(row.weekly_target_minutes),
    work_regime: (WORK_REGIMES as readonly string[]).includes(row.work_regime || '') ? (row.work_regime as any) : '',
    night_start: t5(row.night_start),
    night_end: t5(row.night_end),
    overtime_policy: row.overtime_policy || '',
    overtime_policy_version: numStr(row.overtime_policy_version),
    overtime_policy_config: jsonStr(row.overtime_policy_config),
    rounding_policy: row.rounding_policy || '',
    rounding_policy_version: numStr(row.rounding_policy_version),
    rounding_policy_config: jsonStr(row.rounding_policy_config),
    change_reason: '',
  }
}

/**
 * Cuerpo para POST /defaults/:id/supersede: `effective_from` (obligatorio) + el
 * payload EFECTIVO COMPLETO del formulario + change_reason. Reutiliza la
 * validación de jornada (horario/días/descanso/objetivos/régimen/nocturno/
 * políticas). NO envía scope: el alcance es inmutable.
 */
export function supersedePayload(effectiveFrom: string, form: DefaultForm) {
  const errors: string[] = []
  if (!isCivilDate(effectiveFrom)) errors.push('"Vigente desde (nueva versión)" debe ser una fecha real.')
  errors.push(...validateJornadaFields(form))
  if (errors.length) throw new Error([...new Set(errors)][0])
  return {
    effective_from: effectiveFrom,
    ...jornadaPayload(form),
    change_reason: form.change_reason.trim() || null,
  }
}

/** Cuerpo para POST /defaults/:id/close. Fecha civil real (no sólo regex). */
export function closePayload(validTo: string, reason: string) {
  if (!isCivilDate(validTo)) throw new Error('"Vigente hasta" debe ser una fecha real.')
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
