/**
 * legal.js — Planillas legales de Paraguay.
 *
 *   GET /api/legal/planilla-mtess?year=&month=&dept=
 *       Planilla de Control de Asistencia (registro de entradas y salidas)
 *       en formato exigido por el Ministerio de Trabajo (MTESS): encabezado
 *       del empleador + por empleado la grilla diaria de entrada/salida + una
 *       columna de firma. PDF A4 apaisado, lista para imprimir/archivar.
 *
 *   GET /api/legal/ips-jornales?year=&month=&dept=&format=xlsx|json
 *       Resumen para la planilla de sueldos y jornales del IPS: por empleado
 *       C.I., N° IPS, días trabajados y horas del mes. Alimenta el cálculo de
 *       aportes patronales/obreros.
 *
 * Requiere permiso de ver reportes.
 */
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { authenticate, requirePermission } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { sequelize } = require('../config/database');

router.use(authenticate, requirePermission('reportes', 'view'));

const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Devuelve solo la hora HH:mm de un DATETIME de la BD (o '' si nulo).
function hhmm(v) {
  if (!v) return '';
  const s = String(v);
  // Formatos posibles: "YYYY-MM-DD HH:mm:ss" o ISO
  const m = s.match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

async function getEmployerData() {
  const [rows] = await sequelize.query(
    `SELECT setting_key, setting_value FROM notification_settings
     WHERE setting_key LIKE 'employer_%' OR setting_key IN ('system_company','system_name','system_signer_name','system_signer_position','system_signer_doc_id')`
  );
  return Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
}

// Trae el resumen diario (first_in/last_out/status/minutos) de un período,
// agrupado por empleado. Consulta sargable por rango.
async function getMonthlyGrid(year, month, dept) {
  const dateFrom = `${year}-${String(month).padStart(2, '0')}-01`;
  const dateTo = new Date(year, month, 0).toISOString().split('T')[0];
  const params = [dateFrom, dateTo];
  let deptFilter = '';
  if (dept) { deptFilter = 'AND e.department_id = ?'; params.push(dept); }

  const [rows] = await sequelize.query(`
    SELECT
      e.id, e.code, e.document_number, e.ips_number, e.position,
      CONCAT(e.last_name, ', ', e.first_name) AS employee_name,
      d.name AS department,
      ds.date, ds.status, ds.first_in, ds.last_out,
      ds.worked_minutes, ds.overtime_minutes
    FROM employees e
    LEFT JOIN departments d ON e.department_id = d.id
    LEFT JOIN daily_summary ds ON e.id = ds.employee_id
         AND ds.date BETWEEN ? AND ?
    WHERE e.status = 'active' ${deptFilter}
    ORDER BY d.name, e.last_name, e.first_name, ds.date
  `, { replacements: params });

  const byEmp = new Map();
  for (const r of rows) {
    if (!byEmp.has(r.id)) {
      byEmp.set(r.id, {
        id: r.id, code: r.code, ci: r.document_number || '', ips: r.ips_number || '',
        position: r.position || '', name: r.employee_name, department: r.department || '',
        days: {}, workedMin: 0, otMin: 0, presentDays: 0,
      });
    }
    if (r.date) {
      const day = new Date(r.date).getDate();
      const emp = byEmp.get(r.id);
      emp.days[day] = { in: hhmm(r.first_in), out: hhmm(r.last_out), status: r.status };
      emp.workedMin += r.worked_minutes || 0;
      emp.otMin += r.overtime_minutes || 0;
      if (r.status === 'present' || r.status === 'late') emp.presentDays++;
    }
  }
  return Array.from(byEmp.values());
}

// ─── Planilla MTESS (PDF) ────────────────────────────────────────
router.get('/planilla-mtess', asyncHandler(async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
  const dept = req.query.dept || null;
  const daysInMonth = new Date(year, month, 0).getDate();

  const [employer, employees] = await Promise.all([getEmployerData(), getMonthlyGrid(year, month, dept)]);

  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 24 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="planilla_asistencia_mtess_${year}_${String(month).padStart(2, '0')}.pdf"`);
  doc.pipe(res);

  const razon = employer.employer_razon_social || employer.system_company || employer.system_name || 'Empleador';
  const pageW = doc.page.width, left = doc.page.margins.left, right = doc.page.width - doc.page.margins.right;

  function header() {
    doc.fontSize(13).fillColor('#0f172a').font('Helvetica-Bold')
      .text('PLANILLA DE CONTROL DE ASISTENCIA', left, 24, { width: pageW - 48, align: 'center' });
    doc.fontSize(8).font('Helvetica').fillColor('#475569')
      .text('Registro de entradas y salidas del personal — Ministerio de Trabajo, Empleo y Seguridad Social (MTESS)', { width: pageW - 48, align: 'center' });
    doc.moveDown(0.4);
    const info = [
      `Empleador: ${razon}`,
      employer.employer_ruc ? `RUC: ${employer.employer_ruc}` : null,
      employer.employer_ips_patronal ? `Patronal IPS: ${employer.employer_ips_patronal}` : null,
      employer.employer_mtess_registro ? `Reg. MTESS: ${employer.employer_mtess_registro}` : null,
    ].filter(Boolean).join('     ');
    const info2 = [
      employer.employer_domicilio ? `Domicilio: ${employer.employer_domicilio}` : null,
      employer.employer_ciudad ? employer.employer_ciudad : null,
      `Período: ${MESES[month]} ${year}`,
      dept ? `Depto. filtrado` : 'Todos los departamentos',
    ].filter(Boolean).join('     ');
    doc.fontSize(8).fillColor('#334155').text(info, left, doc.y);
    doc.text(info2);
    doc.moveDown(0.3);
  }

  header();

  // Columnas de la grilla
  const nameW = 120, ciW = 58, totW = 42;
  const gridW = right - (left + nameW + ciW) - totW;
  const colW = gridW / daysInMonth;
  const rowH = 15;

  function drawTableHead(y) {
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#0f172a');
    doc.rect(left, y, right - left, rowH).fillAndStroke('#e2e8f0', '#94a3b8');
    doc.fillColor('#0f172a');
    doc.text('Apellido, Nombre  (C.I.)', left + 2, y + 4, { width: nameW + ciW - 2 });
    let x = left + nameW + ciW;
    for (let d = 1; d <= daysInMonth; d++) {
      doc.text(String(d), x, y + 4, { width: colW, align: 'center' });
      x += colW;
    }
    doc.text('Hs', x, y + 4, { width: totW, align: 'center' });
    return y + rowH;
  }

  let y = drawTableHead(doc.y + 2);

  for (const emp of employees) {
    if (y + rowH > doc.page.height - 90) {
      doc.addPage(); header(); y = drawTableHead(doc.y + 2);
    }
    // Fila del empleado (entrada arriba / salida abajo en cada día → 2 líneas)
    const cellH = rowH * 1.6;
    doc.rect(left, y, right - left, cellH).stroke('#cbd5e1');
    doc.font('Helvetica').fontSize(6.5).fillColor('#0f172a');
    doc.text(emp.name, left + 2, y + 2, { width: nameW - 2, ellipsis: true });
    doc.fontSize(6).fillColor('#64748b').text(`C.I. ${emp.ci || '—'}`, left + 2, y + cellH - 9, { width: nameW - 2 });
    doc.fontSize(6).fillColor('#334155').text(emp.ci || '', left + nameW, y + 2, { width: ciW, align: 'center' });

    let x = left + nameW + ciW;
    doc.fontSize(5.6);
    for (let d = 1; d <= daysInMonth; d++) {
      const cell = emp.days[d];
      // separador de columna
      doc.moveTo(x, y).lineTo(x, y + cellH).stroke('#e2e8f0');
      if (cell && (cell.in || cell.out)) {
        doc.fillColor('#0f766e').text(cell.in || '·', x, y + 2, { width: colW, align: 'center' });
        doc.fillColor('#b91c1c').text(cell.out || '·', x, y + cellH - 8, { width: colW, align: 'center' });
      } else if (cell && cell.status === 'absent') {
        doc.fillColor('#94a3b8').text('A', x, y + cellH / 2 - 3, { width: colW, align: 'center' });
      } else if (cell && (cell.status === 'holiday' || cell.status === 'weekend' || cell.status === 'permission')) {
        const mk = cell.status === 'permission' ? 'P' : (cell.status === 'holiday' ? 'F' : '—');
        doc.fillColor('#a78bfa').text(mk, x, y + cellH / 2 - 3, { width: colW, align: 'center' });
      }
      x += colW;
    }
    doc.moveTo(x, y).lineTo(x, y + cellH).stroke('#cbd5e1');
    const hs = Math.round(emp.workedMin / 60);
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#0f172a').text(String(hs), x, y + cellH / 2 - 4, { width: totW, align: 'center' });
    y += cellH;
  }

  // Leyenda + firma
  y += 8;
  doc.font('Helvetica').fontSize(6.5).fillColor('#64748b')
    .text('Referencias: fila superior = hora de ENTRADA, fila inferior = hora de SALIDA · A = ausente · P = permiso · F = feriado · — = franco/descanso · Hs = horas trabajadas del mes.', left, y, { width: right - left });

  const signer = employer.system_signer_name || employer.employer_representante || '';
  const signerPos = employer.system_signer_position || 'Representante legal';
  y = doc.page.height - 70;
  doc.moveTo(right - 240, y).lineTo(right - 40, y).stroke('#94a3b8');
  doc.fontSize(8).fillColor('#334155').text(signer, right - 240, y + 4, { width: 200, align: 'center' });
  doc.fontSize(7).fillColor('#64748b').text(signerPos, right - 240, y + 15, { width: 200, align: 'center' });

  doc.end();
}));

// ─── Resumen IPS — días y horas trabajadas ───────────────────────
router.get('/ips-jornales', asyncHandler(async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
  const dept = req.query.dept || null;
  const format = (req.query.format || 'json').toLowerCase();

  const [employer, employees] = await Promise.all([getEmployerData(), getMonthlyGrid(year, month, dept)]);
  const data = employees.map(e => ({
    code: e.code, name: e.name, ci: e.ci, ips: e.ips, position: e.position,
    dias_trabajados: e.presentDays,
    horas_trabajadas: Math.round(e.workedMin / 60),
    horas_extra: Math.round(e.otMin / 60),
  }));

  if (format === 'xlsx') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`IPS ${MESES[month]} ${year}`);
    ws.addRow([`Planilla IPS — Sueldos y Jornales · ${employer.employer_razon_social || employer.system_company || ''}`]);
    ws.addRow([`RUC: ${employer.employer_ruc || ''}   Patronal IPS: ${employer.employer_ips_patronal || ''}   Período: ${MESES[month]} ${year}`]);
    ws.addRow([]);
    ws.addRow(['Código', 'Apellido y Nombre', 'C.I.', 'N° IPS', 'Cargo', 'Días trabajados', 'Horas trabajadas', 'Horas extra']);
    ws.getRow(4).font = { bold: true };
    for (const d of data) ws.addRow([d.code, d.name, d.ci, d.ips, d.position, d.dias_trabajados, d.horas_trabajadas, d.horas_extra]);
    ws.columns.forEach(c => { c.width = 18; });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="planilla_ips_${year}_${String(month).padStart(2, '0')}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }

  res.json({
    employer: {
      razon_social: employer.employer_razon_social || employer.system_company || '',
      ruc: employer.employer_ruc || '', ips_patronal: employer.employer_ips_patronal || '',
    },
    period: { year, month, label: `${MESES[month]} ${year}` },
    total: data.length,
    data,
  });
}));

module.exports = router;
