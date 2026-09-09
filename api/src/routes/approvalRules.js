/**
 * approvalRules.js — CRUD de permission_approval_rules.
 * Solo GTH / admin / super_admin.
 */
const router = require('express').Router();
const { insertId } = require('../utils/insertId');
const { authenticate, authorize } = require('../middleware/auth');
const { sequelize } = require('../config/database');

router.use(authenticate, authorize('admin','gth'));

// GET /api/approval-rules
router.get('/', async (req, res) => {
  try {
    const [rows] = await sequelize.query(`
      SELECT r.*, d.name AS department_name, u.full_name AS created_by_name
      FROM permission_approval_rules r
      LEFT JOIN departments d ON r.department_id = d.id
      LEFT JOIN users u       ON r.created_by    = u.id
      ORDER BY (r.department_id IS NOT NULL) DESC,
               (r.permission_type IS NOT NULL) DESC,
               r.id ASC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/approval-rules
router.post('/', async (req, res) => {
  const {
    department_id, permission_type,
    requires_coordinator = 1, requires_manager = 1, requires_gth_final = 1,
    self_approve_max_days = 0, notes, active = 1,
  } = req.body || {};

  try {
    const [r] = await sequelize.query(`
      INSERT INTO permission_approval_rules
        (department_id, permission_type, requires_coordinator, requires_manager,
         requires_gth_final, self_approve_max_days, notes, active, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `, { replacements: [
      department_id || null, permission_type || null,
      requires_coordinator ? 1 : 0,
      requires_manager     ? 1 : 0,
      requires_gth_final   ? 1 : 0,
      parseInt(self_approve_max_days) || 0,
      notes || null, active ? 1 : 0, req.user.id,
    ]});
    res.status(201).json({ id: insertId(r) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/approval-rules/:id
router.patch('/:id', async (req, res) => {
  const fields = ['requires_coordinator','requires_manager','requires_gth_final',
                  'self_approve_max_days','notes','active',
                  'department_id','permission_type'];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(req.body[f] === null || req.body[f] === '' ? null : req.body[f]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Sin cambios' });
  vals.push(req.params.id);
  try {
    await sequelize.query(
      `UPDATE permission_approval_rules SET ${sets.join(', ')} WHERE id = ?`,
      { replacements: vals }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/approval-rules/:id
router.delete('/:id', async (req, res) => {
  try {
    await sequelize.query('DELETE FROM permission_approval_rules WHERE id = ?',
      { replacements: [req.params.id] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
