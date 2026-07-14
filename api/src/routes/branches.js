/**
 * branches.js — CRUD de sedes (multi-sede).
 */
const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const { sequelize } = require('../config/database');

router.use(authenticate);

// GET /api/branches — lista (todos los roles)
router.get('/', async (req, res) => {
  const { active } = req.query;
  const where = [];
  const params = [];
  if (active !== undefined) { where.push('active = ?'); params.push(active === '1' ? 1 : 0); }
  const sql = `SELECT b.*,
      (SELECT COUNT(*) FROM employees e WHERE e.branch_id = b.id AND e.status='active') AS employee_count,
      (SELECT COUNT(*) FROM devices d WHERE d.branch_id = b.id) AS device_count
    FROM branches b
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY b.name ASC`;
  const [rows] = await sequelize.query(sql, { replacements: params });
  res.json(rows);
});

// GET /api/branches/:id
router.get('/:id', async (req, res) => {
  const [[row]] = await sequelize.query(
    'SELECT * FROM branches WHERE id = ? LIMIT 1',
    { replacements: [req.params.id] }
  );
  if (!row) return res.status(404).json({ error: 'Sede no encontrada' });
  res.json(row);
});

// POST /api/branches
router.post('/', authorize('admin', 'super_admin'), async (req, res) => {
  const { code, name, address, city, phone, timezone, geo_lat, geo_lng, geo_radius_m } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'code y name son requeridos' });
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  try {
    const [r] = await sequelize.query(
      `INSERT INTO branches (code, name, address, city, phone, timezone, geo_lat, geo_lng, geo_radius_m)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      { replacements: [code, name, address || null, city || null, phone || null, timezone || 'America/Asuncion',
        num(geo_lat), num(geo_lng), geo_radius_m != null ? (parseInt(geo_radius_m, 10) || null) : null] }
    );
    res.status(201).json({ id: r.insertId, message: 'Sede creada' });
  } catch (err) {
    if (err.original?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Ya existe una sede con ese código' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/branches/:id
router.put('/:id', authorize('admin', 'super_admin'), async (req, res) => {
  const { code, name, address, city, phone, timezone, active, geo_lat, geo_lng, geo_radius_m } = req.body;
  const num = v => { if (v === '' || v == null) return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  try {
    await sequelize.query(
      `UPDATE branches SET
         code=COALESCE(?,code), name=COALESCE(?,name),
         address=?, city=?, phone=?,
         timezone=COALESCE(?,timezone),
         active=COALESCE(?,active),
         geo_lat=?, geo_lng=?, geo_radius_m=COALESCE(?,geo_radius_m)
       WHERE id=?`,
      { replacements: [code || null, name || null, address || null, city || null, phone || null, timezone || null,
        active === undefined ? null : (active ? 1 : 0),
        num(geo_lat), num(geo_lng), geo_radius_m === '' || geo_radius_m == null ? null : (parseInt(geo_radius_m, 10) || null),
        req.params.id] }
    );
    res.json({ message: 'Sede actualizada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/branches/:id (soft)
router.delete('/:id', authorize('admin', 'super_admin'), async (req, res) => {
  const [[count]] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM employees WHERE branch_id=? AND status='active'`,
    { replacements: [req.params.id] }
  );
  if (count.n > 0) {
    return res.status(409).json({ error: `No se puede desactivar: ${count.n} empleado(s) activos asignados` });
  }
  await sequelize.query('UPDATE branches SET active = 0 WHERE id = ?', { replacements: [req.params.id] });
  res.json({ message: 'Sede desactivada' });
});

module.exports = router;
