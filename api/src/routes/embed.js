/**
 * embed.js — Dashboards embebibles via token público read-only.
 *
 * Permite generar URLs como:
 *   https://sishoras.saa.com.py/api/embed/data/<token>
 *   https://sishoras.saa.com.py/embed/<token>
 * Para insertar widgets en Oracle APEX / intranets sin autenticación.
 *
 * Endpoints CRUD (admin) + endpoint público que valida token.
 */
const router = require('express').Router();
const crypto = require('crypto');
const { authenticate, authorize } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const logger = require('../config/logger');
const { logInternalError } = require('../utils/logInternalError');

// ─── Endpoint público (no auth) ──────────────────────────────────
// IMPORTANTE: este endpoint debe registrarse ANTES del authenticate
const publicRouter = require('express').Router();

publicRouter.get('/data/:token', async (req, res) => {
  try {
    const [[t]] = await sequelize.query(
      `SELECT * FROM embed_tokens WHERE token = ? AND active = 1
       AND (expires_at IS NULL OR expires_at > NOW())`,
      { replacements: [req.params.token] }
    );
    if (!t) return res.status(404).json({ error: 'Token inválido o expirado' });

    // Tracking de uso
    sequelize.query(
      'UPDATE embed_tokens SET last_used_at = NOW(), use_count = use_count + 1 WHERE id = ?',
      { replacements: [t.id] }
    ).catch(() => {});

    const scope = typeof t.scope === 'string' ? JSON.parse(t.scope) : t.scope;
    const widgets = Array.isArray(scope.widgets) ? scope.widgets : ['kpis'];
    const deptId  = scope.deptId || null;

    const out = { generated_at: new Date().toISOString() };

    // KPIs del día
    if (widgets.includes('kpis')) {
      const today = new Date().toISOString().slice(0, 10);
      const params = [today];
      let dFilter = '';
      if (deptId) { dFilter = ' AND e.department_id = ?'; params.push(deptId); }

      const [[k]] = await sequelize.query(`
        SELECT
          COUNT(DISTINCT CASE WHEN e.status = 'active' THEN e.id END) AS total_employees,
          SUM(CASE WHEN ds.status = 'present' THEN 1 ELSE 0 END) AS present,
          SUM(CASE WHEN ds.status = 'late'    THEN 1 ELSE 0 END) AS late_count,
          SUM(CASE WHEN ds.status = 'absent'  THEN 1 ELSE 0 END) AS absent
        FROM employees e
        LEFT JOIN daily_summary ds ON ds.employee_id = e.id AND ds.date = ?
        WHERE 1=1 ${dFilter}
      `, { replacements: params });
      out.kpis = k;
    }

    // Tendencia 7 días
    if (widgets.includes('trend')) {
      const params = [];
      let dFilter = '';
      if (deptId) { dFilter = ' AND e.department_id = ?'; params.push(deptId); }
      const [trend] = await sequelize.query(`
        SELECT ds.date,
          SUM(CASE WHEN ds.status IN ('present','late') THEN 1 ELSE 0 END) AS present,
          SUM(CASE WHEN ds.status = 'absent' THEN 1 ELSE 0 END) AS absent
        FROM daily_summary ds
        JOIN employees e ON e.id = ds.employee_id
        WHERE ds.date BETWEEN DATE_SUB(CURDATE(), INTERVAL 6 DAY) AND CURDATE()
          AND e.status = 'active' ${dFilter}
        GROUP BY ds.date ORDER BY ds.date
      `, { replacements: params });
      out.trend = trend;
    }

    // Por departamento (siempre que no esté filtrado por dept)
    if (widgets.includes('byDept') && !deptId) {
      const today = new Date().toISOString().slice(0, 10);
      const [byDept] = await sequelize.query(`
        SELECT d.name AS department,
          COUNT(DISTINCT e.id) AS employees,
          SUM(CASE WHEN ds.status IN ('present','late') THEN 1 ELSE 0 END) AS present,
          SUM(CASE WHEN ds.status = 'absent' THEN 1 ELSE 0 END) AS absent
        FROM departments d
        JOIN employees e ON e.department_id = d.id AND e.status = 'active'
        LEFT JOIN daily_summary ds ON ds.employee_id = e.id AND ds.date = ?
        WHERE d.active = 1
        GROUP BY d.id, d.name
        ORDER BY present DESC
      `, { replacements: [today] });
      out.byDept = byDept;
    }

    // Branding ligero (sin URLs sensibles)
    out.scope = { widgets, deptId, name: t.name };

    res.json(out);
  } catch (err) {
    logInternalError(logger, { event: 'embed GET /data/:token', route: 'embed GET /data/:token', err });
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── Endpoints autenticados (CRUD de tokens) ────────────────────
router.use(authenticate);
router.use(authorize('admin', 'gth', 'super_admin'));

// GET / — listado
router.get('/', async (_req, res) => {
  try {
    const [rows] = await sequelize.query(`
      SELECT t.id, t.token, t.name, t.scope, t.expires_at, t.last_used_at,
             t.use_count, t.active, t.created_at,
             u.full_name AS created_by_name
      FROM embed_tokens t
      LEFT JOIN users u ON u.id = t.created_by
      ORDER BY t.created_at DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    logInternalError(logger, { event: 'embed GET /', route: 'embed GET /', err });
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST / — crear token
router.post('/', async (req, res) => {
  const { name, widgets = ['kpis'], deptId, expires_at } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name es requerido' });
  try {
    const token = crypto.randomBytes(24).toString('hex');
    const scope = { widgets, deptId: deptId || null };
    const [r] = await sequelize.query(
      `INSERT INTO embed_tokens (token, name, scope, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      { replacements: [token, name, JSON.stringify(scope), expires_at || null, req.user.id] }
    );
    res.status(201).json({ ok: true, id: r, token });
  } catch (err) {
    logInternalError(logger, { event: 'embed POST /', route: 'embed POST /', err });
    res.status(500).json({ error: 'Error interno' });
  }
});

// PUT /:id — toggle active / cambiar nombre/expiración
router.put('/:id', async (req, res) => {
  const allowed = ['name','active','expires_at'];
  const sets = []; const vals = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) { sets.push(`${k} = ?`); vals.push(req.body[k]); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Sin cambios' });
  try {
    await sequelize.query(`UPDATE embed_tokens SET ${sets.join(', ')} WHERE id = ?`,
      { replacements: [...vals, req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    logInternalError(logger, { event: 'embed PUT /:id', route: 'embed PUT /:id', err });
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /:id — revocar
router.delete('/:id', async (req, res) => {
  try {
    await sequelize.query('DELETE FROM embed_tokens WHERE id = ?', { replacements: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    logInternalError(logger, { event: 'embed DELETE /:id', route: 'embed DELETE /:id', err });
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
module.exports.publicRouter = publicRouter;
