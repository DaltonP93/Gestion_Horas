/**
 * lactancia.js — Maternidad / Lactancia (reducción horaria).
 *
 *   GET  /api/lactancia/config          → reducción, edad máx. y días de alerta
 *   PUT  /api/lactancia/config          → guardar config (admin/gth/hr)
 *   GET  /api/lactancia?status=active   → períodos (con días restantes)
 *   GET  /api/lactancia/alerts          → períodos por finalizar
 *   POST /api/lactancia                 → alta (auto end = nacimiento + edad máx.)
 *   PUT  /api/lactancia/:id             → editar
 *   POST /api/lactancia/:id/end         → cerrar período
 *   DELETE /api/lactancia/:id           → eliminar
 *
 * Exporta getLactanciaReductionMinutes(employeeId, dateStr): minutos de
 * reducción vigentes para un empleado en una fecha (para consumidores como
 * reportes o el motor de reglas).
 *
 * Gobernado por el permiso 'lactancia' (sección gestión). La config requiere
 * RRHH/admin.
 */
const router = require('express').Router();
const { insertId } = require('../utils/insertId');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const audit = require('../services/audit');

async function getConfig() {
  const [rows] = await sequelize.query(
    "SELECT setting_key, setting_value FROM notification_settings WHERE setting_key IN ('lactancia_reduction_minutes','lactancia_max_child_age_months','lactancia_alert_days')"
  );
  const m = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
  const int = (v, def) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : def; };
  return {
    reduction_minutes: int(m.lactancia_reduction_minutes, 90),
    max_child_age_months: int(m.lactancia_max_child_age_months, 24),
    alert_days: int(m.lactancia_alert_days, 15),
  };
}

// Suma la fecha de nacimiento + N meses → 'YYYY-MM-DD'.
function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Helper reutilizable: minutos de reducción vigentes para un empleado en una
// fecha (0 si no hay período activo que la cubra).
async function getLactanciaReductionMinutes(employeeId, dateStr) {
  const [rows] = await sequelize.query(
    `SELECT reduction_minutes FROM lactancia_periods
     WHERE employee_id = ? AND status = 'active'
       AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
     ORDER BY reduction_minutes DESC LIMIT 1`,
    { replacements: [employeeId, dateStr, dateStr] }
  );
  return rows.length ? (rows[0].reduction_minutes || 0) : 0;
}

router.use(authenticate);

// ── Config ─────────────────────────────────────────────────────
router.get('/config', requirePermission('lactancia', 'view'), async (req, res, next) => {
  try { res.json(await getConfig()); } catch (e) { next(e); }
});

