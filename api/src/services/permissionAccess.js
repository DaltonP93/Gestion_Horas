'use strict';

/**
 * permissionAccess.js — alcance de lectura/escritura sobre solicitudes de
 * permiso/licencia (tabla `permissions`).
 *
 * Reglas (una sola fuente para listado, detalle, alta y adjuntos):
 *   - Roles globales de RR.HH. (super_admin, admin, gth, hr): todas.
 *   - Roles con alcance (manager, coordinator, supervisor, gestor): las de
 *     empleados dentro de su alcance departamental (misma fuente que
 *     `enforceEmployeeScope`) + las propias.
 *   - Cualquier otro rol (p. ej. employee): sólo las propias.
 *
 * "Propias" se resuelve SIEMPRE desde la base (`users.employee_id` con
 * `active = 1`), nunca desde el JWT: el claim puede estar desactualizado o
 * vacío tras un refresh.
 *
 * Fuera de alcance se responde igual que "no existe" (404) para no filtrar la
 * existencia del recurso.
 */

const { sequelize } = require('../config/database');
const { getVisibleDepartmentIds, canSeeEmployee } = require('./departmentScope');

/** employee_id vinculado al usuario activo, o null. */
async function resolveSelfEmployeeId(user) {
  if (!user || !user.id) return null;
  const [[row]] = await sequelize.query(
    'SELECT employee_id FROM users WHERE id = ? AND active = 1 LIMIT 1',
    { replacements: [user.id] },
  );
  const id = Number(row?.employee_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Contexto de acceso del actor.
 * @returns {{unrestricted:boolean, deptScope:object|null, selfEmployeeId:number|null}}
 */
async function getAccessContext(user) {
  const deptScope = await getVisibleDepartmentIds(user);
  if (deptScope && deptScope.unrestricted) {
    return { unrestricted: true, deptScope, selfEmployeeId: null };
  }
  const selfEmployeeId = await resolveSelfEmployeeId(user);
  return { unrestricted: false, deptScope, selfEmployeeId };
}

/**
 * Fragmento SQL para acotar un listado. `empAlias` es el alias de employees
 * y `permAlias` el de permissions en la consulta.
 */
function listFilter(ctx, { empAlias = 'e', permAlias = 'p' } = {}) {
  if (ctx.unrestricted) return { clause: '', params: [] };
  const parts = [];
  const params = [];
  const ids = (ctx.deptScope && ctx.deptScope.ids) || [];
  if (ids.length) {
    parts.push(`${empAlias}.department_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  if (ctx.selfEmployeeId) {
    parts.push(`${permAlias}.employee_id = ?`);
    params.push(ctx.selfEmployeeId);
  }
  if (!parts.length) return { clause: ' AND 1=0', params: [] };
  return { clause: ` AND (${parts.join(' OR ')})`, params };
}

/**
 * ¿Puede el actor ver/operar sobre el empleado `emp` ({id, department_id})?
 * Se usa para el detalle de una solicitud y para el alta a nombre de otro.
 */
function canActOnEmployee(ctx, emp) {
  if (!emp) return false;
  if (ctx.unrestricted) return true;
  if (ctx.selfEmployeeId && Number(emp.id) === ctx.selfEmployeeId) return true;
  return canSeeEmployee(ctx.deptScope, emp);
}

module.exports = {
  resolveSelfEmployeeId,
  getAccessContext,
  listFilter,
  canActOnEmployee,
};
