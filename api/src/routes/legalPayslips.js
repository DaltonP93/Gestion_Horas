/**
 * legalPayslips.js — Publicación manual de recibos de sueldo.
 *
 *   POST /api/legal/payslips/publish   { employee_id, year, month }
 *
 * Genera el recibo informativo (mismo motor `computeLiquidacion` vía
 * services/payslip.js) y lo GUARDA en el repositorio de documentos del
 * empleado (`employee_documents`, category 'payslip', visible_to_employee=1)
 * para que aparezca en "Mis documentos". Es una acción MANUAL de RR.HH.
 * (nunca un cron) y NO reemplaza la carga manual de PDFs existente.
 *
 * Restringido a admin/super_admin/hr/gth. Sólo lectura sobre asistencia;
 * la única escritura es en `employee_documents` (repositorio propio), nunca
 * en att2000, attendance_logs ni daily_summary.
 *
 * Se monta como router propio (antes que routes/legal.js) para no alterar el
 * flujo de las planillas legales certificadas.
 */

const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { sequelize } = require('../config/database');
const audit = require('../services/audit');
const { computePayslip, buildPayslipPdf } = require('../services/payslip');
const { defaultTitleFor } = require('../services/employeeDocuments');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'));
const DOC_DIR = path.join(UPLOAD_DIR, 'employee-documents');

// Genera el PDF del recibo en memoria (Buffer) a partir de los datos.
function renderPayslipBuffer(data) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    buildPayslipPdf(doc, data);
    doc.end();
  });
}

router.use(authenticate);

// ── POST /api/legal/payslips/publish ────────────────────────────────
router.post('/publish',
  authorize('admin', 'super_admin', 'hr', 'gth'),
  requirePermission('empleados', 'update'),
  asyncHandler(async (req, res) => {
    const employeeId = parseInt(req.body.employee_id, 10);
    const year = parseInt(req.body.year, 10);
    const month = parseInt(req.body.month, 10);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return res.status(400).json({ error: 'employee_id inválido' });
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2099) {
      return res.status(400).json({ error: 'year inválido' });
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: 'month inválido' });
    }

    const data = await computePayslip(sequelize, { employeeId, year, month });
    if (!data) return res.status(404).json({ error: 'Empleado no encontrado' });

    const buf = await renderPayslipBuffer(data);

    if (!fs.existsSync(DOC_DIR)) fs.mkdirSync(DOC_DIR, { recursive: true });
    const period = `${year}-${String(month).padStart(2, '0')}`;
    const base = crypto.randomBytes(8).toString('hex');
    const storedName = `payslip_${employeeId}_${period}_${base}.pdf`;
    const full = path.join(DOC_DIR, storedName);
    fs.writeFileSync(full, buf);
    const relPath = path.relative(UPLOAD_DIR, full);

    const filename = `recibo_sueldo_${period}.pdf`;
    const title = defaultTitleFor({ category: 'payslip', period, filename });

    const [r] = await sequelize.query(
      `INSERT INTO employee_documents
         (employee_id, category, period, title, filename, path, size_bytes,
          mime, uploaded_by, visible_to_employee, note)
       VALUES (?, 'payslip', ?, ?, ?, ?, ?, 'application/pdf', ?, 1, ?)`,
      { replacements: [
        employeeId, period, title, filename, relPath, buf.length,
        req.user.id, 'Recibo informativo generado automáticamente',
      ] }
    );

    audit.log({
      req, user: req.user, action: 'employee.payslip.publish',
      entity: 'employee', entity_id: employeeId,
      details: { document_id: r.insertId, period, size: buf.length },
    });

    res.status(201).json({
      id: r.insertId, employee_id: employeeId, period,
      category: 'payslip', title, size_bytes: buf.length,
    });
  })
);

module.exports = router;
