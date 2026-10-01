/**
 * Roles de Evaluaciones de Desempeño. Espeja `api/src/routes/appraisals.js`
 * (el servidor vuelve a autorizar todo; esto sólo decide qué mostrar):
 *   - globales: plantillas (escritura), cierre y override de manager/RR.HH.;
 *   - gestión (globales + manager/coordinator/gestor): listado de su alcance
 *     y alta de evaluaciones;
 *   - employee: su propio listado, historial, detalle y autoevaluación.
 * supervisor no administra evaluaciones (sólo las que tenga asignadas como reviewer).
 */
export const APPRAISAL_ADMIN_ROLES = ['super_admin', 'admin', 'gth', 'hr'] as const
export const APPRAISAL_MANAGER_ROLES = [...APPRAISAL_ADMIN_ROLES, 'manager', 'coordinator', 'gestor'] as const
export const APPRAISAL_LIST_ROLES = [...APPRAISAL_MANAGER_ROLES, 'employee'] as const

const has = (list: readonly string[], role: string | undefined | null) => !!role && list.includes(role)

/** Crear/editar/desactivar plantillas, cerrar evaluaciones, override de manager/RR.HH. */
export function canAdministerAppraisals(role: string | undefined | null): boolean {
  return has(APPRAISAL_ADMIN_ROLES, role)
}

/** Ver evaluaciones de su alcance y crear evaluaciones. */
export function canManageAppraisals(role: string | undefined | null): boolean {
  return has(APPRAISAL_MANAGER_ROLES, role)
}

/** ¿El rol puede cargar el listado? (employee: sólo lo propio, lo filtra el servidor). */
export function canListAppraisals(role: string | undefined | null): boolean {
  return has(APPRAISAL_LIST_ROLES, role)
}
