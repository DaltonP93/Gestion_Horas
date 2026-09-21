import {
  validateDefaultForm, defaultPayload, parseBulkItems, layerLabel, scopeSummary,
  emptyDefaultForm, DefaultForm, companyLabel, unwrapList,
} from '../workdayDefaults'

const base = (over: Partial<DefaultForm> = {}): DefaultForm => ({ ...emptyDefaultForm('2026-09-20'), ...over })

describe('validateDefaultForm — coherencia de alcance y vigencia', () => {
  test('general no admite empresa/depto', () => {
    expect(validateDefaultForm(base({ scope: 'general', company_id: '3' })))
      .toContain('El alcance general no admite empresa ni departamento.')
  })
  test('company exige empresa; department exige depto', () => {
    expect(validateDefaultForm(base({ scope: 'company' }))[0]).toMatch(/Empresa/)
    expect(validateDefaultForm(base({ scope: 'department' }))[0]).toMatch(/Departamento/)
  })
  test('valid_to < valid_from se rechaza', () => {
    const errs = validateDefaultForm(base({ valid_from: '2026-09-10', valid_to: '2026-09-01' }))
    expect(errs.some(e => /no puede ser anterior/.test(e))).toBe(true)
  })
  test('franja nocturna exige inicio y fin', () => {
    expect(validateDefaultForm(base({ night_start: '21:00', night_end: '' })))
      .toContain('La franja nocturna requiere inicio y fin.')
  })
  test('formulario general válido no arroja errores', () => {
    expect(validateDefaultForm(base())).toEqual([])
  })
})

describe('defaultPayload — normalización', () => {
  test('mapea alcance y ordena días', () => {
    const p = defaultPayload(base({ scope: 'department', department_id: '5', work_days: [6, 2, 4] }))
    expect(p.scope).toBe('department')
    expect(p.department_id).toBe(5)
    expect(p.company_id).toBeNull()
    expect(p.work_days).toEqual([2, 4, 6])
  })
  test('lanza con el primer error', () => {
    expect(() => defaultPayload(base({ scope: 'company' }))).toThrow(/Empresa/)
  })
})

describe('parseBulkItems — JSON array y NDJSON', () => {
  test('array JSON', () => {
    expect(parseBulkItems('[{"a":1},{"a":2}]')).toHaveLength(2)
  })
  test('NDJSON una línea por objeto', () => {
    expect(parseBulkItems('{"a":1}\n{"a":2}')).toHaveLength(2)
  })
  test('vacío → []', () => {
    expect(parseBulkItems('   ')).toEqual([])
  })
  test('línea inválida informa el número', () => {
    expect(() => parseBulkItems('{"a":1}\n{bad}')).toThrow(/Línea 2/)
  })
})

describe('Corrección F — formas reales de las APIs', () => {
  test('companyLabel usa trade_name || legal_name || code (NO company.name)', () => {
    expect(companyLabel({ id: 1, trade_name: 'ACME', legal_name: 'ACME S.A.', code: 'AC' })).toBe('ACME')
    expect(companyLabel({ id: 1, trade_name: null, legal_name: 'ACME S.A.', code: 'AC' })).toBe('ACME S.A.')
    expect(companyLabel({ id: 1, trade_name: null, legal_name: null, code: 'AC' })).toBe('AC')
    expect(companyLabel({ id: 7 })).toBe('#7')
  })
  test('unwrapList acepta { data: [...] } (companies) y array directo (departments)', () => {
    expect(unwrapList({ data: [{ id: 1 }, { id: 2 }] })).toHaveLength(2)   // /api/companies
    expect(unwrapList([{ id: 1 }])).toHaveLength(1)                        // /api/departments
    expect(unwrapList(null)).toEqual([])
    expect(unwrapList({})).toEqual([])
    expect(unwrapList('nope')).toEqual([])
  })
})

describe('etiquetas', () => {
  test('layerLabel traduce capas conocidas y pasa las desconocidas', () => {
    expect(layerLabel('department_historical_default')).toMatch(/departamento/i)
    expect(layerLabel('x_unknown')).toBe('x_unknown')
    expect(layerLabel(null)).toBe('—')
  })
  test('scopeSummary describe el alcance', () => {
    expect(scopeSummary({ scope: 'general', company_id: null, department_id: null })).toBe('General')
    expect(scopeSummary({ scope: 'company', company_id: 3, department_id: null })).toMatch(/Empresa #3/)
    expect(scopeSummary({ scope: 'department', company_id: null, department_id: 9 })).toMatch(/Departamento #9/)
  })
})
