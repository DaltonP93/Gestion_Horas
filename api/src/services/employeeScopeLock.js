'use strict';

/**
 * employeeScopeLock.js — autorización por EMPLEADO consistente con la
 * mutación que autoriza.
 *
 * `findEmployeeInScope(user, employeeId, { transaction, lock, allowSelf })`
 * devuelve `{ id, department_id }` sólo si el empleado EXISTE y el actor puede
 * operar sobre él; si no, `null` (el caller responde el mismo 404 para
 * inexistente y fuera de alcance).
 *
 *   - Roles globales de RR.HH.: cualquier empleado EXISTENTE (antes se
 *     devolvía `true` sin consultar y un id inexistente terminaba en 201/500).
 *   - Roles por sede: empleado de un departamento activo de su sede.
 *   - `allowSelf` (notas): el rol employee sólo su propio empleado
 *     (users.employee_id vigente).
 *   - Cualquier otro caso: null.
 *
 * Con `transaction` + `lock: true`, la fila del empleado se lee con
 * `SELECT … FOR UPDATE` y el alcance del actor con `FOR SHARE`, dentro de la
 * MISMA transacción que la escritura: un cambio concurrente de departamento o
 * de sede espera al commit (o la mutación espera al suyo) y la decisión se
 * toma sobre el valor vigente, nunca sobre una lectura previa.
 */

const { sequelize } = require('../config/database');
const { getVisibleDepartmentIds, canSeeEmployee, isGlobal } = require('./departmentScope');

async function findEmployeeInScope(user, employeeId, { transaction, lock = false, allowSelf = false } = {}) {
  if (!user || !Number.isSafeInteger(employeeId) || employeeId <= 0) return null;
  const scope = await getVisibleDepartmentIds(user, { transaction });
  const [[emp]] = await sequelize.query(
    `SELECT id, department_id FROM employees WHERE id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    { replacements: [employeeId], transaction }
  );
  if (!emp) return null;
  const row = { id: Number(emp.id), department_id: emp.department_id == null ? null : Number(emp.department_id) };
  if (isGlobal(scope)) return row;
  if (allowSelf && user.role === 'employee') {
    return user.employee_id != null && Number(user.employee_id) === row.id ? row : null;
  }
  return canSeeEmployee(scope, row) ? row : null;
}

/** Rollback que no enmascara el error original ni falla si ya terminó. */
async function rollbackQuietly(t) {
  if (!t || t.finished) return;
  try { await t.rollback(); } catch { /* noop */ }
}

module.exports = { findEmployeeInScope, rollbackQuietly };
