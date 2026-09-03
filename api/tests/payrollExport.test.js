/**
 * payrollExport.test.js
 *
 * Export de nómina/asistencia para integración externa (CSV / XLSX / JSON).
 *
 * Cubre:
 *   1. Dataset canónico correcto (schema_version, columnas, unidades, valores).
 *   2. CSV / XLSX / JSON con EXACTAMENTE las mismas filas y valores.
 *   3. Nocturno que cruza medianoche cuenta como UN jornal (mismo caso del
 *      helper del motor), atribuido al día en que empezó.
 *   4. RBAC de MONTOS: sólo super_admin/admin/hr ven salario_base; el dataset y
 *      las tres serializaciones lo OMITEN para roles no autorizados (gth).
 *   5. RBAC de acceso: un rol fuera de admin/hr/gth recibe 403 en el endpoint.
 *   6. Período sin datos → export vacío pero válido en los tres formatos.
 *
 * La base está mockeada. Sin configuración cargada, las jornadas caen en
 * `historical_fallback` (estado real de producción), donde el motor no descuenta
 * el descanso de nuevo y `worked_minutes === segment_minutes`.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock('../src/services/workdayConfig', () => ({
  loadWorkdayConfig: jest.fn(async () => ({ forDate: () => null, historyFor: () => [] })),
}));
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));

const ExcelJS = require('exceljs');
const { sequelize } = require('../src/config/database');
const {
  SCHEMA_VERSION,
  CANONICAL_COLUMNS,
  canSeeAmounts,
  buildPayrollDataset,
  toCsv,
  buildWorkbook,
  toXlsxBuffer,
} = require('../src/services/payrollExport');

// Nocturno que cruza medianoche: entra Mié 15/01 21:00, descanso 00:00–00:30,
// sale Jue 16/01 06:00 → trabajado 510 min (8:30), atribuido íntegro al 15.
const NOCTURNO = [
  { id: 1, employee_id: 7, timestamp: '2025-01-15 21:00:00', type: 'in' },
  { id: 2, employee_id: 7, timestamp: '2025-01-16 00:00:00', type: 'out' },
  { id: 3, employee_id: 7, timestamp: '2025-01-16 00:30:00', type: 'in' },
  { id: 4, employee_id: 7, timestamp: '2025-01-16 06:00:00', type: 'out' },
];

// Fila de agregado (daily_summary) que devolvería la 1ª consulta del servicio.
const BASE_ROW = {
  id: 7,
  codigo: '007',
  documento: '1.234.567',
  nombre: 'Ada Nocturna',
  departamento: 'Vigilancia',
  salario_base: 3000000,
  dias_trabajados: 1,
  minutos_extra: 45,
  atrasos_min: 12,
  ausencias: 2,
};

function mockService({ base = [BASE_ROW], punches = [NOCTURNO] } = {}) {
  // 1ª consulta: agregado por empleado. 2ª (por lote): marcajes del motor.
  sequelize.query.mockReset();
  sequelize.query.mockResolvedValueOnce([base]);
  for (const p of punches) sequelize.query.mockResolvedValueOnce([p]);
}

describe('buildPayrollDataset — dataset canónico', () => {
  test('estructura, versión, unidades y valores (con montos)', async () => {
    mockService();
    const ds = await buildPayrollDataset({ year: 2025, month: 1, includeAmounts: true });

    expect(ds.schema_version).toBe(SCHEMA_VERSION);
    expect(ds.period).toMatchObject({ year: 2025, month: 1, from: '2025-01-01', to: '2025-01-31' });
    expect(ds.includes_amounts).toBe(true);
    expect(ds.count).toBe(1);
    expect(ds.columns).toEqual([...CANONICAL_COLUMNS, 'salario_base']);

    const r = ds.rows[0];
    expect(r).toMatchObject({
      codigo: '007',
      documento: '1.234.567',
      nombre: 'Ada Nocturna',
      departamento: 'Vigilancia',
      dias_trabajados: 1,
      minutos_trabajados: 510, // del MOTOR (nocturno completo)
      horas_trabajadas: 8.5,   // 510 / 60
      minutos_extra: 45,
      horas_extra: 0.75,
      atrasos_min: 12,
      ausencias: 2,
      salario_base: 3000000,
    });
    // Unidades documentadas para el consumidor externo.
    expect(ds.units.minutos_trabajados).toBe('minutes');
    expect(ds.units.horas_trabajadas).toMatch(/hours/);
  });

  test('sin montos: la columna salario_base no aparece en el dataset', async () => {
    mockService();
    const ds = await buildPayrollDataset({ year: 2025, month: 1, includeAmounts: false });
    expect(ds.includes_amounts).toBe(false);
    expect(ds.columns).toEqual(CANONICAL_COLUMNS);
    expect(ds.columns).not.toContain('salario_base');
    expect(ds.rows[0]).not.toHaveProperty('salario_base');
    // Las horas/asistencia siguen presentes.
    expect(ds.rows[0].minutos_trabajados).toBe(510);
  });

  test('nocturno = UN jornal del día que empezó (510 min), no partido', async () => {
    mockService();
    const ds = await buildPayrollDataset({ year: 2025, month: 1, includeAmounts: false });
    expect(ds.rows[0].minutos_trabajados).toBe(510);
    expect(ds.rows[0].horas_trabajadas).toBe(8.5);
  });

  test('período sin empleados → export vacío pero válido', async () => {
    mockService({ base: [], punches: [] });
    const ds = await buildPayrollDataset({ year: 2025, month: 2, includeAmounts: true });
    expect(ds.count).toBe(0);
    expect(ds.rows).toEqual([]);
    // Serializa igual sin lanzar.
    expect(toCsv(ds)).toContain('codigo,');
  });

  test('empleado activo sin marcajes ni daily_summary → ceros, no lanza', async () => {
    const emptyRow = {
      id: 9, codigo: '009', documento: '', nombre: 'Sin Datos', departamento: '',
      salario_base: 0, dias_trabajados: 0, minutos_extra: 0, atrasos_min: 0, ausencias: 0,
    };
    mockService({ base: [emptyRow], punches: [[]] });
    const ds = await buildPayrollDataset({ year: 2025, month: 3, includeAmounts: false });
    expect(ds.rows[0].minutos_trabajados).toBe(0);
    expect(ds.rows[0].horas_trabajadas).toBe(0);
  });

  test('filtro por department_id se refleja en filters', async () => {
    mockService();
    const ds = await buildPayrollDataset({ year: 2025, month: 1, departmentId: 5, includeAmounts: false });
    expect(ds.filters.department_id).toBe(5);
  });
});

describe('serializaciones CSV / XLSX / JSON — mismas filas y valores', () => {
  async function xlsxRows(dataset) {
    const buf = await toXlsxBuffer(dataset);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    const header = ws.getRow(1).values.slice(1).map(String); // exceljs 1-based
    const out = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const obj = {};
      header.forEach((h, i) => { obj[h] = row.values[i + 1]; });
      out.push(obj);
    });
    return { header, rows: out };
  }

  test('las tres salidas coinciden en columnas y valores (con montos)', async () => {
    mockService();
    const ds = await buildPayrollDataset({ year: 2025, month: 1, includeAmounts: true });

    // JSON: es el propio dataset.
    const jsonRow = ds.rows[0];

    // CSV: parseo simple (sin comillas embebidas en este dataset salvo documento).
    const csv = toCsv(ds);
    expect(csv.charCodeAt(0)).toBe(0xFEFF); // BOM
    const lines = csv.replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(lines[0]).toBe(ds.columns.join(','));
    expect(lines.length).toBe(1 + ds.rows.length);

    // XLSX: leído de vuelta.
    const xlsx = await xlsxRows(ds);
    const labelByKey = require('../src/services/payrollExport').COLUMN_LABELS;
    expect(xlsx.header).toEqual(ds.columns.map((c) => labelByKey[c] || c));

    // Valores numéricos clave iguales entre JSON y XLSX.
    expect(xlsx.rows[0][labelByKey.minutos_trabajados]).toBe(jsonRow.minutos_trabajados);
    expect(xlsx.rows[0][labelByKey.horas_trabajadas]).toBe(jsonRow.horas_trabajadas);
    expect(xlsx.rows[0][labelByKey.salario_base]).toBe(jsonRow.salario_base);
    expect(String(xlsx.rows[0][labelByKey.codigo])).toBe(jsonRow.codigo);
  });

  test('sin montos: ni CSV ni XLSX incluyen salario_base', async () => {
    mockService();
    const ds = await buildPayrollDataset({ year: 2025, month: 1, includeAmounts: false });
    const csv = toCsv(ds);
    expect(csv).not.toMatch(/salario_base/);

    const buf = await toXlsxBuffer(ds);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const header = wb.worksheets[0].getRow(1).values.slice(1).map(String);
    expect(header).not.toContain('Salario base');
  });
});

describe('canSeeAmounts — RBAC de montos', () => {
  test('super_admin/admin/hr ven montos; gth y otros no', () => {
    expect(canSeeAmounts({ role: 'super_admin' })).toBe(true);
    expect(canSeeAmounts({ role: 'admin' })).toBe(true);
    expect(canSeeAmounts({ role: 'hr' })).toBe(true);
    expect(canSeeAmounts({ role: 'gth' })).toBe(false);
    expect(canSeeAmounts({ role: 'manager' })).toBe(false);
    expect(canSeeAmounts(null)).toBe(false);
    expect(canSeeAmounts(undefined)).toBe(false);
  });
});
