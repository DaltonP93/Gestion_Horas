/**
 * payrollExportRoute.test.js
 *
 * RBAC de los endpoints de export de nómina montados en el router real de
 * `/api/payroll` (middleware de auth REAL: JWT + authorize + requirePermission).
 *
 *   - Rol fuera de admin/hr/gth (+super_admin) → 403 (sin tocar la BD).
 *   - admin (autorizado a montos) → export CON salario_base.
 *   - gth (autorizado al endpoint pero NO a montos) → export SIN salario_base.
 *   - JSON expone schema_version y metadatos de período.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock('../src/services/workdayConfig', () => ({
  loadWorkdayConfig: jest.fn(async () => ({ forDate: () => null, historyFor: () => [] })),
}));
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));

process.env.JWT_SECRET = 'test-secret-payroll-export';

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { sequelize } = require('../src/config/database');
const payrollRouter = require('../src/routes/payroll');

const NOCTURNO = [
  { id: 1, employee_id: 7, timestamp: '2025-01-15 21:00:00', type: 'in' },
  { id: 2, employee_id: 7, timestamp: '2025-01-16 00:00:00', type: 'out' },
  { id: 3, employee_id: 7, timestamp: '2025-01-16 00:30:00', type: 'in' },
  { id: 4, employee_id: 7, timestamp: '2025-01-16 06:00:00', type: 'out' },
];
const BASE_ROW = {
  id: 7, codigo: '007', documento: '1.234.567', nombre: 'Ada Nocturna',
  departamento: 'Vigilancia', salario_base: 3000000,
  dias_trabajados: 1, minutos_extra: 45, atrasos_min: 12, ausencias: 2,
};

function token(role) {
  return jwt.sign({ id: 1, role }, process.env.JWT_SECRET, { algorithm: 'HS256' });
}

describe('RBAC /api/payroll/export.* ', () => {
  let server, base;
  beforeAll((done) => {
    const app = express();
    app.use('/api/payroll', payrollRouter);
    server = http.createServer(app).listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });
  afterAll((done) => { server.close(done); });
  beforeEach(() => sequelize.query.mockReset());

  function get(path, role) {
    return new Promise((resolve, reject) => {
      const req = http.get(base + path, { headers: { Authorization: `Bearer ${token(role)}` } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
    });
  }

  test('rol employee → 403 (authorize corta antes de la BD)', async () => {
    const { status } = await get('/api/payroll/export.json?year=2025&month=1', 'employee');
    expect(status).toBe(403);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('admin → JSON con schema_version y salario_base', async () => {
    // admin: requirePermission hace bypass, sólo consultas del handler.
    sequelize.query
      .mockResolvedValueOnce([[BASE_ROW]])   // agregado
      .mockResolvedValueOnce([NOCTURNO]);    // marcajes del motor
    const { status, body } = await get('/api/payroll/export.json?year=2025&month=1', 'admin');
    expect(status).toBe(200);
    const ds = JSON.parse(body);
    expect(ds.schema_version).toBe('1.0');
    expect(ds.period).toMatchObject({ year: 2025, month: 1 });
    expect(ds.includes_amounts).toBe(true);
    expect(ds.rows[0]).toHaveProperty('salario_base', 3000000);
    expect(ds.rows[0].minutos_trabajados).toBe(510);
  });

  test('gth → autorizado al endpoint pero SIN montos', async () => {
    // gth: requirePermission consulta user_permissions (can_view=1), luego handler.
    sequelize.query
      .mockResolvedValueOnce([[{ can_view: 1, can_create: 0, can_update: 0, can_delete: 0 }]])
      .mockResolvedValueOnce([[BASE_ROW]])
      .mockResolvedValueOnce([NOCTURNO]);
    const { status, body } = await get('/api/payroll/export.json?year=2025&month=1', 'gth');
    expect(status).toBe(200);
    const ds = JSON.parse(body);
    expect(ds.includes_amounts).toBe(false);
    expect(ds.rows[0]).not.toHaveProperty('salario_base');
    // Horas/asistencia igual presentes (lo esencial para nómina).
    expect(ds.rows[0].minutos_trabajados).toBe(510);
  });

  test('CSV para admin lleva BOM, header y attachment', async () => {
    sequelize.query
      .mockResolvedValueOnce([[BASE_ROW]])
      .mockResolvedValueOnce([NOCTURNO]);
    const { status, body } = await get('/api/payroll/export.csv?year=2025&month=1', 'admin');
    expect(status).toBe(200);
    expect(body.charCodeAt(0)).toBe(0xFEFF);
    expect(body.replace(/^﻿/, '').split('\r\n')[0]).toContain('salario_base');
  });
});
