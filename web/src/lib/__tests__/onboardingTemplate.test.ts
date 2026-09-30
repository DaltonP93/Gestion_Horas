import { buildTemplatePayload, isValidDueDays, TEMPLATE_DUE_DAYS_MAX } from '../onboardingTemplate'

const form = { name: ' Ingreso ', type: 'onboarding' as const, description: '' }
const task = (over = {}) => ({ title: 'Crear cuenta', description: '', default_assignee_role: '', due_days: 3, ...over })

describe('isValidDueDays', () => {
  it('acepta 0..3650 enteros', () => {
    expect(TEMPLATE_DUE_DAYS_MAX).toBe(3650)
    for (const n of [0, 1, 3650]) expect(isValidDueDays(n)).toBe(true)
  })
  it('rechaza negativos, fracciones, NaN, fuera de rango y texto', () => {
    for (const n of [-1, 1.5, NaN, 3651, '5', null]) expect(isValidDueDays(n)).toBe(false)
  })
})

describe('buildTemplatePayload', () => {
  it('cero días es válido; recorta nombre y títulos; descarta filas sin título', () => {
    const r = buildTemplatePayload(form, [task({ title: ' Día cero ', due_days: 0 }), task({ title: '   ' })])
    expect(r).toEqual({ ok: true, payload: { name: 'Ingreso', type: 'onboarding', description: '', tasks: [task({ title: 'Día cero', due_days: 0 })] } })
  })
  it('plazo vacío (NaN) o negativo en una fila con título → error, no se envía', () => {
    expect(buildTemplatePayload(form, [task({ due_days: NaN })]).ok).toBe(false)
    expect(buildTemplatePayload(form, [task(), task({ title: 'Otra', due_days: -2 })]).ok).toBe(false)
  })
  it('sin nombre o sin tareas → error', () => {
    expect(buildTemplatePayload({ ...form, name: '  ' }, [task()]).ok).toBe(false)
    expect(buildTemplatePayload(form, [task({ title: '' })]).ok).toBe(false)
  })
})
