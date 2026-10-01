/**
 * Roles de Evaluaciones de Desempeño. Espeja `api/src/routes/appraisals.js`
 * (el servidor vuelve a autorizar todo; esto sólo decide qué mostrar):
 *   - globales: plantillas (escritura), cierre y override de manager/RR.HH.;
 *   - gestión (globales + manager/coordinator/gestor): listado de su alcance
 *     y alta de evaluaciones;
 *   - supervisor: no administra; puede ser reviewer y su listado sólo trae
 *     las evaluaciones que tiene asignadas (lo filtra el servidor);
 *   - employee: su propio listado, historial, detalle y autoevaluación.
 */
export const APPRAISAL_ADMIN_ROLES = ['super_admin', 'admin', 'gth', 'hr'] as const
export const APPRAISAL_MANAGER_ROLES = [...APPRAISAL_ADMIN_ROLES, 'manager', 'coordinator', 'gestor'] as const
export const APPRAISAL_LIST_ROLES = [...APPRAISAL_MANAGER_ROLES, 'employee', 'supervisor'] as const
/** Candidatos del selector de reviewer (el POST vuelve a validar alcance y estado). */
export const APPRAISAL_REVIEWER_ROLES = ['manager', 'coordinator', 'gestor', 'supervisor', 'admin', 'gth', 'hr'] as const

const has = (list: readonly string[], role: string | undefined | null) => !!role && list.includes(role)

/** Crear/editar/desactivar plantillas, cerrar evaluaciones, override de manager/RR.HH. */
export function canAdministerAppraisals(role: string | undefined | null): boolean {
  return has(APPRAISAL_ADMIN_ROLES, role)
}

/** Ver evaluaciones de su alcance y crear evaluaciones. */
export function canManageAppraisals(role: string | undefined | null): boolean {
  return has(APPRAISAL_MANAGER_ROLES, role)
}

/** ¿El rol puede cargar el listado? (employee: lo propio; supervisor: sus asignadas). */
export function canListAppraisals(role: string | undefined | null): boolean {
  return has(APPRAISAL_LIST_ROLES, role)
}

/** URL del selector de reviewers (/api/users/lookup ya filtra por alcance). */
export function reviewerLookupUrl(): string {
  return `/api/users/lookup?role=${APPRAISAL_REVIEWER_ROLES.join(',')}`
}

/** Acciones de la página según el rol. */
export function appraisalPageActions(role: string | undefined | null) {
  const admin = canAdministerAppraisals(role)
  const mgr = canManageAppraisals(role)
  return {
    loadList: canListAppraisals(role),
    newAppraisal: mgr,
    newTemplate: admin,
    templatesTab: mgr,
    kpis: mgr,
    toggleTemplate: admin,
  }
}

interface DetailInput {
  role: string | undefined | null
  userId: number | undefined | null
  userEmployeeId: number | undefined | null
  status: string
  employeeId: number
  reviewerId: number | null
  selfScored: boolean
  managerScored: boolean
}

/** Acciones del detalle de una evaluación según el rol, la asignación y el estado. */
export function appraisalDetailActions(d: DetailInput) {
  const admin = canAdministerAppraisals(d.role)
  const isEmployee = d.userEmployeeId != null && d.userEmployeeId === d.employeeId
  const isReviewer = d.userId != null && d.reviewerId != null && d.userId === d.reviewerId
  const open = d.status !== 'closed'
  return {
    selfScore: open && d.status === 'self_pending' && isEmployee && !d.selfScored,
    managerScore: open && d.status === 'manager_pending' && (isReviewer || admin) && !d.managerScored,
    hrScore: open && d.status === 'hr_review' && admin,
    close: (d.status === 'hr_review' || d.status === 'manager_pending') && admin,
  }
}
