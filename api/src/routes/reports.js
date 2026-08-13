const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { sequelize } = require('../config/database');
const { dbTimeHHmm } = require('../utils/dbTime');
const { generateMarcadasReport, buildMarcadasTableHtml, minsToHM, maxPairsOf } = require('../services/scheduler');
const { sendMail, buildReportEmailHtml } = require('../services/emailService');
const {
  getVisibleDepartmentIds,
  applyDepartmentScope,
  canSeeEmployee,
} = require('../services/departmentScope');

router.use(authenticate);

// Helpers para inyectar scope de departamento en reports que arman su propio SQL.
// - Cuando el scope es unrestricted → no-op.
// - Cuando es scoped sin depto vinculado → fuerza 0 filas (mismo criterio que
//   applyDepartmentScope, para no filtrar datos de otros supervisores).
function scopeToClause(scope, col = 'e.department_id') {
  if (!scope || scope.unrestricted) return { clause: '', params: [], empty: false };
  const ids = scope.ids || [];
  if (!ids.length) return { clause: 'AND 1=0', params: [], empty: true };
  return {
    clause: `AND ${col} IN (${ids.map(() => '?').join(',')})`,
    params: ids,
    empty: false,
  };
}

// GET /api/reports/monthly?year=&month=&dept=
router.get('/monthly', asyncHandler(async (req, res) => {
  const { year = new Date().getFullYear(), month = new Date().getMonth() + 1, dept } = req.query;
  const dateFrom = `${year}-${String(month).padStart(2,'0')}-01`;
  const dateTo   = new Date(year, month, 0).toISOString().split('T')[0];

  let deptFilter = '';
  const params = [dateFrom, dateTo];
  if (dept) { deptFilter = 'AND e.department_id = ?'; params.push(dept); }

  // RBAC jerárquico: acota por departamento del usuario scoped.
  const scope = await getVisibleDepartmentIds(req.user);
  const sc = scopeToClause(scope, 'e.department_id');
  deptFilter += ` ${sc.clause}`;
  params.push(...sc.params);

  const [rows] = await sequelize.query(`
    SELECT
      e.id, e.code, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
      d.name AS department,
      COUNT(CASE WHEN ds.status IN ('present','late') THEN 1 END)  AS days_present,
      COUNT(CASE WHEN ds.status = 'late'              THEN 1 END)  AS days_late,
      COUNT(CASE WHEN ds.status = 'absent'            THEN 1 END)  AS days_absent,
      SUM(ds.worked_minutes)                                        AS total_worked_minutes,
      SUM(ds.late_minutes)                                          AS total_late_minutes,
      SUM(ds.overtime_minutes)                                      AS total_overtime_minutes
    FROM employees e
    LEFT JOIN daily_summary ds ON e.id = ds.employee_id AND ds.date BETWEEN ? AND ?
    LEFT JOIN departments   d  ON e.department_id = d.id
    WHERE e.status = 'active' ${deptFilter}
    GROUP BY e.id
    ORDER BY d.name, e.last_name
  `, { replacements: params });

  res.json({ data: rows, period: { year, month, from: dateFrom, to: dateTo } });
}));

// GET /api/reports/weekly?week=&year=
router.get('/weekly', asyncHandler(async (req, res) => {
  const now = new Date();
  const { year = now.getFullYear(), week } = req.query;

  // Calcular inicio y fin de la semana
  const jan1 = new Date(year, 0, 1);
  const weekNum = week || Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  const from = new Date(jan1.getTime() + (weekNum - 1) * 7 * 86400000);
  const to   = new Date(from.getTime() + 6 * 86400000);

  // RBAC jerárquico: acota por departamento del usuario scoped.
  const scope = await getVisibleDepartmentIds(req.user);
  const sc = scopeToClause(scope, 'e.department_id');

  const [rows] = await sequelize.query(`
    SELECT
      ds.date, ds.status, ds.first_in, ds.last_out, ds.worked_minutes, ds.late_minutes,
      CONCAT(e.first_name,' ',e.last_name) AS employee_name, d.name AS department
    FROM daily_summary ds
    JOIN employees e ON ds.employee_id = e.id
    LEFT JOIN departments d ON e.department_id = d.id
    WHERE ds.date BETWEEN ? AND ? ${sc.clause}
    ORDER BY ds.date, e.last_name
  `, { replacements: [from.toISOString().split('T')[0], to.toISOString().split('T')[0], ...sc.params] });

  res.json({ data: rows, week: weekNum, from, to });
}));

