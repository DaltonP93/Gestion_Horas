/**
 * justificationsBulk.js — Justificaciones masivas desde Excel.
 *
 * Formato esperado (hoja 1):
 *   Columnas: codigo | fecha | tipo | justificacion
 *   - codigo:        código del empleado en el reloj (employees.code)
 *   - fecha:         YYYY-MM-DD
 *   - tipo:          permiso | vacaciones | enfermedad | otro
 *   - justificacion: texto libre
 */
const router = require('express').Router();
const multer = require('multer');
const ExcelJS = require('exceljs');
const { authenticate, authorize } = require('../middleware/auth');
const { sequelize } = require('../config/database');

router.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /spreadsheetml|excel|octet-stream/.test(file.mimetype) || /\.xlsx$/i.test(file.originalname);
    cb(ok ? null : new Error('Solo archivos .xlsx'), ok);
  },
});

// GET /api/justifications/template → plantilla Excel vacía
router.get('/template', async (_req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Justificaciones');
  ws.columns = [
    { header: 'codigo',        key: 'code',  width: 12 },
    { header: 'fecha',         key: 'date',  width: 14 },
    { header: 'tipo',          key: 'type',  width: 16 },
    { header: 'justificacion', key: 'just',  width: 50 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
  ws.addRow({ code: 'E001', date: '2026-04-21', type: 'permiso', just: 'Ejemplo — reemplazar por datos reales' });

  // Hoja de referencia: tipos válidos y cuáles descuentan días (MTESS).
  const ref = wb.addWorksheet('Tipos válidos');
  ref.columns = [
    { header: 'tipo', key: 't', width: 18 },
    { header: 'descuenta días (mensualizado)', key: 'd', width: 30 },
    { header: 'descripción', key: 'x', width: 40 },
  ];
  ref.getRow(1).font = { bold: true };
  [
    ['permiso', 'No', 'Permiso con goce de sueldo'],
    ['vacaciones', 'Sí', 'Vacaciones'],
    ['enfermedad', 'Sí', 'Enfermedad / reposo médico'],
    ['reposo', 'Sí', 'Reposo'],
    ['licencia_especial', 'Sí', 'Licencia especial'],
    ['sin_goce', 'Sí', 'Licencia sin goce de sueldo'],
    ['injustificada', 'Sí', 'Ausencia injustificada'],
    ['otro', 'No', 'Otro (no descuenta por defecto)'],
  ].forEach(r => ref.addRow({ t: r[0], d: r[1], x: r[2] }));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_justificaciones.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

// POST /api/justifications/bulk → dry_run opcional
router.post('/bulk', authorize('admin', 'hr', 'gth'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Archivo .xlsx requerido (campo "file")' });
  const dryRun = req.query.dry_run === '1' || req.body.dry_run === '1';
  // Tipos válidos. Los que descuentan días para mensualizados en la planilla
  // MTESS: vacaciones, enfermedad, reposo, licencia_especial, sin_goce,
  // injustificada. 'permiso' (con goce) y 'otro' NO descuentan por defecto.
  const validTypes = new Set([
    'permiso', 'vacaciones', 'enfermedad', 'reposo',
    'licencia_especial', 'sin_goce', 'injustificada', 'otro',
  ]);

  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: 'Archivo sin hojas' });

    const rows = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // header
      const code = String(row.getCell(1).value ?? '').trim();
      const dateVal = row.getCell(2).value;
      const type = String(row.getCell(3).value ?? '').toLowerCase().trim();
      const just = String(row.getCell(4).value ?? '').trim();

      let date = '';
      if (dateVal instanceof Date) {
        date = dateVal.toISOString().slice(0, 10);
      } else if (typeof dateVal === 'string') {
        date = dateVal.slice(0, 10);
      } else if (dateVal && typeof dateVal === 'object' && dateVal.text) {
        date = String(dateVal.text).slice(0, 10);
      }

      if (code && date) rows.push({ rowNumber, code, date, type, just });
    });

    const results = { total: rows.length, ok: 0, skipped: 0, errors: [] };

    for (const r of rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
        results.errors.push({ row: r.rowNumber, error: `Fecha inválida: ${r.date}` });
        continue;
      }
      if (!validTypes.has(r.type)) {
        results.errors.push({ row: r.rowNumber, error: `Tipo inválido: ${r.type}` });
        continue;
      }
      if (!r.just) {
        results.errors.push({ row: r.rowNumber, error: 'Justificación vacía' });
        continue;
      }

      const [[emp]] = await sequelize.query(
        'SELECT id FROM employees WHERE code = ? LIMIT 1',
        { replacements: [r.code] }
      );
      if (!emp) {
        results.errors.push({ row: r.rowNumber, error: `Empleado no encontrado: ${r.code}` });
        continue;
      }

      if (!dryRun) {
        // Una ausencia injustificada NO es un permiso: debe quedar como
        // 'absent' para que los reportes que suman status='absent' la sigan
        // contando; sólo se registra su justification_type para la planilla.
        // El resto (permiso, vacaciones, enfermedad…) sí pasa a 'permission'.
        const isAbsence = r.type === 'injustificada';
        const newStatus = isAbsence ? 'absent' : 'permission';
        const statusUpdate = isAbsence
          ? 'status = status'
          : "status = CASE WHEN status = 'absent' THEN 'permission' ELSE status END";
        await sequelize.query(`
          INSERT INTO daily_summary (employee_id, date, justification, justification_type, status)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            justification      = VALUES(justification),
            justification_type = VALUES(justification_type),
            ${statusUpdate}
        `, { replacements: [emp.id, r.date, r.just, r.type, newStatus] });
      }
      results.ok++;
    }

    results.skipped = results.errors.length;
    res.json({ dry_run: dryRun, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
