/**
 * integration.js
 * Endpoints especiales para integración con sistemas externos.
 *
 * Autenticación: X-API-Key header (sin necesidad de JWT de usuario).
 * Ideal para Oracle APEX, ERP, nómina, etc.
 *
 * @swagger
 * tags:
 *   - name: Integration
 *     description: Endpoints optimizados para integración con Oracle APEX y otros sistemas
 */

const router   = require('express').Router();
const { sequelize } = require('../config/database');
const logger   = require('../config/logger');
const { pyDateStr } = require('../services/scheduler');
const { buildPayrollDataset, toCsv, buildWorkbook } = require('../services/payrollExport');

// Middleware: autenticación por API Key
function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.INTEGRATION_API_KEY) {
    return res.status(401).json({ error: 'X-API-Key inválida o faltante' });
  }
  next();
}

router.use(apiKeyAuth);

/**
 * @swagger
 * /api/integration/attendance/today:
 *   get:
 *     tags: [Integration]
 *     summary: Asistencia de hoy — optimizado para Oracle APEX
 *     description: |
 *       Devuelve todos los marcajes del día actual en formato plano.
 *       Ideal para crear una fuente de datos REST en Oracle APEX.
 *
 *       **Oracle APEX — REST Data Source:**
 *       - URL: GET /api/integration/attendance/today
 *       - Header: X-API-Key: {tu_clave}
 *       - Response type: JSON
 *       - Row Selector: $.data[*]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: dept_id
 *         schema: { type: integer }
 *         description: Filtrar por departamento
 *     responses:
 *       200:
 *         description: Marcajes del día
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 date:  { type: string, format: date }
 *                 total: { type: integer }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/DailySummary' }
 */
router.get('/attendance/today', async (req, res) => {
  const today = pyDateStr(new Date());
  const { dept_id } = req.query;

  let deptFilter = '';
  const params = [today];
  if (dept_id) { deptFilter = 'AND e.department_id = ?'; params.push(dept_id); }

  const [rows] = await sequelize.query(`
    SELECT
      e.id           AS employee_id,
      e.code         AS employee_code,
      e.employee_number,
      CONCAT(e.first_name,' ',e.last_name) AS employee_name,
      d.name         AS department,
      s.check_in     AS scheduled_in,
      s.check_out    AS scheduled_out,
      ds.first_in,
      ds.last_out,
      ds.worked_minutes,
      ds.late_minutes,
      ds.overtime_minutes,
      COALESCE(ds.status,'absent') AS status
    FROM employees e
    LEFT JOIN departments  d  ON e.department_id = d.id
    LEFT JOIN schedules    s  ON e.schedule_id   = s.id
    LEFT JOIN daily_summary ds ON e.id = ds.employee_id AND ds.date = ?
    WHERE e.status = 'active' ${deptFilter}
    ORDER BY d.name, e.last_name, e.first_name
  `, { replacements: params });

  res.json({ date: today, total: rows.length, data: rows });
});

/**
 * @swagger
 * /api/integration/attendance/range:
 *   get:
 *     tags: [Integration]
 *     summary: Rango de fechas — para reportes de nómina
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: date_from
 *         required: true
 *         schema: { type: string, format: date }
 *         example: "2026-04-01"
 *       - in: query
 *         name: date_to
 *         required: true
 *         schema: { type: string, format: date }
 *         example: "2026-04-30"
 *       - in: query
 *         name: employee_id
 *         schema: { type: integer }
 *       - in: query
 *         name: dept_id
 *         schema: { type: integer }
 */
router.get('/attendance/range', async (req, res) => {
  const { date_from, date_to, employee_id, dept_id } = req.query;
  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from y date_to son requeridos' });
  }

  let where = 'WHERE ds.date BETWEEN ? AND ? AND e.status = "active"';
  const params = [date_from, date_to];
  if (employee_id) { where += ' AND e.id = ?'; params.push(employee_id); }
  if (dept_id)     { where += ' AND e.department_id = ?'; params.push(dept_id); }

  const [rows] = await sequelize.query(`
    SELECT
      ds.date,
      e.id           AS employee_id,
      e.code         AS employee_code,
      e.employee_number,
      CONCAT(e.first_name,' ',e.last_name) AS employee_name,
      d.name         AS department,
      ds.first_in,
      ds.last_out,
      ds.worked_minutes,
      ds.late_minutes,
      ds.overtime_minutes,
      ds.status
    FROM daily_summary ds
    JOIN employees e ON ds.employee_id = e.id
    LEFT JOIN departments d ON e.department_id = d.id
    ${where}
    ORDER BY ds.date, e.last_name
  `, { replacements: params });

  res.json({
    date_from, date_to,
    total_records: rows.length,
    data: rows
  });
});

/**
 * @swagger
 * /api/integration/employees:
 *   get:
 *     tags: [Integration]
 *     summary: Lista de empleados activos
 *     security:
 *       - apiKeyAuth: []
 */
router.get('/employees', async (req, res) => {
  const [rows] = await sequelize.query(`
    SELECT
      e.id, e.code, e.employee_number,
      CONCAT(e.first_name,' ',e.last_name) AS full_name,
      e.first_name, e.last_name, e.email, e.phone,
      d.id AS dept_id, d.name AS department,
      s.id AS schedule_id, s.name AS schedule,
      s.check_in, s.check_out,
      e.position, e.hire_date, e.status
    FROM employees e
    LEFT JOIN departments d ON e.department_id = d.id
    LEFT JOIN schedules   s ON e.schedule_id   = s.id
    WHERE e.status = 'active'
    ORDER BY e.last_name, e.first_name
  `);
  res.json({ total: rows.length, data: rows });
});

