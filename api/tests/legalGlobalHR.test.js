/**
 * legalGlobalHR.test.js — planillas legales y datos legales: sólo roles
 * globales de RR.HH. (requireGlobalHR) mientras no exista configuración
 * patronal por empresa.
 *
 * Routers REALES y authenticate REAL; base SIMULADA. Un rol por sede con
 * permiso de reportes (incluso por override en user_permissions) recibe 403
 * GLOBAL_HR_ONLY ANTES de cualquier consulta de empleados. La prueba con MySQL
 * real está en tests/it/sensitiveData.it.test.js.
 */
process.env.JWT_SECRET = 'test-secret-legal-global-0123456789';

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));

const express = require('express');
const jwt = require('jsonwebtoken');
const { sequelize } = require('../src/config/database');

const USERS = {
  1: { id: 1, username: 'hr', role: 'hr', active: 1, employee_id: null },
  2: { id: 2, username: 'mgr', role: 'manager', active: 1, employee_id: null },
  3: { id: 3, username: 'coord', role: 'coordinator', active: 1, employee_id: null },
  4: { id: 4, username: 'sup', role: 'supervisor', active: 1, employee_id: null },
  5: { id: 5, username: 'ges', role: 'gestor', active: 1, employee_id: null },
  6: { id: 6, username: 'emp', role: 'employee', active: 1, employee_id: 100 },
};

let server; let base;
const call = (method, url, userId) => fetch(base + url, {
  method,
  headers: { Authorization: `Bearer ${jwt.sign({ id: userId, role: USERS[userId].role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })}` },
});

beforeAll(async () => {
  const app = express();
  app.use('/api/legal', require('../src/routes/legal'));
  app.use('/api/legal-data', require('../src/routes/legalData'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  jest.clearAllMocks();
  sequelize.query.mockImplementation(async (sql, opts = {}) => {
    const rp = opts.replacements || [];
    if (/FROM users WHERE id = \? LIMIT 1/.test(sql)) { const u = USERS[rp[0]]; return [u ? [u] : []]; }
    // Override: TODOS los módulos habilitados — el rol, no el permiso, decide.
    if (/FROM user_permissions/.test(sql)) return [[{ module: rp[1], can_view: 1, can_create: 1, can_update: 1, can_delete: 1 }]];
    return [[]];
  });
});

const ENDPOINTS = [
  ['GET', '/api/legal/planilla-mtess?year=2026&month=1'],
  ['GET', '/api/legal/ips-jornales?year=2026&month=1'],
  ['GET', '/api/legal/planilla-comunicacion?year=2026&month=1'],
  ['GET', '/api/legal/aguinaldo?year=2026&month=1'],
  ['GET', '/api/legal-data/completeness'],
  ['GET', '/api/legal-data/template'],
  ['POST', '/api/legal-data/import'],
];

describe('roles por sede y employee → 403 GLOBAL_HR_ONLY sin consultar empleados', () => {
  test.each(ENDPOINTS.flatMap(([m, u]) => [2, 3, 4, 5, 6].map((uid) => [m, u, uid])))('%s %s (usuario %s)', async (method, url, uid) => {
    const r = await call(method, url, uid);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('GLOBAL_HR_ONLY');
    const sqls = sequelize.query.mock.calls.map(([sql]) => sql);
    expect(sqls.some((s) => /FROM employees|notification_settings/.test(s))).toBe(false);
  });
});

describe('rol global de RR.HH. (control positivo)', () => {
  test('hr pasa la guarda y obtiene la completitud y la plantilla', async () => {
    const c = await call('GET', '/api/legal-data/completeness', 1);
    expect(c.status).toBe(200);
    expect(await c.json()).toMatchObject({ total: 0, incomplete: [] });
    expect((await call('GET', '/api/legal-data/template', 1)).status).toBe(200);
    expect((await call('GET', '/api/legal/ips-jornales?year=2026&month=1', 1)).status).toBe(200);
  });
});
