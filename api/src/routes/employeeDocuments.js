/**
 * employeeDocuments.js — Rutas de gestión del repositorio de documentos
 * personales del empleado desde el lado de RR.HH.
 *
 *   POST   /api/employees/:id/documents                (upload)
 *   GET    /api/employees/:id/documents                (list)
 *   GET    /api/employees/:id/documents/:docId/download
 *   DELETE /api/employees/:id/documents/:docId
 *
 * El binario se guarda en UPLOAD_DIR (mismo mecanismo que las fotos).
 * El acceso self-service del empleado a sus propios documentos vive en
 * `routes/me.js` (`/api/me/documents*`).
 */

const { resolvePrivatePath, sendPrivateFile } = require('../utils/privateFile');
const router  = require('express').Router({ mergeParams: true });
const { insertId } = require('../utils/insertId');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const enforceEmployeeScope = require('../middleware/enforceEmployeeScope');
const { asyncHandler } = require('../utils/asyncHandler');
const { finalizeUpload } = require('../utils/uploadSniff');
const { sequelize } = require('../config/database');
const audit = require('../services/audit');
const {
  isValidCategory, isValidPeriod, isAllowedMime,
  sanitizeTitle, defaultTitleFor, MAX_SIZE_BYTES,
} = require('../services/employeeDocuments');

const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads')
);
const DOC_DIR = path.join(UPLOAD_DIR, 'employee-documents');
if (!fs.existsSync(DOC_DIR)) fs.mkdirSync(DOC_DIR, { recursive: true });

// Nombre neutro y no predecible, SIN la extensión del cliente: la extensión la
// fija finalizeUpload según el CONTENIDO real (utils/uploadSniff). El MIME
// declarado sólo sirve de primer filtro; nunca decide el tipo.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DOC_DIR),
  filename:    (_req, _file, cb) => cb(null, `doc_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`),
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!isAllowedMime(file.mimetype))
      return cb(Object.assign(new Error('Tipo de archivo no permitido'), { status: 400 }));
    cb(null, true);
  },
});
// Tipos admitidos por CONTENIDO (mismos formatos que ALLOWED_MIME).
const DOC_TYPES = ['pdf', 'png', 'jpg', 'webp', 'docx', 'xlsx'];

// multer como middleware que responde 400 controlado (y no deja archivo).
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'Archivo demasiado grande' : 'Tipo de archivo no permitido' });
  });
}

router.use(authenticate);

