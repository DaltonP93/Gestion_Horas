import {
  validateDefaultForm, defaultPayload, parseBulkItems, layerLabel, scopeSummary,
  emptyDefaultForm, DefaultForm, companyLabel, unwrapList, bulkBlockingCount,
  versionIsOpen, canMutateVersion, formFromDefaultRow, supersedePayload, closePayload,
  mutationErrorMessage, WorkdayDefaultRow,
} from '../workdayDefaults'

const rowOpen = { id: 1, scope: 'general', company_id: null, department_id: null, label: null, valid_from: '2026-01-01', valid_to: null, check_in: '08:00:00', check_out: '17:00:00', tolerance_in: 10, tolerance_out: 10, break_mode: 'punched', break_minutes: 0, break_after_minutes: 0, weekly_target_minutes: null, daily_target_minutes: null, work_regime: null, night_start: null, night_end: null, work_days: '2,3,4,5,6', config_version: 1, change_reason: null, active: 1 } as unknown as WorkdayDefaultRow
const rowClosed = { ...rowOpen, id: 2, valid_to: '2026-06-30' } as WorkdayDefaultRow

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

describe('Corrección N — acciones append-only en la UI', () => {
  test('versionIsOpen: abierta si valid_to null/""', () => {
    expect(versionIsOpen(rowOpen)).toBe(true)
    expect(versionIsOpen(rowClosed)).toBe(false)
    expect(versionIsOpen({ valid_to: '' })).toBe(true)
  })

  test('canMutateVersion exige canWrite + writesEnabled + versión ABIERTA', () => {
    expect(canMutateVersion(rowOpen, { canWrite: true, writesEnabled: true })).toBe(true)
    expect(canMutateVersion(rowClosed, { canWrite: true, writesEnabled: true })).toBe(false) // cerrada
    expect(canMutateVersion(rowOpen, { canWrite: false, writesEnabled: true })).toBe(false)   // sin permiso
    expect(canMutateVersion(rowOpen, { canWrite: true, writesEnabled: false })).toBe(false)   // writes off
  })

  test('supersedePayload arma effective_from + payload de jornada (sin scope)', () => {
    const form = formFromDefaultRow(rowOpen, '2026-09-20')
    const p = supersedePayload('2026-10-01', { ...form, check_in: '07:00', change_reason: 'nuevo' })
    expect(p.effective_from).toBe('2026-10-01')
    expect(p.check_in).toBe('07:00')
    expect(p.work_days).toEqual([2, 3, 4, 5, 6])
    expect(p.change_reason).toBe('nuevo')
    expect(p).not.toHaveProperty('scope')
  })

  test('supersedePayload rechaza effective_from inválido', () => {
    const form = formFromDefaultRow(rowOpen, '2026-09-20')
    expect(() => supersedePayload('nope', form)).toThrow(/fecha real/)
  })

  test('closePayload arma valid_to + reason y valida fecha', () => {
    expect(closePayload('2026-12-31', 'fin')).toEqual({ valid_to: '2026-12-31', reason: 'fin' })
    expect(closePayload('2026-12-31', '')).toEqual({ valid_to: '2026-12-31', reason: null })
    expect(() => closePayload('x', 'y')).toThrow(/fecha real/)
  })

  test('mutationErrorMessage mapea los 409 conocidos', () => {
    expect(mutationErrorMessage({ response: { status: 409, data: { code: 'SUPERSEDE_REQUIRES_OPEN_VERSION' } } })).toMatch(/vigencia abierta/i)
    expect(mutationErrorMessage({ response: { status: 409, data: { code: 'DEFAULT_ALREADY_CLOSED' } } })).toMatch(/cerrada/i)
    expect(mutationErrorMessage({ response: { status: 409, data: { code: 'SUPERSEDE_NOT_FORWARD' } } })).toMatch(/después/i)
    expect(mutationErrorMessage({ response: { status: 503 } })).toMatch(/deshabilitadas/i)
    expect(mutationErrorMessage({ message: 'boom' })).toBe('boom')
  })
})

describe('Corrección J — incomplete bloquea la aplicación masiva', () => {
  test('bulkBlockingCount cuenta invalid, incomplete y overlap', () => {
    const results = [
      { status: 'ok' }, { status: 'incomplete' }, { status: 'invalid' },
      { status: 'overlap' }, { status: 'ok' },
    ]
    expect(bulkBlockingCount(results)).toBe(3)
  })
  test('sólo ok → 0 (aplicable)', () => {
    expect(bulkBlockingCount([{ status: 'ok' }, { status: 'ok' }])).toBe(0)
  })
  test('una fila incomplete basta para bloquear', () => {
    expect(bulkBlockingCount([{ status: 'ok' }, { status: 'incomplete' }])).toBe(1)
  })
  test('robusto ante null/no-array', () => {
    expect(bulkBlockingCount(null)).toBe(0)
    expect(bulkBlockingCount(undefined)).toBe(0)
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
