/**
 * departmentScope.js — RBAC jerárquico por departamento.
 *
 * Roles "scoped" (manager / coordinator / supervisor / gestor) sólo ven
 * empleados de su departamento y de los descendientes en la jerarquía
 * (`departments.parent_id`). Los roles admin / super_admin / hr / gth
 * mantienen visibilidad total (retornamos `null`, "sin filtro").
 *
 * El scope se determina desde el empleado vinculado al usuario
 * (`users.employee_id → employees.department_id`) más los descendientes
 * de ese departamento. Si el usuario tiene rol scoped pero no está
 * vinculado a un empleado con departamento, el resultado es `[]`
 * (sin visibilidad → 0 filas) para evitar leaks accidentales.
 *
 * Diseño defensivo:
 *   - `getVisibleDepartmentIds(user)` retorna `{ unrestricted: true }`
 *     para roles no scoped o `{ unrestricted: false, ids: number[] }`.
 *   - El helper `applyDepartmentScope(where, params, scope, col)` compone
 *     la cláusula SQL de forma segura cuando `unrestricted === false`.
 *   - Si la migración 066 aún no corrió (no hay `parent_id`), degradamos
 *     al scope plano del propio departamento del usuario.
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
  if (!user || !user.role) return { unrestricted: false, ids: [] };
  if (isUnrestricted(user.role)) return { unrestricted: true };
  if (!isScoped(user.role)) return { unrestricted: false, ids: [] };

  let deptId = null;
  if (user.employee_id) {
    try {
      const [[row]] = await sequelize.query(
        'SELECT department_id FROM employees WHERE id = ? LIMIT 1',
        { replacements: [user.employee_id] }
      );
      deptId = row?.department_id || null;
    } catch { deptId = null; }
  }
  if (!deptId) return { unrestricted: false, ids: [] };

  const ids = await _expandDescendants(deptId);
  return { unrestricted: false, ids };
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
