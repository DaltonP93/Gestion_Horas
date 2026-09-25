'use strict';

/**
 * permissionAccess.js — capacidad funcional + alcance sobre solicitudes de
 * permiso/licencia (tabla `permissions`). Fuente única para listado, detalle,
 * alta, cancelación y adjuntos.
 *
 * Dos requisitos independientes:
 *   1. CAPACIDAD funcional (services/capabilities, misma regla que
 *      requirePermission, incluida la denegación explícita por usuario):
 *        - `mis_permisos` → autoservicio sobre las solicitudes PROPIAS;
 *        - `permisos`     → gestión de solicitudes de OTRAS personas.
 *   2. ALCANCE (sólo para otras personas): roles globales de RR.HH. → todos;
 *      roles con alcance → empleados de sus departamentos visibles (misma
 *      fuente que enforceEmployeeScope); resto → nadie.
 *   Tener empleados en alcance NUNCA concede la capacidad.
 *
 * Identidad desde la base, no desde el token: se leen `role`, `active` y
 * `employee_id` vigentes del usuario. Usuario inexistente o inactivo → sin
 * acceso. Una solicitud propia también es alcanzable por la vía de gestión
 * (si el actor tiene `permisos` y su propio departamento está en alcance).
 *
 * Fuera de alcance / sin visibilidad ≡ inexistente (404) a nivel objeto.
 */

const { sequelize } = require('../config/database');
const { getVisibleDepartmentIds, canSeeEmployee } = require('./departmentScope');
const { getCapabilityFlags } = require('./capabilities');

const OWN_MODULE = 'mis_permisos';
const OTHERS_MODULE = 'permisos';

/** Fila vigente del usuario o null. */
async function loadActor(user) {
  if (!user || !user.id) return null;
  const [[row]] = await sequelize.query(
    'SELECT id, role, active, employee_id FROM users WHERE id = ? LIMIT 1',
    { replacements: [user.id] },
  );
  return row || null;
}

/** employee_id vinculado al usuario ACTIVO, o null. */
async function resolveSelfEmployeeId(user) {
  const row = await loadActor(user);
  if (!row || Number(row.active) !== 1) return null;
  const id = Number(row.employee_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Contexto de acceso del actor.
 * @returns {{active:false} | {active:true, actor:{id:number,role:string},
 *   unrestricted:boolean, deptScope:object, selfEmployeeId:number|null,
 *   can:{own:object, others:object}}}
 */
async function getAccessContext(user) {
  const row = await loadActor(user);
  if (!row || Number(row.active) !== 1) return { active: false };
  const actor = { id: Number(row.id), role: row.role };
  const [deptScope, flags] = await Promise.all([
    getVisibleDepartmentIds(actor),
    getCapabilityFlags(actor, [OWN_MODULE, OTHERS_MODULE]),
  ]);
  const selfId = Number(row.employee_id);
  return {
    active: true,
    actor,
    unrestricted: !!(deptScope && deptScope.unrestricted),
    deptScope,
    selfEmployeeId: Number.isInteger(selfId) && selfId > 0 ? selfId : null,
    can: { own: flags[OWN_MODULE], others: flags[OTHERS_MODULE] },
  };
}

function isOwn(ctx, employeeId) {
  return !!ctx.selfEmployeeId && Number(employeeId) === ctx.selfEmployeeId;
}

/** Vía de gestión: capacidad `permisos` + alcance. */
function canManage(ctx, action, emp) {
  if (!ctx.active || !emp || !ctx.can.others[action]) return false;
  return ctx.unrestricted || canSeeEmployee(ctx.deptScope, emp);
}

/**
 * ¿Puede el actor ejecutar `action` sobre solicitudes del empleado `emp`
 * ({id, department_id})? Propio: `mis_permisos` o la vía de gestión.
 */
function canOnEmployee(ctx, action, emp) {
  if (!ctx || !ctx.active || !emp) return false;
  if (isOwn(ctx, emp.id) && ctx.can.own[action]) return true;
  return canManage(ctx, action, emp);
}

/** ¿Tiene alguna forma de ver solicitudes? (para 403 explícito en listado) */
function canListAny(ctx) {
  return !!(ctx && ctx.active && (ctx.can.own.view || ctx.can.others.view));
}

/**
 * Fragmento SQL que acota el listado a lo que el actor puede ver.
 * `empAlias`/`permAlias`: alias de employees y permissions en la consulta.
 */
function listFilter(ctx, { empAlias = 'e', permAlias = 'p' } = {}) {
  if (!ctx || !ctx.active) return { clause: ' AND 1=0', params: [] };
  const parts = [];
  const params = [];
  if (ctx.can.others.view) {
    if (ctx.unrestricted) return { clause: '', params: [] };
    const ids = (ctx.deptScope && ctx.deptScope.ids) || [];
    if (ids.length) {
      parts.push(`${empAlias}.department_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
  }
  if (ctx.can.own.view && ctx.selfEmployeeId) {
    parts.push(`${permAlias}.employee_id = ?`);
    params.push(ctx.selfEmployeeId);
  }
  if (!parts.length) return { clause: ' AND 1=0', params: [] };
  return { clause: ` AND (${parts.join(' OR ')})`, params };
}

module.exports = {
  OWN_MODULE,
  OTHERS_MODULE,
  resolveSelfEmployeeId,
  getAccessContext,
  isOwn,
  canManage,
  canOnEmployee,
  canListAny,
  listFilter,
};
