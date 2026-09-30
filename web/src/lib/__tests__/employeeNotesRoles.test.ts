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

describe('visibilidad de notas por rol (espeja api/src/routes/employeeNotes.js)', () => {
  const { allowedNoteVisibilities, defaultNoteVisibility } = require('../employeeNotesRoles')

  test('roles globales: las tres visibilidades y `hr_only` por defecto', () => {
    for (const r of ['super_admin', 'admin', 'gth', 'hr']) {
      expect(allowedNoteVisibilities(r)).toEqual(['hr_only', 'managers', 'employee'])
      expect(defaultNoteVisibility(r)).toBe('hr_only')
    }
  })

  test('roles por sede: sin `hr_only` y `managers` por defecto', () => {
    for (const r of ['manager', 'coordinator', 'supervisor', 'gestor', 'employee', null, undefined, '']) {
      expect(allowedNoteVisibilities(r)).toEqual(['managers', 'employee'])
      expect(defaultNoteVisibility(r)).toBe('managers')
    }
  })
})
