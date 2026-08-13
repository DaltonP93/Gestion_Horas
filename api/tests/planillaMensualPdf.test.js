/**
 * GET /api/reports/monthly/export?format=pdf — layout de la planilla mensual.
 *
 * Se levanta el router real en Express y se cuenta cuántas páginas trae el PDF
 * generado. El objetivo del rediseño es "un empleado = una hoja A4 apaisada",
 * y esa propiedad sólo se puede verificar sobre el documento producido: la
 * versión anterior emitía SIEMPRE una segunda página por empleado que
 * contenía únicamente el bloque de firma.
 */

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({
  sequelize: { query: (...a) => mockQuery(...a) },
  DB_TIMEZONE: '-03:00',
}));
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin' }; next(); },
  authorize: () => (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/departmentScope', () => ({
  getVisibleDepartmentIds: async () => ({ unrestricted: true }),
  applyDepartmentScope: (where, params) => ({ where, params }),
  canSeeEmployee: async () => true,
  scopeToClause: () => ({ clause: '', params: [], empty: false }),
}));

const express = require('express');
const http = require('http');
const reportsRouter = require('../src/routes/reports');

/** Filas de daily_summary: `emps` empleados × todos los días del mes. */
function filasDe(emps, year, month) {
  const dias = new Date(year, month, 0).getDate();
  const rows = [];
  for (let e = 1; e <= emps; e++) {
    for (let d = 1; d <= dias; d++) {
      rows.push({
        id: e,
        code: `E${String(e).padStart(3, '0')}`,
        employee_name: `Empleado Número ${e}`,
        department: 'Administración',
        date: new Date(Date.UTC(year, month - 1, d)),
        status: d % 7 === 0 ? 'absent' : (d % 5 === 0 ? 'late' : 'present'),
        first_in:  new Date(Date.UTC(year, month - 1, d, 11, 2)),
        last_out:  new Date(Date.UTC(year, month - 1, d, 20, 5)),
        worked_minutes: 480,
        late_minutes: d % 5 === 0 ? 12 : 0,
        overtime_minutes: d % 9 === 0 ? 45 : 0,
        justification: null,
      });
    }
  }
  return rows;
}

let server, base;
beforeAll((done) => {
  const app = express();
  app.use('/api/reports', reportsRouter);
  server = http.createServer(app).listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

function getPdf(path) {
  return new Promise((resolve, reject) => {
    http.get(base + path, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

/** Cuenta objetos de página en el PDF. */
function contarPaginas(buf) {
  return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
}

describe('planilla mensual en PDF', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  function prepararDatos(emps, year, month) {
    mockQuery
      .mockResolvedValueOnce([filasDe(emps, year, month)])  // daily_summary
      .mockResolvedValueOnce([[]]);                          // settings de firma
  }

  test('★ un empleado = una hoja, con un mes de 31 días', async () => {
    // Es el caso que fallaba: con 31 filas apiladas la firma no entraba nunca
    // y se emitía una segunda página sólo para firmar.
    prepararDatos(1, 2025, 1);
    const { status, buf } = await getPdf('/api/reports/monthly/export?year=2025&month=1&format=pdf');

    expect(status).toBe(200);
    expect(contarPaginas(buf)).toBe(1);
  });

  test('tres empleados = tres hojas, ni una más', async () => {
    prepararDatos(3, 2025, 1);
    const { buf } = await getPdf('/api/reports/monthly/export?year=2025&month=3&format=pdf');
    expect(contarPaginas(buf)).toBe(3);
  });

  test('vale para meses de 28, 30 y 31 días', async () => {
    for (const [year, month] of [[2025, 2], [2025, 4], [2025, 12]]) {
      prepararDatos(2, year, month);
      const { buf } = await getPdf(`/api/reports/monthly/export?year=${year}&month=${month}&format=pdf`);
      expect(contarPaginas(buf)).toBe(2);
    }
  });

  test('febrero bisiesto (29 días) sigue entrando en una hoja', async () => {
    prepararDatos(1, 2024, 2);
    const { buf } = await getPdf('/api/reports/monthly/export?year=2024&month=2&format=pdf');
    expect(contarPaginas(buf)).toBe(1);
  });

  test('sin datos no explota', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
    const { status, buf } = await getPdf('/api/reports/monthly/export?year=2025&month=1&format=pdf');
    expect(status).toBe(200);
    expect(buf.length).toBeGreaterThan(0);
  });

  test('el PDF sale en A4 apaisado', async () => {
    prepararDatos(1, 2025, 1);
    const { buf } = await getPdf('/api/reports/monthly/export?year=2025&month=1&format=pdf');
    // A4 apaisado = 841.89 × 595.28 pt; pdfkit lo escribe en el MediaBox.
    expect(buf.toString('latin1')).toMatch(/MediaBox\s*\[0 0 841\.89 595\.28\]/);
  });
});
