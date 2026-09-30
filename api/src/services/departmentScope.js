/**
 * departmentScope.js — RBAC de lectura por SEDE para roles de gestión.
 *
 * Modelo canónico:
 *   - users.branch_id = alcance de datos (sede).
 *   - role / user_permissions = capacidades (qué puede ver/hacer).
 *   - users.employee_id = vínculo personal opcional; NO define el alcance.
 *
 * Roles scoped (manager / coordinator / supervisor / gestor) ven los
 * departamentos activos de su sede. Sin users.branch_id, o con una sede
 * inexistente o inactiva => alcance vacío (fail-closed). Roles globales (super_admin / admin / gth / hr) mantienen
 * visibilidad total.
 */

const { sequelize } = require('../config/database');
const scopeGrant = require('./scopeGrant');

const UNRESTRICTED_ROLES = new Set(['super_admin', 'admin', 'gth', 'hr']);
const SCOPED_ROLES = new Set(['manager', 'coordinator', 'supervisor', 'gestor']);

let _parentColChecked = null;
async function hasParentColumn() {
  if (_parentColChecked !== null) return _parentColChecked;
  try {
    const [rows] = await sequelize.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'departments' AND COLUMN_NAME = 'parent_id'`
    );
    _parentColChecked = rows.length > 0;
  } catch {
    _parentColChecked = false;
  }
  return _parentColChecked;
}

function isScoped(role) {
  return SCOPED_ROLES.has(role);
}

function isUnrestricted(role) {
  return UNRESTRICTED_ROLES.has(role);
}

/**
 * Devuelve la unión del departamento del empleado del usuario + descendientes.
 * Usa CTE recursiva (MySQL 8). Fallback plano si no hay `parent_id`.
 */
async function _expandDescendants(rootId) {
  if (!rootId) return [];
  if (!(await hasParentColumn())) return [rootId];

  const [rows] = await sequelize.query(
    `WITH RECURSIVE tree AS (
       SELECT id FROM departments WHERE id = ?
       UNION ALL
       SELECT d.id FROM departments d
       JOIN tree t ON d.parent_id = t.id
     )
     SELECT id FROM tree`,
    { replacements: [rootId] }
  );
  return rows.map(r => r.id);
}

/**
 * getVisibleDepartmentIds(user)
 *   → alcance global emitido (scopeGrant)   (admin/hr/gth/super_admin)
 *   → { unrestricted: false, ids: [...] }   (manager/coord/supervisor/gestor)
 *   → { unrestricted: false, ids: [] }      (rol scoped sin empleado/depto → nada)
 * Roles no reconocidos (p.ej. 'employee') → { unrestricted: false, ids: [] }.
 */
async function getVisibleDepartmentIds(user) {
  if (!user || !user.role) return { unrestricted: false, ids: [], branchIds: [] };
  if (isUnrestricted(user.role)) return scopeGrant.issueGlobal();
  if (!isScoped(user.role)) return { unrestricted: false, ids: [], branchIds: [] };

  // La sede pertenece a la CUENTA. Se consulta en cada resolución para que
  // un cambio administrativo tenga efecto inmediato sin depender de un JWT
  // potencialmente desactualizado. La sede debe EXISTIR y estar ACTIVA: sin
  // sede, con una sede inexistente o desactivada no hay alcance (fail-closed).
  // Reactivarla devuelve el alcance en la siguiente resolución; nada se borra.
  let branchId = null;
  try {
    const [[row]] = await sequelize.query(
      `SELECT u.branch_id FROM users u
         JOIN branches b ON b.id = u.branch_id AND b.active = 1
        WHERE u.id = ? AND u.active = 1 LIMIT 1`,
      { replacements: [user.id] }
    );
    branchId = row?.branch_id || null;
  } catch { branchId = null; }

  if (!branchId) return { unrestricted: false, ids: [], branchIds: [] };

  try {
    const [rows] = await sequelize.query(
      'SELECT id FROM departments WHERE active = 1 AND branch_id = ? ORDER BY id',
      { replacements: [branchId] }
    );
    return {
      unrestricted: false,
      ids: rows.map(r => Number(r.id)).filter(Number.isInteger),
      branchIds: [Number(branchId)],
    };
  } catch {
    return { unrestricted: false, ids: [], branchIds: [] };
  }
}

/**
 * Alcance global para TAREAS INTERNAS del servidor sin usuario (p. ej. el
 * reporte programado). No depende de datos de la solicitud. Una prueba
 * estática restringe qué módulos pueden llamarlo.
 */
function systemScope() {
  return scopeGrant.issueGlobal();
}

/**
 * ¿Es un alcance GLOBAL emitido por el servidor? Un objeto armado a mano con
 * `unrestricted: true`, `null` o `undefined` NO lo es (ver scopeGrant.js).
 */
function isGlobal(scope) {
  return scopeGrant.isGlobal(scope);
}

/**
 * Departamentos visibles de un alcance RESTRINGIDO bien formado; cualquier
 * otro valor (ausente, nulo, mal formado) → [] (fail-closed).
 */
function visibleIds(scope) {
  return scopeGrant.isRestricted(scope, ['ids'], ['branchIds']) ? scope.ids : [];
}

/**
 * Compone una cláusula SQL a partir de un scope resuelto.
 *   - global emitido por el servidor: no-op (retorna { where, params }).
 *   - ids vacío, alcance ausente o inválido: fuerza `AND 1=0` (0 filas).
 *   - ids no vacío: `AND col IN (?, ?, …)`.
 */
function applyDepartmentScope(where, params, scope, col = 'e.department_id') {
  if (isGlobal(scope)) return { where, params };
  const ids = visibleIds(scope);
  if (!ids.length) return { where: `${where} AND 1=0`, params };
  const placeholders = ids.map(() => '?').join(',');
  return {
    where: `${where} AND ${col} IN (${placeholders})`,
    params: [...params, ...ids],
  };
}

/**
 * canSeeEmployee(scope, employee) — helper puro para chequeos por-id.
 * Retorna `true` cuando el scope es global (emitido por el servidor) o el
 * `department_id` del empleado está en la lista visible. `department_id`
 * `null` sólo es visible con alcance global (roles scoped no ven "sin depto").
 * Alcance ausente o inválido → `false`.
 */
function canSeeEmployee(scope, employee) {
  if (isGlobal(scope)) return true;
  const ids = visibleIds(scope);
  if (!ids.length) return false;
  const deptId = employee?.department_id ?? null;
  if (deptId == null) return false;
  return ids.includes(deptId);
}

module.exports = {
  UNRESTRICTED_ROLES,
  SCOPED_ROLES,
  isScoped,
  isUnrestricted,
  isGlobal,
  systemScope,
  getVisibleDepartmentIds,
  applyDepartmentScope,
  canSeeEmployee,
  // Exportado sólo para tests.
  _expandDescendants,
};
