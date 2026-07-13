const router = require('express').Router();
const Joi = require('joi');
const { authenticate, authorize, authenticateServiceKey, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { sequelize } = require('../config/database');
const {
  getDashboardStats, getByDate, registerManual, registerMobile,
  bridgeWebhook
} = require('../controllers/attendanceController');

// DTO del marcaje manual: valida tipos y valores antes del controlador.
const manualPunchSchema = Joi.object({
  employeeId: Joi.number().integer().positive().required(),
  timestamp:  Joi.date().iso().required(),
  type:       Joi.string().valid('in', 'out', 'break_start', 'break_end').required(),
  notes:      Joi.string().max(500).allow('', null),
}).unknown(true);

// Endpoint para el Bridge ZKTeco (clave interna, sin JWT)
router.post('/bridge/webhook', authenticateServiceKey, bridgeWebhook);

router.use(authenticate);

router.get('/live',  getDashboardStats);   // estado actual del día — KPIs + últimos marcajes
router.get('/',                getByDate);            // ?date=&dept=&employeeId=
router.post('/manual',         authorize('admin','hr'), validate(manualPunchSchema), registerManual);
router.post('/mobile',         registerMobile);       // marcaje desde app

// Recalcular daily_summary en bloque para una fecha (admin)
router.post('/recalc-summary', authorize('admin','super_admin'), async (req, res) => {
  try {
    const { bulkRecalcDailySummary, pyDateStr } = require('../services/scheduler');
    const date = req.body.date || pyDateStr(new Date());
    await bulkRecalcDailySummary(date);
    res.json({ ok: true, date, message: `daily_summary recalculado para ${date}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Marcaciones fuera de rango (punto 8) ───────────────────────
// Lista los días en que un empleado marcó ENTRADA mucho antes de su horario
// o SALIDA mucho después, más allá de umbrales configurables (settings
// att_early_mark_alert_min / att_late_mark_alert_min). Sirve para que RRHH
// revise (y decida si autorizar la hora extra correspondiente), en vez de
// computarlo automáticamente.
router.get('/out-of-range', requirePermission('asistencia', 'view'), async (req, res, next) => {
  try {
    const now = new Date();
    const from = req.query.from || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const to   = req.query.to   || new Date().toISOString().slice(0, 10);
    const [cfg] = await sequelize.query(
      "SELECT setting_key, setting_value FROM notification_settings WHERE setting_key IN ('att_early_mark_alert_min','att_late_mark_alert_min')"
    );
    const m = Object.fromEntries(cfg.map(r => [r.setting_key, r.setting_value]));
    const early = parseInt(m.att_early_mark_alert_min, 10);
    const late  = parseInt(m.att_late_mark_alert_min, 10);
    const earlyMin = Number.isFinite(early) ? early : 30;
    const lateMin  = Number.isFinite(late)  ? late  : 30;

    const params = [from, to];
    let deptFilter = '';
    if (req.query.dept) { deptFilter = 'AND e.department_id = ?'; params.push(req.query.dept); }
    params.push(earlyMin, lateMin);

    const [rows] = await sequelize.query(`
      SELECT * FROM (
        SELECT e.id AS employee_id, e.code, CONCAT(e.first_name,' ',e.last_name) AS name,
               COALESCE(d.name,'') AS department,
               DATE_FORMAT(ds.date, '%Y-%m-%d') AS date,
               TIME_FORMAT(ds.first_in, '%H:%i') AS first_in,
               TIME_FORMAT(ds.last_out, '%H:%i') AS last_out,
               TIME_FORMAT(s.check_in, '%H:%i')  AS check_in,
               TIME_FORMAT(s.check_out, '%H:%i') AS check_out,
               ROUND((TIME_TO_SEC(s.check_in)  - TIME_TO_SEC(TIME(ds.first_in))) / 60) AS early_min,
               ROUND((TIME_TO_SEC(TIME(ds.last_out)) - TIME_TO_SEC(s.check_out)) / 60) AS late_out_min
        FROM daily_summary ds
        JOIN employees e ON e.id = ds.employee_id
        JOIN schedules  s ON s.id = e.schedule_id
        LEFT JOIN departments d ON d.id = e.department_id
        WHERE ds.date BETWEEN ? AND ? AND ds.first_in IS NOT NULL ${deptFilter}
      ) t
      WHERE t.early_min > ? OR t.late_out_min > ?
      ORDER BY t.date DESC, t.name
    `, { replacements: params });

    res.json({ from, to, thresholds: { early_min: earlyMin, late_min: lateMin }, total: rows.length, data: rows });
  } catch (e) { next(e); }
});

module.exports = router;