/**
 * @swagger
 * /api/integration/stats/summary:
 *   get:
 *     tags: [Integration]
 *     summary: Resumen de KPIs para dashboard externo
 *     security:
 *       - apiKeyAuth: []
 */
router.get('/stats/summary', async (req, res) => {
  const today = pyDateStr(new Date());

  const [[stats]] = await sequelize.query(`
    SELECT
      COUNT(e.id)                                              AS total_employees,
      SUM(ds.status IN ('present','late'))                     AS present_today,
      SUM(ds.status = 'late')                                  AS late_today,
      SUM(ds.status = 'absent' OR ds.status IS NULL)           AS absent_today,
      SUM(ds.status = 'permission')                            AS on_permission,
      ROUND(SUM(ds.status IN ('present','late')) / COUNT(e.id) * 100, 1) AS attendance_pct
    FROM employees e
    LEFT JOIN daily_summary ds ON e.id = ds.employee_id AND ds.date = ?
    WHERE e.status = 'active'
  `, { replacements: [today] });

  res.json({ date: today, ...stats });
});

/**
 * @swagger
 * /api/integration/checkin:
 *   post:
 *     tags: [Integration]
 *     summary: Registrar marcaje desde sistema externo
 *     description: |
 *       Permite a sistemas externos (Oracle APEX, ERP) registrar un marcaje.
 *       Útil cuando el empleado marca desde una interfaz web del ERP.
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [employee_code]
 *             properties:
 *               employee_code:
 *                 type: string
 *                 description: Código del empleado (campo "code" en employees)
 *                 example: "1089"
 *               timestamp:
 *                 type: string
 *                 format: date-time
 *                 description: Si no se envía, usa la hora actual del servidor
 *               type:
 *                 type: string
 *                 enum: [in, out]
 *                 description: Si no se envía, se detecta automáticamente
 *               notes:
 *                 type: string
 */
router.post('/checkin', async (req, res) => {
  const { employee_code, timestamp, type, notes } = req.body;
  if (!employee_code) {
    return res.status(400).json({ error: 'employee_code es requerido' });
  }

  try {
    const [[emp]] = await sequelize.query(
      'SELECT id, first_name, last_name FROM employees WHERE code = ? AND status = "active"',
      { replacements: [String(employee_code)] }
    );
    if (!emp) return res.status(404).json({ error: `Empleado con código ${employee_code} no encontrado` });

    const ts = timestamp ? new Date(timestamp) : new Date();
    const detectedType = type || 'unknown';

    await sequelize.query(
      'INSERT INTO attendance_logs (employee_id, timestamp, type, source) VALUES (?, ?, ?, "manual")',
      { replacements: [emp.id, ts, detectedType] }
    );

    logger.info(`Marcaje externo: ${emp.first_name} ${emp.last_name} - ${detectedType} - ${ts.toISOString()}`);

    res.status(201).json({
      ok: true,
      employee_id:   emp.id,
      employee_name: `${emp.first_name} ${emp.last_name}`,
      timestamp:     ts.toISOString(),
      type:          detectedType
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/integration/payroll/export.json:
 *   get:
 *     tags: [Integration]
 *     summary: Planilla mensual de horas/asistencia — dataset canónico para nómina
 *     description: |
 *       Dataset canónico y versionado (`schema_version`) por empleado del período,
 *       pensado para integrar con CUALQUIER sistema de nómina externo. Las horas
 *       trabajadas se calculan con el MOTOR de jornada (los turnos nocturnos que
 *       cruzan medianoche cuentan como UN jornal), no con la suma cruda por fecha
 *       civil.
 *
 *       Auth: header `X-API-Key`. Disponible también como `.csv` y `.xlsx`.
 *
 *       **Unidades:** `minutos_*`/`atrasos_min` en minutos; `horas_*` en horas
 *       (= minutos/60, 2 decimales); `dias_trabajados`/`ausencias` en días.
 *
 *       **Sin montos:** esta vía (API Key compartida) NUNCA incluye salarios;
 *       expone sólo identificadores + horas/asistencia. Para montos usar la vía
 *       JWT (`/api/payroll/export.*`) con un rol autorizado.
 *
 *       Documentación completa: `docs/nomina-export-integracion.md`.
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *         example: 2026
 *       - in: query
 *         name: month
 *         schema: { type: integer }
 *         example: 4
 *       - in: query
 *         name: department_id
 *         schema: { type: integer }
 */
function payrollExportParams(req) {
  const now = new Date();
  const year = +(req.query.year || now.getFullYear());
  const month = +(req.query.month || (now.getMonth() + 1));
  const departmentId = req.query.department_id ? +req.query.department_id : null;
  // La vía API Key NUNCA exporta montos (includeAmounts: false).
  return { year, month, departmentId, includeAmounts: false };
}

router.get('/payroll/export.json', async (req, res) => {
  try {
    const dataset = await buildPayrollDataset(payrollExportParams(req));
    res.setHeader('X-Schema-Version', dataset.schema_version);
    res.json(dataset);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/payroll/export.csv', async (req, res) => {
  try {
    const p = payrollExportParams(req);
    const dataset = await buildPayrollDataset(p);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nomina_export_${p.year}-${String(p.month).padStart(2, '0')}.csv"`);
    res.setHeader('X-Schema-Version', dataset.schema_version);
    res.send(toCsv(dataset));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/payroll/export.xlsx', async (req, res) => {
  try {
    const p = payrollExportParams(req);
    const dataset = await buildPayrollDataset(p);
    const wb = buildWorkbook(dataset);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="nomina_export_${p.year}-${String(p.month).padStart(2, '0')}.xlsx"`);
    res.setHeader('X-Schema-Version', dataset.schema_version);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
