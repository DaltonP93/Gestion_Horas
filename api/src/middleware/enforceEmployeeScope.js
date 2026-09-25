/**
 * enforceEmployeeScope.js — Middleware de alcance organizacional por empleado.
 *
 * Los roles "scoped" (supervisor / manager / gestor / coordinator) sólo pueden
 * operar sobre empleados dentro de su ámbito organizacional: su propio
 * departamento más los descendientes en la jerarquía (`departments.parent_id`).
 * Los roles globales de RR.HH. (super_admin / admin / gth / hr) conservan acceso
 * amplio.
 *
 * REUTILIZA `services/departmentScope` — la MISMA fuente de verdad que ya usan
 * el listado de empleados, los reportes y la asistencia — para no introducir un
 * mecanismo de alcance paralelo.
 *
 * Decisión de negocio (dueño): el acceso FUERA DE ALCANCE responde 404, no 403,
 * para no filtrar la existencia del empleado ("oráculo de existencia"). Un
 * empleado inexistente y uno fuera de alcance quedan indistinguibles para el
 * cliente.
 *
 * De dónde sale el id del empleado:
 *   enforceEmployeeScope('employeeId')                 → req.params.employeeId
 *   enforceEmployeeScope('id')                         → req.params.id
 *   enforceEmployeeScope({ from: 'body',  key: 'employee_id' })
 *   enforceEmployeeScope({ from: 'query', key: 'employee_id' })
 *   enforceEmployeeScope((req) => req.body.employee_id) → función a medida
 *
 * Id AUSENTE: el middleware no decide y llama a next() (el handler responde su
 * propio 400). Id PRESENTE pero no canónico (ver utils/strictId): 400 para
 * todos los roles. Id válido: se publica en `req.scopedEmployeeId`, que es el
 * ÚNICO valor sobre el que debe operar el handler, y se bloquea con 404 si
 * resulta inexistente o fuera de alcance.
 */

const { asyncHandler } = require('../utils/asyncHandler');
const { sequelize } = require('../config/database');
const { getVisibleDepartmentIds, canSeeEmployee } = require('../services/departmentScope');
const { parsePositiveId, isAbsent } = require('../utils/strictId');

function resolveRawId(source, req) {
  if (typeof source === 'function') return source(req);
  if (source && typeof source === 'object') {
    const bag = source.from === 'body'  ? (req.body  || {})
              : source.from === 'query' ? (req.query || {})
              : (req.params || {});
    return bag[source.key];
  }
  // Cadena simple: primero params, luego body (útil para POST /verify).
  return (req.params && req.params[source] != null)
    ? req.params[source]
    : (req.body ? req.body[source] : undefined);
}

function enforceEmployeeScope(source = 'employeeId') {
  const mw = asyncHandler(async (req, res, next) => {
    const rawId = resolveRawId(source, req);

    // Sin id: no decidimos acá; el handler valida (400 propio).
    if (isAbsent(rawId)) return next();

    // Id presente pero no canónico ('1e2', '0x10', '1.5', '10abc', arrays,
    // objetos…) → 400 para todos los roles. Nunca se deja pasar: el handler
    // podría reinterpretar el valor original de otra forma que el control.
    const employeeId = parsePositiveId(rawId);
    if (employeeId === null) {
      return res.status(400).json({ error: 'Identificador de empleado inválido' });
    }
    // Valor ÚNICO validado: el handler opera sobre éste, no sobre la entrada.
    req.scopedEmployeeId = employeeId;

    const scope = await getVisibleDepartmentIds(req.user);

    // Roles globales de RR.HH.: acceso amplio. No pagamos una consulta extra —
    // el propio handler ya resuelve el 404 de "no encontrado" si aplica.
    if (scope && scope.unrestricted) return next();

    const [[emp]] = await sequelize.query(
      'SELECT department_id FROM employees WHERE id = ? LIMIT 1',
      { replacements: [employeeId] }
    );

    // Inexistente o fuera de alcance ⇒ el MISMO 404 (no filtra existencia).
    if (!emp || !canSeeEmployee(scope, emp)) {
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }

    return next();
  });
  // Marca para poder verificar en tests que una ruta tiene el enforcement.
  mw._enforceEmployeeScope = true;
  return mw;
}

module.exports = enforceEmployeeScope;
module.exports.enforceEmployeeScope = enforceEmployeeScope;
