/**
 * holidays.js — Días feriados / no laborables.
 * Lectura: autenticado.
 * Escritura: admin / hr / gth.
 */
const router = require('express').Router();
const { insertId } = require('../utils/insertId');
const { authenticate, authorize } = require('../middleware/auth');
const { sequelize } = require('../config/database');

router.use(authenticate);

// GET /api/holidays?year=2026
router.get('/', async (req, res) => {
  try {
    const { year } = req.query;
    let sql = 'SELECT * FROM holidays WHERE active = 1';
    const repl = [];
    if (year) { sql += ' AND YEAR(date) = ?'; repl.push(year); }
    sql += ' ORDER BY date ASC';
    const [rows] = await sequelize.query(sql, { replacements: repl });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/holidays
router.post('/', authorize('admin', 'hr', 'gth'), async (req, res) => {
  const { name, date, type = 'national' } = req.body;
  if (!name || !date) return res.status(400).json({ error: 'name y date requeridos' });
  try {
    const [r] = await sequelize.query(
      `INSERT INTO holidays (name, date, type) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), type = VALUES(type), active = 1`,
      { replacements: [name, date, type] }
    );
    res.status(201).json({ id: insertId(r) || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/holidays/:id
router.put('/:id', authorize('admin', 'hr', 'gth'), async (req, res) => {
  const { name, date, type } = req.body;
  try {
    await sequelize.query(
      `UPDATE holidays SET
         name = COALESCE(?, name),
         date = COALESCE(?, date),
         type = COALESCE(?, type)
       WHERE id = ?`,
      { replacements: [name ?? null, date ?? null, type ?? null, req.params.id] }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/holidays/:id — soft delete
router.delete('/:id', authorize('admin', 'hr', 'gth'), async (req, res) => {
  try {
    await sequelize.query(
      'UPDATE holidays SET active = 0 WHERE id = ?',
      { replacements: [req.params.id] }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
