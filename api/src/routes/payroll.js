/**
 * payroll.js — Export de nómina formato SAA.
 *
 * GET /api/payroll/export?year=&month=&branch_id=&format=xlsx|csv
 *   Genera un archivo con las columnas que usa el sistema contable SAA:
 *     codigo | nombre | cedula | departamento | sede
 *     dias_trab | hs_trab | hs_extra | atrasos_min
 *     ausencias | permisos | vacaciones | enfermedad
 */
const router = require('express').Router();
const ExcelJS = require('exceljs');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { sequelize } = require('../config/database');

router.use(authenticate);
router.use(authorize('admin', 'hr', 'gth', 'super_admin'));
router.use(requirePermission('nomina', 'view'));

function monthRange(year, month) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to   = new Date(year, month, 0).toISOString().slice(0, 10);
  return { from, to };
}

async function fetchRows(year, month, branchId) {
  const { from, to } = monthRange(year, month);
  const bFilter = branchId ? ' AND e.branch_id = ?' : '';
  const params  = branchId ? [from, to, branchId] : [from, to];

  const [rows] = await sequelize.query(`
    SELECT
      e.code                 AS codigo,
      CONCAT(e.first_name, ' ', e.last_name) AS nombre,
      COALESCE(e.document_number, e.employee_number, '') AS cedula,
      COALESCE(d.name, '')   AS departamento,
      COALESCE(b.name, '')   AS sede,
      SUM(CASE WHEN ds.status IN ('present','late') THEN 1 ELSE 0 END) AS dias_trab,
      ROUND(SUM(COALESCE(ds.worked_minutes,0))   / 60, 2) AS hs_trab,
      ROUND(SUM(COALESCE(ds.overtime_minutes,0)) / 60, 2) AS hs_extra,
      SUM(COALESCE(ds.late_minutes,0)) AS atrasos_min,
      SUM(CASE WHEN ds.status = 'absent'     THEN 1 ELSE 0 END) AS ausencias,
      SUM(CASE WHEN ds.justification_type = 'permiso'     THEN 1 ELSE 0 END) AS permisos,
      SUM(CASE WHEN ds.justification_type = 'vacaciones'  THEN 1 ELSE 0 END) AS vacaciones,
      SUM(CASE WHEN ds.justification_type = 'enfermedad'  THEN 1 ELSE 0 END) AS enfermedad
    FROM employees e
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN branches    b ON b.id = e.branch_id
    LEFT JOIN daily_summary ds ON ds.employee_id = e.id AND ds.date BETWEEN ? AND ?
    WHERE e.status = 'active' ${bFilter}
    GROUP BY e.id
    ORDER BY sede, departamento, e.last_name, e.first_name
  `, { replacements: params });
  return rows;
}