// ─── GET /api/reports/marcadas ─────────────────────────────────────
// Reporte detallado por empleado: múltiples entradas/salidas por día
// igual al "Reporte Marcadas por Empleado" del sistema ZKTeco original
router.get('/marcadas', async (req, res) => {
  const { from, to, employeeId, deptId } = req.query;
  try {
    const scope = await getVisibleDepartmentIds(req.user);
    const result = await generateMarcadasReport({ dateFrom: from, dateTo: to, employeeId, deptId, scope });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/reports/daily-detail?date= ─────────────────────────
// Reporte del día con todos los logs crudos por empleado
router.get('/daily-detail', async (req, res) => {
  const { date = new Date().toISOString().split('T')[0], dept } = req.query;
  let filter = '';
  const params = [date];
  if (dept) { filter = 'AND e.department_id = ?'; params.push(dept); }

  // RBAC jerárquico: acota por departamento del usuario scoped.
  const scope = await getVisibleDepartmentIds(req.user);
  const sc = scopeToClause(scope, 'e.department_id');
  filter += ` ${sc.clause}`;
  params.push(...sc.params);

  const [rows] = await sequelize.query(`
    SELECT
      e.id AS employee_id, e.code,
      CONCAT(e.first_name,' ',e.last_name) AS employee_name,
      d.name AS department, s.name AS schedule,
      s.check_in AS scheduled_in, s.check_out AS scheduled_out,
      ds.first_in, ds.last_out, ds.worked_minutes, ds.late_minutes,
      ds.overtime_minutes, ds.status, ds.justification, ds.justification_type,
      GROUP_CONCAT(
        CONCAT(DATE_FORMAT(al.timestamp,'%H:%i'), '=', al.type)
        ORDER BY al.timestamp SEPARATOR '|'
      ) AS marks_raw
    FROM employees e
    LEFT JOIN departments d ON e.department_id = d.id
    LEFT JOIN schedules s ON e.schedule_id = s.id
    LEFT JOIN daily_summary ds ON e.id = ds.employee_id AND ds.date = ?
    LEFT JOIN attendance_logs al ON e.id = al.employee_id AND DATE(al.timestamp) = ?
    WHERE e.status = 'active' ${filter}
    GROUP BY e.id
    ORDER BY d.name, e.last_name
  `, { replacements: [date, date, ...params.slice(1)] });

  // Parsear marks_raw a array
  const data = rows.map(r => ({
    ...r,
    marks: r.marks_raw ? r.marks_raw.split('|').map(m => {
      const [time, type] = m.split('=');
      return { time, type };
    }) : [],
    marks_raw: undefined,
  }));

  res.json({ date, data });
});

// ─── GET /api/reports/marcadas/pdf ────────────────────────────────
// PDF imprimible: una página por empleado con las marcadas pareadas y total.
router.get('/marcadas/pdf', async (req, res) => {
  const { from, to, employeeId, deptId } = req.query;
  try {
    const scope = await getVisibleDepartmentIds(req.user);
    const report = await generateMarcadasReport({ dateFrom: from, dateTo: to, employeeId, deptId, scope });
    const PDFDocument = require('pdfkit');

    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const fname = employeeId
      ? `marcadas_${employeeId}_${from}_${to}.pdf`
      : `marcadas_${from}_${to}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    doc.pipe(res);

    const employees = report.data || [];
    if (!employees.length) {
      doc.fontSize(14).fillColor('#1e40af').text('Reporte de Marcadas', { align: 'center' });
      doc.moveDown();
      doc.fontSize(11).fillColor('#64748b').text(`Período: ${from} al ${to}`, { align: 'center' });
      doc.moveDown(2);
      doc.fontSize(10).fillColor('#000').text('Sin registros en el período seleccionado.', { align: 'center' });
      doc.end();
      return;
    }

    // Sin spread: este array tiene un elemento por empleado × día, y el
    // `Math.max(...)` que había acá desbordaba el stack en rangos grandes.
    const maxPairs = employees.reduce((max, e) => Math.max(max, maxPairsOf(e.rows)), 1);

    employees.forEach((emp, idx) => {
      if (idx > 0) doc.addPage();

      // Encabezado
      doc.fontSize(16).fillColor('#1e40af').text('Reporte de Marcadas por Empleado', { align: 'center' });
      doc.moveDown(0.2);
      doc.fontSize(10).fillColor('#64748b').text(`Período: ${from} al ${to}`, { align: 'center' });
      doc.moveDown(1);

      // Datos del empleado
      doc.fontSize(12).fillColor('#000')
        .text(emp.employee_name, { continued: true })
        .fillColor('#64748b').fontSize(10).text(`   Cód. ${emp.code}${emp.department ? ' · ' + emp.department : ''}`);
      doc.moveDown(0.7);

      // Tabla
      const colDate   = 110;
      const colPair   = 55;  // ancho por columna entrada/salida
      const colTotal  = 60;
      const tableW    = colDate + colPair * 2 * maxPairs + colTotal;
      const startX    = doc.page.margins.left;
      let y           = doc.y;

      // Headers
      doc.fontSize(8).fillColor('#fff');
      doc.rect(startX, y, tableW, 18).fill('#1e40af');
      doc.fillColor('#fff');
      doc.text('Fecha', startX + 4, y + 5, { width: colDate - 4 });
      for (let i = 0; i < maxPairs; i++) {
        const xE = startX + colDate + (i * 2) * colPair;
        const xS = xE + colPair;
        doc.text('Entrada', xE, y + 5, { width: colPair, align: 'center' });
        doc.text('Salida',  xS, y + 5, { width: colPair, align: 'center' });
      }
      doc.text('Total', startX + tableW - colTotal, y + 5, { width: colTotal - 4, align: 'right' });
      y += 18;

      // Filas
      doc.fontSize(9);
      emp.rows.forEach((row, ri) => {
        if (y > doc.page.height - 80) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        if (ri % 2 === 0) {
          doc.rect(startX, y, tableW, 16).fill('#f8fafc');
        }
        doc.fillColor('#0f172a')
          .text(`${row.dayName} ${row.date}`, startX + 4, y + 4, { width: colDate - 4 });
        for (let i = 0; i < maxPairs; i++) {
          const p  = row.pairs[i] || { entrada: '', salida: '' };
          const xE = startX + colDate + (i * 2) * colPair;
          const xS = xE + colPair;
          doc.fillColor('#334155').font('Courier')
            .text(p.entrada, xE, y + 4, { width: colPair, align: 'center' })
            .text(p.salida,  xS, y + 4, { width: colPair, align: 'center' })
            .font('Helvetica');
        }
        doc.fillColor(row.total === '0:00' ? '#dc2626' : '#1e40af')
          .font('Courier-Bold')
          .text(row.total, startX + tableW - colTotal, y + 4, { width: colTotal - 4, align: 'right' })
          .font('Helvetica');
        y += 16;
      });

      // Total
      doc.rect(startX, y, tableW, 22).fill('#eff6ff');
      doc.fillColor('#1e40af').fontSize(11).font('Helvetica-Bold')
        .text('Total período', startX + 4, y + 6, { width: tableW - colTotal - 8 });
      doc.font('Courier-Bold').fontSize(13)
        .text(emp.total_hm, startX + tableW - colTotal, y + 5, { width: colTotal - 4, align: 'right' });
      doc.font('Helvetica');
    });

    doc.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/reports/marcadas/email ─────────────────────────────
// Generar y enviar reporte por email inmediatamente
router.post('/marcadas/email', async (req, res) => {
  const { from, to, employeeId, deptId, recipients } = req.body;
  if (!recipients || !recipients.length) {
    return res.status(400).json({ error: 'recipients requerido' });
  }

  try {
    const scope = await getVisibleDepartmentIds(req.user);
    const report = await generateMarcadasReport({ dateFrom: from, dateTo: to, employeeId, deptId, scope });

    const tableHtmlParts = report.data.map(emp => `
      <h3 style="margin-top:20px">${emp.employee_name} [${emp.code}]${emp.department ? ' — ' + emp.department : ''}</h3>
      ${buildMarcadasTableHtml(emp)}
      <p style="text-align:right;font-weight:bold;color:#1e40af">Total período: ${emp.total_hm}</p>
    `).join('<hr>');

    const html = buildReportEmailHtml({
      title: 'Reporte de Marcadas por Empleado',
      period: `${from || 'Hoy'} al ${to || 'Hoy'}`,
      tableHtml: tableHtmlParts || '<p>Sin registros en este período</p>',
    });

    const result = await sendMail({
      to: recipients,
      subject: `Reporte de Marcadas — ${from} al ${to}`,
      html,
    });

    res.json({ ...result, employees: report.data.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/reports/attendance/justify ─────────────────────────
// Justificar una ausencia / tardanza
router.post('/attendance/justify', async (req, res) => {
  const { employeeId, date, justification, justificationType } = req.body;
  if (!employeeId || !date || !justification) {
    return res.status(400).json({ error: 'employeeId, date y justification son requeridos' });
  }
  await sequelize.query(`
    INSERT INTO daily_summary (employee_id, date, justification, justification_type, status)
    VALUES (?, ?, ?, ?, 'permission')
    ON DUPLICATE KEY UPDATE
      justification      = VALUES(justification),
      justification_type = VALUES(justification_type),
      status = CASE
        WHEN status = 'absent' THEN 'permission'
        ELSE status
      END
  `, { replacements: [employeeId, date, justification, justificationType || 'other'] });

  res.json({ message: 'Justificación registrada' });
});

// ─── GET /api/reports/employee/:id/analytics ──────────────────────
// Datos de analytics profundos por empleado: tendencias, comparativas, heatmap
router.get('/employee/:id/analytics', async (req, res) => {
  const { months = 3 } = req.query;
  const empId = req.params.id;
  const dateFrom = new Date();
  dateFrom.setMonth(dateFrom.getMonth() - +months);
  const from = dateFrom.toISOString().split('T')[0];
  const to   = new Date().toISOString().split('T')[0];

  try {
    // RBAC jerárquico: 403 si el rol scoped no incluye este empleado.
    const [[empRow]] = await sequelize.query(
      'SELECT department_id FROM employees WHERE id = ? LIMIT 1',
      { replacements: [empId] }
    );
    if (!empRow) return res.status(404).json({ error: 'Empleado no encontrado' });
    const scope = await getVisibleDepartmentIds(req.user);
    if (!canSeeEmployee(scope, empRow)) {
      return res.status(403).json({ error: 'Sin acceso a este empleado (fuera de tu ámbito)' });
    }

    // Datos diarios
    const [daily] = await sequelize.query(`
      SELECT
        ds.date, ds.status, ds.worked_minutes, ds.late_minutes,
        ds.overtime_minutes, ds.first_in, ds.last_out,
        ds.justification, ds.justification_type
      FROM daily_summary ds
      WHERE ds.employee_id = ? AND ds.date BETWEEN ? AND ?
      ORDER BY ds.date
    `, { replacements: [empId, from, to] });

    // Resumen del período
    const present = daily.filter(d => ['present','late'].includes(d.status)).length;
    const late    = daily.filter(d => d.status === 'late').length;
    const absent  = daily.filter(d => d.status === 'absent').length;
    const totalWorked = daily.reduce((a, d) => a + (d.worked_minutes || 0), 0);
    const totalLate   = daily.reduce((a, d) => a + (d.late_minutes   || 0), 0);

    // Promedio de hora de entrada (solo días con registro)
    const entries = daily.filter(d => d.first_in).map(d => {
      const t = new Date(d.first_in);
      return t.getHours() * 60 + t.getMinutes();
    });
    const avgEntryMinutes = entries.length ? Math.round(entries.reduce((a,b) => a+b, 0) / entries.length) : null;

    // Tendencia por semana (agrupar)
    const weeklyMap = {};
    for (const d of daily) {
      const dt  = new Date(d.date + 'T12:00');
      const mon = new Date(dt);
      mon.setDate(dt.getDate() - dt.getDay() + 1);
      const wk = mon.toISOString().split('T')[0];
      if (!weeklyMap[wk]) weeklyMap[wk] = { week: wk, worked: 0, late: 0, present: 0 };
      weeklyMap[wk].worked  += d.worked_minutes || 0;
      weeklyMap[wk].late    += d.late_minutes   || 0;
      if (['present','late'].includes(d.status)) weeklyMap[wk].present++;
    }
    const weekly = Object.values(weeklyMap).map(w => ({
      ...w,
      worked_hm: minsToHM(w.worked),
    }));

    // Conteo por día de semana
    const dayOfWeek = [0,0,0,0,0,0,0];
    const dayNames  = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
    for (const d of daily) {
      if (['present','late'].includes(d.status)) {
        dayOfWeek[new Date(d.date + 'T12:00').getDay()]++;
      }
    }
    const byDow = dayNames.map((name, i) => ({ name, present: dayOfWeek[i] }));

    res.json({
      period: { from, to, months: +months },
      summary: {
        present, late, absent,
        total_worked: minsToHM(totalWorked),
        total_late_minutes: totalLate,
        avg_entry: avgEntryMinutes ? `${Math.floor(avgEntryMinutes/60)}:${String(avgEntryMinutes%60).padStart(2,'0')}` : null,
        attendance_rate: daily.length ? Math.round(present / daily.length * 100) : 0,
      },
      weekly,
      byDayOfWeek: byDow,
      daily,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/reports/monthly/export?format=xlsx|pdf&year=&month=&dept= ──
// Exportación mensual imprimible (planilla por empleado)
router.get('/monthly/export', async (req, res) => {
  const {
    year = new Date().getFullYear(),
    month = new Date().getMonth() + 1,
    dept,
    format = 'xlsx',
  } = req.query;

  const dateFrom = `${year}-${String(month).padStart(2,'0')}-01`;
  const dateTo   = new Date(year, month, 0).toISOString().split('T')[0];
  const daysInMonth = new Date(year, month, 0).getDate();

  let deptFilter = '';
  const params = [dateFrom, dateTo];
  if (dept) { deptFilter = 'AND e.department_id = ?'; params.push(dept); }

  // RBAC jerárquico: acota por departamento del usuario scoped.
  const scope = await getVisibleDepartmentIds(req.user);
  const sc = scopeToClause(scope, 'e.department_id');
  deptFilter += ` ${sc.clause}`;
  params.push(...sc.params);

  try {
    const [rows] = await sequelize.query(`
      SELECT
        e.id, e.code, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
        d.name AS department,
        ds.date, ds.status, ds.first_in, ds.last_out,
        ds.worked_minutes, ds.late_minutes, ds.overtime_minutes,
        ds.justification
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN daily_summary ds ON e.id = ds.employee_id AND ds.date BETWEEN ? AND ?
      WHERE e.status = 'active' ${deptFilter}
      ORDER BY d.name, e.last_name, ds.date
    `, { replacements: params });

    // Agrupar por empleado
    const byEmp = new Map();
    for (const r of rows) {
      if (!byEmp.has(r.id)) {
        byEmp.set(r.id, {
          id: r.id, code: r.code, name: r.employee_name,
          department: r.department, days: {},
          totals: { worked: 0, late: 0, overtime: 0, present: 0, absent: 0, latedays: 0 },
        });
      }
      if (r.date) {
        const dayKey = String(new Date(r.date).getDate());
        byEmp.get(r.id).days[dayKey] = r;
        const t = byEmp.get(r.id).totals;
        t.worked   += r.worked_minutes   || 0;
        t.late     += r.late_minutes     || 0;
        t.overtime += r.overtime_minutes || 0;
        if (['present','late'].includes(r.status)) t.present++;
        if (r.status === 'late')    t.latedays++;
        if (r.status === 'absent')  t.absent++;
      }
    }

    const employees = Array.from(byEmp.values());
    const period = `${String(month).padStart(2,'0')}/${year}`;

    // Cargar settings de firma para los PDFs
    const [sigRows] = await sequelize.query(
      "SELECT setting_key, setting_value FROM notification_settings WHERE setting_key IN ('system_signature_url','system_seal_url','system_signer_name','system_signer_position','system_signer_doc_id')"
    );
    const sig = Object.fromEntries(sigRows.map(r => [r.setting_key, r.setting_value]));

    if (format === 'pdf') {
      const PDFDocument = require('pdfkit');
      const path = require('path');
      const fs = require('fs');
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="planilla_${year}_${String(month).padStart(2,'0')}.pdf"`);
      doc.pipe(res);

      // Helper para resolver path local de archivo subido (/uploads/xxx.png)
      const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'));
      function resolveUpload(url) {
        if (!url) return null;
        if (!url.startsWith('/uploads/')) return null;
        const filename = url.replace('/uploads/', '');
        const fp = path.join(UPLOAD_DIR, filename);
        return fs.existsSync(fp) ? fp : null;
      }
      const signaturePath = resolveUpload(sig.system_signature_url);
      const sealPath      = resolveUpload(sig.system_seal_url);

      function drawSignatureBlock(yPos) {
        const pageW = doc.page.width;
        const blockY = Math.min(yPos, doc.page.height - 130);
        const xLeft  = pageW / 2 - 200;
        const xRight = pageW / 2 + 200;

        // Linea de firma
        doc.moveTo(xLeft + 30, blockY + 60).lineTo(xLeft + 230, blockY + 60).stroke('#94a3b8');
        if (signaturePath) {
          try { doc.image(signaturePath, xLeft + 50, blockY, { width: 160, height: 60 }); } catch {}
        }
        // Los tres campos del firmante son texto libre sin límite de longitud
        // en la configuración. Si envolvieran a varias líneas con el bloque
        // anclado al pie, pdfkit paginaría solo y volvería a aparecer la hoja
        // extra que este cambio elimina.
        //
        // Lo que acota la caja es `height`: medido, `lineBreak: false` por sí
        // solo NO evita la paginación —pdfkit igual desborda hacia abajo—.
        // Con `height` + `ellipsis` el texto se recorta con puntos suspensivos
        // antes que romper el documento.
        const unaLinea = { width: 200, align: 'center', height: 11, ellipsis: true };
        doc.fontSize(9).fillColor('#475569');
        doc.text(sig.system_signer_name || '', xLeft + 30, blockY + 65, unaLinea);
        doc.fontSize(8).fillColor('#94a3b8');
        doc.text(sig.system_signer_position || '', xLeft + 30, blockY + 78, unaLinea);
        if (sig.system_signer_doc_id) {
          doc.text(sig.system_signer_doc_id, xLeft + 30, blockY + 90, unaLinea);
        }

        // Sello a la derecha
        if (sealPath) {
          try { doc.image(sealPath, xRight - 90, blockY - 5, { width: 100, height: 100, fit: [100, 100] }); } catch {}
        }
      }
      // exponer en closure para uso al final
      doc._drawSignatureBlock = drawSignatureBlock;

      // ─── Layout de la planilla mensual ──────────────────────────
      //
      // Objetivo: un empleado = una hoja A4 apaisada.
      //
      // La versión anterior apilaba los 31 días en una sola columna, lo que
      // consumía ~370 pt de alto y dejaba la firma sin lugar: la condición
      // `sigY < height - 130` no se cumplía NUNCA con un mes completo, así
      // que cada planilla terminaba con una segunda página que sólo llevaba
      // la firma. Al mismo tiempo usaba 375 pt de los ~780 disponibles a lo
      // ancho: el apaisado estaba desaprovechado.
      //
      // Acá los días se reparten en DOS tablas lado a lado, que es la forma
      // natural de usar una hoja apaisada. Con eso el alto de la grilla baja
      // a la mitad y entran cómodamente encabezado, totales, firma y pie.
      const COLS = [
        { label: 'Día',     w: 28, align: 'left'   },
        { label: 'Estado',  w: 62, align: 'left'   },
        { label: 'Entrada', w: 50, align: 'center' },
        { label: 'Salida',  w: 50, align: 'center' },
        { label: 'Trab.',   w: 52, align: 'right'  },
        { label: 'Atraso',  w: 48, align: 'right'  },
        { label: 'Extra',   w: 48, align: 'right'  },
      ];
      const TABLE_W  = COLS.reduce((a, c) => a + c.w, 0);
      const GAP      = 30;
      const MARGIN   = doc.page.margins.left;
      const PAGE_W   = doc.page.width;
      const PAGE_H   = doc.page.height;
      const GRID_X   = (PAGE_W - (TABLE_W * 2 + GAP)) / 2;   // centrado
      // El pie tiene que quedar DENTRO del área de contenido: pdfkit pagina
      // solo, y un `text()` por debajo del margen inferior agrega una página
      // en blanco. Es lo que hacía aparecer una segunda hoja por empleado.
      const FOOTER_Y = PAGE_H - doc.page.margins.bottom - 10;

      // Etiquetas legibles: la planilla es un documento impreso, no un dump.
      const ESTADO = {
        present: 'Presente', late: 'Tarde', absent: 'Ausente',
        permission: 'Permiso', holiday: 'Feriado', weekend: 'Fin de sem.',
      };

      /** Dibuja una de las dos tablas de días. Devuelve el `y` final. */
      function drawDayTable(emp, x, yTop, desde, hasta, rowH) {
        let y = yTop;

        doc.rect(x, y, TABLE_W, 15).fill('#1e40af');
        doc.fontSize(7.5).fillColor('#fff').font('Helvetica-Bold');
        let cx = x;
        for (const c of COLS) {
          doc.text(c.label, cx + 3, y + 4.5, { width: c.w - 6, align: c.align });
          cx += c.w;
        }
        y += 15;

        doc.font('Helvetica').fontSize(7.5);
        for (let d = desde; d <= hasta; d++) {
          const rec = emp.days[d] || {};
          if ((d - desde) % 2 === 0) doc.rect(x, y, TABLE_W, rowH).fill('#f8fafc');

          const valores = [
            String(d).padStart(2, '0'),
            ESTADO[rec.status] || (rec.status ? String(rec.status) : '—'),
            dbTimeHHmm(rec.first_in),
            dbTimeHHmm(rec.last_out),
            minsToHM(rec.worked_minutes || 0),
            rec.late_minutes ? String(rec.late_minutes) : '',
            rec.overtime_minutes ? minsToHM(rec.overtime_minutes) : '',
          ];

          // El atraso en rojo: es el dato que se busca de un vistazo.
          cx = x;
          valores.forEach((v, i) => {
            doc.fillColor(i === 5 && rec.late_minutes ? '#dc2626' : '#0f172a');
            doc.text(String(v), cx + 3, y + (rowH - 7.5) / 2 + 0.5, {
              width: COLS[i].w - 6, align: COLS[i].align, lineBreak: false,
            });
            cx += COLS[i].w;
          });
          y += rowH;
        }

        doc.rect(x, yTop + 15, TABLE_W, y - yTop - 15).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
        return y;
      }

      for (let ei = 0; ei < employees.length; ei++) {
        const emp = employees[ei];
        if (ei > 0) doc.addPage();

        // ── Encabezado ──
        let y = MARGIN;
        doc.fontSize(15).fillColor('#1e40af').font('Helvetica-Bold')
          .text('Planilla Mensual de Asistencia', MARGIN, y, { width: PAGE_W - MARGIN * 2, align: 'center' });
        y += 19;
        doc.fontSize(9.5).fillColor('#64748b').font('Helvetica')
          .text(`Período ${period}`, MARGIN, y, { width: PAGE_W - MARGIN * 2, align: 'center' });
        y += 17;

        doc.rect(GRID_X, y, TABLE_W * 2 + GAP, 24).fill('#f1f5f9');
        doc.fontSize(10).fillColor('#0f172a').font('Helvetica-Bold')
          .text(`${emp.name}`, GRID_X + 8, y + 7, { width: TABLE_W, lineBreak: false });
        doc.fontSize(8.5).fillColor('#475569').font('Helvetica')
          .text(`Cód. ${emp.code}${emp.department ? '   ·   ' + emp.department : ''}`,
            GRID_X + TABLE_W, y + 8, { width: TABLE_W + GAP - 8, align: 'right', lineBreak: false });
        y += 33;

        // ── Grilla de días, en dos columnas ──
        const mitad  = Math.ceil(daysInMonth / 2);
        // Alto disponible hasta donde arranca el bloque de totales+firma.
        // Se ajusta la altura de fila para que SIEMPRE entre en la página:
        // así el salto de página deja de depender del largo del mes.
        const dispo  = (FOOTER_Y - 150) - (y + 15);
        const rowH   = Math.min(12.5, Math.max(8, dispo / mitad));

        const yFin = Math.max(
          drawDayTable(emp, GRID_X, y, 1, mitad, rowH),
          drawDayTable(emp, GRID_X + TABLE_W + GAP, y, mitad + 1, daysInMonth, rowH),
        );
        y = yFin + 14;

        // ── Totales ──
        const totalW = TABLE_W * 2 + GAP;
        doc.rect(GRID_X, y, totalW, 30).fill('#eff6ff');
        const celdas = [
          ['Trabajado', minsToHM(emp.totals.worked)],
          ['Atrasos',   `${emp.totals.late} min`],
          ['Extras',    minsToHM(emp.totals.overtime)],
          ['Presentes', String(emp.totals.present)],
          ['Ausentes',  String(emp.totals.absent)],
        ];
        const celdaW = totalW / celdas.length;
        celdas.forEach(([etiqueta, valor], i) => {
          const cx2 = GRID_X + i * celdaW;
          doc.fontSize(7).fillColor('#64748b').font('Helvetica')
            .text(etiqueta.toUpperCase(), cx2, y + 6, { width: celdaW, align: 'center' });
          doc.fontSize(11).fillColor('#1e40af').font('Helvetica-Bold')
            .text(valor, cx2, y + 15, { width: celdaW, align: 'center' });
        });
        doc.font('Helvetica');
        y += 44;

        // ── Firma, en la MISMA página y anclada al pie ──
        // Se ancla abajo, como en cualquier documento que se firma, en vez de
        // quedar flotando debajo de los totales con un vacío grande abajo.
        // Si un mes anómalo empujara la grilla hacia abajo, se dibuja donde
        // haya quedado: se prefiere apretar antes que abrir una hoja nueva.
        const SIG_H = 115;
        doc._drawSignatureBlock(y <= FOOTER_Y - SIG_H ? FOOTER_Y - SIG_H : y);

        // ── Pie ──
        doc.fontSize(7).fillColor('#94a3b8').font('Helvetica')
          .text(`Página ${ei + 1} de ${employees.length}`,
            MARGIN, FOOTER_Y, { width: PAGE_W - MARGIN * 2, align: 'center' });
      }
      doc.end();
      return;
    }

    // ─── Excel ─────
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SisHoras';
    wb.created = new Date();

    // Hoja resumen
    const sum = wb.addWorksheet('Resumen');
    sum.columns = [
      { header: 'Código',       key: 'code',      width: 10 },
      { header: 'Empleado',     key: 'name',      width: 30 },
      { header: 'Departamento', key: 'dept',      width: 22 },
      { header: 'Presentes',    key: 'present',   width: 11 },
      { header: 'Tarde',        key: 'late',      width: 8 },
      { header: 'Ausente',      key: 'absent',    width: 10 },
      { header: 'Trabajado',    key: 'worked',    width: 12 },
      { header: 'Atraso (min)', key: 'latemin',   width: 12 },
      { header: 'Extra',        key: 'overtime',  width: 10 },
    ];
    sum.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sum.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };

    for (const emp of employees) {
      sum.addRow({
        code: emp.code, name: emp.name, dept: emp.department || '',
        present: emp.totals.present, late: emp.totals.latedays, absent: emp.totals.absent,
        worked: minsToHM(emp.totals.worked),
        latemin: emp.totals.late,
        overtime: minsToHM(emp.totals.overtime),
      });
    }

    // Una hoja por empleado (planilla imprimible)
    for (const emp of employees) {
      const safe = String(emp.code || emp.id).replace(/[^\w]/g, '').slice(0, 30);
      const ws = wb.addWorksheet(`${safe}`.slice(0, 31));
      ws.mergeCells('A1:G1');
      ws.getCell('A1').value = `Planilla Mensual — ${period}`;
      ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF1E40AF' } };
      ws.getCell('A1').alignment = { horizontal: 'center' };

      ws.getCell('A2').value = `${emp.name} [${emp.code}] — ${emp.department || ''}`;
      ws.getCell('A2').font = { bold: true };

      const header = ['Día', 'Estado', 'Entrada', 'Salida', 'Trabajado', 'Atraso (min)', 'Extra'];
      ws.addRow([]);
      const hr = ws.addRow(header);
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF475569' } };

      for (let d = 1; d <= daysInMonth; d++) {
        const rec = emp.days[d] || {};
        ws.addRow([
          d,
          rec.status || '',
          dbTimeHHmm(rec.first_in),
          dbTimeHHmm(rec.last_out),
          minsToHM(rec.worked_minutes || 0),
          rec.late_minutes || 0,
          minsToHM(rec.overtime_minutes || 0),
        ]);
      }

      ws.addRow([]);
      const tot = ws.addRow(['TOTAL', '',
        '', '',
        minsToHM(emp.totals.worked),
        emp.totals.late,
        minsToHM(emp.totals.overtime),
      ]);
      tot.font = { bold: true, color: { argb: 'FF1E40AF' } };

      ws.columns = [
        { width: 6 }, { width: 12 }, { width: 10 }, { width: 10 },
        { width: 12 }, { width: 14 }, { width: 10 },
      ];
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="planilla_${year}_${String(month).padStart(2,'0')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
