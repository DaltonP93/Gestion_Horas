export type BreakMode = 'none' | 'punched' | 'fixed_unpaid'
export type WorkRegime = 'day' | 'night' | 'mixed' | 'special' | 'custom'

export interface WorkdaySchedule {
  id: number
  name: string
  check_in: string
  check_out: string
  tolerance_in: number
  tolerance_out: number
  break_minutes: number
  work_days: string
}

export interface WorkdayHistoryRow {
  id: number
  employee_id: number
  schedule_id: number | null
  schedule_name_snapshot?: string | null
  valid_from: string
  valid_to: string | null
  check_in: string | null
  check_out: string | null
  tolerance_in: number | null
  tolerance_out: number | null
  work_days: number[] | null
  break_mode: BreakMode | null
  break_minutes: number | null
  break_after_minutes: number | null
  weekly_target_minutes: number | null
  daily_target_minutes: number | null
  work_regime: WorkRegime | null
  night_start: string | null
  night_end: string | null
  rounding_policy: string | null
  rounding_policy_version?: number | null
  rounding_policy_config?: Record<string, unknown> | null
  overtime_policy: string | null
  overtime_policy_version?: number | null
  overtime_policy_config?: Record<string, unknown> | null
  notes?: string | null
  snapshot_version?: number | null
  snapshot_source?: string | null
  snapshot_complete?: boolean
  change_reason?: string | null
}

export interface EffectiveWorkdayConfig {
  employee_id: number
  date: string
  calculation_mode_candidate: 'configured' | 'historical_fallback'
  source: string
  configuration_conflict: boolean
  calendar_conflict: boolean
  expected_workday: boolean | null
  kind: string | null
  schedule_snapshot: WorkdayHistoryRow | null
  profile: {
    weekly_target_minutes?: number | null
    daily_target_minutes?: number | null
    work_regime?: WorkRegime | null
    break_mode?: BreakMode | null
    break_minutes?: number | null
    break_after_minutes?: number | null
    night_start?: string | null
    night_end?: string | null
    rounding_policy?: string | null
    rounding_policy_version?: number | null
    rounding_policy_config?: Record<string, unknown> | null
    overtime_policy?: string | null
    overtime_policy_version?: number | null
    overtime_policy_config?: Record<string, unknown> | null
  } | null
  turnera: {
    shift_schedule_id: number | null
    check_in: string | null
    check_out: string | null
    segments: number
    shift_weekly_target_minutes: number | null
    daily_target_minutes: number | null
    kind: string
    active_for_calculation: boolean
    pending_employee_configuration: boolean
    planning_conflict: boolean
  } | null
  permission: unknown | null
  holiday: unknown | null
  config_incomplete: boolean
  contract_id: number | null
}

export interface WorkdayConfigForm {
  schedule_id: string
  valid_from: string
  valid_to: string
  check_in: string
  check_out: string
  tolerance_in: string
  tolerance_out: string
  work_days: number[]
  break_mode: BreakMode
  break_minutes: string
  break_after_minutes: string
  weekly_target_hours: string
  daily_target_hours: string
  work_regime: '' | WorkRegime
  night_start: string
  night_end: string
  rounding_policy: string
  rounding_policy_version: string
  rounding_policy_config: string
  overtime_policy: string
  overtime_policy_version: string
  overtime_policy_config: string
  reason: string
  notes: string
}

export const DAY_LABELS: Record<number, string> = {
  1: 'Dom', 2: 'Lun', 3: 'Mar', 4: 'Mié', 5: 'Jue', 6: 'Vie', 7: 'Sáb',
}

export function emptyWorkdayConfigForm(today: string): WorkdayConfigForm {
  return {
    schedule_id: '',
    valid_from: today,
    valid_to: '',
    check_in: '08:00',
    check_out: '17:00',
    tolerance_in: '10',
    tolerance_out: '10',
    work_days: [2, 3, 4, 5, 6],
    break_mode: 'none',
    break_minutes: '0',
    break_after_minutes: '0',
    weekly_target_hours: '',
    daily_target_hours: '',
    work_regime: '',
    night_start: '',
    night_end: '',
    rounding_policy: '',
    rounding_policy_version: '',
    rounding_policy_config: '',
    overtime_policy: '',
    overtime_policy_version: '',
    overtime_policy_config: '',
    reason: '',
    notes: '',
  }
}

export function time5(v: string | null | undefined): string {
  return v ? String(v).slice(0, 5) : ''
}

function hoursFromMinutes(v: number | null | undefined): string {
  if (v == null) return ''
  const h = v / 60
  return Number.isInteger(h) ? String(h) : String(Math.round(h * 100) / 100)
}

