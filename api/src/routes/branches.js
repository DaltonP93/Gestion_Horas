/**
 * branches.js — CRUD de sedes (multi-sede).
 */
const router = require('express').Router();
const { insertId } = require('../utils/insertId');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const { asyncHandler } = require('../utils/asyncHandler');
const { getOrgScope } = require('../services/orgScope');
const governance = require('../services/governance');
const audit = require('../services/audit');

router.use(authenticate);

// GET /api/branches — globales ven todo; otros sólo su sede asignada.
router.get('/', asyncHandler(async (req, res) => {
  const { active } = req.query;
  const where = [];
  const params = [];
  if (active !== undefined) { where.push('b.active = ?'); params.push(active === '1' ? 1 : 0); }
  const scope = await getOrgScope(req.user);
  if (!scope.unrestricted) {
    const branchIds = scope.branchIds || [];
    if (!branchIds.length) return res.json([]);
    where.push('b.id IN (' + branchIds.map(() => '?').join(',') + ')');
    params.push(...branchIds);
  }
  const sql = `SELECT b.*, c.legal_name AS company_name,
      (SELECT COUNT(*) FROM employees e WHERE e.branch_id = b.id AND e.status='active') AS employee_count,
      (SELECT COUNT(*) FROM devices d WHERE d.branch_id = b.id) AS device_count
    FROM branches b
    LEFT JOIN companies c ON c.id = b.company_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY b.name ASC`;
  const [rows] = await sequelize.query(sql, { replacements: params });
  res.json(rows);
}));

// GET /api/branches/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const scope = await getOrgScope(req.user);
  const branchId = Number(req.params.id);
  if (!scope.unrestricted && !(scope.branchIds || []).includes(branchId)) {
    return res.status(404).json({ error: 'Sede no encontrada' });
  }
  const [[row]] = await sequelize.query(
    'SELECT * FROM branches WHERE id = ? LIMIT 1',
    { replacements: [req.params.id] }
  );
  if (!row) return res.status(404).json({ error: 'Sede no encontrada' });
  res.json(row);
}));

// Vincular una sede existente a una empresa activa. Sólo permite el primer vínculo:
// mover una sede con empleados a otra empresa requiere un procedimiento aparte.
router.patch('/:id/company', authorize('admin', 'super_admin'), requirePermission('empresas', 'update'), asyncHandler(async (req, res) => {
  governance.assertWriteEnabled();
  const branchId = Number(req.params.id);
  const companyId = Number(req.body?.company_id);
  if (!Number.isSafeInteger(branchId) || branchId <= 0 ||
      !Number.isSafeInteger(companyId) || companyId <= 0 ||
      req.body?.confirm !== 'VINCULAR') {
    return res.status(400).json({ error: 'Sede, empresa y confirmación VINCULAR son requeridos', code: 'INVALID_COMPANY_LINK' });
  }

  const result = await sequelize.transaction(async transaction => {
    const [[branch]] = await sequelize.query(
      'SELECT id, company_id FROM branches WHERE id = ? FOR UPDATE',
      { replacements: [branchId], transaction }
    );
    if (!branch) return { status: 404, error: 'Sede no encontrada' };
    if (branch.company_id != null) {
      if (Number(branch.company_id) === companyId) return { changed: false };
      return { status: 409, error: 'La sede ya está vinculada a otra empresa', code: 'COMPANY_ALREADY_LINKED' };
    }
    const [[company]] = await sequelize.query(
      'SELECT id FROM companies WHERE id = ? AND active = 1 FOR UPDATE',
      { replacements: [companyId], transaction }
    );
    if (!company) return { status: 400, error: 'Empresa inválida o inactiva', code: 'INVALID_COMPANY' };
    const [[count]] = await sequelize.query(
      "SELECT COUNT(*) AS n FROM employees WHERE branch_id = ? AND status = 'active'",
      { replacements: [branchId], transaction }
    );
    await sequelize.query(
      'UPDATE branches SET company_id = ? WHERE id = ? AND company_id IS NULL',
      { replacements: [companyId, branchId], transaction }
    );
    return { changed: true, employeeCount: Number(count.n) };
  });
  if (result.status) return res.status(result.status).json({ error: result.error, code: result.code });
  if (!result.changed) return res.json({ ok: true, changed: false, company_id: companyId });
  audit.log({
    req, user: req.user, action: 'branch.company.link',
    entity: 'branch', entity_id: branchId,
    details: { from: 'unlinked', to: companyId, employees: result.employeeCount, reason: 'bootstrap' },
  });
  res.json({ ok: true, changed: true, company_id: companyId });
}));

// POST /api/branches
router.post('/', authorize('admin', 'super_admin'), async (req, res) => {
  const { code, name, address, city, phone, timezone, geo_lat, geo_lng, geo_radius_m, company_id } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'code y name son requeridos' });
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  try {
    let companyId = null;
    if (company_id != null && company_id !== '') {
      governance.assertWriteEnabled();
      companyId = Number(company_id);
      if (!Number.isSafeInteger(companyId) || companyId <= 0) {
        return res.status(400).json({ error: 'Empresa inválida', code: 'INVALID_COMPANY' });
      }
      const [[company]] = await sequelize.query(
        'SELECT id FROM companies WHERE id = ? AND active = 1 LIMIT 1',
        { replacements: [companyId] }
      );
      if (!company) return res.status(400).json({ error: 'Empresa inválida o inactiva', code: 'INVALID_COMPANY' });
    }
    const [r] = await sequelize.query(
      `INSERT INTO branches (code, name, address, city, phone, timezone, geo_lat, geo_lng, geo_radius_m, company_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      { replacements: [code, name, address || null, city || null, phone || null, timezone || 'America/Asuncion',
        num(geo_lat), num(geo_lng), geo_radius_m != null ? (parseInt(geo_radius_m, 10) || null) : null, companyId] }
    );
    const branchId = insertId(r);
    if (companyId) audit.log({
      req, user: req.user, action: 'branch.company.link',
      entity: 'branch', entity_id: branchId,
      details: { from: 'unlinked', to: companyId, employees: 0, reason: 'create' },
    });
    res.status(201).json({ id: branchId, message: 'Sede creada' });
  } catch (err) {
    if (err.original?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Ya existe una sede con ese código' });
    }
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
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
