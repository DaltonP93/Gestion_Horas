'use strict';

/**
 * rawStateReportRoute.test.js — validación del ID de reloj en
 * GET /api/devices/:id/raw-state-report.
 *
 * El ID debe ser un entero positivo CANÓNICO y seguro (utils/strictId): nada de
 * parseInt permisivo. Un ID inválido responde 400 ANTES de consultar la base
 * (ni el reloj ni el reporte). Se conservan los controles de ID válido (200) e
 * inexistente (404).
 */
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  authorize: () => (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
  requireSuperAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const { sequelize } = require('../src/config/database');

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use('/api/devices', require('../src/routes/devices'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => sequelize.query.mockReset());

const RANGE = '?from=2026-10-05&to=2026-10-05';
const get = async (rawId) => {
  const r = await fetch(`${base}/api/devices/${rawId}/raw-state-report${RANGE}`);
  return { status: r.status, body: await r.json() };
};

describe('raw-state-report: ID de reloj estricto', () => {
  test.each([
    ['1e2'], ['1abc'], ['1.5'], ['%2B1'], ['-1'], ['01'], ['007'], ['0'], ['%207'],
    ['9007199254740993'], ['0x10'],
  ])('ID %s → 400 sin consultar la base', async (rawId) => {
    const r = await get(rawId);
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('ID válido → consulta el reloj y el reporte (200)', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 12 }]])   // SELECT id FROM devices
      .mockResolvedValueOnce([[]]);            // agregación del reporte
    const r = await get('12');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, device_id: 12, total: 0 });
    expect(sequelize.query.mock.calls[0][1].replacements).toEqual([12]);
  });

  test('ID válido inexistente → 404', async () => {
    sequelize.query.mockResolvedValueOnce([[]]);
    const r = await get('9007199254740991');
    expect(r.status).toBe(404);
    expect(sequelize.query).toHaveBeenCalledTimes(1);
  });
});
