const { sequelize } = require('../config/database');
const logger = require('../config/logger');
const audit = require('../services/audit');
const { capsForRole } = require('../services/employeeCaps');
const {
  validate: validateField,
  auditValueOf,
  SENSITIVE_VALUE,
} = require('../services/employeeFieldValidation');
const {
  getVisibleDepartmentIds,
  applyDepartmentScope,
  canSeeEmployee,
} = require('../services/departmentScope');
const {
  maskEmployeeRow,
  maskEmployeeList,
  privacyDescriptor,
} = require('../services/employeePrivacy');
const { computeAntiguedad, formatAntiguedad } = require('../services/antiguedad');
const paymentTypes = require('../services/paymentTypes');
const { todayInCompanyTZ } = require('../utils/civilDate');

// Columnas de inactivación (migración 063). Se detectan una vez para degradar
// con gracia si la migración aún no corrió.
let _inactCols = null;
async function hasInactivationCols() {
  if (_inactCols !== null) return _inactCols;
  try {
    const [rows] = await sequelize.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees'
          AND COLUMN_NAME IN ('deactivated_at','device_disable_pending')`
    );
    _inactCols = rows.length >= 2;
  } catch { _inactCols = false; }
  return _inactCols;
}

// GET /api/employees
async function getAll(req, res) {
  try {
    const { dept, department_id, branch_id, status, search, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    // status vacío = mostrar activos por defecto; 'all' o '' sin especificar = todos
    const effectiveStatus = status === undefined ? 'active' : status;

    // `where` se arma SIN el filtro de estado: los contadores por estado se
    // calculan sobre este conjunto (scope + depto + sucursal + búsqueda) para
    // que "Todos = Activos + Inactivos" siempre se sostenga. El filtro de
    // estado se agrega después, sólo para el listado y su total paginado.
    let where = 'WHERE 1=1';
    let params = [];

    const deptVal = dept || department_id;
    if (deptVal) { where += ' AND e.department_id = ?'; params.push(deptVal); }
    if (branch_id) { where += ' AND e.branch_id = ?'; params.push(branch_id); }

    // RBAC jerárquico: los roles scoped ven sólo su depto + descendientes.
    const scope = await getVisibleDepartmentIds(req.user);
    ({ where, params } = applyDepartmentScope(where, params, scope, 'e.department_id'));
    if (search) {
      // Búsqueda por nombre/apellido/código/employee_number(legajo)/documento,
      // y por device_user_id vía employee_device_map (coincidencia EXACTA, como
      // vínculo explícito — no se confunde con employees.code).
      const clauses = [
        'e.first_name LIKE ?', 'e.last_name LIKE ?', 'e.code LIKE ?',
        'e.employee_number LIKE ?', 'e.document_number LIKE ?',
        'CONCAT(e.first_name," ",e.last_name) LIKE ?',
      ];
      const like = `%${search}%`;
      const searchParams = [like, like, like, like, like, like];
      const { tableExists } = require('../services/zktecoReader');
      if (await tableExists('employee_device_map')) {
        clauses.push('e.id IN (SELECT employee_id FROM employee_device_map WHERE device_user_id = ? AND active = 1)');
        searchParams.push(String(search).trim());
      }
      where += ` AND (${clauses.join(' OR ')})`;
      params.push(...searchParams);
    }

    // Contadores por estado sobre el conjunto visible, sin paginar.
    const [statusRows] = await sequelize.query(
      `SELECT e.status AS status, COUNT(*) AS n FROM employees e ${where} GROUP BY e.status`,
      { replacements: params }
    );
    // `suspended` es un estado de primera clase del ENUM y lo asigna el
    // bulk-update: si no se contara aparte, `all` lo incluiría sin que
    // ninguna tarjeta lo mostrara y el total dejaría de cuadrar.
    const counts = { all: 0, active: 0, inactive: 0, suspended: 0 };
    for (const row of statusRows) {
      const n = Number(row.n) || 0;
      counts.all += n;
      if (row.status in counts && row.status !== 'all') counts[row.status] += n;
    }

    // A partir de acá sí pesa el filtro de estado (listado + total paginado).
    let listWhere = where;
    const listParams = [...params];
    if (effectiveStatus && effectiveStatus !== 'all') {
      listWhere += ' AND e.status = ?'; listParams.push(effectiveStatus);
    }

    const [employees] = await sequelize.query(`
      SELECT
        e.id, e.code, e.employee_number, e.document_number,
        CONCAT(e.first_name, ' ', e.last_name) AS full_name,
        e.first_name, e.last_name, e.email, e.phone,
        e.position, e.hire_date, e.status, e.photo_url,
        d.name AS department, d.id AS department_id,
        e.branch_id, b.name AS branch_name,
        s.name AS schedule, s.check_in, s.check_out
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN schedules   s ON e.schedule_id   = s.id
      LEFT JOIN branches    b ON e.branch_id     = b.id
      ${listWhere}
      ORDER BY e.last_name, e.first_name
      LIMIT ? OFFSET ?
    `, { replacements: [...listParams, parseInt(limit), parseInt(offset)] });

    const [[{ total }]] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM employees e ${listWhere}`,
      { replacements: listParams }
    );

    // Enmascarar campos legales cuando el rol no puede verlos.
    const caps = capsForRole(req.user?.role);
    maskEmployeeList(employees, { caps });

    res.json({
      data: employees, total, counts, page: +page, limit: +limit, pages: Math.ceil(total / limit),
      _scope: { unrestricted: !!scope.unrestricted, departments: scope.unrestricted ? null : (scope.ids || []).length },
      _privacy: privacyDescriptor({ caps }),
    });
  } catch (err) {
    logger.error('Error getAll employees:', err);
    res.status(500).json({ error: 'Error al obtener empleados' });
  }
}