router.get('/export', async (req, res) => {
  try {
    const now = new Date();
    const year  = +(req.query.year  || now.getFullYear());
    const month = +(req.query.month || (now.getMonth() + 1));
    const branchId = req.query.branch_id ? +req.query.branch_id : null;
    const format = (req.query.format || 'xlsx').toLowerCase();

    const rows = await fetchRows(year, month, branchId);
    const fname = `nomina_saa_${year}-${String(month).padStart(2, '0')}${branchId ? `_b${branchId}` : ''}`;

    if (format === 'csv') {
      const headers = ['codigo','nombre','cedula','departamento','sede','dias_trab','hs_trab','hs_extra','atrasos_min','ausencias','permisos','vacaciones','enfermedad'];
      const esc = (v) => {
        const s = String(v ?? '');
        return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const out = [headers.join(';'), ...rows.map(r => headers.map(h => esc(r[h])).join(';'))].join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}.csv"`);
      return res.send('\uFEFF' + out);
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Nómina ${year}-${month}`);
    ws.columns = [
      { header: 'Código',       key: 'codigo',       width: 10 },
      { header: 'Nombre',        key: 'nombre',       width: 30 },
      { header: 'Cédula',        key: 'cedula',       width: 14 },
      { header: 'Departamento',  key: 'departamento', width: 22 },
      { header: 'Sede',          key: 'sede',         width: 18 },
      { header: 'Días trab.',    key: 'dias_trab',    width: 12 },
      { header: 'Hs trab.',      key: 'hs_trab',      width: 12 },
      { header: 'Hs extra',      key: 'hs_extra',     width: 12 },
      { header: 'Atrasos (min)', key: 'atrasos_min',  width: 14 },
      { header: 'Ausencias',     key: 'ausencias',    width: 12 },
      { header: 'Permisos',      key: 'permisos',     width: 12 },
      { header: 'Vacaciones',    key: 'vacaciones',   width: 12 },
      { header: 'Enfermedad',    key: 'enfermedad',   width: 12 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
    rows.forEach(r => ws.addRow(r));

    // Total row
    const totalRow = ws.addRow({
      codigo: '', nombre: 'TOTAL', cedula: '', departamento: '', sede: '',
      dias_trab:  rows.reduce((a, r) => a + Number(r.dias_trab || 0), 0),
      hs_trab:    rows.reduce((a, r) => a + Number(r.hs_trab    || 0), 0),
      hs_extra:   rows.reduce((a, r) => a + Number(r.hs_extra   || 0), 0),
      atrasos_min:rows.reduce((a, r) => a + Number(r.atrasos_min|| 0), 0),
      ausencias:  rows.reduce((a, r) => a + Number(r.ausencias  || 0), 0),
      permisos:   rows.reduce((a, r) => a + Number(r.permisos   || 0), 0),
      vacaciones: rows.reduce((a, r) => a + Number(r.vacaciones || 0), 0),
      enfermedad: rows.reduce((a, r) => a + Number(r.enfermedad || 0), 0),
    });
    totalRow.font = { bold: true };
    totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Preview JSON (para mostrar tabla antes de descargar)
router.get('/preview', async (req, res) => {
  try {
    const now = new Date();
    const year  = +(req.query.year  || now.getFullYear());
    const month = +(req.query.month || (now.getMonth() + 1));
    const branchId = req.query.branch_id ? +req.query.branch_id : null;
    const rows = await fetchRows(year, month, branchId);
    res.json({ period: { year, month, branch_id: branchId }, rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Aportes IPS (montos) ────────────────────────────────────────
// Planilla de sueldos y jornales con cálculo de aportes:
//   obrero (default 9%) y patronal (default 16,5%) sobre el salario base.
// Tasas configurables en settings (ips_rate_obrero / ips_rate_patronal).
async function fetchSalaryRows(year, month, branchId) {
  const { from, to } = monthRange(year, month);
  const bFilter = branchId ? ' AND e.branch_id = ?' : '';
  const params  = branchId ? [from, to, branchId] : [from, to];
  const [rows] = await sequelize.query(`
    SELECT
      e.code AS codigo,
      CONCAT(e.last_name, ', ', e.first_name) AS nombre,
      COALESCE(e.document_number,'') AS cedula,
      COALESCE(e.ips_number,'')      AS ips,
      COALESCE(e.salary_base, 0)     AS salario_base,
      COALESCE(d.name,'') AS departamento,
      SUM(CASE WHEN ds.status IN ('present','late') THEN 1 ELSE 0 END) AS dias_trab,
      ROUND(SUM(COALESCE(ds.worked_minutes,0)) / 60, 2) AS hs_trab
    FROM employees e
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN daily_summary ds ON ds.employee_id = e.id AND ds.date BETWEEN ? AND ?
    WHERE e.status = 'active' ${bFilter}
    GROUP BY e.id
    ORDER BY departamento, e.last_name, e.first_name
  `, { replacements: params });
  return rows;
}

// Interpreta una tasa configurada en settings (campo de texto libre).
// Acepta separador decimal con coma (uso paraguayo: "16,5") o punto ("16.5").
// Si el valor es inválido o está vacío, devuelve el default.
function parseRate(value, fallback) {
  if (value == null) return fallback;
  const n = parseFloat(String(value).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

async function getIpsRates() {
  const [r] = await sequelize.query(
    "SELECT setting_key, setting_value FROM notification_settings WHERE setting_key IN ('ips_rate_obrero','ips_rate_patronal','employer_razon_social','employer_ruc','employer_ips_patronal')"
  );
  const m = Object.fromEntries(r.map(x => [x.setting_key, x.setting_value]));
  return {
    obrero: parseRate(m.ips_rate_obrero, 9),
    patronal: parseRate(m.ips_rate_patronal, 16.5),
    razon: m.employer_razon_social || '',
    ruc: m.employer_ruc || '',
    patronalNro: m.employer_ips_patronal || '',
  };
}

function computeIps(rows, rates) {
  return rows.map(e => {
    const base = Number(e.salario_base) || 0;
    const obrero = Math.round(base * rates.obrero) / 100;
    const patronal = Math.round(base * rates.patronal) / 100;
    return {
      codigo: e.codigo, nombre: e.nombre, cedula: e.cedula, ips: e.ips,
      departamento: e.departamento, dias_trab: e.dias_trab, hs_trab: e.hs_trab,
      salario_base: base,
      aporte_obrero: obrero,
      aporte_patronal: patronal,
      total_aporte: Math.round((obrero + patronal) * 100) / 100,
    };
  });
}

router.get('/ips-aportes', async (req, res) => {
  try {
    const now = new Date();
    const year  = +(req.query.year  || now.getFullYear());
    const month = +(req.query.month || (now.getMonth() + 1));
    const branchId = req.query.branch_id ? +req.query.branch_id : null;
    const format = (req.query.format || 'json').toLowerCase();

    const [rates, baseRows] = await Promise.all([getIpsRates(), fetchSalaryRows(year, month, branchId)]);
    const data = computeIps(baseRows, rates);
    const totals = data.reduce((a, r) => ({
      salario_base: a.salario_base + r.salario_base,
      aporte_obrero: a.aporte_obrero + r.aporte_obrero,
      aporte_patronal: a.aporte_patronal + r.aporte_patronal,
      total_aporte: a.total_aporte + r.total_aporte,
    }), { salario_base: 0, aporte_obrero: 0, aporte_patronal: 0, total_aporte: 0 });

    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(`Aportes IPS ${month}-${year}`);
      ws.addRow([`Planilla de Sueldos y Jornales — Aportes IPS`]);
      ws.addRow([`${rates.razon}   RUC: ${rates.ruc}   Patronal IPS: ${rates.patronalNro}   Período: ${String(month).padStart(2,'0')}/${year}`]);
      ws.addRow([`Tasas: Obrero ${rates.obrero}%   Patronal ${rates.patronal}%`]);
      ws.addRow([]);
      ws.addRow(['Código','Apellido y Nombre','C.I.','N° IPS','Depto.','Días','Salario base',`Aporte obrero (${rates.obrero}%)`,`Aporte patronal (${rates.patronal}%)`,'Total aporte']);
      ws.getRow(5).font = { bold: true };
      for (const r of data) ws.addRow([r.codigo, r.nombre, r.cedula, r.ips, r.departamento, r.dias_trab, r.salario_base, r.aporte_obrero, r.aporte_patronal, r.total_aporte]);
      ws.addRow([]);
      ws.addRow(['', '', '', '', '', 'TOTALES', totals.salario_base, totals.aporte_obrero, totals.aporte_patronal, totals.total_aporte]).font = { bold: true };
      ws.columns.forEach(c => { c.width = 16; });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="aportes_ips_${year}_${String(month).padStart(2,'0')}.xlsx"`);
      await wb.xlsx.write(res);
      return res.end();
    }

    res.json({ period: { year, month }, rates, total: data.length, data, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
