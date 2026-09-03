/**
 * payrollExport.js — Dataset canónico de nómina/asistencia para integración con
 * CUALQUIER sistema de nómina externo, serializable a CSV, XLSX y JSON.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * PROPÓSITO
 * ═══════════════════════════════════════════════════════════════════════
 * Arma UN dataset estable y versionado por empleado para un período mensual, y
 * lo serializa idénticamente a CSV / XLSX / JSON. La misma información, las
 * mismas filas y los mismos valores en los tres formatos, para que un ERP de
 * nómina pueda consumir el que le sea más cómodo (archivo o API).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CONSISTENCIA CON EL REPORTE MENSUAL — HORAS TRABAJADAS POR EL MOTOR
 * ═══════════════════════════════════════════════════════════════════════
 * Las horas trabajadas NO salen de `SUM(daily_summary.worked_minutes)`. Esa
 * columna la escribe el motor LEGACY por FECHA CIVIL y parte en dos los turnos
 * nocturnos que cruzan medianoche. Acá el trabajado se calcula con el MISMO
 * motor y el mismo camino de lectura que usa Marcadas / el reporte mensual
 * (`monthlyWorkedByEmployee`), así un nocturno cuenta como UN jornal atribuido
 * al día en que empezó. Es SÓLO LECTURA: no toca `daily_summary`, `attendance_logs`
 * ni ningún flag.
 *
 * Los conteos de estado (días trabajados, ausencias), el atraso y las horas
 * extra siguen viniendo de `daily_summary`, igual que el reporte mensual.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ESQUEMA CANÓNICO (schema_version) Y UNIDADES
 * ═══════════════════════════════════════════════════════════════════════
 * schema_version = '1.0'. Campos por empleado (orden estable):
 *   - codigo             (string)  employees.code
 *   - documento          (string)  employees.document_number ('' si no hay)
 *   - nombre             (string)  "first_name last_name"
 *   - departamento       (string)  departments.name ('' si no hay)
 *   - dias_trabajados    (int)     días con status present|late [unidad: días]
 *   - minutos_trabajados (int)     trabajado del mes por el MOTOR [unidad: minutos]
 *   - horas_trabajadas   (num,2)   minutos_trabajados / 60 [unidad: horas]
 *   - minutos_extra      (int)     SUM(overtime_minutes) [unidad: minutos]
 *   - horas_extra        (num,2)   minutos_extra / 60 [unidad: horas]
 *   - atrasos_min        (int)     SUM(late_minutes) [unidad: minutos]
 *   - ausencias          (int)     días con status absent [unidad: días]
 *   - salario_base       (num)     employees.salary_base — SÓLO si el llamador
 *                                  está autorizado a ver montos (ver RBAC).
 *
 * La columna `salario_base` sólo existe en el dataset (y por lo tanto en el CSV,
 * el XLSX y el JSON) cuando `includeAmounts` es true. Cuando es false, ninguna
 * de las tres salidas la incluye. Así un consumidor sin autorización para montos
 * recibe exactamente los mismos identificadores + horas/asistencia, sin salarios.
 */

'use strict';

const ExcelJS = require('exceljs');
const { sequelize } = require('../config/database');
const { monthlyWorkedByEmployee } = require('./monthlyWorkedFromEngine');

const SCHEMA_VERSION = '1.0';

/** Columnas canónicas SIN montos (orden estable). */
const CANONICAL_COLUMNS = [
  'codigo',
  'documento',
  'nombre',
  'departamento',
  'dias_trabajados',
  'minutos_trabajados',
  'horas_trabajadas',
  'minutos_extra',
  'horas_extra',
  'atrasos_min',
  'ausencias',
];

/** Columna monetaria adicional (sólo cuando includeAmounts). */
const AMOUNT_COLUMN = 'salario_base';

/** Etiquetas legibles para el encabezado XLSX. */
const COLUMN_LABELS = {
  codigo: 'Código',
  documento: 'Documento',
  nombre: 'Nombre',
  departamento: 'Departamento',
  dias_trabajados: 'Días trabajados',
  minutos_trabajados: 'Minutos trabajados',
  horas_trabajadas: 'Horas trabajadas',
  minutos_extra: 'Minutos extra',
  horas_extra: 'Horas extra',
  atrasos_min: 'Atrasos (min)',
  ausencias: 'Ausencias',
  salario_base: 'Salario base',
};

/** Descripción de unidades por campo (metadato para el consumidor externo). */
const UNITS = {
  dias_trabajados: 'days',
  minutos_trabajados: 'minutes',
  horas_trabajadas: 'hours (= minutos_trabajados / 60, 2 decimals)',
  minutos_extra: 'minutes',
  horas_extra: 'hours (= minutos_extra / 60, 2 decimals)',
  atrasos_min: 'minutes',
  ausencias: 'days',
  salario_base: 'currency amount (moneda local, sin conversión)',
};

/**
 * ¿Puede este usuario exportar MONTOS (salario_base)?
 *
 * El endpoint de export ya exige rol admin/hr/gth (+ super_admin) y permiso
 * `nomina.view` para acceder a horas/asistencia. Los montos son sensibles y se
 * acotan aún más: sólo super_admin, admin y hr los ven. `gth` obtiene la
 * planilla de horas/asistencia (que es lo esencial para nómina) pero NO los
 * salarios. Un rol fuera de ese conjunto no llega siquiera al endpoint.
 */
function canSeeAmounts(user) {
  return !!user && ['super_admin', 'admin', 'hr'].includes(user.role);
}

