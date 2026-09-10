/**
 * reportsWeeklyExport.test.js — export CSV del reporte semanal.
 *
 * Paridad con /monthly/export. Handler puro (sin HTTP), como catalogs.test.js.
 * Verifica el contrato del CSV y que es SÓLO lectura (nada de escrituras).
 */

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/middleware/auth', () => ({ authenticate: (_req, _res, next) => next() }));
jest.mock('../src/services/departmentScope', () => ({
  getVisibleDepartmentIds: jest.fn().mockResolvedValue({ unrestricted: true }),
  applyDepartmentScope: jest.fn(),
  canSeeEmployee: jest.fn(),
}));
// Evita arrastrar el grafo pesado (cron/pdf/mail) al requerir el router.
jest.mock('../src/services/scheduler', () => ({
  generateMarcadasReport: jest.fn(), buildMarcadasTableHtml: jest.fn(),
  minsToHM: jest.fn(), maxPairsOf: jest.fn(),
}));
jest.mock('../src/services/marcadasPdf', () => ({ renderMarcadasPdf: jest.fn() }));
jest.mock('../src/services/emailService', () => ({ sendMail: jest.fn(), buildReportEmailHtml: jest.fn() }));

const { sequelize } = require('../src/config/database');
const reportsRouter = require('../src/routes/reports');

function findHandler(stack, method, path) {
  for (const layer of stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`handler no encontrado: ${method} ${path}`);
}

const handler = findHandler(reportsRouter.stack, 'get', '/weekly/export');

function invoke(query = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      headers: {}, statusCode: 200, body: undefined,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(p) { this.body = p; resolve(this); return this; },
      send(p) { this.body = p; resolve(this); return this; },
    };
    Promise.resolve(handler({ user: { id: 1, role: 'admin' }, query }, res, reject)).catch(reject);
  });
}

const ROWS = [
  { date: '2026-05-04', status: 'present', first_in: '2026-05-04 08:00:00', last_out: '2026-05-04 17:00:00', worked_minutes: 480, late_minutes: 0, employee_name: 'Ana, Gómez', department: 'Operaciones' },
  { date: '2026-05-05', status: 'late', first_in: '2026-05-05 08:15:00', last_out: '2026-05-05 17:00:00', worked_minutes: 465, late_minutes: 15, employee_name: 'Beto Díaz', department: null },
];

beforeEach(() => {
  sequelize.query.mockReset();
  sequelize.query.mockResolvedValue([ROWS]);
});

test('devuelve CSV con headers de descarga y BOM', async () => {
  const res = await invoke({ year: 2026, week: 18 });
  expect(res.headers['Content-Type']).toMatch(/text\/csv/);
  expect(res.headers['Content-Disposition']).toMatch(/attachment; filename=.*reporte-semanal.*S18\.csv/);
  expect(res.body.startsWith('﻿')).toBe(true);
});

test('el CSV trae encabezado + una fila por registro y escapa la coma del nombre', async () => {
  const res = await invoke({ year: 2026, week: 18 });
  const lines = res.body.replace(/^﻿/, '').split('\r\n');
  expect(lines[0]).toBe('Fecha,Empleado,Departamento,Estado,Entrada,Salida,Min trabajados,Min tarde');
  expect(lines).toHaveLength(3); // header + 2 filas
  // "Ana, Gómez" tiene coma → va entre comillas.
  expect(lines[1]).toContain('"Ana, Gómez"');
  expect(lines[1]).toContain('2026-05-04');
  expect(lines[2]).toContain('Beto Díaz');
});

test('es sólo lectura: sólo un SELECT, ninguna escritura', async () => {
  await invoke({ year: 2026, week: 18 });
  const sqls = sequelize.query.mock.calls.map(([s]) => s);
  expect(sqls.every((s) => /^\s*SELECT/i.test(s))).toBe(true);
  expect(sqls.some((s) => /INSERT|UPDATE|DELETE|REPLACE/i.test(s))).toBe(false);
});
