/**
 * faceRecognition.js
 * Gestión de descriptores faciales (face-api.js genera el vector en el browser).
 *
 * El browser calcula el descriptor 128-d, la API solo almacena / compara.
 * Esto evita instalar TensorFlow en el servidor.
 *
 * Endpoints:
 *   GET  /api/face/:employeeId/descriptor  — recuperar descriptor de referencia
 *   PUT  /api/face/:employeeId/enroll      — guardar descriptor + foto URL
 *   POST /api/face/verify                  — comparar descriptor vs. referencia
 *   GET  /api/face/verifications           — historial de verificaciones
 */
const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler }           = require('../utils/asyncHandler');
const { sequelize }               = require('../config/database');
const audit                       = require('../services/audit');

router.use(authenticate);

// Distancia euclidiana entre dos descriptores (Array de 128 floats)
function euclidean(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 99;
  return Math.sqrt(a.reduce((acc, v, i) => acc + (v - b[i]) ** 2, 0));
}

// GET /api/face/:employeeId/descriptor
// Devuelve descriptor de referencia (solo admin/gth o el propio usuario)
router.get('/:employeeId/descriptor',
  authorize('admin', 'gth', 'hr', 'super_admin', 'manager', 'gestor'),
  asyncHandler(async (req, res) => {
    const [rows] = await sequelize.query(
      'SELECT face_descriptor, face_photo_url, face_enrolled_at FROM employees WHERE id = ?',
      { replacements: [req.params.employeeId] }
    );
    if (!rows.length) return res.status(404).json({ error: 'Empleado no encontrado' });
    const e = rows[0];
    res.json({
      ok: true,
      has_face: !!e.face_descriptor,
      face_photo_url: e.face_photo_url,
      face_enrolled_at: e.face_enrolled_at,
      face_descriptor: e.face_descriptor,  // array 128-d
    });
  })
);

// PUT /api/face/:employeeId/enroll
// Guarda descriptor facial + foto URL (el descriptor fue calculado por el browser)
router.put('/:employeeId/enroll',
  authorize('admin', 'gth', 'hr', 'super_admin'),
  asyncHandler(async (req, res) => {
    const { face_descriptor, face_photo_url } = req.body;
    if (!Array.isArray(face_descriptor) || face_descriptor.length !== 128) {
      return res.status(400).json({ error: 'face_descriptor debe ser un array de 128 floats' });
    }
    const [emp] = await sequelize.query(
      'SELECT id, full_name FROM employees WHERE id = ?',
      { replacements: [req.params.employeeId] }
    );
    if (!emp.length) return res.status(404).json({ error: 'Empleado no encontrado' });

    await sequelize.query(
      `UPDATE employees SET
         face_descriptor  = ?,
         face_photo_url   = ?,
         face_enrolled_at = NOW(),
         face_enrolled_by = ?
       WHERE id = ?`,
      { replacements: [JSON.stringify(face_descriptor), face_photo_url || null, req.user.id, req.params.employeeId] }
    );
    await audit.log({ req, user: req.user, action: 'face_enroll', entity: 'employee', entity_id: req.params.employeeId, details: { name: emp[0].full_name } });
    res.json({ ok: true, message: 'Descriptor facial guardado' });
  })
);

// POST /api/face/verify
// Compara descriptor enviado vs. el de referencia del empleado
// Body: { employee_id, descriptor: [128 floats], selfie_url?, attendance_log_id? }
router.post('/verify', asyncHandler(async (req, res) => {
  const { employee_id, descriptor, selfie_url, attendance_log_id } = req.body;
  if (!employee_id || !Array.isArray(descriptor) || descriptor.length !== 128) {
    return res.status(400).json({ error: 'employee_id y descriptor[128] son requeridos' });
  }
  const [rows] = await sequelize.query(
    'SELECT face_descriptor FROM employees WHERE id = ?',
    { replacements: [employee_id] }
  );
  if (!rows.length) return res.status(404).json({ error: 'Empleado no encontrado' });

  const ref = rows[0].face_descriptor;
  if (!ref) return res.status(422).json({ error: 'Empleado sin descriptor facial registrado', code: 'NO_FACE' });

  const refArr = typeof ref === 'string' ? JSON.parse(ref) : ref;
  const distance = euclidean(descriptor, refArr);
  const matched  = distance < 0.6;

  // Registrar en log
  await sequelize.query(
    `INSERT INTO face_verifications (employee_id, attendance_log_id, distance, matched, selfie_url, ip)
     VALUES (?, ?, ?, ?, ?, ?)`,
    { replacements: [employee_id, attendance_log_id || null, distance, matched ? 1 : 0, selfie_url || null, req.ip] }
  );

  res.json({ ok: true, matched, distance: Math.round(distance * 1000) / 1000 });
}));

// GET /api/face/verifications — historial (admin)
router.get('/verifications',
  authorize('admin', 'gth', 'super_admin'),
  asyncHandler(async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const empId  = req.query.employee_id;
    let where = 'WHERE 1=1';
    const params = [];
    if (empId) { where += ' AND fv.employee_id = ?'; params.push(empId); }

    const [rows] = await sequelize.query(`
      SELECT fv.*, CONCAT(e.first_name,' ',e.last_name) AS full_name, e.code
      FROM face_verifications fv
      JOIN employees e ON e.id = fv.employee_id
      ${where}
      ORDER BY fv.id DESC
      LIMIT ? OFFSET ?
    `, { replacements: [...params, limit, offset] });

    const [[{ total }]] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM face_verifications fv ${where}`,
      { replacements: params }
    );
    res.json({ ok: true, rows, total, limit, offset });
  })
);

// DELETE /api/face/:employeeId/enroll — borrar descriptor
router.delete('/:employeeId/enroll',
  authorize('admin', 'super_admin'),
  asyncHandler(async (req, res) => {
    await sequelize.query(
      'UPDATE employees SET face_descriptor=NULL, face_photo_url=NULL, face_enrolled_at=NULL WHERE id=?',
      { replacements: [req.params.employeeId] }
    );
    res.json({ ok: true });
  })
);

module.exports = router;
