'use strict';

/**
 * appraisalAccess.js — reglas PURAS de acceso a evaluaciones (sin base):
 * qué evaluación puede ver un actor y qué filtro SQL aplica su listado.
 * `scope` es el alcance vigente resuelto por departmentScope; `emp` el
 * empleado evaluado ({ id, department_id }).
 */

const { applyDepartmentScope, canSeeEmployee, isGlobal } = require('./departmentScope');

const SCOPED_MGR_ROLES = new Set(['manager', 'coordinator', 'gestor']);
const ownEmployeeId = (user) => (user && user.employee_id != null ? Number(user.employee_id) : null);

/**
 * ¿Puede el actor ver esta evaluación? `scope` es el alcance vigente del
 * actor; `emp` el empleado evaluado ({ id, department_id }).
 */
function canSeeAppraisal(user, scope, appraisal, emp) {
  if (isGlobal(scope)) return true;
  const assigned = Number(appraisal.reviewer_id) === Number(user.id) && canSeeEmployee(scope, emp);
  const own = ownEmployeeId(user) === Number(appraisal.employee_id);
  // Supervisor: sus propias (acceso personal) o sus asignadas dentro del alcance.
  if (user.role === 'supervisor') return own || assigned;
  if (SCOPED_MGR_ROLES.has(user.role) && canSeeEmployee(scope, emp)) return true;
  return assigned || own;
}

/**
 * Filtro del listado (el MISMO para filas y total). Global: sin filtro;
 * gestión con alcance: departamentos de su alcance; supervisor:
 * `(propia OR (asignada AND en alcance))` — entre paréntesis para que los
 * filtros de estado/período/empleado apliquen a toda la unión; sin vínculo
 * personal sólo la rama asignada, y sin alcance esa rama es `1=0`; employee:
 * sólo lo propio.
 */
function listScope(user, scope, where, params) {
  if (isGlobal(scope)) return { where, params };
  if (SCOPED_MGR_ROLES.has(user.role)) return applyDepartmentScope(where, params, scope, 'e.department_id');
  if (user.role === 'supervisor') {
    // Rama asignada: reviewer = cuenta Y alcance departamental (fail-closed).
    const assigned = applyDepartmentScope('a.reviewer_id = ?', [Number(user.id)], scope, 'e.department_id');
    const parts = [`(${assigned.where})`];
    const branchParams = [...assigned.params];
    // Rama propia: acceso personal, SIN alcance departamental.
    const own = ownEmployeeId(user);
    if (own !== null) { parts.unshift('a.employee_id = ?'); branchParams.unshift(own); }
    return { where: `${where} AND (${parts.join(' OR ')})`, params: [...params, ...branchParams] };
  }
  const own = ownEmployeeId(user);
  if (own === null) return { where: `${where} AND 1=0`, params };
  return { where: `${where} AND a.employee_id = ?`, params: [...params, own] };
}

module.exports = { SCOPED_MGR_ROLES, ownEmployeeId, canSeeAppraisal, listScope };