// GET /api/employees/:id
async function getById(req, res) {
  try {
    const [rows] = await sequelize.query(`
      SELECT
        e.*, d.name AS department_name, s.name AS schedule_name,
        s.check_in, s.check_out, s.tolerance_in,
        b.name AS branch_name, b.code AS branch_code
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN schedules   s ON e.schedule_id   = s.id
      LEFT JOIN branches    b ON e.branch_id     = b.id
      WHERE e.id = ?
    `, { replacements: [req.params.id] });

    if (!rows.length) return res.status(404).json({ error: 'Empleado no encontrado' });
    const row = rows[0];

    // RBAC jerárquico: 403 si el rol scoped no incluye este departamento.
    const scope = await getVisibleDepartmentIds(req.user);
    if (!canSeeEmployee(scope, row)) {
      return res.status(403).json({ error: 'Sin acceso a este empleado (fuera de tu ámbito)' });
    }

    // Capacidades del usuario actual sobre esta ficha (PR 1 — edición).
    // Permite al frontend ocultar controles sin re-implementar la política.
    const caps = capsForRole(req.user?.role);
    maskEmployeeRow(row, { caps });
    row._caps = caps;
    row._privacy = privacyDescriptor({ caps });

    // Antigüedad derivada de hire_date (única fuente). No se persiste; se
    // recalcula al leer. La UI la muestra en modo lectura sin controles
    // de edición.
    const ant = computeAntiguedad(row.hire_date, todayInCompanyTZ());
    row.antiguedad_years  = ant ? ant.years  : null;
    row.antiguedad_months = ant ? ant.months : null;
    row.antiguedad_label  = formatAntiguedad(ant);

    res.json(row);
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /api/employees
async function create(req, res) {
  const { code, employee_number, first_name, last_name, email, phone,
          department_id, schedule_id, position, hire_date } = req.body;

  if (!code || !first_name || !last_name) {
    return res.status(400).json({ error: 'Código, nombre y apellido son requeridos' });
  }

  try {
    const [result] = await sequelize.query(`
      INSERT INTO employees (code, employee_number, first_name, last_name, email,
        phone, department_id, schedule_id, position, hire_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, { replacements: [code, employee_number, first_name, last_name, email,
        phone, department_id, schedule_id, position, hire_date] });

    logger.info(`Empleado creado: ${code} - ${first_name} ${last_name}`);
    res.status(201).json({ id: result.insertId, message: 'Empleado creado correctamente' });
  } catch (err) {
    if (err.original?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'El código o email ya existe' });
    }
    res.status(500).json({ error: 'Error al crear empleado' });
  }
}

// Columnas DECIMAL de `employees`: comparar por valor numérico, no por texto.
const DECIMAL_COLS = new Set(['salary_base']);
function sameDecimal(before, after) {
  if (before == null && after == null) return true;
  if (before == null || after == null) return false;
  const a = Number(before), b = Number(after);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return String(before) === String(after);
  return a === b;
}

// PUT /api/employees/:id
// Actualización ATÓMICA de la ficha (PR 1: modal de edición completa).
//
// Contrato:
// 1. Se validan TODOS los campos entrantes antes de escribir.
// 2. Si cualquiera falla, se rechaza el request completo (nada se persiste).
// 3. El UPDATE corre dentro de una transacción; la escritura y la comprobación
//    de existencia del empleado comparten la misma conexión.
// 4. Un campo con `null` / `''` significa "limpiar" (a diferencia del viejo
//    COALESCE que no permitía borrar).
// 5. Los campos ausentes en el body se dejan intactos.
// 6. Se auditan solo los cambios reales; `salary_base` NUNCA loggea el valor.
// 7. Responde con la ficha completa recién guardada para que la UI no necesite
//    una segunda vuelta al backend antes de cerrar el modal.
async function update(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

  // Campos permitidos por PUT (superset de /quick + relaciones).
  // `antiguedad_rate` queda fuera desde PR-B: es derivado de hire_date.
  const ALLOWED = new Set([
    'first_name', 'last_name', 'email', 'phone', 'position',
    'hire_date', 'birth_date', 'status',
    'department_id', 'schedule_id', 'branch_id',
    'document_number', 'ips_number', 'salary_base',
    'gender', 'pay_type', 'children_count',
  ]);
  // Campos con validador dedicado (el resto pasa por allowlist genérica).
  const VALIDATED = new Set([
    'first_name', 'last_name', 'email', 'phone', 'position',
    'hire_date', 'birth_date', 'status',
    'document_number', 'ips_number', 'salary_base',
    'gender', 'pay_type', 'children_count',
    'schedule_id',
  ]);
  // FKs opcionales: entero positivo o null; el select de UI envía '' o un id.
  const NULLABLE_FK = new Set(['department_id', 'branch_id']);

  // Validación completa PREVIA a cualquier escritura. Si algún campo falla,
  // devolvemos 400 y el estado en BD queda intacto (guardado atómico).
  const changes = {};
  for (const [k, raw] of Object.entries(req.body || {})) {
    if (!ALLOWED.has(k)) continue;
    if (VALIDATED.has(k)) {
      const v = validateField(k, raw);
      if (!v.ok) return res.status(400).json({ error: v.error, field: k });
      changes[k] = v.value;
    } else if (NULLABLE_FK.has(k)) {
      if (raw === null || raw === '' || raw === undefined) changes[k] = null;
      else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: `${k} inválido`, field: k });
        changes[k] = n;
      }
    }
  }

  if (!Object.keys(changes).length) return res.json({ message: 'Sin cambios', changed: [] });

  // Existencia del pay_type: se comprueba antes de abrir la transacción para
  // no dejar el lock innecesariamente.
  if (changes.pay_type != null) {
    const ok = await paymentTypes.isActiveCode(changes.pay_type);
    if (!ok) return res.status(400).json({ error: 'Tipo de pago inválido o inactivo', field: 'pay_type' });
  }

  const t = await sequelize.transaction();
  try {
    const cols = Object.keys(changes);
    const [prevRows] = await sequelize.query(
      `SELECT ${cols.map(c => '`' + c + '`').join(', ')} FROM employees WHERE id = ? FOR UPDATE`,
      { replacements: [id], transaction: t }
    );
    const prev = prevRows[0];
    if (!prev) {
      await t.rollback();
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }

    // Filtrar los que efectivamente cambian. Las columnas DECIMAL vuelven de
    // MySQL como string ("3500000.00"), así que comparar en texto contra el
    // entero ya normalizado marcaría un cambio inexistente y reescribiría —
    // y auditaría — un salario que nadie tocó.
    const diff = {};
    for (const c of cols) {
      const before = prev[c];
      const after  = changes[c];
      const same = DECIMAL_COLS.has(c)
        ? sameDecimal(before, after)
        : ((before === after) || (before == null && after == null)
           || (before != null && after != null && String(before) === String(after)));
      if (!same) diff[c] = { from: before, to: after };
    }

    if (!Object.keys(diff).length) {
      await t.commit();
      // Sin cambios reales: aún así devolvemos la ficha para que la UI la
      // refresque sin hacer un segundo GET.
      const employee = await readEmployeeById(id, req.user);
      return res.json({ message: 'Sin cambios', changed: [], employee });
    }

    // UPDATE dinámico. Las columnas provienen de la allowlist, nunca del cliente.
    const setSql = Object.keys(diff).map(c => `\`${c}\` = ?`).join(', ');
    const vals   = Object.keys(diff).map(c => diff[c].to);
    await sequelize.query(
      `UPDATE employees SET ${setSql} WHERE id = ?`,
      { replacements: [...vals, id], transaction: t }
    );

    await t.commit();

    // Auditoría fuera de la transacción: si audit.log fallara no queremos
    // revertir la escritura ya confirmada. `salary_base` se enmascara.
    for (const [field, ba] of Object.entries(diff)) {
      const kind = require('../services/employeeCaps').classifyField(field);
      audit.log({
        req, user: req.user,
        action: `employee.update.${kind}`,
        entity: 'employee', entity_id: id,
        details: {
          field,
          from: auditValueOf(field, ba.from),
          to:   auditValueOf(field, ba.to),
          sensitive: SENSITIVE_VALUE.has(field) || undefined,
        },
      });
    }

    const employee = await readEmployeeById(id, req.user);
    return res.json({ message: 'Empleado actualizado', changed: Object.keys(diff), employee });
  } catch (err) {
    try { await t.rollback(); } catch { /* noop */ }
    logger.error('Error updating employee:', err);
    return res.status(500).json({ error: 'Error al actualizar empleado' });
  }
}

// Helper: relee la ficha completa (mismo shape que getById) para devolver al
// cliente tras un UPDATE atómico. Enmascara según caps del usuario actual y
// añade antigüedad derivada + capacidades.
async function readEmployeeById(id, reqUser) {
  const [rows] = await sequelize.query(`
    SELECT
      e.*, d.name AS department_name, s.name AS schedule_name,
      s.check_in, s.check_out, s.tolerance_in,
      b.name AS branch_name, b.code AS branch_code
    FROM employees e
    LEFT JOIN departments d ON e.department_id = d.id
    LEFT JOIN schedules   s ON e.schedule_id   = s.id
    LEFT JOIN branches    b ON e.branch_id     = b.id
    WHERE e.id = ?
  `, { replacements: [id] });
  if (!rows.length) return null;
  const row = rows[0];
  const caps = capsForRole(reqUser?.role);
  maskEmployeeRow(row, { caps });
  row._caps = caps;
  const ant = computeAntiguedad(row.hire_date, todayInCompanyTZ());
  row.antiguedad_years  = ant ? ant.years  : null;
  row.antiguedad_months = ant ? ant.months : null;
  row.antiguedad_label  = formatAntiguedad(ant);
  return row;
}

// DELETE /api/employees/:id · POST /api/employees/:id/deactivate
// Baja robusta: conserva el histórico, registra motivo/quién/cuándo y deja
// pendiente la deshabilitación en el reloj (device_disable_pending) hasta que
// exista la sincronización inversa empleados → reloj. NO escribe al reloj aquí.
async function deactivate(req, res) {
  const id = parseInt(req.params.id, 10);
  const reason = String(req.body?.reason || '').trim().slice(0, 255) || null;
  try {
    const [[emp]] = await sequelize.query(
      'SELECT id, code, first_name, last_name, status FROM employees WHERE id = ?',
      { replacements: [id] }
    );
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });

    if (await hasInactivationCols()) {
      await sequelize.query(
        `UPDATE employees
            SET status = 'inactive', deactivated_at = NOW(), deactivated_by = ?,
                deactivation_reason = ?, reactivated_at = NULL, reactivated_by = NULL,
                device_disable_pending = 1
          WHERE id = ?`,
        { replacements: [req.user?.id || null, reason, id] }
      );
    } else {
      await sequelize.query('UPDATE employees SET status = ? WHERE id = ?', { replacements: ['inactive', id] });
    }

    // La auditoría no serializa PII ni texto libre: sin nombre ni el motivo en
    // claro (el motivo queda en employees.deactivation_reason). Sólo ids/acciones.
    audit.log({ req, user: req.user, action: 'employee.deactivate', entity: 'employee', entity_id: id,
      details: { code: emp.code, was: emp.status, reason_provided: !!reason } });
    logger.info(`Empleado dado de baja: ${emp.code}`);
    res.json({
      message: 'Empleado dado de baja. El histórico se conserva.',
      device_disable_pending: true,
      note: 'La deshabilitación en el reloj queda pendiente hasta la sincronización inversa.',
    });
  } catch (err) {
    logger.error('Error al desactivar empleado:', err);
    res.status(500).json({ error: 'Error al desactivar empleado' });
  }
}

