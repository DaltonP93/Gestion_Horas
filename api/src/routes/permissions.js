/**
 * permissions.js
 * Workflow de 2 niveles + GTH final.
 * Transiciones controladas por permissionWorkflow.js.
 */
const router = require('express').Router();
const { insertId } = require('../utils/insertId');
const path = require('path');
const fs   = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const { finalizeUpload } = require('../utils/uploadSniff');
const { authenticate, authorize } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const wf = require('../services/permissionWorkflow');
const notif = require('../services/notifications');
const access = require('../services/permissionAccess');
const { logInternalError } = require('../utils/logInternalError');
const logger = require('../config/logger');

router.use(authenticate);

// ─── Uploads de justificativos de permisos ─────────────────────
const PERM_UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'),
  'permissions'
);
if (!fs.existsSync(PERM_UPLOAD_DIR)) fs.mkdirSync(PERM_UPLOAD_DIR, { recursive: true });

const permStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PERM_UPLOAD_DIR),
  // Nombre neutro y no predecible; la extensión la fija finalizeUpload según
  // el CONTENIDO real. El nombre original sólo se guarda como dato (columna).
  filename: (_req, _file, cb) => {
    cb(null, `perm_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.upload`);
  },
});
const permUpload = multer({
  storage: permStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const ok = /^(application\/pdf|image\/(jpeg|png|webp))$/.test(file.mimetype);
    cb(ok ? null : new Error('Tipo de archivo no permitido (PDF/JPG/PNG/WebP)'), ok);
  },
});

