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
      e.salary_base, e.pay_type, e.children_count, e.antiguedad_rate, e.hire_date,
      s.work_days,
      CONCAT(e.last_name, ', ', e.first_name) AS employee_name,
      d.name AS department,
      ds.date, ds.status, ds.first_in, ds.last_out, ds.justification_type,
      ds.worked_minutes, ds.overtime_minutes, oa.status AS ot_status
    FROM employees e
    LEFT JOIN departments d ON e.department_id = d.id
    LEFT JOIN schedules   s ON e.schedule_id = s.id
    LEFT JOIN daily_summary ds ON e.id = ds.employee_id
         AND ds.date BETWEEN ? AND ?
    LEFT JOIN overtime_approvals oa ON oa.employee_id = ds.employee_id AND oa.date = ds.date
    WHERE e.status = 'active' ${deptFilter}
    ORDER BY d.name, e.last_name, e.first_name, ds.date
  `, { replacements: params });

  // ¿La empresa exige autorizar las horas extra? Si sí, sólo se pagan/informan
  // las aprobadas (el cálculo del overtime no cambia; sólo su cómputo aquí).
  const [otCfg] = await sequelize.query(
    "SELECT setting_value FROM notification_settings WHERE setting_key = 'att_overtime_requires_auth' LIMIT 1"
  );
  const otRequiresAuth = String(otCfg[0]?.setting_value ?? '') === '1';

  // Feriados del período (para no descontar días no laborables).
  const [hol] = await sequelize.query(
    'SELECT DATE_FORMAT(date, "%Y-%m-%d") AS d FROM holidays WHERE active = 1 AND date BETWEEN ? AND ?',
    { replacements: [dateFrom, dateTo] }
  );
  const holidays = new Set(hol.map(h => h.d));

  // work_days usa la convención DAYOFWEEK: 1=Dom, 2=Lun … 7=Sáb.
  // Sin horario cargado, se asume lunes a viernes (2..6).
  function workDaySet(wd) {
    const s = String(wd || '').replace(/\s/g, '');
    if (!s) return new Set([2, 3, 4, 5, 6]);
    return new Set(s.split(',').map(Number).filter(n => !Number.isNaN(n)));
  }

  const byEmp = new Map();
  for (const r of rows) {
    if (!byEmp.has(r.id)) {
      byEmp.set(r.id, {
        id: r.id, code: r.code, ci: r.document_number || '', ips: r.ips_number || '',
        position: r.position || '', name: r.employee_name, department: r.department || '',
        salary_base: Number(r.salary_base) || 0, pay_type: r.pay_type || 'mensualizado',
        children_count: Number(r.children_count) || 0, antiguedad_rate: Number(r.antiguedad_rate) || 0,
        hire_date: r.hire_date || null,
        workDays: workDaySet(r.work_days),
        days: {}, workedMin: 0, otMin: 0, presentDays: 0,
      });
    }
    if (r.date) {
      const dt = new Date(r.date);
      const day = dt.getDate();
      const emp = byEmp.get(r.id);
      const dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      // work_days usa convención DAYOFWEEK: 1=Dom … 7=Sáb.
      // getDay() da 0=Dom … 6=Sáb, así que se suma 1.
      const dow = dt.getDay() + 1;
      const working = emp.workDays.has(dow) && !holidays.has(dateStr);
      const inHM = hhmm(r.first_in);
      const outHM = hhmm(r.last_out);
      const inMinutes = inHM ? (+inHM.slice(0, 2) * 60 + +inHM.slice(3, 5)) : null;
      const outMinutes = outHM ? (+outHM.slice(0, 2) * 60 + +outHM.slice(3, 5)) : null;
      // Overtime computable: si se exige autorización, sólo el aprobado.
      const otMin = (otRequiresAuth && r.ot_status !== 'approved') ? 0 : (r.overtime_minutes || 0);
      emp.days[day] = {
        in: inHM, out: outHM,
        status: r.status, jtype: (r.justification_type || '').toLowerCase().trim(),
        otMin, inMinutes, outMinutes, working,
      };
      emp.workedMin += r.worked_minutes || 0;
      emp.otMin += otMin;
      if (r.status === 'present' || r.status === 'late') emp.presentDays++;
    }
  }
  return Array.from(byEmp.values());
}

// Tipos de justificación que DESCUENTAN días para un mensualizado, según la
// regla del MTESS: reposo, ausencia injustificada, licencia especial, días sin
// goce de salario y vacaciones. Los francos/libres normales NO descuentan.
// Configurable en settings (mtess_dias_descuento_tipos, lista separada por
// comas). Se compara por coincidencia parcial y sin acentos para tolerar
// variantes ("sin_goce", "sin goce de salario", "lic. especial", …).
const DEFAULT_DISCOUNT_TYPES = ['vacacion', 'enfermedad', 'reposo', 'licencia_especial', 'licencia especial', 'sin_goce', 'sin goce', 'injustific'];

function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

async function getMtessDaysConfig() {
  const [rows] = await sequelize.query(
    "SELECT setting_key, setting_value FROM notification_settings WHERE setting_key IN ('mtess_dias_base_mensual','mtess_dias_descuento_tipos')"
  );
  const m = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
  const base = parseInt(m.mtess_dias_base_mensual, 10);
  const list = (m.mtess_dias_descuento_tipos || '').split(',').map(x => normalize(x)).filter(Boolean);
  return {
    base: Number.isFinite(base) && base > 0 ? base : 30,
    discountTypes: list.length ? list : DEFAULT_DISCOUNT_TYPES.map(normalize),
  };
}

// Tipos de justificación con goce que NO descuentan (permiso pago, "otro").
const NON_DISCOUNT_TYPES = ['permiso', 'otro'];

// Calcula los "días trabajados" a informar y el desglose de descuentos.
//
// Clave: `status='absent'` sólo lo genera materializeAbsents para un día
// LABORABLE del horario del empleado sin marcación → es una ausencia
// injustificada real (los francos/libres son días NO laborables y nunca
// generan fila 'absent'). Por eso una ausencia sin justificación SÍ descuenta,
// mientras que un franco (sin fila, o status weekend/holiday) no.
function computeDiasTrabajados(emp, cfg) {
  if (emp.pay_type === 'jornalero') {
    // Jornalero: cantidad exacta de días efectivamente trabajados.
    return { dias: emp.presentDays, base: emp.presentDays, descuentos: 0, detalle: {} };
  }
  // Mensualizado: base (30) menos días descontables.
  const detalle = {};
  let descuentos = 0;
  for (const info of Object.values(emp.days)) {
    const jt = normalize(info.jtype);
    const st = info.status;
    // Un día NO laborable (franco por horario o feriado) nunca descuenta,
    // aunque una importación le haya puesto una justificación (p. ej.
    // vacaciones cargadas sobre un rango que incluye sábados/domingos).
    if (info.working === false) continue;
    // Días que NO descuentan: trabajados, feriado, franco/fin de semana.
    if (st === 'present' || st === 'late' || st === 'holiday' || st === 'weekend') continue;
    // Permiso con goce u "otro": no descuenta.
    if (NON_DISCOUNT_TYPES.includes(jt)) continue;
    // Tipo de ausencia descontable explícito (vacaciones, reposo, sin goce…).
    if (jt && cfg.discountTypes.some(t => jt.includes(t) || t.includes(jt))) {
      descuentos++;
      detalle[info.jtype] = (detalle[info.jtype] || 0) + 1;
      continue;
    }
    // Ausencia injustificada: día laborable sin marcación ni justificación.
    if (st === 'absent') {
      descuentos++;
      const k = jt ? info.jtype : 'injustificada';
      detalle[k] = (detalle[k] || 0) + 1;
    }
  }
  return { dias: Math.max(0, cfg.base - descuentos), base: cfg.base, descuentos, detalle };
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

// ─── Planilla de Comunicación MTESS (formato de carga) ───────────
// Columnas EXACTAS del archivo que se sube al MTESS (ver ejemplo oficial).
const MTESS_HEADERS = [
  'numero_patronal', 'nro_ci', 'periodo_pago_desde', 'periodo_pago_hasta', 'forma_de_pago',
  'canti_dias_trabajados', 'canti_piezas_tareas', 'horas_ordinarias', 'horas_extraordinarias',
  'Salario Básico', 'Comisiones', 'Horas extras diurnas(50%)', 'Recargo horario Nocturno',
  'Horas extras nocturnas(100%)', 'Premios', 'Salario en especie (Max 30%)', 'Regalias',
  'Gratificaciones', 'Grado Académico', 'Feriados', 'Dietas', 'Complemento Salarial',
  'Bonificacion Familiar', 'Antigüedad', 'Anticipos de salario', 'Aporte Seg. Social',
  'Descuentos 1', 'Concepto descuentos 1', 'Descuentos 2', 'Concepto descuentos 2',
  'Descuentos 3', 'Concepto descuentos 3', 'Asignación por guardería',
  'Asignación por trabajo insalubre o riesgoso', 'Otras asignaciones 1', 'Concepto otras asignaciones 1',
  'Otras asignaciones 2', 'Concepto otras asignaciones 2', 'Otras asignaciones 3', 'Concepto otras asignaciones 3',
];

async function getObreroRate() {
  const [rows] = await sequelize.query(
    "SELECT setting_value FROM notification_settings WHERE setting_key = 'ips_rate_obrero' LIMIT 1"
  );
  const n = parseFloat(String(rows[0]?.setting_value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 9;
}

const { DEFAULT_RATES, computeLiquidacion } = require('../services/liquidacion');

// Parámetros de liquidación desde settings (con defaults sensatos).
async function getLiquidacionRates() {
  const keys = ['ips_rate_obrero', 'salario_minimo', 'hora_divisor_mensual',
    'nocturno_desde', 'nocturno_hasta', 'extra_diurna_mult', 'extra_nocturna_mult',
    'recargo_nocturno_pct', 'bonif_familiar_pct', 'mtess_dias_base_mensual', 'mtess_prorratear_basico'];
  const [rows] = await sequelize.query(
    `SELECT setting_key, setting_value FROM notification_settings WHERE setting_key IN (${keys.map(() => '?').join(',')})`,
    { replacements: keys }
  );
  const m = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
  const num = (v, def) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : def; };
  // "HH:MM" → minutos desde medianoche.
  const hm = (v, def) => { const s = String(v || '').match(/(\d{1,2}):(\d{2})/); return s ? (+s[1] * 60 + +s[2]) : def; };
  return {
    divisorMensual: num(m.hora_divisor_mensual, DEFAULT_RATES.divisorMensual),
    nocturnoDesde: hm(m.nocturno_desde, DEFAULT_RATES.nocturnoDesde),
    nocturnoHasta: hm(m.nocturno_hasta, DEFAULT_RATES.nocturnoHasta),
    extraDiurnaMult: num(m.extra_diurna_mult, DEFAULT_RATES.extraDiurnaMult),
    extraNocturnaMult: num(m.extra_nocturna_mult, DEFAULT_RATES.extraNocturnaMult),
    recargoNocturnoPct: num(m.recargo_nocturno_pct, DEFAULT_RATES.recargoNocturnoPct),
    bonifFamiliarPct: num(m.bonif_familiar_pct, DEFAULT_RATES.bonifFamiliarPct),
    salarioMinimo: num(m.salario_minimo, DEFAULT_RATES.salarioMinimo),
    obreroPct: num(m.ips_rate_obrero, DEFAULT_RATES.obreroPct),
    baseMensual: num(m.mtess_dias_base_mensual, DEFAULT_RATES.baseMensual),
    prorratearBasico: String(m.mtess_prorratear_basico ?? '1') !== '0',
  };
}

router.get('/planilla-comunicacion', asyncHandler(async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
  const dept = req.query.dept || null;
  const format = (req.query.format || 'json').toLowerCase();

  const [employer, employees, cfg, rates] = await Promise.all([
    getEmployerData(), getMonthlyGrid(year, month, dept), getMtessDaysConfig(), getLiquidacionRates(),
  ]);

  const desde = new Date(Date.UTC(year, month - 1, 1, 12));
  const hasta = new Date(Date.UTC(year, month, 0, 12));
  const patronal = employer.employer_ips_patronal || '';

  const rows = employees.map(e => {
    const d = computeDiasTrabajados(e, cfg);
    const forma = e.pay_type === 'jornalero' ? 1 : 3; // 1=Jornal, 3=Mensual
    const liq = computeLiquidacion({ ...e, days: Object.values(e.days) }, d.dias, rates);
    return {
      // Campos con datos que el sistema conoce
      numero_patronal: patronal,
      nro_ci: e.ci,
      periodo_pago_desde: desde,
      periodo_pago_hasta: hasta,
      forma_de_pago: forma,
      canti_dias_trabajados: d.dias,
      // worked_minutes incluye el tramo de horas extra (span entrada→salida);
      // las ordinarias son el total menos las extraordinarias.
      horas_ordinarias: Math.round(Math.max(0, e.workedMin - e.otMin) / 60),
      horas_extraordinarias: Math.round(e.otMin / 60),
      salario_basico: liq.basico,
      extra_diurna: liq.monto_extra_diurna,
      extra_nocturna: liq.monto_extra_nocturna,
      recargo_nocturno: liq.recargo_nocturno,
      bonif_familiar: liq.bonif_familiar,
      antiguedad: liq.antiguedad,
      aporte_seg_social: liq.aporte_obrero,
      // metadatos para la vista previa (no van al Excel de carga)
      _meta: {
        code: e.code, name: e.name, pay_type: e.pay_type,
        base: d.base, descuentos: d.descuentos, detalle: d.detalle,
        valor_hora: liq.valor_hora, ot_diurna_horas: liq.ot_diurna_horas,
        ot_nocturna_horas: liq.ot_nocturna_horas,
        total_bruto: liq.total_bruto, total_neto: liq.total_neto,
      },
    };
  });

  if (format === 'xlsx') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Comunicacion');
    ws.addRow(MTESS_HEADERS);
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      const row = new Array(MTESS_HEADERS.length).fill(null);
      row[0] = r.numero_patronal;
      row[1] = r.nro_ci;
      row[2] = r.periodo_pago_desde;
      row[3] = r.periodo_pago_hasta;
      row[4] = r.forma_de_pago;
      row[5] = r.canti_dias_trabajados;
      row[6] = null;                       // canti_piezas_tareas
      row[7] = r.horas_ordinarias;
      row[8] = r.horas_extraordinarias;
      row[9]  = r.salario_basico;          // Salario Básico
      row[11] = r.extra_diurna || null;    // Horas extras diurnas(50%)
      row[12] = r.recargo_nocturno || null; // Recargo horario Nocturno
      row[13] = r.extra_nocturna || null;  // Horas extras nocturnas(100%)
      row[22] = r.bonif_familiar || null;  // Bonificacion Familiar
      row[23] = r.antiguedad || null;      // Antigüedad
      row[25] = r.aporte_seg_social;       // Aporte Seg. Social
      const added = ws.addRow(row);
      added.getCell(3).numFmt = 'dd/mm/yyyy';
      added.getCell(4).numFmt = 'dd/mm/yyyy';
    }
    ws.getColumn(1).width = 14; ws.getColumn(2).width = 12; ws.getColumn(3).width = 13;
    ws.getColumn(4).width = 13; ws.getColumn(10).width = 14; ws.getColumn(26).width = 14;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="planilla_comunicacion_mtess_${year}_${String(month).padStart(2, '0')}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }

  res.json({
    period: { year, month, label: `${MESES[month]} ${year}` },
    config: {
      base_mensual: cfg.base, tipos_descuento: cfg.discountTypes,
      ips_rate_obrero: rates.obreroPct, salario_minimo: rates.salarioMinimo,
      extra_diurna_mult: rates.extraDiurnaMult, extra_nocturna_mult: rates.extraNocturnaMult,
      nocturno: `${String(Math.floor(rates.nocturnoDesde / 60)).padStart(2, '0')}:${String(rates.nocturnoDesde % 60).padStart(2, '0')}–${String(Math.floor(rates.nocturnoHasta / 60)).padStart(2, '0')}:${String(rates.nocturnoHasta % 60).padStart(2, '0')}`,
    },
    total: rows.length,
    data: rows.map(({ _meta, periodo_pago_desde, periodo_pago_hasta, ...rest }) => ({
      ...rest,
      periodo_pago_desde: periodo_pago_desde.toISOString().slice(0, 10),
      periodo_pago_hasta: periodo_pago_hasta.toISOString().slice(0, 10),
      ..._meta,
    })),
  });
}));

// ─── Aguinaldo (1/12 de lo percibido en el año) ──────────────────
// Recorre los meses del año (hasta el mes indicado, default diciembre),
// acumula la remuneración imponible de cada empleado y divide por 12.
router.get('/aguinaldo', asyncHandler(async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const upTo = Math.min(12, Math.max(1, parseInt(req.query.month) || 12));
  const dept = req.query.dept || null;
  const format = (req.query.format || 'json').toLowerCase();

  const [employer, cfg, rates] = await Promise.all([
    getEmployerData(), getMtessDaysConfig(), getLiquidacionRates(),
  ]);

  // Acumular por empleado a lo largo de los meses.
  const acc = new Map(); // id → { code, name, ci, meses, percibido }
  for (let m = 1; m <= upTo; m++) {
    const employees = await getMonthlyGrid(year, m, dept);
    const monthEnd = new Date(year, m, 0); // último día del mes m
    for (const e of employees) {
      // No acreditar meses anteriores al ingreso (un mensualizado devuelve
      // base 30 aunque no tenga marcaciones): el empleado aún no existía.
      if (e.hire_date && new Date(e.hire_date) > monthEnd) continue;
      const d = computeDiasTrabajados(e, cfg);
      const liq = computeLiquidacion({ ...e, days: Object.values(e.days) }, d.dias, rates);
      // Imponible del mes (sin bonif. familiar, que no integra el aguinaldo).
      const mes = liq.basico + liq.monto_extra_diurna + liq.monto_extra_nocturna +
        liq.recargo_nocturno + liq.antiguedad;
      if (!acc.has(e.id)) acc.set(e.id, { code: e.code, name: e.name, ci: e.ci, meses: 0, percibido: 0 });
      const a = acc.get(e.id);
      a.percibido += mes;
      if (mes > 0) a.meses += 1;
    }
  }

  const data = Array.from(acc.values()).map(a => ({
    code: a.code, name: a.name, ci: a.ci,
    meses: a.meses, percibido_anual: a.percibido,
    aguinaldo: Math.round(a.percibido / 12),
  })).sort((x, y) => x.name.localeCompare(y.name));

  if (format === 'xlsx') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Aguinaldo ${year}`);
    ws.addRow([`Aguinaldo ${year} — ${employer.employer_razon_social || employer.system_company || ''}`]);
    ws.addRow([`RUC: ${employer.employer_ruc || ''}   Patronal IPS: ${employer.employer_ips_patronal || ''}`]);
    ws.addRow([]);
    ws.addRow(['Código', 'Apellido y Nombre', 'C.I.', 'Meses', 'Percibido anual', 'Aguinaldo (1/12)']);
    ws.getRow(4).font = { bold: true };
    for (const d of data) ws.addRow([d.code, d.name, d.ci, d.meses, d.percibido_anual, d.aguinaldo]);
    const totAg = data.reduce((s, d) => s + d.aguinaldo, 0);
    const tr = ws.addRow(['', 'TOTAL', '', '', '', totAg]);
    tr.font = { bold: true };
    ws.columns.forEach(c => { c.width = 20; });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="aguinaldo_${year}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }

  res.json({
    year, up_to_month: upTo,
    total: data.length,
    total_aguinaldo: data.reduce((s, d) => s + d.aguinaldo, 0),
    data,
  });
}));

module.exports = router;
