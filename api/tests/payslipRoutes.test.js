/**
 * payslipRoutes.test.js — Control de acceso y flujo HTTP del recibo de sueldo.
 *
 * Invariante crítica: un empleado sólo obtiene SU propio recibo; el de otro
 * devuelve 403 sin exponer ningún monto. RR.HH./admin obtienen cualquiera.
 * Además: el atajo self-service /api/me/payslip/pdf y el publish manual que
 * inserta en employee_documents.
 *
 * El rol/employee_id del solicitante se inyecta por cabeceras de test
 * (x-test-role / x-test-emp) desde el mock de authenticate.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// UPLOAD_DIR temporal ANTES de requerir los routers (se lee en load).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payslip-test-'));
process.env.UPLOAD_DIR = TMP;

// ── Mock de la BD: query inteligente por contenido del SQL ───────────
const insertCalls = [];
let gridFor = { 5: true }; // employee_id existentes por defecto

function empRow(id) {
  return {
    id, code: `E00${id}`, first_name: 'Ana', last_name: 'Pérez',
    document_number: '1234567', ips_number: 'IPS-9', position: 'Analista',
    salary_base: 3000000, pay_type: 'mensualizado', children_count: 0,
    antiguedad_rate: 0, hire_date: null, status: 'active',
    work_days: '2,3,4,5,6', department: 'Administración',
    date: null, ds_status: null, first_in: null, last_out: null,
    justification_type: null, worked_minutes: null, overtime_minutes: null, ot_status: null,
  };
}

const mockQuery = jest.fn(async (sql, opts) => {
  const rep = opts?.replacements || [];
  if (/INSERT INTO employee_documents/i.test(sql)) { insertCalls.push({ sql, rep }); return [{ insertId: 777 }]; }
  if (/setting_key LIKE 'employer_%'/.test(sql)) return [[]];
  if (/mtess_dias_base_mensual/.test(sql) && /mtess_dias_descuento_tipos/.test(sql)) return [[]];
  if (/att_overtime_requires_auth/.test(sql)) return [[]];
  if (/FROM holidays/.test(sql)) return [[]];
  if (/FROM employees e/.test(sql) && /daily_summary/.test(sql)) {
    const id = rep[2];
    return [gridFor[id] ? [empRow(id)] : []];
  }
  if (/notification_settings/.test(sql) && /IN \(\?/.test(sql)) return [[]];
  if (/FROM users WHERE id/.test(sql)) return [[{ employee_id: null }]];
  return [[]];
});

jest.mock('../src/config/database', () => ({
  sequelize: { query: (...a) => mockQuery(...a) },
  DB_TIMEZONE: '-03:00',
}));
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
jest.mock('../src/services/audit', () => ({ log: () => {} }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    const role = req.headers['x-test-role'] || 'employee';
    const emp = req.headers['x-test-emp'];
    req.user = { id: 99, role, employee_id: emp ? Number(emp) : null };
    next();
  },
  authorize: (...roles) => (req, res, next) => {
    if (req.user.role === 'super_admin') return next();
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Sin permisos' });
    next();
  },
  requirePermission: () => (_req, _res, next) => next(),
}));

const express = require('express');
const http = require('http');
const payslipRoutes = require('../src/routes/payslip');
const legalPayslipsRoutes = require('../src/routes/legalPayslips');
const meRoutes = require('../src/routes/me');

let server, base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/employees/:id/payslip', payslipRoutes);
  app.use('/api/legal/payslips', legalPayslipsRoutes);
  app.use('/api/me', meRoutes);
  server = http.createServer(app).listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
beforeEach(() => { insertCalls.length = 0; gridFor = { 5: true, 6: true }; });

function req(method, urlPath, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request(base + urlPath, { method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

describe('GET /api/employees/:id/payslip/pdf — control de acceso', () => {
  test('empleado pide SU propio recibo → 200 PDF', async () => {
    const { status, ct, buf } = await req('GET', '/api/employees/5/payslip/pdf?year=2026&month=7',
      { 'x-test-role': 'employee', 'x-test-emp': '5' });
    expect(status).toBe(200);
    expect(ct).toMatch(/application\/pdf/);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1000);
  });

  test('empleado pide el recibo de OTRO → 403 y sin montos', async () => {
    const { status, ct, buf } = await req('GET', '/api/employees/6/payslip/pdf?year=2026&month=7',
      { 'x-test-role': 'employee', 'x-test-emp': '5' });
    expect(status).toBe(403);
    expect(ct).not.toMatch(/application\/pdf/);
    const body = buf.toString('utf8');
    expect(body).not.toMatch(/\d{1,3}(\.\d{3})+/); // ningún monto con separador de miles
    expect(body).not.toMatch(/3000000|2730000|270000/);
  });

  test('admin pide el de cualquiera → 200', async () => {
    const { status } = await req('GET', '/api/employees/6/payslip/pdf?year=2026&month=7',
      { 'x-test-role': 'admin' });
    expect(status).toBe(200);
  });

  test('hr pide el de cualquiera → 200', async () => {
    const { status } = await req('GET', '/api/employees/6/payslip/pdf?year=2026&month=7',
      { 'x-test-role': 'hr' });
    expect(status).toBe(200);
  });

  test('gth pide el de cualquiera → 200', async () => {
    const { status } = await req('GET', '/api/employees/6/payslip/pdf?year=2026&month=7',
      { 'x-test-role': 'gth' });
    expect(status).toBe(200);
  });

  test('empleado inexistente (admin) → 404', async () => {
    gridFor = {}; // ningún empleado
    const { status } = await req('GET', '/api/employees/999/payslip/pdf?year=2026&month=7',
      { 'x-test-role': 'admin' });
    expect(status).toBe(404);
  });

  test('empleado sin employee_id vinculado pidiendo otro id → 403', async () => {
    const { status } = await req('GET', '/api/employees/5/payslip/pdf',
      { 'x-test-role': 'employee' }); // sin x-test-emp → fallback devuelve null
    expect(status).toBe(403);
  });
});

describe('GET /api/me/payslip/pdf — atajo self-service', () => {
  test('empleado logueado obtiene su recibo → 200 PDF', async () => {
    const { status, ct, buf } = await req('GET', '/api/me/payslip/pdf?year=2026&month=7',
      { 'x-test-role': 'employee', 'x-test-emp': '5' });
    expect(status).toBe(200);
    expect(ct).toMatch(/application\/pdf/);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('usuario sin empleado vinculado → 400', async () => {
    const { status } = await req('GET', '/api/me/payslip/pdf',
      { 'x-test-role': 'employee' });
    expect(status).toBe(400);
  });
});

describe('POST /api/legal/payslips/publish — publicación manual', () => {
  test('admin publica → 201 e inserta en employee_documents (payslip)', async () => {
    const { status, buf } = await req('POST', '/api/legal/payslips/publish',
      { 'x-test-role': 'admin' }, { employee_id: 5, year: 2026, month: 7 });
    expect(status).toBe(201);
    const body = JSON.parse(buf.toString('utf8'));
    expect(body.category).toBe('payslip');
    expect(body.period).toBe('2026-07');
    expect(body.id).toBe(777);
    // Se insertó exactamente una fila en employee_documents.
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].sql).toMatch(/INSERT INTO employee_documents/);
    expect(insertCalls[0].rep).toContain('2026-07');   // period
    expect(insertCalls[0].rep).toContain(5);           // employee_id
    // El archivo PDF quedó escrito en el repositorio de documentos.
    const files = fs.readdirSync(path.join(TMP, 'employee-documents'));
    expect(files.some(f => f.startsWith('payslip_5_2026-07'))).toBe(true);
  });

  test('empleado común NO puede publicar → 403', async () => {
    const { status } = await req('POST', '/api/legal/payslips/publish',
      { 'x-test-role': 'employee', 'x-test-emp': '5' }, { employee_id: 5, year: 2026, month: 7 });
    expect(status).toBe(403);
    expect(insertCalls.length).toBe(0);
  });

  test('empleado inexistente → 404, sin insertar', async () => {
    gridFor = {};
    const { status } = await req('POST', '/api/legal/payslips/publish',
      { 'x-test-role': 'admin' }, { employee_id: 999, year: 2026, month: 7 });
    expect(status).toBe(404);
    expect(insertCalls.length).toBe(0);
  });
});
