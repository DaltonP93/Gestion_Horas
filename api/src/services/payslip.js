/**
 * payslip.js — Recibo de sueldo individual (talón de pago informativo).
 *
 * Reúne los datos de un empleado en un período y produce el detalle de
 * haberes y descuentos REUTILIZANDO el motor `computeLiquidacion`
 * (services/liquidacion.js), el mismo que alimenta la planilla de
 * comunicación MTESS y el aguinaldo en `routes/legal.js`.
 *
 * IMPORTANTE — alcance del cálculo:
 *   `computeLiquidacion` cubre el MÍNIMO legal (básico, horas extra
 *   diurna/nocturna, recargo nocturno, bonificación familiar, antigüedad y
 *   aporte obrero IPS 9%). NO calcula IRP ni la totalidad de descuentos
 *   posibles (adelantos, embargos, préstamos, etc.). Este recibo es un
 *   documento INFORMATIVO y no constituye una liquidación legal certificada.
 *
 * Sólo LECTURA sobre la base `asistencia` (daily_summary, employees,
 * schedules, holidays, notification_settings). No escribe en att2000 ni en
 * attendance_logs / daily_summary.
 */

const { DEFAULT_RATES, computeLiquidacion } = require('./liquidacion');

const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// ── Helpers puros (equivalentes a los de routes/legal.js) ────────────
function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// HH:mm de un DATETIME (o '' si nulo).
function hhmm(v) {
  if (!v) return '';
  const m = String(v).match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

// work_days ("2,3,4,5,6" convención DAYOFWEEK 1=Dom..7=Sáb) → Set de números.
// Sin horario cargado se asume lunes a viernes (2..6).
function workDaySet(wd) {
  const s = String(wd || '').replace(/\s/g, '');
  if (!s) return new Set([2, 3, 4, 5, 6]);
  return new Set(s.split(',').map(Number).filter(n => !Number.isNaN(n)));
}

// Formatea un monto entero en guaraníes con separador de miles (1.234.567).
function formatGs(n) {
  const v = Math.round(Number(n) || 0);
  const neg = v < 0;
  const digits = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}${digits}`;
}

// ── Configuración desde settings (idéntico criterio que legal.js) ────
async function getEmployerData(sequelize) {
  const [rows] = await sequelize.query(
    `SELECT setting_key, setting_value FROM notification_settings
     WHERE setting_key LIKE 'employer_%' OR setting_key IN ('system_company','system_name','system_signer_name','system_signer_position','system_signer_doc_id')`
  );
  return Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
}

const DEFAULT_DISCOUNT_TYPES = ['vacacion', 'enfermedad', 'reposo', 'licencia_especial', 'licencia especial', 'sin_goce', 'sin goce', 'injustific'];
const NON_DISCOUNT_TYPES = ['permiso', 'otro'];

async function getMtessDaysConfig(sequelize) {
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

async function getLiquidacionRates(sequelize) {
  const keys = ['ips_rate_obrero', 'salario_minimo', 'hora_divisor_mensual',
    'nocturno_desde', 'nocturno_hasta', 'extra_diurna_mult', 'extra_nocturna_mult',
    'recargo_nocturno_pct', 'plus_nocturno_feriados', 'plus_nocturno_finde',
    'bonif_familiar_pct', 'mtess_dias_base_mensual', 'mtess_prorratear_basico'];
  const [rows] = await sequelize.query(
    `SELECT setting_key, setting_value FROM notification_settings WHERE setting_key IN (${keys.map(() => '?').join(',')})`,
    { replacements: keys }
  );
  const m = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
  const num = (v, def) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : def; };
  const hm = (v, def) => { const s = String(v || '').match(/(\d{1,2}):(\d{2})/); return s ? (+s[1] * 60 + +s[2]) : def; };
  return {
    divisorMensual: num(m.hora_divisor_mensual, DEFAULT_RATES.divisorMensual),
    nocturnoDesde: hm(m.nocturno_desde, DEFAULT_RATES.nocturnoDesde),
    nocturnoHasta: hm(m.nocturno_hasta, DEFAULT_RATES.nocturnoHasta),
    extraDiurnaMult: num(m.extra_diurna_mult, DEFAULT_RATES.extraDiurnaMult),
    extraNocturnaMult: num(m.extra_nocturna_mult, DEFAULT_RATES.extraNocturnaMult),
    recargoNocturnoPct: num(m.recargo_nocturno_pct, DEFAULT_RATES.recargoNocturnoPct),
    plusNocturnoFeriados: String(m.plus_nocturno_feriados ?? '1') !== '0',
    plusNocturnoFinde: String(m.plus_nocturno_finde ?? '1') !== '0',
    bonifFamiliarPct: num(m.bonif_familiar_pct, DEFAULT_RATES.bonifFamiliarPct),
    salarioMinimo: num(m.salario_minimo, DEFAULT_RATES.salarioMinimo),
    obreroPct: num(m.ips_rate_obrero, DEFAULT_RATES.obreroPct),
    baseMensual: num(m.mtess_dias_base_mensual, DEFAULT_RATES.baseMensual),
    prorratearBasico: String(m.mtess_prorratear_basico ?? '1') !== '0',
  };
}

// Días a informar y descuentos (misma regla que la planilla MTESS).
function computeDiasTrabajados(emp, cfg) {
  if (emp.pay_type === 'jornalero') {
    return { dias: emp.presentDays, base: emp.presentDays, descuentos: 0, detalle: {} };
  }
  const detalle = {};
  let descuentos = 0;
  for (const info of Object.values(emp.days)) {
    const jt = normalize(info.jtype);
    const st = info.status;
    if (info.working === false) continue;
    if (st === 'present' || st === 'late' || st === 'holiday' || st === 'weekend') continue;
    if (NON_DISCOUNT_TYPES.includes(jt)) continue;
    if (jt && cfg.discountTypes.some(t => jt.includes(t) || t.includes(jt))) {
      descuentos++;
      detalle[info.jtype] = (detalle[info.jtype] || 0) + 1;
      continue;
    }
    if (st === 'absent') {
      descuentos++;
      const k = jt ? info.jtype : 'injustificada';
      detalle[k] = (detalle[k] || 0) + 1;
    }
  }
  return { dias: Math.max(0, cfg.base - descuentos), base: cfg.base, descuentos, detalle };
}

/**
 * getEmployeeMonthlyGrid — resumen mensual de UN empleado (por id).
 * A diferencia de la planilla, no filtra por status='active': un empleado
 * dado de baja aún necesita el recibo de un período pasado.
 * Devuelve el objeto del empleado (grid) o null si no existe.
 */
async function getEmployeeMonthlyGrid(sequelize, { employeeId, year, month }) {
  const dateFrom = `${year}-${String(month).padStart(2, '0')}-01`;
  const dateTo = new Date(year, month, 0).toISOString().split('T')[0];

  const [rows] = await sequelize.query(`
    SELECT
      e.id, e.code, e.first_name, e.last_name, e.document_number, e.ips_number,
      e.position, e.salary_base, e.pay_type, e.children_count, e.antiguedad_rate,
      e.hire_date, e.status,
      s.work_days,
      d.name AS department,
      ds.date, ds.status AS ds_status, ds.first_in, ds.last_out, ds.justification_type,
      ds.worked_minutes, ds.overtime_minutes, oa.status AS ot_status
    FROM employees e
    LEFT JOIN departments d ON e.department_id = d.id
    LEFT JOIN schedules   s ON e.schedule_id = s.id
    LEFT JOIN daily_summary ds ON e.id = ds.employee_id
         AND ds.date BETWEEN ? AND ?
    LEFT JOIN overtime_approvals oa ON oa.employee_id = ds.employee_id AND oa.date = ds.date
    WHERE e.id = ?
    ORDER BY ds.date
  `, { replacements: [dateFrom, dateTo, employeeId] });

  if (!rows.length) return null;

  const [otCfg] = await sequelize.query(
    "SELECT setting_value FROM notification_settings WHERE setting_key = 'att_overtime_requires_auth' LIMIT 1"
  );
  const otRequiresAuth = String(otCfg[0]?.setting_value ?? '') === '1';

  const [hol] = await sequelize.query(
    'SELECT DATE_FORMAT(date, "%Y-%m-%d") AS d FROM holidays WHERE active = 1 AND date BETWEEN ? AND ?',
    { replacements: [dateFrom, dateTo] }
  );
  const holidays = new Set(hol.map(h => h.d));

  const head = rows[0];
  const emp = {
    id: head.id, code: head.code,
    first_name: head.first_name, last_name: head.last_name,
    name: `${head.last_name || ''}, ${head.first_name || ''}`.replace(/^, |, $/, '').trim(),
    ci: head.document_number || '', ips: head.ips_number || '',
    position: head.position || '', department: head.department || '',
    status: head.status || '',
    salary_base: Number(head.salary_base) || 0, pay_type: head.pay_type || 'mensualizado',
    children_count: Number(head.children_count) || 0,
    antiguedad_rate: Number(head.antiguedad_rate) || 0,
    hire_date: head.hire_date || null,
    workDays: workDaySet(head.work_days),
    days: {}, workedMin: 0, otMin: 0, presentDays: 0,
  };

  for (const r of rows) {
    if (!r.date) continue;
    const dt = new Date(r.date);
    const day = dt.getDate();
    const dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dow = dt.getDay() + 1; // getDay 0=Dom..6=Sáb → 1=Dom..7=Sáb
    const isHoliday = holidays.has(dateStr);
    const isWeekend = dow === 1 || dow === 7;
    const working = emp.workDays.has(dow) && !isHoliday;
    const inHM = hhmm(r.first_in);
    const outHM = hhmm(r.last_out);
    const inMinutes = inHM ? (+inHM.slice(0, 2) * 60 + +inHM.slice(3, 5)) : null;
    const outMinutes = outHM ? (+outHM.slice(0, 2) * 60 + +outHM.slice(3, 5)) : null;
    const otMin = (otRequiresAuth && r.ot_status !== 'approved') ? 0 : (r.overtime_minutes || 0);
    emp.days[day] = {
      status: r.ds_status, jtype: (r.justification_type || '').toLowerCase().trim(),
      otMin, inMinutes, outMinutes, working, isHoliday, isWeekend,
    };
    emp.workedMin += r.worked_minutes || 0;
    emp.otMin += otMin;
    if (r.ds_status === 'present' || r.ds_status === 'late') emp.presentDays++;
  }

  return emp;
}

/**
 * computePayslip(sequelize, { employeeId, year, month })
 *   → { employer, period, employee, dias, liquidacion } | null (empleado inexistente)
 * Reutiliza computeLiquidacion (el mismo motor de la planilla de comunicación).
 */
async function computePayslip(sequelize, { employeeId, year, month }) {
  const [employer, cfg, rates] = await Promise.all([
    getEmployerData(sequelize), getMtessDaysConfig(sequelize), getLiquidacionRates(sequelize),
  ]);

  const emp = await getEmployeeMonthlyGrid(sequelize, { employeeId, year, month });
  if (!emp) return null;

  const d = computeDiasTrabajados(emp, cfg);
  // Antigüedad referida al cierre del período (más correcto para un recibo
  // histórico que la fecha de hoy).
  const refDate = new Date(year, month, 0).toISOString().split('T')[0];
  const liq = computeLiquidacion({ ...emp, days: Object.values(emp.days) }, d.dias, { ...rates, refDate });

  return {
    employer,
    period: { year, month, label: `${MESES[month]} ${year}` },
    employee: {
      id: emp.id, code: emp.code, name: emp.name,
      ci: emp.ci, ips: emp.ips, position: emp.position,
      department: emp.department, pay_type: emp.pay_type, status: emp.status,
    },
    dias: d,
    liquidacion: liq,
  };
}

// ── Render del PDF (talón de pago) ───────────────────────────────────
const DISCLAIMER =
  'DOCUMENTO INFORMATIVO — no constituye liquidación legal certificada. ' +
  'El cálculo cubre el mínimo previsional (salario básico, horas extra, recargo nocturno, ' +
  'bonificación familiar, antigüedad y aporte obrero IPS 9%); NO incluye IRP ni la totalidad ' +
  'de descuentos posibles (adelantos, préstamos, embargos u otros). Verificar con RR.HH.';

/**
 * buildPayslipPdf(doc, data) — dibuja el talón sobre un PDFDocument A4.
 * `doc` es una instancia de pdfkit; `data` es el retorno de computePayslip.
 */
function buildPayslipPdf(doc, data) {
  const { employer, period, employee, liquidacion: liq, dias } = data;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const razon = employer.employer_razon_social || employer.system_company || employer.system_name || 'Empleador';

  // Encabezado
  doc.fontSize(15).fillColor('#0f172a').font('Helvetica-Bold')
    .text('RECIBO DE SUELDO', left, doc.y, { width, align: 'center' });
  doc.fontSize(8).font('Helvetica').fillColor('#64748b')
    .text('Talón de pago informativo', { width, align: 'center' });
  doc.moveDown(0.6);

  // Datos del empleador
  const empInfo = [
    `Empleador: ${razon}`,
    employer.employer_ruc ? `RUC: ${employer.employer_ruc}` : null,
    employer.employer_ips_patronal ? `Patronal IPS: ${employer.employer_ips_patronal}` : null,
  ].filter(Boolean).join('     ');
  doc.fontSize(8.5).fillColor('#334155').text(empInfo, left, doc.y, { width });
  doc.moveDown(0.4);

  // Caja de datos del empleado
  const boxY = doc.y;
  doc.rect(left, boxY, width, 52).fillAndStroke('#f1f5f9', '#cbd5e1');
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(9);
  doc.text(employee.name || '—', left + 8, boxY + 6, { width: width - 16 });
  doc.font('Helvetica').fontSize(8).fillColor('#475569');
  const line1 = [
    `Legajo: ${employee.code || '—'}`,
    `C.I.: ${employee.ci || '—'}`,
    employee.ips ? `N° IPS: ${employee.ips}` : null,
  ].filter(Boolean).join('      ');
  const line2 = [
    employee.position ? `Cargo: ${employee.position}` : null,
    employee.department ? `Depto.: ${employee.department}` : null,
    `Modalidad: ${employee.pay_type === 'jornalero' ? 'Jornalero' : 'Mensualizado'}`,
  ].filter(Boolean).join('      ');
  doc.text(line1, left + 8, boxY + 22, { width: width - 16 });
  doc.text(line2, left + 8, boxY + 34, { width: width - 16 });
  doc.y = boxY + 52;
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0f172a')
    .text(`Período liquidado: ${period.label}     Días informados: ${dias.dias}`, left, doc.y, { width });
  doc.moveDown(0.4);

  // Tabla de conceptos: descripción | haber | descuento
  const colDesc = width * 0.58;
  const colHaber = width * 0.21;
  const colDesc2 = width * 0.21;
  const rowH = 18;

  function tableHead(y) {
    doc.rect(left, y, width, rowH).fillAndStroke('#e2e8f0', '#94a3b8');
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8);
    doc.text('Concepto', left + 6, y + 5, { width: colDesc - 8 });
    doc.text('Haberes', left + colDesc, y + 5, { width: colHaber - 6, align: 'right' });
    doc.text('Descuentos', left + colDesc + colHaber, y + 5, { width: colDesc2 - 6, align: 'right' });
    return y + rowH;
  }

  function row(y, label, haber, descuento, opts = {}) {
    if (opts.zebra) { doc.rect(left, y, width, rowH).fill('#f8fafc'); }
    doc.rect(left, y, width, rowH).stroke('#e2e8f0');
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#0f172a');
    doc.text(label, left + 6, y + 5, { width: colDesc - 8 });
    doc.text(haber != null ? formatGs(haber) : '', left + colDesc, y + 5, { width: colHaber - 6, align: 'right' });
    doc.text(descuento != null ? formatGs(descuento) : '', left + colDesc + colHaber, y + 5, { width: colDesc2 - 6, align: 'right' });
    return y + rowH;
  }

  let y = tableHead(doc.y);
  const haberes = [
    ['Salario básico', liq.basico],
    [`Horas extra diurnas (${liq.ot_diurna_horas} h)`, liq.monto_extra_diurna],
    [`Horas extra nocturnas (${liq.ot_nocturna_horas} h)`, liq.monto_extra_nocturna],
    ['Recargo nocturno', liq.recargo_nocturno],
    ['Bonificación familiar', liq.bonif_familiar],
    ['Antigüedad', liq.antiguedad],
  ];
  let z = false;
  for (const [label, monto] of haberes) {
    y = row(y, label, monto, null, { zebra: z }); z = !z;
  }
  // Descuentos
  y = row(y, 'Aporte obrero IPS (9%)', null, liq.aporte_obrero, { zebra: z });

  // Totales
  y += 4;
  doc.rect(left, y, width, rowH).fillAndStroke('#e2e8f0', '#94a3b8');
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0f172a');
  doc.text('Total haberes (bruto)', left + 6, y + 5, { width: colDesc - 8 });
  doc.text(formatGs(liq.total_bruto), left + colDesc, y + 5, { width: colHaber - 6, align: 'right' });
  doc.text(formatGs(liq.aporte_obrero), left + colDesc + colHaber, y + 5, { width: colDesc2 - 6, align: 'right' });
  y += rowH;

  doc.rect(left, y, width, rowH + 4).fillAndStroke('#0f766e', '#0f766e');
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff');
  doc.text('NETO A PERCIBIR', left + 6, y + 6, { width: colDesc + colHaber - 8 });
  doc.text(`Gs ${formatGs(liq.total_neto)}`, left + colDesc, y + 6, { width: colHaber + colDesc2 - 6, align: 'right' });
  y += rowH + 4;

  // Nota valor hora
  doc.moveDown(0.6);
  doc.font('Helvetica').fontSize(7.5).fillColor('#64748b')
    .text(`Valor hora considerado: Gs ${formatGs(liq.valor_hora)}.`, left, y + 8, { width });

  // Disclaimer (recuadro visible)
  const discY = doc.page.height - 120;
  doc.rect(left, discY, width, 60).fillAndStroke('#fef3c7', '#f59e0b');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#92400e')
    .text('AVISO', left + 8, discY + 6, { width: width - 16 });
  doc.font('Helvetica').fontSize(7.5).fillColor('#78350f')
    .text(DISCLAIMER, left + 8, discY + 18, { width: width - 16 });

  // Pie
  doc.font('Helvetica').fontSize(7).fillColor('#94a3b8')
    .text(`Generado el ${new Date().toISOString().slice(0, 10)}`, left, doc.page.height - 48, { width });
}

module.exports = {
  MESES, DISCLAIMER,
  normalize, hhmm, workDaySet, formatGs,
  getEmployerData, getMtessDaysConfig, getLiquidacionRates,
  computeDiasTrabajados, getEmployeeMonthlyGrid, computePayslip,
  buildPayslipPdf,
};
