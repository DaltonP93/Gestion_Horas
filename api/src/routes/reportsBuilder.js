/**
 * reportsBuilder.js — Constructor de reportes a medida.
 *
 * POST /api/reports-builder/preview
 *   Body: { source, fields[], filters{}, groupBy?, orderBy?, limit? }
 *   source: 'attendance' | 'daily_summary' | 'permissions' | 'employees'
 *   Devuelve filas (max 1000) según las opciones.
 *
 * POST /api/reports-builder/export
 *   Mismo body + format=csv|xlsx → genera archivo
 */
const router = require('express').Router();
const ExcelJS = require('exceljs');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const logger = require('../config/logger');
const { logInternalError } = require('../utils/logInternalError');

router.use(authenticate);
router.use(authorize('admin', 'gth', 'hr', 'manager', 'gestor'));
router.use(requirePermission('reportes', 'view'));

// ─── Catálogos por fuente de datos ───────────────────────────────
// Cada source define: tabla base, JOINs, fields disponibles (con cómo se calculan)
const SOURCES = {
  attendance: {
    base: 'attendance_logs al',
    joins: [
      'JOIN employees e ON e.id = al.employee_id',
      'LEFT JOIN departments d ON d.id = e.department_id',
    ],
    fields: {
      employee_code:   { sql: 'e.code',                         label: 'Código' },
      employee_name:   { sql: "CONCAT(e.first_name,' ',e.last_name)", label: 'Empleado' },
      department:      { sql: 'd.name',                         label: 'Departamento' },
      timestamp:       { sql: 'al.timestamp',                   label: 'Fecha y hora' },
      date:            { sql: 'DATE(al.timestamp)',             label: 'Fecha' },
      time:            { sql: 'TIME(al.timestamp)',             label: 'Hora' },
      type:            { sql: 'al.type',                        label: 'Tipo (in/out)' },
      source:          { sql: 'al.source',                      label: 'Origen' },
    },
    dateField: 'al.timestamp',
  },
  daily_summary: {
    base: 'daily_summary ds',
    joins: [
      'JOIN employees e ON e.id = ds.employee_id',
      'LEFT JOIN departments d ON d.id = e.department_id',
    ],
    fields: {
      employee_code:    { sql: 'e.code',                          label: 'Código' },
      employee_name:    { sql: "CONCAT(e.first_name,' ',e.last_name)", label: 'Empleado' },
      department:       { sql: 'd.name',                          label: 'Departamento' },
      date:             { sql: 'ds.date',                         label: 'Fecha' },
      first_in:         { sql: 'ds.first_in',                     label: 'Primera entrada' },
      last_out:         { sql: 'ds.last_out',                     label: 'Última salida' },
      worked_minutes:   { sql: 'ds.worked_minutes',               label: 'Min. trabajados' },
      worked_hours:     { sql: 'ROUND(ds.worked_minutes / 60, 2)', label: 'Horas trabajadas' },
      late_minutes:     { sql: 'ds.late_minutes',                 label: 'Min. tardanza' },
      overtime_minutes: { sql: 'ds.overtime_minutes',             label: 'Min. extra' },
      status:           { sql: 'ds.status',                       label: 'Estado' },
      justification:    { sql: 'ds.justification',                label: 'Justificación' },
    },
    dateField: 'ds.date',
  },
  permissions: {
    base: 'permissions p',
    joins: [
      'JOIN employees e ON e.id = p.employee_id',
      'LEFT JOIN departments d ON d.id = e.department_id',
    ],
    fields: {
      employee_code:  { sql: 'e.code',                          label: 'Código' },
      employee_name:  { sql: "CONCAT(e.first_name,' ',e.last_name)", label: 'Empleado' },
      department:     { sql: 'd.name',                          label: 'Departamento' },
      type:           { sql: 'p.type',                          label: 'Tipo' },
      date_from:      { sql: 'p.date_from',                     label: 'Desde' },
      date_to:        { sql: 'p.date_to',                       label: 'Hasta' },
      days:           { sql: 'DATEDIFF(p.date_to, p.date_from) + 1', label: 'Días' },
      status:         { sql: 'p.status',                        label: 'Estado' },
      reason:         { sql: 'p.reason',                        label: 'Motivo' },
      created_at:     { sql: 'p.created_at',                    label: 'Creado' },
    },
    dateField: 'p.date_from',
  },
  employees: {
    base: 'employees e',
    joins: [
      'LEFT JOIN departments d ON d.id = e.department_id',
      'LEFT JOIN branches b ON b.id = e.branch_id',
      'LEFT JOIN schedules s ON s.id = e.schedule_id',
    ],
    fields: {
      code:           { sql: 'e.code',                          label: 'Código' },
      employee_name:  { sql: "CONCAT(e.first_name,' ',e.last_name)", label: 'Empleado' },
      document:       { sql: 'e.employee_number',               label: 'Cédula' },
      department:     { sql: 'd.name',                          label: 'Departamento' },
      branch:         { sql: 'b.name',                          label: 'Sede' },
      schedule:       { sql: 's.name',                          label: 'Horario' },
      position:       { sql: 'e.position',                      label: 'Cargo' },
      email:          { sql: 'e.email',                         label: 'Email' },
      phone:          { sql: 'e.phone',                         label: 'Teléfono' },
      hire_date:      { sql: 'e.hire_date',                     label: 'Fecha ingreso' },
      birth_date:     { sql: 'e.birth_date',                    label: 'Nacimiento' },
      status:         { sql: 'e.status',                        label: 'Estado' },
    },
    dateField: 'e.hire_date',
  },
};