export function formFromHistory(row: WorkdayHistoryRow): WorkdayConfigForm {
  return {
    schedule_id: row.schedule_id == null ? '' : String(row.schedule_id),
    valid_from: String(row.valid_from).slice(0, 10),
    valid_to: row.valid_to ? String(row.valid_to).slice(0, 10) : '',
    check_in: time5(row.check_in),
    check_out: time5(row.check_out),
    tolerance_in: String(row.tolerance_in ?? 0),
    tolerance_out: String(row.tolerance_out ?? 0),
    work_days: row.work_days ? [...row.work_days] : [],
    break_mode: row.break_mode || 'none',
    break_minutes: String(row.break_minutes ?? 0),
    break_after_minutes: String(row.break_after_minutes ?? 0),
    weekly_target_hours: hoursFromMinutes(row.weekly_target_minutes),
    daily_target_hours: hoursFromMinutes(row.daily_target_minutes),
    work_regime: row.work_regime || '',
    night_start: time5(row.night_start),
    night_end: time5(row.night_end),
    rounding_policy: row.rounding_policy || '',
    rounding_policy_version: row.rounding_policy_version == null ? '' : String(row.rounding_policy_version),
    rounding_policy_config: row.rounding_policy_config ? JSON.stringify(row.rounding_policy_config, null, 2) : '',
    overtime_policy: row.overtime_policy || '',
    overtime_policy_version: row.overtime_policy_version == null ? '' : String(row.overtime_policy_version),
    overtime_policy_config: row.overtime_policy_config ? JSON.stringify(row.overtime_policy_config, null, 2) : '',
    reason: '',
    notes: row.notes || '',
  }
}

export function applyScheduleToForm(form: WorkdayConfigForm, schedule: WorkdaySchedule): WorkdayConfigForm {
  const days = String(schedule.work_days || '')
    .split(',')
    .map(x => Number(x.trim()))
    .filter(x => Number.isInteger(x) && x >= 1 && x <= 7)
  return {
    ...form,
    schedule_id: String(schedule.id),
    check_in: time5(schedule.check_in),
    check_out: time5(schedule.check_out),
    tolerance_in: String(schedule.tolerance_in ?? 0),
    tolerance_out: String(schedule.tolerance_out ?? 0),
    work_days: [...new Set(days)].sort((a, b) => a - b),
    break_mode: Number(schedule.break_minutes || 0) > 0 ? 'fixed_unpaid' : 'none',
    break_minutes: String(schedule.break_minutes ?? 0),
  }
}

function minutesFromHours(v: string, maxHours?: number): number | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) throw new Error('Las horas objetivo deben ser números positivos')
  if (maxHours != null && n > maxHours) throw new Error(`Las horas objetivo no pueden superar ${maxHours} h`)
  return Math.round(n * 60)
}

function boundedInt(
  v: string,
  label: string,
  { min = 0, max = Number.MAX_SAFE_INTEGER, nullable = false } = {},
): number | null {
  const s = String(v ?? '').trim()
  if (!s) return nullable ? null : 0
  const n = Number(s)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label} debe ser un entero entre ${min} y ${max}`)
  }
  return n
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
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v || ''))
  return !!m
}

const POLICY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i

function parsePolicyConfig(v: string, label: string): Record<string, unknown> | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch {
    throw new Error(`${label} debe ser JSON válido`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} debe ser un objeto JSON`)
  }
  return parsed as Record<string, unknown>
}

