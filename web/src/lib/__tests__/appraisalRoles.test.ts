import { canAdministerAppraisals, canManageAppraisals, canListAppraisals } from '../appraisalRoles'

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
  it.each(['supervisor', '', undefined, null, 'otro'])('%s: sin administración ni listado', (r) => {
    expect(canAdministerAppraisals(r as any)).toBe(false)
    expect(canManageAppraisals(r as any)).toBe(false)
    expect(canListAppraisals(r as any)).toBe(false)
  })
})
