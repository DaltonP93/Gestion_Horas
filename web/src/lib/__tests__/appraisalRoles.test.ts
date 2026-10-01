import {
  canAdministerAppraisals, canManageAppraisals, canListAppraisals,
  reviewerLookupUrl, appraisalPageActions, appraisalDetailActions,
} from '../appraisalRoles'

describe('appraisalRoles (espeja api/src/routes/appraisals.js)', () => {
  it.each(['super_admin', 'admin', 'gth', 'hr'])('%s: global (plantillas, cierre) y gestión', (r) => {
    expect(canAdministerAppraisals(r)).toBe(true)
    expect(canManageAppraisals(r)).toBe(true)
    expect(canListAppraisals(r)).toBe(true)
  })
  it.each(['manager', 'coordinator', 'gestor'])('%s: gestión con alcance, sin plantillas', (r) => {
    expect(canAdministerAppraisals(r)).toBe(false)
    expect(canManageAppraisals(r)).toBe(true)
    expect(canListAppraisals(r)).toBe(true)
  })
  it('employee: sólo su listado', () => {
    expect(canAdministerAppraisals('employee')).toBe(false)
    expect(canManageAppraisals('employee')).toBe(false)
    expect(canListAppraisals('employee')).toBe(true)
  })
  it('supervisor: lista sus asignadas pero no administra', () => {
    expect(canAdministerAppraisals('supervisor')).toBe(false)
    expect(canManageAppraisals('supervisor')).toBe(false)
    expect(canListAppraisals('supervisor')).toBe(true)
  })
  it.each(['', undefined, null, 'otro'])('%s: sin administración ni listado', (r) => {
    expect(canAdministerAppraisals(r as any)).toBe(false)
    expect(canManageAppraisals(r as any)).toBe(false)
    expect(canListAppraisals(r as any)).toBe(false)
  })
})

describe('selector de reviewers', () => {
  it('incluye supervisor junto a los roles de gestión', () => {
    expect(reviewerLookupUrl()).toBe('/api/users/lookup?role=manager,coordinator,gestor,supervisor,admin,gth,hr')
  })
})

describe('appraisalPageActions', () => {
  it('supervisor: carga el listado; sin nueva evaluación, plantillas ni KPIs', () => {
    expect(appraisalPageActions('supervisor')).toEqual({
      loadList: true, newAppraisal: false, newTemplate: false, templatesTab: false, kpis: false, toggleTemplate: false,
    })
  })
  it('manager: crea evaluaciones pero no plantillas', () => {
    expect(appraisalPageActions('manager')).toMatchObject({ loadList: true, newAppraisal: true, newTemplate: false, toggleTemplate: false })
  })
  it('hr: todas las acciones', () => {
    expect(appraisalPageActions('hr')).toEqual({
      loadList: true, newAppraisal: true, newTemplate: true, templatesTab: true, kpis: true, toggleTemplate: true,
    })
  })
})

describe('appraisalDetailActions', () => {
  const base = { userId: 7, userEmployeeId: null, employeeId: 3, reviewerId: 7, selfScored: true, managerScored: false }
  it('supervisor asignado en manager_pending: sólo puntuar como manager (sin cierre)', () => {
    expect(appraisalDetailActions({ ...base, role: 'supervisor', status: 'manager_pending' }))
      .toEqual({ selfScore: false, managerScore: true, hrScore: false, close: false })
  })
  it('supervisor asignado en hr_review: ninguna acción', () => {
    expect(appraisalDetailActions({ ...base, role: 'supervisor', status: 'hr_review' }))
      .toEqual({ selfScore: false, managerScore: false, hrScore: false, close: false })
  })
  it('supervisor no asignado: ninguna acción', () => {
    expect(appraisalDetailActions({ ...base, role: 'supervisor', status: 'manager_pending', reviewerId: 99 }))
      .toEqual({ selfScore: false, managerScore: false, hrScore: false, close: false })
  })
  it('hr en hr_review: puntuar RR.HH. y cerrar', () => {
    expect(appraisalDetailActions({ ...base, role: 'hr', userId: 1, status: 'hr_review' }))
      .toEqual({ selfScore: false, managerScore: false, hrScore: true, close: true })
  })
  it('supervisor sobre su propia evaluación en self_pending: sólo autoevaluación (sin cierre)', () => {
    expect(appraisalDetailActions({ ...base, role: 'supervisor', userEmployeeId: 3, reviewerId: 99, status: 'self_pending', selfScored: false }))
      .toEqual({ selfScore: true, managerScore: false, hrScore: false, close: false })
  })
  it('supervisor evaluado y no asignado en manager_pending: no puede puntuar como manager', () => {
    expect(appraisalDetailActions({ ...base, role: 'supervisor', userEmployeeId: 3, reviewerId: 99, status: 'manager_pending' }))
      .toEqual({ selfScore: false, managerScore: false, hrScore: false, close: false })
  })
  it('employee propio en self_pending: autoevaluación', () => {
    expect(appraisalDetailActions({ ...base, role: 'employee', userId: 5, userEmployeeId: 3, reviewerId: 7, status: 'self_pending', selfScored: false }))
      .toEqual({ selfScore: true, managerScore: false, hrScore: false, close: false })
  })
})