export function validateWorkdayConfigForm(form: WorkdayConfigForm): string[] {
  const errors: string[] = []
  if (!isCivilDate(form.valid_from)) errors.push('La fecha "Vigente desde" debe ser una fecha real.')
  if (form.valid_to && !isCivilDate(form.valid_to)) errors.push('"Vigente hasta" debe ser una fecha real.')
  if (form.valid_to && isCivilDate(form.valid_from) && isCivilDate(form.valid_to) && form.valid_to < form.valid_from) {
    errors.push('"Vigente hasta" no puede ser anterior a "Vigente desde".')
  }
  if (!isClockTime(form.check_in)) errors.push('La hora de entrada debe ser HH:mm válida.')
  if (!isClockTime(form.check_out)) errors.push('La hora de salida debe ser HH:mm válida.')
  if (!form.work_days.length || form.work_days.some(d => !Number.isInteger(d) || d < 1 || d > 7)) {
    errors.push('Seleccioná días laborables válidos.')
  }
  if ((form.night_start && !form.night_end) || (!form.night_start && form.night_end)) {
    errors.push('La franja nocturna requiere inicio y fin.')
  } else if (form.night_start && (!isClockTime(form.night_start) || !isClockTime(form.night_end))) {
    errors.push('La franja nocturna debe usar horas HH:mm válidas.')
  }

  try { boundedInt(form.tolerance_in, 'Tolerancia de entrada', { min: 0, max: 1440 }) } catch (e: any) { errors.push(e.message) }
  try { boundedInt(form.tolerance_out, 'Tolerancia de salida', { min: 0, max: 1440 }) } catch (e: any) { errors.push(e.message) }
  try { boundedInt(form.break_minutes, 'Minutos de descanso', { min: 0, max: 1440 }) } catch (e: any) { errors.push(e.message) }
  try { boundedInt(form.break_after_minutes, 'Umbral de descanso', { min: 0, max: 1440 }) } catch (e: any) { errors.push(e.message) }
  try { minutesFromHours(form.weekly_target_hours, 168) } catch (e: any) { errors.push(e.message) }
  try { minutesFromHours(form.daily_target_hours, 24) } catch (e: any) { errors.push(e.message) }

  if (form.rounding_policy.trim() && !POLICY_RE.test(form.rounding_policy.trim())) {
    errors.push('Policy de redondeo debe ser un código de hasta 40 caracteres (letras, números, _ o -).')
  }
  if (form.overtime_policy.trim() && !POLICY_RE.test(form.overtime_policy.trim())) {
    errors.push('Policy de horas extra debe ser un código de hasta 40 caracteres (letras, números, _ o -).')
  }
  try { boundedInt(form.rounding_policy_version, 'Versión de redondeo', { min: 1, max: 100000, nullable: true }) } catch (e: any) { errors.push(e.message) }
  try { boundedInt(form.overtime_policy_version, 'Versión de horas extra', { min: 1, max: 100000, nullable: true }) } catch (e: any) { errors.push(e.message) }
  try { parsePolicyConfig(form.rounding_policy_config, 'Config de redondeo') } catch (e: any) { errors.push(e.message) }
  try { parsePolicyConfig(form.overtime_policy_config, 'Config de horas extra') } catch (e: any) { errors.push(e.message) }

  return [...new Set(errors)]
}

export function workdayConfigPayload(form: WorkdayConfigForm) {
  const errors = validateWorkdayConfigForm(form)
  if (errors.length) throw new Error(errors[0])
  return {
    schedule_id: form.schedule_id ? Number(form.schedule_id) : null,
    valid_from: form.valid_from,
    valid_to: form.valid_to || null,
    check_in: form.check_in,
    check_out: form.check_out,
    tolerance_in: boundedInt(form.tolerance_in, 'Tolerancia de entrada', { min: 0, max: 1440 }) as number,
    tolerance_out: boundedInt(form.tolerance_out, 'Tolerancia de salida', { min: 0, max: 1440 }) as number,
    work_days: [...form.work_days].sort((a, b) => a - b),
    break_mode: form.break_mode,
    break_minutes: boundedInt(form.break_minutes, 'Minutos de descanso', { min: 0, max: 1440 }) as number,
    break_after_minutes: boundedInt(form.break_after_minutes, 'Umbral de descanso', { min: 0, max: 1440 }) as number,
    weekly_target_minutes: minutesFromHours(form.weekly_target_hours, 168),
    daily_target_minutes: minutesFromHours(form.daily_target_hours, 24),
    work_regime: form.work_regime || null,
    night_start: form.night_start || null,
    night_end: form.night_end || null,
    rounding_policy: form.rounding_policy.trim() || null,
    rounding_policy_version: boundedInt(form.rounding_policy_version, 'Versión de redondeo', { min: 1, max: 100000, nullable: true }),
    rounding_policy_config: parsePolicyConfig(form.rounding_policy_config, 'Config de redondeo'),
    overtime_policy: form.overtime_policy.trim() || null,
    overtime_policy_version: boundedInt(form.overtime_policy_version, 'Versión de horas extra', { min: 1, max: 100000, nullable: true }),
    overtime_policy_config: parsePolicyConfig(form.overtime_policy_config, 'Config de horas extra'),
    reason: form.reason.trim() || null,
    notes: form.notes.trim() || null,
  }
}

export function workdayConfigPayloadForSave(
  form: WorkdayConfigForm,
  original?: WorkdayHistoryRow | null,
) {
  const payload = workdayConfigPayload(form)
  if (!original) return payload

  const originalSchedule = original.schedule_id == null ? null : Number(original.schedule_id)
  const selectedSchedule = form.schedule_id ? Number(form.schedule_id) : null

  // updateHistory interpreta la PRESENCIA de schedule_id como una orden de
  // volver a snapshotear el catálogo vivo. Por eso en una corrección de
  // profile/vigencia se omite si no cambió: editar 36 h o una nota jamás debe
  // releer un schedule que pudo haber cambiado desde que nació el snapshot.
  if (originalSchedule === selectedSchedule) {
    const { schedule_id: _unchanged, ...withoutSchedule } = payload
    return withoutSchedule
  }
  return payload
}

export function isRetroactive(validFrom: string, today: string): boolean {
  return Boolean(validFrom && today && validFrom < today)
}

export function modeLabel(mode: EffectiveWorkdayConfig['calculation_mode_candidate'] | undefined) {
  return mode === 'configured' ? 'Configurado' : 'Histórico (sin configurar)'
}
