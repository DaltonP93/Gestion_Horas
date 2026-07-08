/**
 * supervisor.js — Vista de equipo para el usuario logueado.
 *
 * El "equipo" = empleados de todos los departamentos donde
 *   users.id = departments.manager_id  OR  departments.coordinator_id
 *
 *  GET /api/supervisor/team-overview?date=YYYY-MM-DD
 *  GET /api/supervisor/team-status
 *  GET /api/supervisor/pending-approvals
 */
const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { sequelize } = require('../config/database');

router.use(authenticate);

async function getTeamDeptIds(userId) {
  const [rows] = await sequelize.query(
    'SELECT id FROM departments WHERE active = 1 AND (manager_id = ? OR coordinator_id = ?)',
    { replacements: [userId, userId] }
  );
  return rows.map(r => r.id);
}

// KPIs del equipo + lista con status del día
router.get('/team-overview', async (req, res) => {
  try {
    const userId = req.user.id;
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const deptIds = await getTeamDeptIds(userId);
    if (deptIds.length === 0)
      return res.json({ departments: [], team: [], kpis: { total: 0, present: 0, late: 0, absent: 0, permission: 0 } });

    const placeholders = deptIds.map(() => '?').join(',');

    const [team] = await sequelize.query(`
      SELECT e.id, e.code, CONCAT(e.first_name,' ',e.last_name) AS full_name, e.department_id,
             d.name AS department_name,
             ds.status, ds.late_minutes, ds.worked_minutes,
             (SELECT MAX(timestamp) FROM attendance_logs
              WHERE employee_id = e.id AND DATE(timestamp) = ?) AS last_mark
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN daily_summary ds ON ds.employee_id = e.id AND ds.date = ?
      WHERE e.status = 'active' AND e.department_id IN (${placeholders})
      ORDER BY d.name, e.last_name, e.first_name
    `, { replacements: [date, date, ...deptIds] });

    const kpis = team.reduce((a, t) => {
      a.total++;
      if (t.status === 'present')    a.present++;
      if (t.status === 'late')       a.late++;
      if (t.status === 'absent')     a.absent++;
      if (t.status === 'permission') a.permission++;
      return a;
    }, { total: 0, present: 0, late: 0, absent: 0, permission: 0 });

    const [departments] = await sequelize.query(
      `SELECT id, name FROM departments WHERE id IN (${placeholders})`,
      { replacements: deptIds }
    );

    res.json({ date, departments, team, kpis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Permisos pendientes para aprobar (de mi equipo)
router.get('/pending-approvals', async (req, res) => {
  try {
    const userId = req.user.id;
    const deptIds = await getTeamDeptIds(userId);
    if (deptIds.length === 0) return res.json([]);
    const placeholders = deptIds.map(() => '?').join(',');

    const [rows] = await sequelize.query(`
      SELECT p.id, p.type,
             p.date_from AS start_date, p.date_to AS end_date,
             p.reason, p.status, p.approval_state, p.created_at,
             e.code, CONCAT(e.first_name,' ',e.last_name) AS full_name, d.name AS department_name
      FROM permissions p
      JOIN employees e   ON e.id = p.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE p.approval_state IN ('pending', 'level1_ok', 'level2_ok')
        AND e.department_id IN (${placeholders})
      ORDER BY p.created_at DESC
      LIMIT 100
    `, { replacements: deptIds });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
