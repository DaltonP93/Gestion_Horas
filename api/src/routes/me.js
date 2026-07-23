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
const audit = require('../services/audit');

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

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
    let user;
    try {
      [[user]] = await sequelize.query(`
        SELECT u.id, u.username, u.email, u.full_name, u.role, u.active,
               u.last_login, u.employee_id, u.photo_url,
               u.language, u.timezone, u.ui_prefs
        FROM users u WHERE u.id = ?
      `, { replacements: [req.user.id] });
    } catch {
      // Fallback si la migración 062 aún no corrió.
      [[user]] = await sequelize.query(`
        SELECT u.id, u.username, u.email, u.full_name, u.role, u.active,
               u.last_login, u.employee_id, u.photo_url
        FROM users u WHERE u.id = ?
      `, { replacements: [req.user.id] });
    }
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.ui_prefs) { try { user.ui_prefs = JSON.parse(user.ui_prefs); } catch { user.ui_prefs = null; } }

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
// Self-service del perfil. ALLOW-LIST estricta: el usuario sólo edita sus
// datos personales autorizados. NUNCA rol, permisos, estado, sucursal
// administrativa ni grupos de seguridad — esos campos se ignoran aunque
// vengan en el body (la autorización vive en el backend, no en ocultar UI).
const PROFILE_ALLOWED = ['first_name', 'last_name', 'email', 'phone', 'address', 'language', 'timezone', 'ui_prefs'];
router.patch('/profile', async (req, res) => {
  try {
    const changed = [];

    // ── Cuenta (users): email, idioma, zona horaria, preferencias visuales ──
    const uSets = [], uVals = [];
    if (req.body.email !== undefined) {
      const safe = String(req.body.email).trim();
      if (safe && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safe)) {
        return res.status(400).json({ error: 'Email inválido' });
      }
      // Unicidad de email (otro usuario ya lo usa)
      if (safe) {
        const [[dup]] = await sequelize.query(
          'SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1',
          { replacements: [safe, req.user.id] }
        );
        if (dup) return res.status(409).json({ error: 'Ese correo ya está en uso' });
      }
      uSets.push('email = ?'); uVals.push(safe || null); changed.push('email');
    }
    if (req.body.language !== undefined) {
      const lang = String(req.body.language || '').trim().slice(0, 8) || null;
      uSets.push('language = ?'); uVals.push(lang); changed.push('language');
    }
    if (req.body.timezone !== undefined) {
      const tz = String(req.body.timezone || '').trim().slice(0, 64) || null;
      uSets.push('timezone = ?'); uVals.push(tz); changed.push('timezone');
    }
    if (req.body.ui_prefs !== undefined) {
      let json = null;
      try { json = req.body.ui_prefs == null ? null : JSON.stringify(req.body.ui_prefs).slice(0, 4000); } catch { json = null; }
      uSets.push('ui_prefs = ?'); uVals.push(json); changed.push('ui_prefs');
    }
    if (uSets.length) {
      uVals.push(req.user.id);
      await sequelize.query(`UPDATE users SET ${uSets.join(', ')} WHERE id = ?`, { replacements: uVals });
    }

    // ── Empleado vinculado (employees): nombre, apellido, teléfono, domicilio ──
    if (req.user.employee_id) {
      const eSets = [], eVals = [];
      const map = { first_name: 'first_name', last_name: 'last_name', phone: 'phone', address: 'address' };
      for (const [k, col] of Object.entries(map)) {
        if (req.body[k] !== undefined) { eSets.push(`${col} = ?`); eVals.push(String(req.body[k] || '').trim() || null); changed.push(k); }
      }
      if (eSets.length) {
        eVals.push(req.user.employee_id);
        await sequelize.query(`UPDATE employees SET ${eSets.join(', ')} WHERE id = ?`, { replacements: eVals });
      }
    } else if (req.body.first_name !== undefined || req.body.last_name !== undefined) {
      // Usuario sin empleado: nombre completo va en users.full_name.
      const fn = String(req.body.first_name || '').trim();
      const ln = String(req.body.last_name || '').trim();
      const full = [fn, ln].filter(Boolean).join(' ') || null;
      if (full !== null) { await sequelize.query('UPDATE users SET full_name = ? WHERE id = ?', { replacements: [full, req.user.id] }); changed.push('full_name'); }
    }

    // Auditoría: qué campos cambió (sin valores sensibles); email por separado.
    const auditable = changed.filter(f => PROFILE_ALLOWED.includes(f) || f === 'full_name');
    if (auditable.length) {
      audit.log({ req, user: req.user, action: 'profile.update', entity: 'user', entity_id: req.user.id, details: { fields: auditable } });
      if (auditable.includes('email')) {
        audit.log({ req, user: req.user, action: 'profile.email_change', entity: 'user', entity_id: req.user.id, details: {} });
      }
    }

    res.json({ ok: true, message: 'Perfil actualizado', changed: auditable });
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

    audit.log({ req, user: req.user, action: 'profile.photo_change', entity: 'user', entity_id: req.user.id, details: {} });
    res.json({ ok: true, url, message: 'Foto actualizada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/me/security ───────────────────────────────────────
// "Seguridad de mi cuenta": último acceso, 2FA y sesiones activas reales.
// La sesión actual se marca si el cliente envía su refresh token en la
// cabecera X-Current-Refresh (se compara por hash; nunca se registra).
router.get('/security', async (req, res) => {
  try {
    let u = {};
    try {
      [[u]] = await sequelize.query(
        'SELECT last_login, twofa_enabled, twofa_enabled_at, password_changed_at FROM users WHERE id = ?',
        { replacements: [req.user.id] }
      );
    } catch {
      [[u]] = await sequelize.query('SELECT last_login FROM users WHERE id = ?', { replacements: [req.user.id] });
    }

    let sessions = [];
    try {
      const [rows] = await sequelize.query(
        `SELECT id, ip_address, user_agent, created_at, last_used_at, expires_at
           FROM refresh_tokens
          WHERE user_id = ? AND expires_at > NOW()
          ORDER BY COALESCE(last_used_at, created_at) DESC
          LIMIT 50`,
        { replacements: [req.user.id] }
      );
      sessions = rows;
    } catch {
      // Metadata ausente (pre-062): sólo el conteo.
      const [rows] = await sequelize.query(
        'SELECT id, created_at, expires_at FROM refresh_tokens WHERE user_id = ? AND expires_at > NOW() ORDER BY created_at DESC LIMIT 50',
        { replacements: [req.user.id] }
      );
      sessions = rows;
    }

    // Marcar la sesión actual (sin exponer ni registrar el token).
    const current = req.headers['x-current-refresh'];
    if (current) {
      const h = sha256(String(current));
      try {
        const [[row]] = await sequelize.query(
          'SELECT id FROM refresh_tokens WHERE user_id = ? AND token_hash = ? LIMIT 1',
          { replacements: [req.user.id, h] }
        );
        const currentId = row?.id;
        sessions = sessions.map(s => ({ ...s, is_current: s.id === currentId }));
      } catch { /* opcional */ }
    }

    res.json({
      last_login: u?.last_login || null,
      password_changed_at: u?.password_changed_at || null,
      twofa: { enabled: !!u?.twofa_enabled, enabledAt: u?.twofa_enabled_at || null },
      sessions,
      sessions_count: sessions.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/me/security/close-sessions ───────────────────────
// Cierra todas las otras sesiones del usuario. Conserva la actual si el
// cliente envía su refresh token en el body { refreshToken }.
router.post('/security/close-sessions', async (req, res) => {
  try {
    const keep = req.body?.refreshToken ? sha256(String(req.body.refreshToken)) : null;
    let affected = 0;
    if (keep) {
      const [r] = await sequelize.query(
        'DELETE FROM refresh_tokens WHERE user_id = ? AND token_hash <> ?',
        { replacements: [req.user.id, keep] }
      );
      affected = r?.affectedRows ?? 0;
    } else {
      const [r] = await sequelize.query('DELETE FROM refresh_tokens WHERE user_id = ?', { replacements: [req.user.id] });
      affected = r?.affectedRows ?? 0;
    }
    audit.log({ req, user: req.user, action: 'session.close_others', entity: 'user', entity_id: req.user.id, details: { closed: affected } });
    res.json({ ok: true, closed: affected });
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
