/**
 * departmentScope.js — RBAC de lectura por SEDE para roles de gestión.
 *
 * Modelo canónico:
 *   - users.branch_id = alcance de datos (sede).
 *   - role / user_permissions = capacidades (qué puede ver/hacer).
 *   - users.employee_id = vínculo personal opcional; NO define el alcance.
 *
 * Roles scoped (manager / coordinator / supervisor / gestor) ven los
 * departamentos activos de su sede. Sin users.branch_id => alcance vacío
 * (fail-closed). Roles globales (super_admin / admin / gth / hr) mantienen
 * visibilidad total.
 */

const { sequelize } = require('../config/database');

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
 *   → { unrestricted: true }                (admin/hr/gth/super_admin)
 *   → { unrestricted: false, ids: [...] }   (manager/coord/supervisor/gestor)
 *   → { unrestricted: false, ids: [] }      (rol scoped sin empleado/depto → nada)
 * Roles no reconocidos (p.ej. 'employee') → { unrestricted: false, ids: [] }.
 */
async function getVisibleDepartmentIds(user) {
  if (!user || !user.role) return { unrestricted: false, ids: [], branchIds: [] };
  if (isUnrestricted(user.role)) return { unrestricted: true };
  if (!isScoped(user.role)) return { unrestricted: false, ids: [], branchIds: [] };

  // La sede pertenece a la CUENTA. Se consulta en cada resolución para que
  // un cambio administrativo tenga efecto inmediato sin depender de un JWT
  // potencialmente desactualizado.
  let branchId = null;
  try {
    const [[row]] = await sequelize.query(
      'SELECT branch_id FROM users WHERE id = ? AND active = 1 LIMIT 1',
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
 * Compone una cláusula SQL a partir de un scope resuelto.
 *   - unrestricted: no-op (retorna { where, params }).
 *   - ids vacío: fuerza `AND 1=0` (0 filas).
 *   - ids no vacío: `AND col IN (?, ?, …)`.
 */
function applyDepartmentScope(where, params, scope, col = 'e.department_id') {
  if (!scope || scope.unrestricted) return { where, params };
  const ids = scope.ids || [];
  if (!ids.length) return { where: `${where} AND 1=0`, params };
  const placeholders = ids.map(() => '?').join(',');
  return {
    where: `${where} AND ${col} IN (${placeholders})`,
    params: [...params, ...ids],
  };
}

/**
 * canSeeEmployee(scope, employee) — helper puro para chequeos por-id.
 * Retorna `true` cuando el scope es unrestricted o el `department_id`
 * del empleado está en la lista visible. `department_id` `null` sólo
 * es visible con unrestricted (roles scoped no ven "sin depto").
 */
function canSeeEmployee(scope, employee) {
  if (!scope || scope.unrestricted) return true;
  const ids = scope.ids || [];
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
  getVisibleDepartmentIds,
  applyDepartmentScope,
  canSeeEmployee,
  // Exportado sólo para tests.
  _expandDescendants,
};
