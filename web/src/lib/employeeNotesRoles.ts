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

/**
 * Roles globales de RR.HH.: pueden usar las tres visibilidades y, si no
 * eligen, la nota queda `hr_only`. Espeja `isUnrestricted` del API.
 */
export const NOTE_GLOBAL_ROLES = ['super_admin', 'admin', 'gth', 'hr'] as const

export type NoteVisibility = 'hr_only' | 'managers' | 'employee'

/**
 * Visibilidades que el rol puede asignar. Un rol por sede sólo puede crear o
 * cambiar a lo que luego puede leer (`managers` / `employee`); el API
 * rechaza `hr_only` con 403 VISIBILITY_NOT_ALLOWED.
 */
export function allowedNoteVisibilities(role: string | undefined | null): NoteVisibility[] {
  if (role && (NOTE_GLOBAL_ROLES as readonly string[]).includes(role)) return ['hr_only', 'managers', 'employee']
  return ['managers', 'employee']
}

/** Visibilidad por defecto del formulario (igual que el default del API). */
export function defaultNoteVisibility(role: string | undefined | null): NoteVisibility {
  return allowedNoteVisibilities(role)[0]
}
