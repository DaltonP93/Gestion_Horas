/**
 * departments.js — CRUD de departamentos + asignación de coordinador/manager.
 * Lectura: acotada al ALCANCE que resuelve el servidor (departmentScope):
 *   rol global → todos; rol por sede → los departamentos activos de su sede
 *   activa; sin alcance (sin sede, sede inexistente/inactiva, rol sin alcance)
 *   → listado vacío y 404 en detalle/empleados (no se revela existencia).
 * Escritura: admin / gth / super_admin.
 */
const router = require('express').Router();
const { insertId } = require('../utils/insertId');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const { getVisibleDepartmentIds, applyDepartmentScope, canSeeEmployee } = require('../services/departmentScope');

router.use(authenticate);

/** Id de departamento del path: entero positivo o null. */
function deptIdParam(req) {
  const raw = String(req.params.id ?? '');
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/** ¿El actor puede ver el departamento `id`? (mismo criterio que el listado) */
async function canSeeDepartment(req, id) {
  const scope = await getVisibleDepartmentIds(req.user);
  return canSeeEmployee(scope, { department_id: id });
}

// GET /api/departments — lista con conteo y nombres de coord/manager
router.get('/', async (req, res) => {
  try {
    const scope = await getVisibleDepartmentIds(req.user);
    const { where, params } = applyDepartmentScope('WHERE 1=1', [], scope, 'd.id');
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
      ${where}
      ORDER BY d.name ASC
    `, { replacements: params });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/departments/:id
router.get('/:id', async (req, res) => {
  const id = deptIdParam(req);
  // Fuera de alcance, inexistente o id inválido → el MISMO 404.
  if (id == null || !(await canSeeDepartment(req, id))) return res.status(404).json({ error: 'No encontrado' });
  const [[row]] = await sequelize.query(
    'SELECT * FROM departments WHERE id = ?',
    { replacements: [id] }
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
  const id = deptIdParam(req);
  if (id == null || !(await canSeeDepartment(req, id))) return res.status(404).json({ error: 'No encontrado' });
  const [rows] = await sequelize.query(`
    SELECT id, code, first_name, last_name, email, status
    FROM employees WHERE department_id = ? AND status='active'
    ORDER BY first_name, last_name
  `, { replacements: [id] });
  res.json(rows);
});

module.exports = router;
