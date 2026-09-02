/**
 * departments.js — CRUD de departamentos + asignación de coordinador/manager.
 * Lectura: cualquier usuario autenticado.
 * Escritura: admin / gth / super_admin.
 */
const router = require('express').Router();
const { insertId } = require('../utils/insertId');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { sequelize } = require('../config/database');

router.use(authenticate);

// GET /api/departments — lista con conteo y nombres de coord/manager
router.get('/', async (req, res) => {
  try {
    const [rows] = await sequelize.query(`
      SELECT d.*,
        uc.full_name AS coordinator_name,
        uc.username  AS coordinator_username,
        um.full_name AS manager_name,
        um.username  AS manager_username,
        (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id AND e.status='active') AS employees_count
      FROM departments d
      LEFT JOIN users uc ON d.coordinator_id = uc.id
      LEFT JOIN users um ON d.manager_id     = um.id
      ORDER BY d.name ASC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/departments/:id
router.get('/:id', async (req, res) => {
  const [[row]] = await sequelize.query(
    'SELECT * FROM departments WHERE id = ?',
    { replacements: [req.params.id] }
  );
  if (!row) return res.status(404).json({ error: 'No encontrado' });
  res.json(row);
});

// POST /api/departments
router.post('/', authorize('admin','gth'), requirePermission('departamentos', 'create'), async (req, res) => {
  const { name, code, coordinator_id, manager_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    const [r] = await sequelize.query(
      'INSERT INTO departments (name, code, coordinator_id, manager_id) VALUES (?,?,?,?)',
      { replacements: [name, code || null, coordinator_id || null, manager_id || null] }
    );
    res.status(201).json({ id: insertId(r) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/departments/:id
router.patch('/:id', authorize('admin','gth'), requirePermission('departamentos', 'update'), async (req, res) => {
  const { name, code, coordinator_id, manager_id, active } = req.body;
  try {
    await sequelize.query(
      `UPDATE departments SET
         name           = COALESCE(?, name),
         code           = COALESCE(?, code),
         coordinator_id = ?,
         manager_id     = ?,
         active         = COALESCE(?, active)
       WHERE id = ?`,
      { replacements: [
          name ?? null, code ?? null,
          coordinator_id === undefined ? null : (coordinator_id || null),
          manager_id     === undefined ? null : (manager_id     || null),
          active ?? null, req.params.id,
      ]}
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/departments/:id — soft delete: marcar inactive
router.delete('/:id', authorize('admin','gth'), requirePermission('departamentos', 'delete'), async (req, res) => {
  try {
    await sequelize.query('UPDATE departments SET active = 0 WHERE id = ?',
      { replacements: [req.params.id] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/departments/:id/employees
router.get('/:id/employees', async (req, res) => {
  const [rows] = await sequelize.query(`
    SELECT id, code, first_name, last_name, email, status
    FROM employees WHERE department_id = ? AND status='active'
    ORDER BY first_name, last_name
  `, { replacements: [req.params.id] });
  res.json(rows);
});

module.exports = router;
