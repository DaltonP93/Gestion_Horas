import {
  applyScheduleToForm, emptyWorkdayConfigForm, formFromHistory,
  isRetroactive, modeLabel, validateWorkdayConfigForm, workdayConfigPayload,
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