// GET /api/reports-builder/sources — devuelve catálogo
router.get('/sources', (_req, res) => {
  const out = {};
  for (const [key, def] of Object.entries(SOURCES)) {
    out[key] = {
      fields: Object.fromEntries(Object.entries(def.fields).map(([k, v]) => [k, v.label])),
    };
  }
  res.json({ ok: true, sources: out });
});

// Construir query a partir de definición segura
function buildQuery({ source, fields, filters = {}, groupBy = null, orderBy = null, limit = 1000 }) {
  const def = SOURCES[source];
  if (!def) throw new Error(`source inválido: ${source}`);

  const validFields = Object.keys(def.fields);
  const useFields = (fields && fields.length ? fields : validFields).filter(f => validFields.includes(f));
  if (!useFields.length) throw new Error('Debe seleccionar al menos un campo');

  // SELECT con alias seguros
  const selects = useFields.map(f => `${def.fields[f].sql} AS \`${f}\``);

  // GROUP BY
  let group = '';
  if (groupBy && validFields.includes(groupBy)) {
    // Si hay agrupación, los campos numéricos se agregan SUM, los strings se quedan en el campo de groupBy
    const aggSelects = useFields.map(f => {
      if (f === groupBy) return `${def.fields[f].sql} AS \`${f}\``;
      const sql = def.fields[f].sql;
      if (/minutes|hours|days/i.test(f)) return `SUM(${sql}) AS \`${f}\``;
      return `MAX(${sql}) AS \`${f}\``;
    });
    selects.length = 0;
    selects.push(...aggSelects);
    group = `GROUP BY ${def.fields[groupBy].sql}`;
  }

  // WHERE
  const whereParts = [];
  const params = [];

  if (filters.date_from && def.dateField) {
    whereParts.push(`DATE(${def.dateField}) >= ?`);
    params.push(filters.date_from);
  }
  if (filters.date_to && def.dateField) {
    whereParts.push(`DATE(${def.dateField}) <= ?`);
    params.push(filters.date_to);
  }
  if (filters.dept_id && validFields.includes('department')) {
    whereParts.push('d.id = ?');
    params.push(parseInt(filters.dept_id, 10));
  }
  if (filters.employee_id) {
    whereParts.push('e.id = ?');
    params.push(parseInt(filters.employee_id, 10));
  }
  if (filters.status && validFields.includes('status')) {
    whereParts.push(`${def.fields.status.sql} = ?`);
    params.push(filters.status);
  }
  if (filters.type && validFields.includes('type')) {
    whereParts.push(`${def.fields.type.sql} = ?`);
    params.push(filters.type);
  }

  // employees: solo activos por default
  if (source === 'employees' && !filters.include_inactive) {
    whereParts.push("e.status = 'active'");
  }

  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  // ORDER BY
  let order = '';
  if (orderBy && validFields.includes(orderBy)) {
    order = `ORDER BY \`${orderBy}\``;
  } else if (def.dateField) {
    order = `ORDER BY ${def.dateField} DESC`;
  }

  // LIMIT
  const safeLimit = Math.min(parseInt(limit, 10) || 1000, 5000);

  const sql = `
    SELECT ${selects.join(', ')}
    FROM ${def.base}
    ${def.joins.join(' ')}
    ${where}
    ${group}
    ${order}
    LIMIT ${safeLimit}
  `;

  return { sql, params, useFields, def };
}

// POST /api/reports-builder/preview
router.post('/preview', async (req, res) => {
  // buildQuery lanza errores de validación (source/campos inválidos) que SÍ
  // deben informarse al cliente (4xx). Un fallo posterior de BD es un 5xx y no
  // debe filtrar err.message crudo: se loguea en servidor y se responde genérico.
  let built;
  try {
    built = buildQuery(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    const { sql, params, useFields, def } = built;
    const [rows] = await sequelize.query(sql, { replacements: params });
    const headers = useFields.map(f => def.fields[f].label);
    res.json({ ok: true, count: rows.length, fields: useFields, headers, rows });
  } catch (err) {
    logInternalError(logger, { event: 'reports-builder POST /preview', route: 'reports-builder POST /preview', err });
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/reports-builder/export?format=csv|xlsx
router.post('/export', async (req, res) => {
  const format = (req.query.format || req.body.format || 'xlsx').toLowerCase();
  // Igual que /preview: validación → 4xx con mensaje; fallo de BD/generación → 5xx genérico.
  let built;
  try {
    built = buildQuery(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    const { sql, params, useFields, def } = built;
    const [rows] = await sequelize.query(sql, { replacements: params });
    const headers = useFields.map(f => def.fields[f].label);
    const fname = `reporte_${req.body.source || 'custom'}_${new Date().toISOString().slice(0,10)}`;

    if (format === 'csv') {
      const esc = v => /[;"\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '');
      const out = [
        headers.join(';'),
        ...rows.map(r => useFields.map(f => esc(r[f])).join(';')),
      ].join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}.csv"`);
      return res.send('﻿' + out);
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Reporte');
    ws.columns = useFields.map((f, i) => ({ header: headers[i], key: f, width: 18 }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
    rows.forEach(r => ws.addRow(r));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    logInternalError(logger, { event: 'reports-builder POST /export', route: 'reports-builder POST /export', err });
    // Si el fallo ocurre DESPUÉS de enviar headers (streaming del xlsx), no se
    // puede responder JSON: se destruye la conexión de forma controlada para que
    // el cliente vea un error de red y no un archivo truncado 'válido'.
    if (!res.headersSent) res.status(500).json({ error: 'Error interno' });
    else res.destroy();
  }
});

module.exports = router;