// POST /api/employees/:id/reactivate — reactivar con auditoría.
async function reactivate(req, res) {
  const id = parseInt(req.params.id, 10);
  try {
    const [[emp]] = await sequelize.query(
      'SELECT id, code, first_name, last_name, status FROM employees WHERE id = ?',
      { replacements: [id] }
    );
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });

    if (await hasInactivationCols()) {
      await sequelize.query(
        `UPDATE employees
            SET status = 'active', reactivated_at = NOW(), reactivated_by = ?,
                device_disable_pending = 0
          WHERE id = ?`,
        { replacements: [req.user?.id || null, id] }
      );
    } else {
      await sequelize.query('UPDATE employees SET status = ? WHERE id = ?', { replacements: ['active', id] });
    }

    audit.log({ req, user: req.user, action: 'employee.reactivate', entity: 'employee', entity_id: id,
      details: { code: emp.code, name: `${emp.first_name} ${emp.last_name}`, was: emp.status } });
    logger.info(`Empleado reactivado: ${emp.code} (${emp.first_name} ${emp.last_name})`);
    res.json({ message: 'Empleado reactivado.' });
  } catch (err) {
    logger.error('Error al reactivar empleado:', err);
    res.status(500).json({ error: 'Error al reactivar empleado' });
  }
}

