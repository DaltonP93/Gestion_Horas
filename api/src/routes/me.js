/**
 * me.js — Self-service del usuario logueado.
 * Todos los endpoints filtran por req.user.employee_id del JWT,
 * así un empleado nunca ve datos de otros.
 */
const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { sequelize } = require('../config/database');
const wf = require('../services/permissionWorkflow');

// ── Upload de foto de perfil ─────────────────────────────────────
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'));
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const photoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file,  cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const base = crypto.randomBytes(8).toString('hex');
    cb(null, `avatar_${Date.now()}_${base}${ext}`);
  },
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!['image/jpeg','image/png','image/webp'].includes(file.mimetype))
      return cb(new Error('Solo se permiten imágenes JPEG, PNG o WebP'));
    cb(null, true);
  },
});

router.use(authenticate);

// Helper: obtener employee_id del usuario actual (fallback desde DB si JWT viejo).
async function getEmployeeId(req) {
  if (req.user.employee_id) return req.user.employee_id;
  const [[row]] = await sequelize.query(
    'SELECT employee_id FROM users WHERE id = ? LIMIT 1',
    { replacements: [req.user.id] }
  );
  return row?.employee_id || null;
}

// ─── GET /api/me ────────────────────────────────────────────────
// Perfil del usuario + info del empleado vinculado.
router.get('/', async (req, res) => {
  try {
    const [[user]] = await sequelize.query(`
      SELECT u.id, u.username, u.email, u.full_name, u.role, u.active,
             u.last_login, u.employee_id
      FROM users u WHERE u.id = ?
    `, { replacements: [req.user.id] });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    let employee = null;
    if (user.employee_id) {
      const [[emp]] = await sequelize.query(`
        SELECT e.id, e.code, e.first_name, e.last_name, e.email, e.phone,
               e.position, e.hire_date, e.status,
               e.department_id, d.name AS department,
               IFNULL(e.address, '')   AS address,
               IFNULL(e.photo_url, '') AS photo_url
        FROM employees e
        LEFT JOIN departments d ON e.department_id = d.id
        WHERE e.id = ?
      `, { replacements: [user.employee_id] });
      employee = emp || null;
    }

    res.json({ user, employee });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/me/profile ──────────────────────────────────────
// Permite al usuario editar su email (cuenta) y phone/address (empleado).
router.patch('/profile', async (req, res) => {
  try {
    const { email, phone, address } = req.body;

    // Actualizar email en users (si se envió)
    if (email !== undefined) {
      const safe = String(email).trim();
      if (safe && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safe)) {
        return res.status(400).json({ error: 'Email inválido' });
      }
      await sequelize.query(
        'UPDATE users SET email = ? WHERE id = ?',
        { replacements: [safe || null, req.user.id] }
      );
    }

    // Actualizar phone y address en employees (si vinculado)
    if ((phone !== undefined || address !== undefined) && req.user.employee_id) {
      const sets = [];
      const vals = [];
      if (phone !== undefined)   { sets.push('phone = ?');   vals.push(String(phone || '').trim() || null); }
      if (address !== undefined) { sets.push('address = ?'); vals.push(String(address || '').trim() || null); }
      vals.push(req.user.employee_id);
      await sequelize.query(
        `UPDATE employees SET ${sets.join(', ')} WHERE id = ?`,
        { replacements: vals }
      );
    }

    res.json({ ok: true, message: 'Perfil actualizado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/me/photo ─────────────────────────────────────────
// Sube una foto de perfil y la asocia al employee (o al user si no tiene).
router.post('/photo', photoUpload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen' });
    const url = `/uploads/${req.file.filename}`;

    if (req.user.employee_id) {
      await sequelize.query(
        'UPDATE employees SET photo_url = ? WHERE id = ?',
        { replacements: [url, req.user.employee_id] }
      );
    } else {
      await sequelize.query(
        'UPDATE users SET photo_url = ? WHERE id = ?',
        { replacements: [url, req.user.id] }
      );
    }

    res.json({ ok: true, url, message: 'Foto actualizada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/me/attendance?from=&to= ───────────────────────────
// Marcajes del empleado logueado.
router.get('/attendance', asyncHandler(async (req, res) => {
  const employeeId = await getEmployeeId(req);
  if (!employeeId) return res.json([]);

  const { from, to } = req.query;
  const params = [employeeId];
  let where = 'WHERE employee_id = ?';
  if (from) { where += ' AND DATE(timestamp) >= ?'; params.push(from); }
  if (to)   { where += ' AND DATE(timestamp) <= ?'; params.push(to); }

  const [rows] = await sequelize.query(`
    SELECT id, timestamp, type, source, device_id
    FROM attendance_logs
    ${where}
    ORDER BY timestamp DESC
    LIMIT 500
  `, { replacements: params });
  res.json(rows);
}));

// ─── GET /api/me/summary?from=&to= ──────────────────────────────
// Resumen diario (worked_minutes, late_minutes, status).
router.get('/summary', asyncHandler(async (req, res) => {
  const employeeId = await getEmployeeId(req);
  if (!employeeId) return res.json([]);

  const { from, to } = req.query;
  const params = [employeeId];
  let where = 'WHERE employee_id = ?';
  if (from) { where += ' AND date >= ?'; params.push(from); }
  if (to)   { where += ' AND date <= ?'; params.push(to); }

  const [rows] = await sequelize.query(`
    SELECT date, first_in, last_out, worked_minutes, late_minutes, status
    FROM daily_summary
    ${where}
    ORDER BY date DESC
    LIMIT 200
  `, { replacements: params });
  res.json(rows);
}));

// ─── GET /api/me/permissions ────────────────────────────────────
// Mis solicitudes de permiso.
router.get('/permissions', asyncHandler(async (req, res) => {
  const employeeId = await getEmployeeId(req);
  if (!employeeId) return res.json([]);

  const [rows] = await sequelize.query(`
    SELECT p.id, p.type, p.date_from, p.date_to, p.reason,
           p.status, p.approval_state,
           p.needs_level1, p.needs_level2, p.needs_final,
           p.created_at, p.rejection_reason
    FROM permissions p
    WHERE p.employee_id = ?
    ORDER BY p.created_at DESC
    LIMIT 200
  `, { replacements: [employeeId] });
  res.json(rows);
}));

// ─── POST /api/me/permissions ───────────────────────────────────
// Solicitar permiso (self-service).
router.post('/permissions', async (req, res) => {
  const employeeId = await getEmployeeId(req);
  if (!employeeId) return res.status(400).json({ error: 'Tu usuario no está vinculado a un empleado' });

  const { type, date_from, date_to, reason } = req.body;
  if (!type || !date_from || !date_to) {
    return res.status(400).json({ error: 'Tipo y fechas son requeridas' });
  }

  try {
    const [[emp]] = await sequelize.query(
      'SELECT department_id FROM employees WHERE id = ?',
      { replacements: [employeeId] }
    );
    const needs = await wf.computeNeedsForNewPermission({
      department_id: emp?.department_id || null,
      permission_type: type,
    });

    const [r] = await sequelize.query(
      `INSERT INTO permissions
         (employee_id, type, date_from, date_to, reason,
          approval_state, applied_rule_id,
          needs_level1, needs_level2, needs_final)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      { replacements: [
          employeeId, type, date_from, date_to, reason || null,
          needs.applied_rule_id,
          needs.needs_level1, needs.needs_level2, needs.needs_final,
      ]}
    );

    await wf.logEvent({
      permission_id: r.insertId, actor_id: req.user.id,
      from_state: 'n/a', to_state: 'pending',
      note: `Solicitud creada por el empleado (tipo=${type})`,
    });

    res.status(201).json({ id: r.insertId, message: 'Permiso solicitado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/me/permissions/:id/cancel ────────────────────────
// Cancelar mi propia solicitud (solo si aún está pending o level1_ok).
router.post('/permissions/:id/cancel', async (req, res) => {
  const employeeId = await getEmployeeId(req);
  if (!employeeId) return res.status(400).json({ error: 'Sin empleado vinculado' });

  try {
    const [[perm]] = await sequelize.query(
      'SELECT id, employee_id, approval_state FROM permissions WHERE id = ?',
      { replacements: [req.params.id] }
    );
    if (!perm) return res.status(404).json({ error: 'Permiso no encontrado' });
    if (perm.employee_id !== employeeId) return res.status(403).json({ error: 'No es tuyo' });
    if (!['pending','level1_ok','level2_ok'].includes(perm.approval_state)) {
      return res.status(409).json({ error: `No se puede cancelar en estado '${perm.approval_state}'` });
    }

    const fromState = perm.approval_state;
    await sequelize.query(
      `UPDATE permissions SET approval_state = 'cancelled', status = 'cancelled' WHERE id = ?`,
      { replacements: [req.params.id] }
    );
    await wf.logEvent({
      permission_id: perm.id, actor_id: req.user.id,
      from_state: fromState, to_state: 'cancelled',
      note: 'Cancelado por el solicitante',
    });
    res.json({ message: 'Permiso cancelado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Permisos efectivos del usuario logueado (módulos para el sidebar) ───────
const { MODULES, defaultsForRole } = require('../services/permissionMatrix');

router.get('/module-permissions', async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      'SELECT module, can_view, can_create, can_update, can_delete FROM user_permissions WHERE user_id = ?',
      { replacements: [req.user.id] }
    );
    const overrides = Object.fromEntries(rows.map(r => [r.module, r]));
    const defaults = defaultsForRole(req.user.role);
    const effective = {};
    for (const m of MODULES) {
      const src = overrides[m.key] || defaults[m.key];
      effective[m.key] = {
        can_view:   !!src.can_view,
        can_create: !!src.can_create,
        can_update: !!src.can_update,
        can_delete: !!src.can_delete,
      };
    }
    res.json({ role: req.user.role, has_overrides: rows.length > 0, effective });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Notificaciones in-app ───────────────────────────────────────

router.get('/notifications', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const [rows] = await sequelize.query(
      `SELECT id, type, title, body, link, read_at, created_at
         FROM user_notifications
         WHERE user_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      { replacements: [req.user.id, limit] }
    );
    const [[{ unread }]] = await sequelize.query(
      'SELECT COUNT(*) AS unread FROM user_notifications WHERE user_id = ? AND read_at IS NULL',
      { replacements: [req.user.id] }
    );
    res.json({ items: rows, unread });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/notifications/:id/read', async (req, res) => {
  try {
    await sequelize.query(
      'UPDATE user_notifications SET read_at = NOW() WHERE id = ? AND user_id = ? AND read_at IS NULL',
      { replacements: [req.params.id, req.user.id] }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/notifications/read-all', async (req, res) => {
  try {
    await sequelize.query(
      'UPDATE user_notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL',
      { replacements: [req.user.id] }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
