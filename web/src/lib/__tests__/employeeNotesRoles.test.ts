import { canManageNotes, NOTE_MANAGER_ROLES } from '../employeeNotesRoles'

describe('canManageNotes', () => {
  test('permite a admin / super_admin / gth / hr / manager', () => {
    for (const r of ['super_admin', 'admin', 'gth', 'hr', 'manager']) {
      expect(canManageNotes(r)).toBe(true)
    }
  })

  test('rechaza roles operativos', () => {
    for (const r of ['employee', 'supervisor', 'coordinator', 'gestor']) {
      expect(canManageNotes(r)).toBe(false)
    }
  })

  test('null / undefined / cadena vacía → false (nunca crashea)', () => {
    expect(canManageNotes(null)).toBe(false)
    expect(canManageNotes(undefined)).toBe(false)
    expect(canManageNotes('')).toBe(false)
  })

  test('espeja el authorize() del backend en employeeNotes.js', () => {
    // Si este set cambia, hay que revisar api/src/routes/employeeNotes.js.
    expect([...NOTE_MANAGER_ROLES].sort())
      .toEqual(['admin', 'gth', 'hr', 'manager', 'super_admin'])
  })
})
