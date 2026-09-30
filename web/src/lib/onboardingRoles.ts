/**
 * Roles del módulo de onboarding. Espeja `api/src/routes/onboarding.js`:
 *   - gestión global: plantillas (escritura) y crear/completar/cancelar procesos;
 *   - gestión (global + con alcance): ver procesos/plantillas y operar tareas.
 * supervisor y employee no administran onboarding.
 */
export const ONBOARDING_ADMIN_ROLES = ['super_admin', 'admin', 'gth', 'hr'] as const
export const ONBOARDING_MANAGER_ROLES = [...ONBOARDING_ADMIN_ROLES, 'manager', 'coordinator', 'gestor'] as const

/** Crear/editar plantillas y crear, completar o cancelar procesos. */
export function canAdministerOnboarding(role: string | undefined | null): boolean {
  return !!role && (ONBOARDING_ADMIN_ROLES as readonly string[]).includes(role)
}

/** Ver procesos de su alcance y operar sus tareas (estado, responsable). */
export function canManageOnboardingTasks(role: string | undefined | null): boolean {
  return !!role && (ONBOARDING_MANAGER_ROLES as readonly string[]).includes(role)
}