// GET /api/employees/inactive-marks?days=7 — empleados inactivos que siguen
// marcando (alerta). Recorre attendance_logs recientes de empleados no activos.
async function getInactiveMarks(req, res) {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
  try {
    const [rows] = await sequelize.query(`
      SELECT e.id AS employee_id, e.code,
             CONCAT(e.first_name, ' ', e.last_name) AS full_name,
             e.status, e.deactivated_at,
             COUNT(al.id) AS marks,
             MAX(al.timestamp) AS last_mark
        FROM attendance_logs al
        JOIN employees e ON e.id = al.employee_id
       WHERE e.status <> 'active'
         AND al.timestamp >= (NOW() - INTERVAL ? DAY)
       GROUP BY e.id, e.code, full_name, e.status, e.deactivated_at
       ORDER BY last_mark DESC
       LIMIT 200
    `, { replacements: [days] }).catch(async () => {
      // Fallback si deactivated_at no existe aún.
      return sequelize.query(`
        SELECT e.id AS employee_id, e.code,
               CONCAT(e.first_name, ' ', e.last_name) AS full_name,
               e.status, NULL AS deactivated_at,
               COUNT(al.id) AS marks, MAX(al.timestamp) AS last_mark
          FROM attendance_logs al
          JOIN employees e ON e.id = al.employee_id
         WHERE e.status <> 'active' AND al.timestamp >= (NOW() - INTERVAL ? DAY)
         GROUP BY e.id, e.code, full_name, e.status
         ORDER BY last_mark DESC LIMIT 200`, { replacements: [days] });
    });
    res.json({ ok: true, days, count: rows.length, items: rows });
  } catch (err) {
    logger.error('Error en inactive-marks:', err);
    res.status(500).json({ ok: false, error: 'Error al obtener marcas de inactivos' });
  }
}

// GET /api/employees/:id/attendance?from=&to=
async function getAttendanceHistory(req, res) {
  const { from, to = new Date().toISOString().split('T')[0] } = req.query;
  const dateFrom = from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    const [rows] = await sequelize.query(`
      SELECT
        ds.date, ds.first_in, ds.last_out, ds.worked_minutes,
        ds.late_minutes, ds.overtime_minutes, ds.status
      FROM daily_summary ds
      WHERE ds.employee_id = ? AND ds.date BETWEEN ? AND ?
      ORDER BY ds.date DESC
    `, { replacements: [req.params.id, dateFrom, to] });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener historial' });
  }
}

module.exports = { getAll, getById, create, update, deactivate, reactivate, getInactiveMarks, getAttendanceHistory };
