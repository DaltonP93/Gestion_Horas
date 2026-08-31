import {
  applyScheduleToForm, emptyWorkdayConfigForm, formFromHistory,
  isRetroactive, modeLabel, validateWorkdayConfigForm, workdayConfigPayload, workdayConfigPayloadForSave,
} from '../workdayConfig'

describe('workdayConfig UI model', () => {
  test('form vacío no inventa target contractual', () => {
    const f = emptyWorkdayConfigForm('2026-09-01')
    const p = workdayConfigPayload(f)
    expect(p.weekly_target_minutes).toBeNull()
    expect(p.daily_target_minutes).toBeNull()
    expect(p.valid_from).toBe('2026-09-01')
  })

  test('seleccionar schedule copia horario/días pero no target contractual', () => {
    const f = applyScheduleToForm(emptyWorkdayConfigForm('2026-09-01'), {
      id: 7, name: 'Nocturno', check_in: '20:00:00', check_out: '06:00:00',
      tolerance_in: 15, tolerance_out: 5, break_minutes: 30,
      work_days: '1,2,3,4,5',
    })
    expect(f.schedule_id).toBe('7')
    expect(f.check_in).toBe('20:00')
    expect(f.check_out).toBe('06:00')
    expect(f.work_days).toEqual([1,2,3,4,5])
    expect(f.break_mode).toBe('fixed_unpaid')
    expect(f.weekly_target_hours).toBe('')
  })

  test('convierte horas a minutos sólo al guardar', () => {
    const f = emptyWorkdayConfigForm('2026-09-01')
    f.weekly_target_hours = '36'
    f.daily_target_hours = '6'
    const p = workdayConfigPayload(f)
    expect(p.weekly_target_minutes).toBe(2160)
    expect(p.daily_target_minutes).toBe(360)
  })

  test('vigencia siempre requiere fecha efectiva explícita', () => {
    const f = emptyWorkdayConfigForm('')
    expect(validateWorkdayConfigForm(f)).toContain('La fecha "Vigente desde" es obligatoria.')
  })

  test('rechaza fin anterior al inicio', () => {
    const f = emptyWorkdayConfigForm('2026-09-01')
    f.valid_to = '2026-08-31'
    expect(validateWorkdayConfigForm(f).join(' ')).toMatch(/no puede ser anterior/)
  })

  test('snapshot histórico vuelve al formulario sin perder profile', () => {
    const f = formFromHistory({
      id: 1, employee_id: 2, schedule_id: 7, schedule_name_snapshot: 'Noche',
      valid_from: '2025-01-01', valid_to: '2025-06-30',
      check_in: '20:00:00', check_out: '06:00:00',
      tolerance_in: 10, tolerance_out: 5, work_days: [2,3,4,5,6],
      break_mode: 'punched', break_minutes: 0, break_after_minutes: 0,
      weekly_target_minutes: 2160, daily_target_minutes: 360,
      work_regime: 'night', night_start: '20:00:00', night_end: '06:00:00',
      rounding_policy: 'nearest_5', rounding_policy_version: 2,
      overtime_policy: 'rrhh_review', overtime_policy_version: 1,
    })
    expect(f.weekly_target_hours).toBe('36')
    expect(f.daily_target_hours).toBe('6')
    expect(f.work_regime).toBe('night')
    expect(f.valid_from).toBe('2025-01-01')
  })

  test('edición de profile no re-snapshotea el schedule si no cambió', () => {
    const original = {
      id: 1, employee_id: 2, schedule_id: 7, valid_from: '2025-01-01', valid_to: null,
      check_in: '08:00:00', check_out: '17:00:00',
      tolerance_in: 10, tolerance_out: 0, work_days: [2,3,4,5,6],
      break_mode: 'none' as const, break_minutes: 0, break_after_minutes: 0,
      weekly_target_minutes: 2160, daily_target_minutes: 360,
      work_regime: 'custom' as const, night_start: null, night_end: null,
      rounding_policy: null, overtime_policy: null,
    }
    const form = formFromHistory(original)
    form.weekly_target_hours = '42'
    const p = workdayConfigPayloadForSave(form, original)
    expect(p.weekly_target_minutes).toBe(2520)
    expect('schedule_id' in p).toBe(false)
  })

  test('cambiar deliberadamente de schedule sí envía schedule_id', () => {
    const original = {
      id: 1, employee_id: 2, schedule_id: 7, valid_from: '2025-01-01', valid_to: null,
      check_in: '08:00:00', check_out: '17:00:00',
      tolerance_in: 10, tolerance_out: 0, work_days: [2,3,4,5,6],
      break_mode: 'none' as const, break_minutes: 0, break_after_minutes: 0,
      weekly_target_minutes: null, daily_target_minutes: null,
      work_regime: null, night_start: null, night_end: null,
      rounding_policy: null, overtime_policy: null,
    }
    let form = formFromHistory(original)
    form = applyScheduleToForm(form, {
      id: 8, name: 'Nuevo', check_in: '07:00:00', check_out: '15:00:00',
      tolerance_in: 5, tolerance_out: 5, break_minutes: 30, work_days: '2,3,4,5,6',
    })
    const p = workdayConfigPayloadForSave(form, original)
    expect(p.schedule_id).toBe(8)
  })

  test('valida límites máximos iguales al backend', () => {
    const f = emptyWorkdayConfigForm('2026-09-01')
    f.weekly_target_hours = '169'
    f.daily_target_hours = '25'
    const errors = validateWorkdayConfigForm(f).join(' ')
    expect(errors).toContain('168 h')
    expect(errors).toContain('24 h')
  })

  test('policy configs JSON hacen round-trip como objetos, no strings', () => {
    const f = emptyWorkdayConfigForm('2026-09-01')
    f.rounding_policy = 'nearest_5'
    f.rounding_policy_version = '2'
    f.rounding_policy_config = '{"step":5}'
    f.overtime_policy = 'rrhh_review'
    f.overtime_policy_version = '1'
    f.overtime_policy_config = '{"approval":"rrhh"}'

    const p = workdayConfigPayload(f)
    expect(p.rounding_policy_config).toEqual({ step: 5 })
    expect(p.overtime_policy_config).toEqual({ approval: 'rrhh' })
  })

  test('policy config rechaza JSON inválido o arrays', () => {
    const f = emptyWorkdayConfigForm('2026-09-01')
    f.rounding_policy_config = '{'
    expect(validateWorkdayConfigForm(f).join(' ')).toContain('JSON válido')

    f.rounding_policy_config = '[]'
    expect(validateWorkdayConfigForm(f).join(' ')).toContain('objeto JSON')
  })

  test('retroactividad se detecta por fecha civil, sin Date/timezone', () => {
    expect(isRetroactive('2025-01-01', '2026-08-30')).toBe(true)
    expect(isRetroactive('2026-08-30', '2026-08-30')).toBe(false)
    expect(isRetroactive('2026-09-01', '2026-08-30')).toBe(false)
  })

  test('modo fallback se comunica como histórico sin configurar', () => {
    expect(modeLabel('historical_fallback')).toBe('Histórico (sin configurar)')
    expect(modeLabel('configured')).toBe('Configurado')
  })
})
