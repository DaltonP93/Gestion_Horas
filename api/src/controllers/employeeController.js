const { sequelize } = require('../config/database');
const logger = require('../config/logger');
const audit = require('../services/audit');

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

    let where = 'WHERE 1=1';
    const params = [];

    if (effectiveStatus && effectiveStatus !== 'all') {
      where += ' AND e.status = ?'; params.push(effectiveStatus);
    }

    const deptVal = dept || department_id;
    if (deptVal) { where += ' AND e.department_id = ?'; params.push(deptVal); }
    if (branch_id) { where += ' AND e.branch_id = ?'; params.push(branch_id); }
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
      ${where}
      ORDER BY e.last_name, e.first_name
      LIMIT ? OFFSET ?
    `, { replacements: [...params, parseInt(limit), parseInt(offset)] });

    const [[{ total }]] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM employees e ${where}`,
      { replacements: params }
    );

    res.json({ data: employees, total, page: +page, limit: +limit, pages: Math.ceil(total / limit) });
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
        s.check_in, s.check_out, s.tolerance_in
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN schedules   s ON e.schedule_id   = s.id
      WHERE e.id = ?
    `, { replacements: [req.params.id] });

    if (!rows.length) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(rows[0]);
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

// PUT /api/employees/:id
async function update(req, res) {
  const { first_name, last_name, email, phone, department_id,
          schedule_id, position, hire_date, birth_date, status,
          document_number, ips_number, salary_base, gender, pay_type,
          children_count, antiguedad_rate } = req.body;
  // Un campo omitido o vacío ('') no debe pisar el valor existente: se pasa
  // NULL para que COALESCE conserve lo que hay en la BD.
  const nn = (v) => (v === undefined || v === '' ? null : v);
  try {
    await sequelize.query(`
      UPDATE employees SET
        first_name = COALESCE(?, first_name),
        last_name  = COALESCE(?, last_name),
        email      = COALESCE(?, email),
        phone      = COALESCE(?, phone),
        department_id = COALESCE(?, department_id),
        schedule_id   = COALESCE(?, schedule_id),
        position   = COALESCE(?, position),
        hire_date  = COALESCE(?, hire_date),
        birth_date = COALESCE(?, birth_date),
        status     = COALESCE(?, status),
        document_number = COALESCE(?, document_number),
        ips_number = COALESCE(?, ips_number),
        salary_base = COALESCE(?, salary_base),
        gender     = COALESCE(?, gender),
        pay_type   = COALESCE(?, pay_type),
        children_count  = COALESCE(?, children_count),
        antiguedad_rate = COALESCE(?, antiguedad_rate)
      WHERE id = ?
    `, { replacements: [first_name, last_name, email, phone, department_id,
        schedule_id, position, hire_date, birth_date, status,
        nn(document_number), nn(ips_number), nn(salary_base), nn(gender), nn(pay_type),
        nn(children_count), nn(antiguedad_rate),
        req.params.id] });

    res.json({ message: 'Empleado actualizado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar empleado' });
  }
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

    audit.log({ req, user: req.user, action: 'employee.deactivate', entity: 'employee', entity_id: id,
      details: { code: emp.code, name: `${emp.first_name} ${emp.last_name}`, reason, was: emp.status } });
    logger.info(`Empleado dado de baja: ${emp.code} (${emp.first_name} ${emp.last_name})`);
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
