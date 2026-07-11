/**
 * legalData.js — Datos maestros para planillas legales (MTESS / IPS).
 *
 *   GET  /api/legal-data/completeness?dept=
 *        Lista los empleados activos a los que les falta algún dato necesario
 *        para las planillas: C.I., N° IPS, salario base u horario asignado
 *        (el horario define qué días son laborables → ausencia vs franco).
 *
 *   GET  /api/legal-data/template
 *        Plantilla Excel para carga masiva de datos legales.
 *
 *   POST /api/legal-data/import   (multipart, campo "file"; ?dry_run=1)
 *        Carga masiva por código: C.I., N° IPS, salario base y tipo de pago.
 *        Sólo actualiza las celdas provistas (no pisa con vacío).
 */
const router = require('express').Router();
const multer = require('multer');
const ExcelJS = require('exceljs');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
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

// ─── Chequeo de completitud ──────────────────────────────────────
router.get('/completeness', requirePermission('reportes', 'view'), async (req, res, next) => {
  try {
    const params = [];
    let deptFilter = '';
    if (req.query.dept) { deptFilter = 'AND e.department_id = ?'; params.push(req.query.dept); }
    const [rows] = await sequelize.query(`
      SELECT e.id, e.code, CONCAT(e.last_name, ', ', e.first_name) AS name,
             e.document_number, e.ips_number, e.salary_base, e.pay_type, e.schedule_id,
             COALESCE(s.name,'') AS schedule_name, COALESCE(d.name,'') AS department
      FROM employees e
      LEFT JOIN schedules s   ON s.id = e.schedule_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.status = 'active' ${deptFilter}
      ORDER BY e.first_name, e.last_name
    `, { replacements: params });

    const incomplete = [];
    const counts = { sin_ci: 0, sin_ips: 0, sin_salario: 0, sin_horario: 0 };
    for (const r of rows) {
      const missing = [];
      if (!r.document_number)                 { missing.push('C.I.');      counts.sin_ci++; }
      if (!r.ips_number)                      { missing.push('N° IPS');    counts.sin_ips++; }
      if (r.salary_base == null || Number(r.salary_base) === 0) { missing.push('Salario base'); counts.sin_salario++; }
      if (!r.schedule_id)                     { missing.push('Horario');   counts.sin_horario++; }
      if (missing.length) {
        incomplete.push({
          id: r.id, code: r.code, name: r.name, department: r.department,
          pay_type: r.pay_type, missing,
        });
      }
    }

    res.json({ total: rows.length, complete: rows.length - incomplete.length, counts, incomplete });
  } catch (e) { next(e); }
});

// ─── Plantilla ───────────────────────────────────────────────────
router.get('/template', requirePermission('empleados', 'view'), async (_req, res, next) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Datos legales');
    ws.columns = [
      { header: 'codigo',       key: 'code',     width: 12 },
      { header: 'cedula',       key: 'ci',       width: 16 },
      { header: 'nro_ips',      key: 'ips',      width: 16 },
      { header: 'salario_base', key: 'salary',   width: 16 },
      { header: 'tipo_pago',    key: 'pay_type', width: 16 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
    ws.addRow({ code: 'E001', ci: '1234567', ips: '987654', salary: 2899048, pay_type: 'mensualizado' });
    ws.addRow({ code: 'E002', ci: '7654321', ips: '123456', salary: 90000, pay_type: 'jornalero' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_datos_legales.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

function normPayType(v) {
  const s = String(v || '').toLowerCase().trim();
  if (!s) return null;
  if (s.startsWith('jorn')) return 'jornalero';
  if (s.startsWith('mens')) return 'mensualizado';
  return null; // valor inválido → se reporta como error
}

function cellStr(cell) {
  let v = cell?.value;
  if (v && typeof v === 'object') {
    if (v.text) v = v.text;
    else if (v.result !== undefined) v = v.result;
    else if (Array.isArray(v.richText)) v = v.richText.map(t => t.text).join('');
  }
  return v == null ? '' : String(v).trim();
}

// ─── Import masivo ───────────────────────────────────────────────
router.post('/import', authorize('admin', 'hr', 'gth'), requirePermission('empleados', 'update'),
  upload.single('file'), async (req, res, next) => {
    if (!req.file) return res.status(400).json({ error: 'Archivo .xlsx requerido (campo "file")' });
    const dryRun = req.query.dry_run === '1' || req.body?.dry_run === '1';
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer);
      const ws = wb.worksheets[0];
      if (!ws) return res.status(400).json({ error: 'El archivo no tiene hojas' });

      const results = { updated: 0, notFound: [], errors: [], skipped: 0 };
      const ops = [];
      ws.eachRow((row, rn) => {
        if (rn === 1) return; // encabezado
        const code = cellStr(row.getCell(1));
        if (!code) return;
        const ci = cellStr(row.getCell(2));
        const ips = cellStr(row.getCell(3));
        const salaryRaw = cellStr(row.getCell(4)).replace(/\./g, '').replace(',', '.');
        const salary = salaryRaw === '' ? null : Number(salaryRaw);
        const payRaw = cellStr(row.getCell(5));
        const pay = payRaw ? normPayType(payRaw) : null;

        if (salaryRaw !== '' && !Number.isFinite(salary)) {
          results.errors.push({ row: rn, error: `Salario inválido: ${salaryRaw}` });
          return;
        }
        if (payRaw && !pay) {
          results.errors.push({ row: rn, error: `Tipo de pago inválido: ${payRaw} (use mensualizado | jornalero)` });
          return;
        }
        ops.push({ rn, code, ci, ips, salary, pay });
      });

      for (const op of ops) {
        const sets = [];
        const vals = [];
        if (op.ci)            { sets.push('document_number = ?'); vals.push(op.ci); }
        if (op.ips)           { sets.push('ips_number = ?');      vals.push(op.ips); }
        if (op.salary != null){ sets.push('salary_base = ?');     vals.push(op.salary); }
        if (op.pay)           { sets.push('pay_type = ?');        vals.push(op.pay); }
        if (!sets.length) { results.skipped++; continue; }

        const [chk] = await sequelize.query('SELECT id FROM employees WHERE code = ? LIMIT 1', { replacements: [op.code] });
        if (!chk.length) { results.notFound.push(op.code); continue; }
        if (!dryRun) {
          vals.push(op.code);
          await sequelize.query(`UPDATE employees SET ${sets.join(', ')} WHERE code = ?`, { replacements: vals });
        }
        results.updated++;
      }

      res.json({ dry_run: dryRun, ...results });
    } catch (e) { next(e); }
  });

module.exports = router;
