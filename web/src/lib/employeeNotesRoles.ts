/**
 * Roles autorizados a crear / editar / borrar notas del empleado.
 * Extraído del componente `EmployeeNotes` para poder testearlo en jest
 * (config `node`, sin JSX/DOM).
 *
 * Espeja `authorize(...)` de `api/src/routes/employeeNotes.js` — si se
 * amplía uno, ampliar el otro para mantenerlos coherentes.
 */
export const NOTE_MANAGER_ROLES = [
  'super_admin', 'admin', 'gth', 'hr', 'manager',
] as const

export type NoteManagerRole = typeof NOTE_MANAGER_ROLES[number]

export function canManageNotes(role: string | undefined | null): boolean {
  if (!role) return false
  return (NOTE_MANAGER_ROLES as readonly string[]).includes(role)
}
