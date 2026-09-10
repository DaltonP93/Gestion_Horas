/**
 * payslip.test.js — Motor del recibo de sueldo (services/payslip.js).
 *
 * Verifica que computePayslip reutiliza computeLiquidacion produciendo
 * haberes, descuentos, bruto y neto, y que el PDF contiene los conceptos,
 * el disclaimer y el neto. No toca la BD real (sequelize mockeado).
 */

const {
  formatGs, computeDiasTrabajados, computePayslip, buildPayslipPdf, DISCLAIMER,
} = require('../src/services/payslip');

// ── Mock inteligente de sequelize.query por contenido del SQL ────────
function makeSequelize(scenario) {
  const calls = [];
  const query = jest.fn(async (sql, opts) => {
    calls.push({ sql, opts });
    const rep = opts?.replacements || [];
    if (/INSERT INTO employee_documents/i.test(sql)) return [{ insertId: 777 }];
    if (/setting_key LIKE 'employer_%'/.test(sql)) return [scenario.employer || []];
    if (/mtess_dias_base_mensual/.test(sql) && /mtess_dias_descuento_tipos/.test(sql)) return [scenario.mtess || []];
    if (/att_overtime_requires_auth/.test(sql)) return [scenario.otCfg || []];
    if (/FROM holidays/.test(sql)) return [scenario.holidays || []];
    if (/FROM employees e/.test(sql) && /daily_summary/.test(sql)) {
      const id = rep[2];
      const rows = (scenario.grid && scenario.grid[id]) || [];
      return [rows];
    }
    if (/notification_settings/.test(sql) && /IN \(\?/.test(sql)) return [scenario.rates || []]; // getLiquidacionRates
    if (/FROM users WHERE id/.test(sql)) return [[{ employee_id: scenario.userEmp ?? null }]];
    return [[]];
  });
  return { sequelize: { query }, calls };
}

// Fila del grid (empleado + un día opcional de daily_summary).
function empRow(overrides = {}) {
  return {
    id: 5, code: 'E005', first_name: 'Ana', last_name: 'Pérez',
    document_number: '1234567', ips_number: 'IPS-9', position: 'Analista',
    salary_base: 3000000, pay_type: 'mensualizado', children_count: 0,
    antiguedad_rate: 0, hire_date: null, status: 'active',
    work_days: '2,3,4,5,6', department: 'Administración',
    date: null, ds_status: null, first_in: null, last_out: null,
    justification_type: null, worked_minutes: null, overtime_minutes: null, ot_status: null,
    ...overrides,
  };
}

describe('formatGs', () => {
  test('agrupa miles con puntos', () => {
    expect(formatGs(3000000)).toBe('3.000.000');
    expect(formatGs(270000)).toBe('270.000');
    expect(formatGs(0)).toBe('0');
    expect(formatGs(-5000)).toBe('-5.000');
    expect(formatGs(null)).toBe('0');
  });
});

describe('computeDiasTrabajados', () => {
  test('mensualizado sin ausencias → base completa (30)', () => {
    const emp = { pay_type: 'mensualizado', days: {} };
    expect(computeDiasTrabajados(emp, { base: 30, discountTypes: [] }).dias).toBe(30);
  });
  test('mensualizado con ausencia injustificada descuenta', () => {
    const emp = { pay_type: 'mensualizado', days: {
      3: { status: 'absent', jtype: '', working: true },
    } };
    expect(computeDiasTrabajados(emp, { base: 30, discountTypes: [] }).dias).toBe(29);
  });
  test('jornalero → días presentes', () => {
    const emp = { pay_type: 'jornalero', presentDays: 12, days: {} };
    expect(computeDiasTrabajados(emp, { base: 30, discountTypes: [] }).dias).toBe(12);
  });
});

describe('computePayslip', () => {
  test('mensualizado sin marcaciones → básico completo, IPS 9%, bruto y neto', async () => {
    const { sequelize } = makeSequelize({ grid: { 5: [empRow()] } });
    const data = await computePayslip(sequelize, { employeeId: 5, year: 2026, month: 7 });
    expect(data).not.toBeNull();
    const liq = data.liquidacion;
    expect(liq.basico).toBe(3000000);
    expect(liq.aporte_obrero).toBe(270000);      // 9% de 3.000.000
    expect(liq.total_bruto).toBe(3000000);
    expect(liq.total_neto).toBe(2730000);
    expect(data.employee.name).toBe('Pérez, Ana');
    expect(data.period.label).toBe('Julio 2026');
    expect(data.dias.dias).toBe(30);
  });

  test('empleado inexistente → null (grid vacío)', async () => {
    const { sequelize } = makeSequelize({ grid: {} });
    const data = await computePayslip(sequelize, { employeeId: 999, year: 2026, month: 7 });
    expect(data).toBeNull();
  });

  test('período sin datos de asistencia no rompe (empleado existe)', async () => {
    const { sequelize } = makeSequelize({ grid: { 5: [empRow({ date: null })] } });
    const data = await computePayslip(sequelize, { employeeId: 5, year: 2026, month: 2 });
    expect(data).not.toBeNull();
    expect(data.liquidacion.total_neto).toBeGreaterThan(0);
  });
});

describe('buildPayslipPdf', () => {
  // pdfkit aplica kerning (TJ) sobre las fuentes estándar, por lo que el texto
  // no es grepeable en el binario; igual que los demás tests de PDF del repo
  // (planillaMensualPdf, marcadasPdf) se valida la estructura del documento.
  // El detalle de conceptos/descuentos/bruto/neto se verifica arriba a nivel
  // de datos (computePayslip), que es la fuente del contenido del PDF.
  async function render(data) {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise(r => doc.on('end', () => r(Buffer.concat(chunks))));
    buildPayslipPdf(doc, data);
    doc.end();
    return await done;
  }

  test('produce un PDF A4 válido y no vacío', async () => {
    const { sequelize } = makeSequelize({ grid: { 5: [empRow()] } });
    const data = await computePayslip(sequelize, { employeeId: 5, year: 2026, month: 7 });
    const buf = await render(data);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1000);
    // A4 vertical = 595.28 × 841.89 pt.
    expect(buf.toString('latin1')).toMatch(/MediaBox\s*\[0 0 595\.28 841\.89\]/);
  });

  test('no explota con montos en cero (empleado sin salario base)', async () => {
    const { sequelize } = makeSequelize({ grid: { 5: [empRow({ salary_base: 0 })] } });
    const data = await computePayslip(sequelize, { employeeId: 5, year: 2026, month: 7 });
    expect(data.liquidacion.total_neto).toBe(0);
    const buf = await render(data);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('el disclaimer aclara que no es liquidación certificada ni cubre IRP', () => {
    expect(DISCLAIMER).toMatch(/no constituye liquidación legal certificada/i);
    expect(DISCLAIMER).toMatch(/IRP/);
  });
});
