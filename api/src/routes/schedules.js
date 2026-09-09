/**
 * schedules.js — CRUD de turnos/horarios + asignación a empleados.
 * Lectura: autenticado.
 * Escritura: admin / hr / gth.
 */
const router = require('express').Router();
const { insertId } = require('../utils/insertId');
const { authenticate, authorize } = require('../middleware/auth');
const { sequelize } = require('../config/database');

router.use(authenticate);

// GET /api/schedules — lista con conteo de empleados asignados
router.get('/', async (req, res) => {
  try {
    const [rows] = await sequelize.query(`
      SELECT s.*,
        (SELECT COUNT(*) FROM employees e
         WHERE e.schedule_id = s.id AND e.status = 'active') AS employees_count
      FROM schedules s
      WHERE s.active = 1
      ORDER BY s.name
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/schedules/:id
router.get('/:id', async (req, res) => {
  try {
    const [[row]] = await sequelize.query(
      'SELECT * FROM schedules WHERE id = ?',
      { replacements: [req.params.id] }
    );
    if (!row) return res.status(404).json({ error: 'No encontrado' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/schedules
router.post('/', authorize('admin', 'hr', 'gth'), async (req, res) => {
  const {
    name, check_in, check_out,
    tolerance_in = 10, tolerance_out = 10, break_minutes = 0,
    work_days = '2,3,4,5,6', // Lun-Vie en convención DAYOFWEEK (1=Dom..7=Sáb)
  } = req.body;
  if (!name || !check_in || !check_out) {
    return res.status(400).json({ error: 'Datos incompletos (name, check_in, check_out)' });
  }
  try {
    const [r] = await sequelize.query(
      `INSERT INTO schedules (name, check_in, check_out, tolerance_in, tolerance_out, break_minutes, work_days)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      { replacements: [name, check_in, check_out, tolerance_in, tolerance_out, +break_minutes || 0, work_days] }
    );
    res.status(201).json({ id: insertId(r) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/schedules/:id
router.put('/:id', authorize('admin', 'hr', 'gth'), async (req, res) => {
  const { name, check_in, check_out, tolerance_in, tolerance_out, break_minutes, work_days } = req.body;
  try {
    await sequelize.query(
      `UPDATE schedules SET
         name          = COALESCE(?, name),
         check_in      = COALESCE(?, check_in),
         check_out     = COALESCE(?, check_out),
         tolerance_in  = COALESCE(?, tolerance_in),
         tolerance_out = COALESCE(?, tolerance_out),
         break_minutes = COALESCE(?, break_minutes),
         work_days     = COALESCE(?, work_days)
       WHERE id = ?`,
      { replacements: [
        name ?? null, check_in ?? null, check_out ?? null,
        tolerance_in ?? null, tolerance_out ?? null,
        break_minutes ?? null, work_days ?? null,
        req.params.id,
      ]}
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/schedules/:id — soft delete (active = 0)
router.delete('/:id', authorize('admin', 'hr', 'gth'), async (req, res) => {
  try {
    // Verificar si hay empleados activos asignados
    const [[{ cnt }]] = await sequelize.query(
      `SELECT COUNT(*) AS cnt FROM employees
       WHERE schedule_id = ? AND status = 'active'`,
      { replacements: [req.params.id] }
    );
    if (cnt > 0) {
      return res.status(400).json({
        error: `No se puede eliminar: ${cnt} empleado(s) tienen este turno asignado`
      });
    }
    await sequelize.query(
      'UPDATE schedules SET active = 0 WHERE id = ?',
      { replacements: [req.params.id] }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/schedules/:id/assign — asignar turno a un conjunto de empleados
// body: { employee_ids: number[] }
router.post('/:id/assign', authorize('admin', 'hr', 'gth'), async (req, res) => {
  const { employee_ids } = req.body;
  if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
    return res.status(400).json({ error: 'employee_ids requerido (array)' });
  }
  try {
    const [result] = await sequelize.query(
      `UPDATE employees SET schedule_id = ? WHERE id IN (?)`,
      { replacements: [req.params.id, employee_ids] }
    );
    res.json({ ok: true, updated: result.affectedRows || employee_ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/schedules/:id/employees — empleados asignados al turno
router.get('/:id/employees', async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT id, code, first_name, last_name, status
       FROM employees
       WHERE schedule_id = ? AND status = 'active'
       ORDER BY first_name, last_name`,
      { replacements: [req.params.id] }
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