/** Redondeo a 2 decimales, tolerante a null. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function monthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  // Último día del mes SIN pasar por toISOString(): `new Date(y, m, 0)` es el
  // último día del mes m (medianoche local); tomar su día del mes evita el
  // corrimiento de fecha en zonas con offset UTC positivo (p.ej. Asia/Tokyo).
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

/**
 * Construye el dataset canónico del período.
 *
 * @param {object} opts
 * @param {number} opts.year
 * @param {number} opts.month           1..12
 * @param {number|null} [opts.departmentId]  filtro opcional por departamento
 * @param {boolean} [opts.includeAmounts]    incluir salario_base (RBAC del caller)
 * @returns {Promise<object>} dataset { schema_version, generated_at, period,
 *   filters, includes_amounts, units, columns, count, rows }
 */
async function buildPayrollDataset({ year, month, departmentId = null, includeAmounts = false } = {}) {
  const { from, to } = monthRange(year, month);

  const deptFilter = departmentId ? ' AND e.department_id = ?' : '';
  const params = departmentId ? [from, to, departmentId] : [from, to];

  // Agregado por empleado desde daily_summary. NO se suma worked_minutes acá:
  // ese total lo pone el motor (nocturno correcto) más abajo.
  const [base] = await sequelize.query(
    `
    SELECT
      e.id,
      e.code                                   AS codigo,
      COALESCE(e.document_number, '')          AS documento,
      CONCAT(e.first_name, ' ', e.last_name)   AS nombre,
      COALESCE(d.name, '')                     AS departamento,
      COALESCE(e.salary_base, 0)               AS salario_base,
      SUM(CASE WHEN ds.status IN ('present','late') THEN 1 ELSE 0 END) AS dias_trabajados,
      SUM(COALESCE(ds.overtime_minutes, 0))    AS minutos_extra,
      SUM(COALESCE(ds.late_minutes, 0))        AS atrasos_min,
      SUM(CASE WHEN ds.status = 'absent' THEN 1 ELSE 0 END)           AS ausencias
    FROM employees e
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN daily_summary ds ON ds.employee_id = e.id AND ds.date BETWEEN ? AND ?
    WHERE e.status = 'active'${deptFilter}
    GROUP BY e.id
    ORDER BY departamento, e.last_name, e.first_name
    `,
    { replacements: params },
  );

  // Trabajado del mes por el MOTOR (sólo lectura, nocturno correcto).
  const engineWorked = await monthlyWorkedByEmployee(base.map((r) => r.id), { from, to });

  const columns = includeAmounts ? [...CANONICAL_COLUMNS, AMOUNT_COLUMN] : [...CANONICAL_COLUMNS];

  const rows = base.map((r) => {
    const agg = engineWorked.get(Number(r.id));
    const minutosTrab = agg ? agg.workedMinutes : 0;
    const minutosExtra = Number(r.minutos_extra) || 0;

    const row = {
      codigo: String(r.codigo ?? ''),
      documento: String(r.documento ?? ''),
      nombre: String(r.nombre ?? ''),
      departamento: String(r.departamento ?? ''),
      dias_trabajados: Number(r.dias_trabajados) || 0,
      minutos_trabajados: minutosTrab,
      horas_trabajadas: round2(minutosTrab / 60),
      minutos_extra: minutosExtra,
      horas_extra: round2(minutosExtra / 60),
      atrasos_min: Number(r.atrasos_min) || 0,
      ausencias: Number(r.ausencias) || 0,
    };
    if (includeAmounts) row.salario_base = Number(r.salario_base) || 0;
    return row;
  });

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    period: { year: Number(year), month: Number(month), from, to },
    filters: { department_id: departmentId ? Number(departmentId) : null },
    includes_amounts: !!includeAmounts,
    units: Object.fromEntries(columns.filter((c) => UNITS[c]).map((c) => [c, UNITS[c]])),
    columns,
    count: rows.length,
    rows,
  };
}

/**
 * Escapa un valor para CSV RFC-4180 (separador coma). Entrecomilla si el valor
 * contiene coma, comilla doble, CR o LF; duplica las comillas internas.
 */
function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serializa el dataset a CSV RFC-4180: separador coma, terminador CRLF, BOM
 * UTF-8 al inicio. El encabezado son las claves canónicas (`columns`).
 */
function toCsv(dataset) {
  const { columns, rows } = dataset;
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * Construye un Workbook ExcelJS con una hoja "Nómina" y una fila de metadatos
 * del período. Devuelve el workbook (el caller decide cómo escribirlo).
 */
function buildWorkbook(dataset) {
  const { columns, rows, period } = dataset;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Gestion_Horas';
  wb.created = new Date();
  const ws = wb.addWorksheet(`Nómina ${period.year}-${String(period.month).padStart(2, '0')}`);

  ws.columns = columns.map((c) => ({
    header: COLUMN_LABELS[c] || c,
    key: c,
    width: c === 'nombre' ? 30 : c === 'departamento' ? 22 : 16,
  }));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };

  for (const row of rows) ws.addRow(row);
  return wb;
}

/** Buffer XLSX (útil para tests y para enviar por adjunto). */
async function toXlsxBuffer(dataset) {
  const wb = buildWorkbook(dataset);
  return wb.xlsx.writeBuffer();
}

module.exports = {
  SCHEMA_VERSION,
  CANONICAL_COLUMNS,
  AMOUNT_COLUMN,
  COLUMN_LABELS,
  UNITS,
  canSeeAmounts,
  buildPayrollDataset,
  toCsv,
  csvEscape,
  buildWorkbook,
  toXlsxBuffer,
};
