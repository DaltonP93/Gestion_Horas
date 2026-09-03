/**
 * overtime.js — Autorización de horas extra (punto 9 del roadmap).
 *
 *   GET  /api/overtime/config      → { requires_auth }
 *   PUT  /api/overtime/config      → { requires_auth }         (solo admin/gth)
 *   GET  /api/overtime?from=&to=&dept=&state=pending|all
 *        Lista los días con horas extra y su estado (pendiente/aprobado/rechazado).
 *   PUT  /api/overtime/decide      → { employee_id, date, status, note }
 *        Aprueba o rechaza el overtime de un empleado en un día.
 *
 * El overtime siempre se calcula (daily_summary.overtime_minutes); esta
 * aprobación sólo gobierna si se paga/informa cuando la empresa lo exige.
 */
const router = require('express').Router();
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { sequelize } = require('../config/database');

router.use(authenticate);
router.use(authorize('admin', 'super_admin', 'gth', 'hr', 'manager', 'coordinator', 'supervisor'));

async function requiresAuth() {
  const [rows] = await sequelize.query(
    "SELECT setting_value FROM notification_settings WHERE setting_key = 'att_overtime_requires_auth' LIMIT 1"
  );
  return String(rows[0]?.setting_value ?? '') === '1';
}

// ── Config ─────────────────────────────────────────────────────
router.get('/config', async (req, res, next) => {
  try { res.json({ requires_auth: await requiresAuth() }); } catch (e) { next(e); }
});

router.put('/config', authorize('admin', 'super_admin', 'gth'), async (req, res, next) => {
  try {
    const val = req.body?.requires_auth ? '1' : '0';
    await sequelize.query(
      `INSERT INTO notification_settings (setting_key, setting_value) VALUES ('att_overtime_requires_auth', ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      { replacements: [val] }
    );
    res.json({ ok: true, requires_auth: val === '1' });
  } catch (e) { next(e); }
});

// ── Lista de días con horas extra + estado de aprobación ───────
router.get('/', requirePermission('aprobaciones', 'view'), async (req, res, next) => {
  try {
    const now = new Date();
    const from = req.query.from || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const to   = req.query.to   || new Date().toISOString().slice(0, 10);
    const state = req.query.state || 'pending';
    const params = [from, to];
    let deptFilter = '';
    if (req.query.dept) { deptFilter = 'AND e.department_id = ?'; params.push(req.query.dept); }
    let stateFilter = '';
    if (state === 'pending')  stateFilter = 'AND oa.status IS NULL';
    if (state === 'approved') stateFilter = "AND oa.status = 'approved'";
    if (state === 'rejected') stateFilter = "AND oa.status = 'rejected'";

    const [rows] = await sequelize.query(`
      SELECT e.id AS employee_id, e.code, CONCAT(e.first_name,' ',e.last_name) AS name,
             COALESCE(d.name,'') AS department,
             DATE_FORMAT(ds.date, '%Y-%m-%d') AS date,
             ds.overtime_minutes,
             oa.status, oa.note, oa.decided_at
      FROM daily_summary ds
      JOIN employees e ON e.id = ds.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN overtime_approvals oa ON oa.employee_id = ds.employee_id AND oa.date = ds.date
      WHERE ds.date BETWEEN ? AND ? AND COALESCE(ds.overtime_minutes,0) > 0 ${deptFilter} ${stateFilter}
      ORDER BY ds.date DESC, name
    `, { replacements: params });

    res.json({ requires_auth: await requiresAuth(), from, to, state, total: rows.length, data: rows });
  } catch (e) { next(e); }
});

// ── Decidir (aprobar/rechazar) ─────────────────────────────────
router.put('/decide', requirePermission('aprobaciones', 'update'), async (req, res, next) => {
  try {
    const { employee_id, date, status, note } = req.body || {};
    if (!employee_id || !date || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'employee_id, date y status (approved|rejected) requeridos' });
    }
    const [[ds]] = await sequelize.query(
      'SELECT overtime_minutes FROM daily_summary WHERE employee_id = ? AND date = ? LIMIT 1',
      { replacements: [employee_id, date] }
    );
    const minutes = ds?.overtime_minutes || 0;
    await sequelize.query(
      `INSERT INTO overtime_approvals (employee_id, date, status, minutes, decided_by, note)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status), minutes=VALUES(minutes),
         decided_by=VALUES(decided_by), note=VALUES(note)`,
      { replacements: [employee_id, date, status, minutes, req.user?.id || null, note || null] }
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// PUT /decide-batch — decisión por LOTE (misma semántica que /decide por fila,
// aplicada atómicamente sobre un conjunto). Escribe SÓLO overtime_approvals;
// misma autorización (aprobaciones:update). Idempotente por fila (upsert).
router.put('/decide-batch', requirePermission('aprobaciones', 'update'), async (req, res, next) => {
  try {
    const { items, status, note } = req.body || {};
    if (!Array.isArray(items) || items.length === 0 || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'items[] y status (approved|rejected) requeridos' });
    }
    if (items.length > 500) {
      return res.status(400).json({ error: 'Demasiados ítems en un lote (máx 500)' });
    }
    const valid = items.filter((it) => it && it.employee_id && it.date);
    if (!valid.length) return res.status(400).json({ error: 'Ningún ítem válido (employee_id y date requeridos)' });

    const tx = await sequelize.transaction();
    try {
      let applied = 0;
      for (const it of valid) {
        const [[ds]] = await sequelize.query(
          'SELECT overtime_minutes FROM daily_summary WHERE employee_id = ? AND date = ? LIMIT 1',
          { replacements: [it.employee_id, it.date], transaction: tx },
        );
        const minutes = ds?.overtime_minutes || 0;
        await sequelize.query(
          `INSERT INTO overtime_approvals (employee_id, date, status, minutes, decided_by, note)
           VALUES (?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE status=VALUES(status), minutes=VALUES(minutes),
             decided_by=VALUES(decided_by), note=VALUES(note)`,
          { replacements: [it.employee_id, it.date, status, minutes, req.user?.id || null, note || null], transaction: tx },
        );
        applied++;
      }
      await tx.commit();
      res.json({ ok: true, applied });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (e) { next(e); }
});

module.exports = router;