// ── POST /api/employees/:id/documents ───────────────────────────
// Subida por RR.HH. — requiere permiso empleados.update. Rol, capacidad,
// id canónico, existencia y alcance del empleado se verifican ANTES de que
// multer escriba nada en disco. El tipo se decide por contenido; si la
// validación o la base fallan se retira SÓLO el archivo de esta solicitud.
router.post('/',
  authorize('admin', 'hr', 'gth'),
  requirePermission('empleados', 'update'),
  enforceEmployeeScope('id'),
  // enforceEmployeeScope no consulta la existencia para roles globales: se
  // verifica acá, también antes de escribir el archivo.
  asyncHandler(async (req, res, next) => {
    const [[emp]] = await sequelize.query('SELECT id FROM employees WHERE id = ? LIMIT 1', { replacements: [req.scopedEmployeeId] });
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });
    return next();
  }),
  uploadSingle,
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const employeeId = req.scopedEmployeeId;
    let newFile = req.file.path; // archivo creado por ESTA solicitud
    const discard = () => { if (newFile) fs.unlink(newFile, () => {}); newFile = null; };

    try {
      const category = String(req.body.category || 'other').toLowerCase();
      const period   = req.body.period || null;
      const visible  = req.body.visible_to_employee === '0' ? 0 : 1;
      const note     = req.body.note ? String(req.body.note).slice(0, 500) : null;

      if (!isValidCategory(category)) {
        discard();
        return res.status(400).json({ error: 'Categoría inválida' });
      }
      if (!isValidPeriod(period)) {
        discard();
        return res.status(400).json({ error: "Período inválido (formato 'YYYY-MM')" });
      }

      let saved;
      try {
        saved = await finalizeUpload(req.file, DOC_TYPES); // borra el archivo si no es válido
      } catch (e) {
        newFile = null;
        if (e.status === 400) return res.status(400).json({ error: e.message });
        throw e;
      }
      newFile = saved.path;

      const title = sanitizeTitle(req.body.title)
        || defaultTitleFor({ category, period, filename: req.file.originalname });
      const relPath = path.relative(UPLOAD_DIR, saved.path);
      const [r] = await sequelize.query(
        `INSERT INTO employee_documents
           (employee_id, category, period, title, filename, path, size_bytes,
            mime, uploaded_by, visible_to_employee, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        { replacements: [
          employeeId, category, period, title, req.file.originalname,
          relPath, req.file.size, saved.mime, req.user.id, visible, note,
        ] }
      );
      newFile = null; // persistido: ya pertenece al registro

      audit.log({
        req, user: req.user, action: 'employee.document.upload',
        entity: 'employee', entity_id: employeeId,
        details: { id: insertId(r), category, period, size: req.file.size },
      });

      return res.status(201).json({ id: insertId(r), title, category, period, visible_to_employee: !!visible });
    } catch (err) {
      discard();
      return res.status(500).json({ error: 'No se pudo guardar el documento' });
    }
  })
);

// ── GET /api/employees/:id/documents ────────────────────────────
// Los roles scoped sólo listan documentos de empleados de su ámbito;
// fuera de alcance → 404 (H-3: IDOR de documentos de RR.HH.).
router.get('/',
  requirePermission('empleados', 'view'),
  enforceEmployeeScope('id'),
  asyncHandler(async (req, res) => {
    const employeeId = parseInt(req.params.id, 10);
    const [rows] = await sequelize.query(
      `SELECT d.id, d.category, d.period, d.title, d.filename, d.size_bytes,
              d.mime, d.uploaded_by, d.uploaded_at, d.visible_to_employee, d.note,
              u.username AS uploaded_by_username
         FROM employee_documents d
         LEFT JOIN users u ON u.id = d.uploaded_by
        WHERE d.employee_id = ?
        ORDER BY d.uploaded_at DESC`,
      { replacements: [employeeId] }
    );
    res.json({ employee_id: employeeId, count: rows.length, items: rows });
  })
);

// ── GET /api/employees/:id/documents/:docId/download ────────────
// Mismo alcance que el listado: descargar recibos/contratos de un empleado
// fuera del ámbito del rol scoped → 404 (H-3).
router.get('/:docId/download',
  requirePermission('empleados', 'view'),
  enforceEmployeeScope('id'),
  asyncHandler(async (req, res) => {
    const employeeId = parseInt(req.params.id, 10);
    const docId      = parseInt(req.params.docId, 10);
    const [[doc]] = await sequelize.query(
      `SELECT id, employee_id, filename, path, mime, size_bytes
         FROM employee_documents WHERE id = ? AND employee_id = ? LIMIT 1`,
      { replacements: [docId, employeeId] }
    );
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });
    const full = resolvePrivatePath(`/uploads/${doc.path}`, { subdir: 'employee-documents' });
    if (!full || !fs.existsSync(full)) return res.status(410).json({ error: 'Archivo ya no está disponible' });

    audit.log({
      req, user: req.user, action: 'employee.document.download',
      entity: 'employee', entity_id: employeeId, details: { id: doc.id },
    });
    sendPrivateFile(res, full, { mime: doc.mime, downloadName: doc.filename });
  })
);

// ── DELETE /api/employees/:id/documents/:docId ──────────────────
router.delete('/:docId',
  authorize('admin', 'hr', 'gth'),
  requirePermission('empleados', 'delete'),
  asyncHandler(async (req, res) => {
    const employeeId = parseInt(req.params.id, 10);
    const docId      = parseInt(req.params.docId, 10);
    const [[doc]] = await sequelize.query(
      'SELECT id, path FROM employee_documents WHERE id = ? AND employee_id = ? LIMIT 1',
      { replacements: [docId, employeeId] }
    );
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });

    await sequelize.query('DELETE FROM employee_documents WHERE id = ?', { replacements: [docId] });
    const full = path.join(UPLOAD_DIR, doc.path);
    fs.unlink(full, () => {});
    audit.log({
      req, user: req.user, action: 'employee.document.delete',
      entity: 'employee', entity_id: employeeId, details: { id: doc.id },
    });
    res.json({ ok: true, id: doc.id });
  })
);

module.exports = router;
