import {
  validateTemplateForm, templateErrorMessage, normalizeCriterionName,
  TEMPLATE_NAME_MAX, CRITERIA_MAX,
} from '../appraisalTemplateForm'

const form = (extra = {}) => ({ name: ' Anual ', description: '', scale_min: 1, scale_max: 5, ...extra })
const c = (name: string, extra = {}) => ({ name, description: '', weight: 1, ...extra })

describe('validateTemplateForm (espeja appraisalTemplateValidation del API)', () => {
  it('válido: recorta nombres y omite descripciones vacías del payload', () => {
    expect(validateTemplateForm(form({ description: 'D' }), [c(' Calidad ', { weight: 2.5, description: 'x' }), c('Equipo')])).toEqual({
      ok: true,
      payload: {
        name: 'Anual', description: 'D', scale_min: 1, scale_max: 5,
        criteria: [{ name: 'Calidad', description: 'x', weight: 2.5 }, { name: 'Equipo', weight: 1 }],
      },
    })
  })
  it('bordes aceptados: escala 0–10, pesos 0.01 y 999.99, 120 caracteres, 50 criterios', () => {
    expect(validateTemplateForm(form({ scale_min: 0, scale_max: 10 }), [c('A', { weight: 0.01 }), c('B', { weight: 999.99 })]).ok).toBe(true)
    expect(validateTemplateForm(form({ name: 'é'.repeat(TEMPLATE_NAME_MAX) }), [c('A')]).ok).toBe(true)
    expect(validateTemplateForm(form(), Array.from({ length: CRITERIA_MAX }, (_, i) => c(`C${i}`))).ok).toBe(true)
  })
  it.each([
    ['nombre vacío', form({ name: '  ' }), [c('A')]],
    ['nombre largo', form({ name: 'x'.repeat(121) }), [c('A')]],
    ['descripción > 65535 bytes', form({ description: 'é'.repeat(32768) }), [c('A')]],
    ['escala NaN (input vacío)', form({ scale_min: NaN }), [c('A')]],
    ['escala fraccionaria', form({ scale_max: 4.5 }), [c('A')]],
    ['escala fuera de 0–10', form({ scale_max: 11 }), [c('A')]],
    ['escala negativa', form({ scale_min: -1 }), [c('A')]],
    ['mínimo = máximo', form({ scale_min: 5, scale_max: 5 }), [c('A')]],
    ['sin criterios', form(), []],
    ['más de 50 criterios', form(), Array.from({ length: 51 }, (_, i) => c(`C${i}`))],
    ['criterio sin nombre (no se descarta)', form(), [c('A'), c('  ')]],
    ['criterio con nombre largo', form(), [c('x'.repeat(121))]],
    ['peso cero', form(), [c('A', { weight: 0 })]],
    ['peso NaN', form(), [c('A', { weight: NaN })]],
    ['peso con 3 decimales', form(), [c('A', { weight: 1.005 })]],
    ['peso sobre 999.99', form(), [c('A', { weight: 1000 })]],
    ['duplicados normalizados', form(), [c('Comunicación'), c('  comunicacion ')]],
  ])('%s → error', (_l, f, crit) => {
    const r = validateTemplateForm(f, crit)
    expect(r.ok).toBe(false)
  })
  it('el error indica el criterio', () => {
    expect(validateTemplateForm(form(), [c('A'), c('')])).toEqual({ ok: false, error: 'Criterio 2: el nombre es requerido' })
  })
  it('normalización de nombres', () => {
    expect(normalizeCriterionName('  Trabajo   EN  Équipo ')).toBe('trabajo en equipo')
  })
})

describe('templateErrorMessage', () => {
  const err = (status: number, error?: unknown) => ({ response: { status, data: error === undefined ? {} : { error } } })
  it('400: mensaje del servidor o genérico', () => {
    expect(templateErrorMessage(err(400, 'criteria[1].name inválido'))).toBe('criteria[1].name inválido')
    expect(templateErrorMessage(err(400))).toBe('Datos inválidos')
  })
  it('403 / 404 / 409', () => {
    expect(templateErrorMessage(err(403, 'Sin permisos'))).toBe('No tienes permisos para esta acción sobre plantillas')
    expect(templateErrorMessage(err(404))).toBe('La plantilla ya no existe')
    expect(templateErrorMessage(err(409, 'Conflicto X'))).toBe('Conflicto X')
    expect(templateErrorMessage(err(409))).toMatch(/recarga/)
  })
  it('500, red o desconocido: genérico (sin detalles internos)', () => {
    expect(templateErrorMessage(err(500, 'ER_SECRET'))).toBe('Error al guardar')
    expect(templateErrorMessage(new Error('Network Error'), 'Error al cargar')).toBe('Error al cargar')
    expect(templateErrorMessage(undefined)).toBe('Error al guardar')
  })
})