router.put('/config', authorize('admin', 'super_admin', 'gth', 'hr'), async (req, res, next) => {
  try {
    const map = {
      lactancia_reduction_minutes: req.body.reduction_minutes,
      lactancia_max_child_age_months: req.body.max_child_age_months,
      lactancia_alert_days: req.body.alert_days,
    };
    for (const [k, v] of Object.entries(map)) {
      if (v == null) continue;
      await sequelize.query(
        `INSERT INTO notification_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        { replacements: [k, String(parseInt(v, 10) || 0)] }
      );
    }
    res.json({ ok: true, ...(await getConfig()) });
  } catch (e) { next(e); }
});

// ── Lista ──────────────────────────────────────────────────────
router.get('/', requirePermission('lactancia', 'view'), async (req, res, next) => {
  try {
    const status = req.query.status || 'active';
    const params = [];
    let where = '';
    if (status === 'active' || status === 'ended') { where = 'WHERE p.status = ?'; params.push(status); }
    const [rows] = await sequelize.query(`
      SELECT p.*, CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.code,
             d.name AS department,
             DATEDIFF(p.end_date, CURDATE()) AS days_left
      FROM lactancia_periods p
      JOIN employees e ON e.id = p.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      ${where}
      ORDER BY p.status, p.end_date IS NULL, p.end_date, p.id DESC
    `, { replacements: params });
    res.json({ ok: true, data: rows });
  } catch (e) { next(e); }
});

// ── Alertas ────────────────────────────────────────────────────
router.get('/alerts', requirePermission('lactancia', 'view'), async (req, res, next) => {
  try {
    const cfg = await getConfig();
    const [rows] = await sequelize.query(`
      SELECT p.id, p.employee_id, p.end_date, p.reduction_minutes,
             CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.code,
             DATEDIFF(p.end_date, CURDATE()) AS days_left
      FROM lactancia_periods p
      JOIN employees e ON e.id = p.employee_id
      WHERE p.status = 'active' AND e.status = 'active'
        AND p.end_date IS NOT NULL
        AND p.end_date >= CURDATE()
        AND DATEDIFF(p.end_date, CURDATE()) <= ?
      ORDER BY p.end_date
    `, { replacements: [cfg.alert_days] });
    res.json({ config: cfg, ending: rows });
  } catch (e) { next(e); }
});

function bodyToPeriod(body, cfg) {
  const p = {
    employee_id: parseInt(body.employee_id, 10),
    child_birth_date: body.child_birth_date || null,
    start_date: body.start_date || null,
    end_date: body.end_date || null,
    reduction_minutes: Number.isFinite(parseInt(body.reduction_minutes, 10)) ? parseInt(body.reduction_minutes, 10) : cfg.reduction_minutes,
    status: body.status === 'ended' ? 'ended' : 'active',
    note: body.note ? String(body.note).slice(0, 255) : null,
  };
  // Auto: si no hay fin y hay nacimiento, fin = nacimiento + edad máx. meses.
  if (!p.end_date && p.child_birth_date) p.end_date = addMonths(p.child_birth_date, cfg.max_child_age_months);
  return p;
}

function validatePeriod(p) {
  if (!p.employee_id) return 'employee_id requerido';
  if (!p.start_date) return 'Fecha de inicio requerida';
  if (p.end_date && p.end_date < p.start_date) return 'La fecha de fin no puede ser anterior al inicio';
  if (p.reduction_minutes < 0) return 'La reducción no puede ser negativa';
  return null;
}

// ── Alta ───────────────────────────────────────────────────────
router.post('/', requirePermission('lactancia', 'create'), async (req, res, next) => {
  try {
    const cfg = await getConfig();
    const p = bodyToPeriod(req.body || {}, cfg);
    const err = validatePeriod(p);
    if (err) return res.status(400).json({ error: err });
    const [r] = await sequelize.query(
      `INSERT INTO lactancia_periods
         (employee_id, child_birth_date, start_date, end_date, reduction_minutes, status, note, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      { replacements: [p.employee_id, p.child_birth_date, p.start_date, p.end_date, p.reduction_minutes, p.status, p.note, req.user?.id || null] }
    );
    audit.log({ req, user: req.user, action: 'lactancia_create', entity: 'lactancia_periods', entity_id: insertId(r), details: { employee_id: p.employee_id } });
    res.status(201).json({ id: insertId(r) });
  } catch (e) { next(e); }
});

// ── Editar ─────────────────────────────────────────────────────
router.put('/:id', requirePermission('lactancia', 'update'), async (req, res, next) => {
  try {
    const cfg = await getConfig();
    const p = bodyToPeriod(req.body || {}, cfg);
    const err = validatePeriod(p);
    if (err) return res.status(400).json({ error: err });
    const [r] = await sequelize.query(
      `UPDATE lactancia_periods SET
         child_birth_date=?, start_date=?, end_date=?, reduction_minutes=?, status=?, note=?
       WHERE id=?`,
      { replacements: [p.child_birth_date, p.start_date, p.end_date, p.reduction_minutes, p.status, p.note, parseInt(req.params.id, 10)] }
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Período no encontrado' });
    audit.log({ req, user: req.user, action: 'lactancia_update', entity: 'lactancia_periods', entity_id: req.params.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Cerrar ─────────────────────────────────────────────────────
router.post('/:id/end', requirePermission('lactancia', 'update'), async (req, res, next) => {
  try {
    const [r] = await sequelize.query(
      "UPDATE lactancia_periods SET status='ended', end_date = COALESCE(end_date, CURDATE()) WHERE id = ?",
      { replacements: [parseInt(req.params.id, 10)] }
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Período no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Eliminar ───────────────────────────────────────────────────
router.delete('/:id', requirePermission('lactancia', 'delete'), async (req, res, next) => {
  try {
    const [r] = await sequelize.query('DELETE FROM lactancia_periods WHERE id = ?', { replacements: [parseInt(req.params.id, 10)] });
    if (!r.affectedRows) return res.status(404).json({ error: 'Período no encontrado' });
    audit.log({ req, user: req.user, action: 'lactancia_delete', entity: 'lactancia_periods', entity_id: req.params.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.getLactanciaReductionMinutes = getLactanciaReductionMinutes;