// ─── GET /api/permissions ──────────────────────────────────────
// Listado filtrable por estado / empleado / departamento
router.get('/', async (req, res) => {
  try {
    const { status, approval_state, employeeId, department_id } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (status)         { where += ' AND p.status = ?';           params.push(status); }
    if (approval_state) { where += ' AND p.approval_state = ?';   params.push(approval_state); }
    if (employeeId)     { where += ' AND p.employee_id = ?';      params.push(employeeId); }
    if (department_id)  { where += ' AND e.department_id = ?';    params.push(department_id); }

    // Alcance del actor: global RR.HH. → todo; con alcance → sus deptos + lo
    // propio; resto → sólo lo propio. Los filtros del cliente se INTERSECTAN.
    const ctx = await access.getAccessContext(req.user);
    const scope = access.listFilter(ctx, { empAlias: 'e', permAlias: 'p' });
    where += scope.clause;
    params.push(...scope.params);

    const [rows] = await sequelize.query(`
      SELECT p.*,
        CONCAT(e.first_name,' ',e.last_name) AS employee_name,
        e.code AS employee_code,
        e.department_id,
        d.name AS department
      FROM permissions p
      JOIN employees e ON p.employee_id = e.id
      LEFT JOIN departments d ON e.department_id = d.id
      ${where}
      ORDER BY p.created_at DESC
      LIMIT 500
    `, { replacements: params });

    res.json(rows);
  } catch (err) {
    logInternalError(logger, { event: 'permissions GET /', route: 'permissions GET /', err, req });
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /api/permissions/inbox ─────────────────────────────────
// Bandeja del usuario actual (sólo los que le toca aprobar)
router.get('/inbox', async (req, res) => {
  try {
    const rows = await wf.getInboxFor(req.user);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/permissions/:id ──────────────────────────────────
router.get('/:id', async (req, res) => {
  const [[perm]] = await sequelize.query(`
    SELECT p.*,
      CONCAT(e.first_name,' ',e.last_name) AS employee_name,
      e.code AS employee_code,
      e.department_id,
      d.name AS department,
      u1.full_name AS level1_approver_name,
      u2.full_name AS level2_approver_name,
      uf.full_name AS final_approver_name
    FROM permissions p
    JOIN employees e ON p.employee_id = e.id
    LEFT JOIN departments d ON e.department_id = d.id
    LEFT JOIN users u1 ON p.level1_approver_id = u1.id
    LEFT JOIN users u2 ON p.level2_approver_id = u2.id
    LEFT JOIN users uf ON p.final_approver_id  = uf.id
    WHERE p.id = ?
  `, { replacements: [req.params.id] });

  if (!perm) return res.status(404).json({ error: 'Permiso no encontrado' });

  // Fuera de alcance ≡ inexistente (404): no se filtra la existencia.
  const ctx = await access.getAccessContext(req.user);
  if (!access.canActOnEmployee(ctx, { id: perm.employee_id, department_id: perm.department_id })) {
    return res.status(404).json({ error: 'Permiso no encontrado' });
  }

  const [events] = await sequelize.query(`
    SELECT e.*, u.full_name AS actor_name, u.role AS actor_role
    FROM permission_approval_events e
    LEFT JOIN users u ON e.actor_id = u.id
    WHERE e.permission_id = ?
    ORDER BY e.created_at ASC
  `, { replacements: [req.params.id] });

  res.json({ ...perm, events });
});

// ─── POST /api/permissions ─────────────────────────────────────
// Crear solicitud. Resuelve regla y guarda needs_*.
router.post('/', async (req, res) => {
  const { employee_id, type, date_from, date_to, reason } = req.body;
  if (!employee_id || !type || !date_from || !date_to) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  try {
    const [[emp]] = await sequelize.query(
      'SELECT id, department_id FROM employees WHERE id = ?',
      { replacements: [employee_id] }
    );
    // El empleado debe existir y estar dentro del alcance del actor (un rol
    // sin alcance de gestión sólo puede solicitar para sí mismo). Fuera de
    // alcance ≡ inexistente (404).
    const ctx = await access.getAccessContext(req.user);
    if (!emp || !access.canActOnEmployee(ctx, emp)) {
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }
    const department_id = emp.department_id || null;

    const needs = await wf.computeNeedsForNewPermission({
      department_id, permission_type: type,
    });

    // Calcular sla_due_at sumando sla_hours de la regla (default 48h)
    let slaHours = 48;
    if (needs.applied_rule_id) {
      const [[rule]] = await sequelize.query(
        'SELECT sla_hours FROM permission_approval_rules WHERE id = ?',
        { replacements: [needs.applied_rule_id] }
      );
      if (rule?.sla_hours) slaHours = rule.sla_hours;
    }

    const [r] = await sequelize.query(
      `INSERT INTO permissions
         (employee_id, type, date_from, date_to, reason,
          approval_state, applied_rule_id,
          needs_level1, needs_level2, needs_final,
          sla_due_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
      { replacements: [
          employee_id, type, date_from, date_to, reason || null,
          needs.applied_rule_id,
          needs.needs_level1, needs.needs_level2, needs.needs_final,
          slaHours,
      ]}
    );

    await wf.logEvent({
      permission_id: insertId(r), actor_id: req.user.id,
      from_state: 'n/a', to_state: 'pending',
      note: `Solicitud creada (tipo=${type})`,
    });

    notif.notifyPermissionCreated(insertId(r)).catch(() => {});
    res.status(201).json({ id: insertId(r), message: 'Permiso solicitado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH/PUT /api/permissions/:id/approve ───────────────────
// Avanza 1 paso en el workflow. Salta niveles no requeridos.
async function approveHandler(req, res) {
  const { note } = req.body || {};
  try {
    const [[perm]] = await sequelize.query(`
      SELECT p.*, e.department_id
      FROM permissions p
      JOIN employees e ON p.employee_id = e.id
      WHERE p.id = ?
    `, { replacements: [req.params.id] });

    if (!perm) return res.status(404).json({ error: 'Permiso no encontrado' });

    if (!['pending','level1_ok','level2_ok'].includes(perm.approval_state)) {
      return res.status(409).json({ error: `No se puede aprobar en estado '${perm.approval_state}'` });
    }

    const allowed = await wf.canUserActOn(req.user, perm);
    if (!allowed) return res.status(403).json({ error: 'No autorizado a aprobar en este nivel' });

    const nextState = wf.nextApprovedState(perm.approval_state, {
      needs_level1: perm.needs_level1,
      needs_level2: perm.needs_level2,
      needs_final:  perm.needs_final,
    });
    if (!nextState) return res.status(409).json({ error: 'Sin transición posible' });

    // Determinar qué campos de aprobador llenar según la transición
    const fromState = perm.approval_state;
    const sets = [];
    const vals = [];

    if (fromState === 'pending') {
      sets.push('level1_approver_id = ?', 'level1_at = NOW()', 'level1_note = ?');
      vals.push(req.user.id, note || null);
    }
    if ((fromState === 'pending' && nextState === 'level2_ok') || fromState === 'level1_ok') {
      sets.push('level2_approver_id = ?', 'level2_at = NOW()', 'level2_note = ?');
      vals.push(req.user.id, note || null);
    }
    if (nextState === 'approved') {
      sets.push('final_approver_id = ?', 'final_at = NOW()', 'final_note = ?');
      vals.push(req.user.id, note || null);
      sets.push(`status = 'approved'`, `approved_by = ?`, `approved_at = NOW()`);
      vals.push(req.user.id);
    }
    sets.push('approval_state = ?');
    vals.push(nextState);
    vals.push(req.params.id);

    await sequelize.query(
      `UPDATE permissions SET ${sets.join(', ')} WHERE id = ?`,
      { replacements: vals }
    );

    await wf.logEvent({
      permission_id: perm.id, actor_id: req.user.id,
      from_state: fromState, to_state: nextState, note,
    });

    notif.notifyPermissionAdvanced(perm.id, fromState, nextState, note).catch(() => {});
    res.json({ message: 'Permiso aprobado', state: nextState });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─── PATCH/PUT /api/permissions/:id/reject ────────────────────
async function rejectHandler(req, res) {
  const { rejection_reason, reason, note } = req.body || {};
  const rejReason = rejection_reason || reason || note || null;

  try {
    const [[perm]] = await sequelize.query(`
      SELECT p.*, e.department_id
      FROM permissions p
      JOIN employees e ON p.employee_id = e.id
      WHERE p.id = ?
    `, { replacements: [req.params.id] });

    if (!perm) return res.status(404).json({ error: 'Permiso no encontrado' });
    if (!['pending','level1_ok','level2_ok'].includes(perm.approval_state)) {
      return res.status(409).json({ error: `No se puede rechazar en estado '${perm.approval_state}'` });
    }
    const allowed = await wf.canUserActOn(req.user, perm);
    if (!allowed) return res.status(403).json({ error: 'No autorizado' });

    await sequelize.query(
      `UPDATE permissions
         SET approval_state = 'rejected',
             status         = 'rejected',
             approved_by    = ?,
             approved_at    = NOW(),
             rejection_reason = ?
       WHERE id = ?`,
      { replacements: [req.user.id, rejReason, req.params.id] }
    );

    await wf.logEvent({
      permission_id: perm.id, actor_id: req.user.id,
      from_state: perm.approval_state, to_state: 'rejected',
      note: rejReason,
    });

    notif.notifyPermissionRejected(perm.id, rejReason).catch(() => {});
    res.json({ message: 'Permiso rechazado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

router.put('/:id/approve',   approveHandler);
router.patch('/:id/approve', approveHandler);
router.put('/:id/reject',    rejectHandler);
router.patch('/:id/reject',  rejectHandler);

// ─── POST /api/permissions/:id/cancel ─────────────────────────
// Cancela la propia solicitud (solo el solicitante o GTH/admin/super).
router.post('/:id/cancel', async (req, res) => {
  try {
    const [[perm]] = await sequelize.query(
      'SELECT p.*, e.department_id FROM permissions p JOIN employees e ON p.employee_id = e.id WHERE p.id = ?',
      { replacements: [req.params.id] }
    );
    if (!perm) return res.status(404).json({ error: 'No encontrado' });
    if (!['pending','level1_ok','level2_ok'].includes(perm.approval_state)) {
      return res.status(409).json({ error: 'Ya finalizó' });
    }

    const selfEmployeeId = await access.resolveSelfEmployeeId(req.user);
    const isOwner = selfEmployeeId != null && selfEmployeeId === Number(perm.employee_id);
    const isPowerUser = ['super_admin','admin','gth'].includes(req.user.role);
    if (!isOwner && !isPowerUser) return res.status(403).json({ error: 'No autorizado' });

    await sequelize.query(
      `UPDATE permissions SET approval_state='cancelled', status='rejected' WHERE id=?`,
      { replacements: [req.params.id] }
    );
    await wf.logEvent({
      permission_id: perm.id, actor_id: req.user.id,
      from_state: perm.approval_state, to_state: 'cancelled',
    });
    res.json({ message: 'Cancelado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/permissions/:id/attachment ─────────────────────
// Subir justificativo (PDF / imagen). Solo el dueño o admin/hr/gth.
// Autorización ANTES de que multer escriba el archivo en disco: si el actor
// no puede adjuntar, no queda ningún archivo huérfano.
//   - roles globales de RR.HH. (unrestricted): cualquier solicitud;
//   - coordinator/manager: sólo solicitudes de empleados en su alcance;
//   - dueño (users.employee_id leído de la base): la propia.
const ATTACH_SCOPED_ROLES = new Set(['coordinator', 'manager']);
async function authorizeAttachment(req, res, next) {
  try {
    const [[perm]] = await sequelize.query(
      `SELECT p.id, p.employee_id, e.department_id
         FROM permissions p
         JOIN employees e ON p.employee_id = e.id
        WHERE p.id = ?`,
      { replacements: [req.params.id] }
    );
    const ctx = perm ? await access.getAccessContext(req.user) : null;
    const emp = perm ? { id: perm.employee_id, department_id: perm.department_id } : null;
    // Sin visibilidad ≡ inexistente.
    if (!perm || !access.canActOnEmployee(ctx, emp)) {
      return res.status(404).json({ error: 'Permiso no encontrado' });
    }
    const isOwner = ctx.selfEmployeeId != null && ctx.selfEmployeeId === Number(perm.employee_id);
    const canAttach = ctx.unrestricted || isOwner || ATTACH_SCOPED_ROLES.has(req.user.role);
    if (!canAttach) {
      return res.status(403).json({ error: 'No autorizado para adjuntar en este permiso' });
    }
    req.permissionForAttachment = perm;
    next();
  } catch (err) {
    logInternalError(logger, { event: 'permissions attachment authorize', route: 'permissions POST /:id/attachment', err, req });
    res.status(500).json({ error: 'Error interno' });
  }
}

router.post('/:id/attachment', authorizeAttachment, permUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido (field "file")' });

    let saved;
    try {
      saved = await finalizeUpload(req.file, ['pdf', 'jpg', 'png', 'webp']);
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: 'Tipo de archivo no permitido (PDF/JPG/PNG/WebP)' });
      throw e;
    }

    const perm = req.permissionForAttachment;
    const user = req.user;

    // Ruta lógica interna: el estático público NO la sirve (uploadsGuard); la
    // descarga es GET /api/permissions/:id/attachment, con alcance.
    const url = `/uploads/permissions/${saved.filename}`;
    await sequelize.query(
      `UPDATE permissions SET
         attachment_url      = ?,
         attachment_filename = ?,
         attachment_size     = ?,
         attachment_mime     = ?
       WHERE id = ?`,
      { replacements: [
        url, req.file.originalname, req.file.size, saved.mime, req.params.id
      ]}
    );

    await wf.logEvent({
      permission_id: perm.id, actor_id: user.id,
      from_state: 'attachment', to_state: 'attachment',
      note: `Adjunto subido: ${req.file.originalname} (${(req.file.size/1024).toFixed(1)} KB)`,
    });

    res.status(201).json({
      ok: true,
      url,
      filename: req.file.originalname,
      size:     req.file.size,
      mime:     saved.mime,
      download: `/api/permissions/${perm.id}/attachment`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/permissions/:id/attachment ──────────────────────
// Descarga autenticada del justificativo. Mismo alcance que el detalle:
// fuera de alcance ≡ inexistente (404). Siempre como descarga (attachment),
// con tipo de una lista cerrada y nosniff.
const ATTACHMENT_MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
router.get('/:id/attachment', async (req, res) => {
  try {
    const [[perm]] = await sequelize.query(
      `SELECT p.id, p.employee_id, e.department_id,
              p.attachment_url, p.attachment_filename, p.attachment_mime
         FROM permissions p
         JOIN employees e ON p.employee_id = e.id
        WHERE p.id = ?`,
      { replacements: [req.params.id] }
    );
    const ctx = perm ? await access.getAccessContext(req.user) : null;
    if (!perm || !access.canActOnEmployee(ctx, { id: perm.employee_id, department_id: perm.department_id })
        || !perm.attachment_url) {
      return res.status(404).json({ error: 'Adjunto no encontrado' });
    }
    // Sólo archivos dentro del directorio de justificativos (sin traversal).
    const name = path.basename(String(perm.attachment_url));
    if (!perm.attachment_url.startsWith('/uploads/permissions/') || !name || name.startsWith('.')) {
      return res.status(404).json({ error: 'Adjunto no encontrado' });
    }
    const full = path.join(PERM_UPLOAD_DIR, name);
    if (!fs.existsSync(full)) return res.status(410).json({ error: 'Archivo ya no está disponible' });

    const mime = ATTACHMENT_MIMES.has(perm.attachment_mime) ? perm.attachment_mime : 'application/octet-stream';
    const downloadName = String(perm.attachment_filename || name).replace(/[^\w.\- ]/g, '_').slice(-120);
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    logInternalError(logger, { event: 'permissions attachment download', route: 'permissions GET /:id/attachment', err, req });
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── DELETE /api/permissions/:id/attachment ───────────────────
router.delete('/:id/attachment', authorize('admin', 'hr', 'gth'), async (req, res) => {
  try {
    const [[perm]] = await sequelize.query(
      'SELECT attachment_url FROM permissions WHERE id = ?',
      { replacements: [req.params.id] }
    );
    if (!perm) return res.status(404).json({ error: 'Permiso no encontrado' });

    if (perm.attachment_url) {
      const filePath = path.join(
        path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads')),
        perm.attachment_url.replace(/^\/uploads\//, '')
      );
      fs.promises.unlink(filePath).catch(() => {});
    }

    await sequelize.query(
      `UPDATE permissions SET
         attachment_url      = NULL,
         attachment_filename = NULL,
         attachment_size     = NULL,
         attachment_mime     = NULL
       WHERE id = ?`,
      { replacements: [req.params.id] }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
