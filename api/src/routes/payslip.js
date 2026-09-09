/**
 * payslip.js — Recibo de sueldo individual (talón informativo en PDF).
 *
 *   GET /api/employees/:id/payslip/pdf?year=&month=
 *
 * CONTROL DE ACCESO (crítico — no filtrar sueldos de terceros):
 *   - Roles de RR.HH./gestión (admin, super_admin, hr, gth): pueden pedir el
 *     recibo de CUALQUIER empleado.
 *   - Un empleado común: SÓLO su propio recibo (su employee_id del token,
 *     con fallback a la BD igual que en routes/me.js). Cualquier otro caso
 *     devuelve 403 SIN revelar monto alguno.
 *
 * El cálculo reutiliza `computeLiquidacion` vía `services/payslip.js`. Es un
 * documento INFORMATIVO (ver disclaimer en el PDF); no constituye
 * liquidación legal certificada, no calcula IRP ni todos los descuentos.
 *
 * Sólo lectura: no escribe en att2000, attendance_logs ni daily_summary.
 */

const router = require('express').Router({ mergeParams: true });
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { sequelize } = require('../config/database');
const audit = require('../services/audit');
const { computePayslip, buildPayslipPdf } = require('../services/payslip');

const HR_ROLES = new Set(['admin', 'super_admin', 'hr', 'gth']);

router.use(authenticate);

// employee_id del usuario actual (fallback a BD si el JWT es viejo).
async function getEmployeeId(req) {
  if (req.user.employee_id) return req.user.employee_id;
  const [[row]] = await sequelize.query(
    'SELECT employee_id FROM users WHERE id = ? LIMIT 1',
    { replacements: [req.user.id] }
  );
  return row?.employee_id || null;
}

// Resuelve si el solicitante puede ver el recibo del empleado `targetId`.
// Devuelve true/false. Los roles de RR.HH. ven cualquiera; el resto sólo el
// suyo. Exportado para test unitario del control de acceso.
async function canAccessPayslip(req, targetId) {
  if (HR_ROLES.has(req.user.role)) return true;
  const own = await getEmployeeId(req);
  return own != null && Number(own) === Number(targetId);
}

// ── GET /api/employees/:id/payslip/pdf ──────────────────────────────
router.get('/pdf', asyncHandler(async (req, res) => {
  const employeeId = parseInt(req.params.id, 10);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    return res.status(400).json({ error: 'Empleado inválido' });
  }

  // Control de acceso ANTES de tocar montos: un empleado ajeno nunca ve nada.
  if (!(await canAccessPayslip(req, employeeId))) {
    return res.status(403).json({ error: 'No autorizado a ver este recibo' });
  }

  const now = new Date();
  const year = parseInt(req.query.year, 10) || now.getFullYear();
  const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);
  if (month < 1 || month > 12) return res.status(400).json({ error: 'Mes inválido' });

  const data = await computePayslip(sequelize, { employeeId, year, month });
  if (!data) return res.status(404).json({ error: 'Empleado no encontrado' });

  audit.log({
    req, user: req.user, action: 'employee.payslip.pdf',
    entity: 'employee', entity_id: employeeId, details: { year, month },
  });

  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="recibo_sueldo_${employeeId}_${year}_${String(month).padStart(2, '0')}.pdf"`);
  doc.pipe(res);
  buildPayslipPdf(doc, data);
  doc.end();
}));

module.exports = router;
module.exports.canAccessPayslip = canAccessPayslip;
module.exports.getEmployeeId = getEmployeeId;
