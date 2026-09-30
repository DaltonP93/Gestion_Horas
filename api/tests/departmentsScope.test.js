/**
 * departmentsScope.test.js — lecturas de /api/departments con alcance.
 *
 * Router REAL, authenticate REAL (identidad vigente desde `users`) y resolutor
 * de alcance REAL (departmentScope); base SIMULADA. La prueba con MySQL real
 * (sede propia/ajena, inexistente, inactiva y reactivada) está en
 * tests/it/orgScope.it.test.js.
 */
process.env.JWT_SECRET = 'test-secret-departments-scope-0123456789';

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));

const express = require('express');
const jwt = require('jsonwebtoken');
const { sequelize } = require('../src/config/database');

// Sede 1 (activa) con depto 10; sede 2 con depto 20. Empleados: 100 en 10, 200 en 20.
const USERS = {
  1: { id: 1, username: 'adm', role: 'admin', active: 1, employee_id: null, branch_id: null },
  2: { id: 2, username: 'mgr1', role: 'manager', active: 1, employee_id: null, branch_id: 1 },
  3: { id: 3, username: 'mgr0', role: 'manager', active: 1, employee_id: null, branch_id: null },
  4: { id: 4, username: 'emp', role: 'employee', active: 1, employee_id: 100, branch_id: 1 },
};
const DEPTS = [
  { id: 10, name: 'Depto sede 1', branch_id: 1, active: 1 },
  { id: 20, name: 'Depto sede 2', branch_id: 2, active: 1 },
];
const EMPS = [
  { id: 100, code: 'E100', first_name: 'Ana', last_name: 'Uno', email: 'ana@example.invalid', status: 'active', department_id: 10 },
  { id: 200, code: 'E200', first_name: 'Beto', last_name: 'Dos', email: 'beto@example.invalid', status: 'active', department_id: 20 },
];
let activeBranches;

function installDb() {
  sequelize.query.mockImplementation(async (sql, opts = {}) => {
    const rp = opts.replacements || [];
    if (/FROM users WHERE id = \? LIMIT 1/.test(sql)) { const u = USERS[rp[0]]; return [u ? [u] : []]; }
    if (/FROM users u\s+JOIN branches b/.test(sql)) {
      const u = USERS[rp[0]];
      return [u && u.active && u.branch_id && activeBranches.has(u.branch_id) ? [{ branch_id: u.branch_id }] : []];
    }
    if (/SELECT id FROM departments WHERE active = 1 AND branch_id = \?/.test(sql)) {
      return [DEPTS.filter((d) => d.active && d.branch_id === rp[0]).map((d) => ({ id: d.id }))];
    }
    if (/FROM departments d/.test(sql)) {
      const m = sql.match(/d\.id IN \(([^)]*)\)/);
      const ids = m ? rp.slice(0, (m[1].match(/\?/g) || []).length) : null;
      if (/1=0/.test(sql)) return [[]];
      return [DEPTS.filter((d) => !ids || ids.includes(d.id))];
    }
    if (/SELECT \* FROM departments WHERE id = \?/.test(sql)) return [DEPTS.filter((d) => d.id === Number(rp[0]))];
    if (/FROM employees WHERE department_id = \?/.test(sql)) return [EMPS.filter((e) => e.department_id === Number(rp[0]))];
    return [[]];
  });
}

let server; let base;
const get = (url, userId) => fetch(base + url, {
  headers: { Authorization: `Bearer ${jwt.sign({ id: userId, role: USERS[userId].role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })}` },
});

beforeAll(async () => {
  const app = express();
  app.use('/api/departments', require('../src/routes/departments'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => { activeBranches = new Set([1, 2]); installDb(); });

describe('manager de la sede 1', () => {
  test('listado: sólo su departamento', async () => {
    const r = await get('/api/departments', 2);
    expect(r.status).toBe(200);
    expect((await r.json()).map((d) => d.id)).toEqual([10]);
  });
  test('detalle y empleados: propio 200, ajeno 404 sin datos', async () => {
    expect((await get('/api/departments/10', 2)).status).toBe(200);
    expect((await (await get('/api/departments/10/employees', 2)).json()).map((e) => e.id)).toEqual([100]);
    for (const url of ['/api/departments/20', '/api/departments/20/employees', '/api/departments/999', '/api/departments/abc']) {
      const r = await get(url, 2);
      expect([url, r.status]).toEqual([url, 404]);
      expect(JSON.stringify(await r.json())).not.toMatch(/beto|Depto sede 2/i);
    }
  });
  test('sede inactiva → listado vacío y detalle/empleados 404; reactivada → vuelve a ver', async () => {
    activeBranches.delete(1);
    expect(await (await get('/api/departments', 2)).json()).toEqual([]);
    expect((await get('/api/departments/10', 2)).status).toBe(404);
    expect((await get('/api/departments/10/employees', 2)).status).toBe(404);
    activeBranches.add(1);
    expect((await (await get('/api/departments', 2)).json()).map((d) => d.id)).toEqual([10]);
  });
});

describe('sin alcance', () => {
  test.each([[3, 'manager sin sede'], [4, 'employee']])('usuario %s (%s) → listado vacío y detalle 404', async (uid) => {
    expect(await (await get('/api/departments', uid)).json()).toEqual([]);
    expect((await get('/api/departments/10', uid)).status).toBe(404);
    expect((await get('/api/departments/10/employees', uid)).status).toBe(404);
  });
});

describe('rol global (control positivo)', () => {
  test('admin ve todos los departamentos, su detalle y sus empleados', async () => {
    expect((await (await get('/api/departments', 1)).json()).map((d) => d.id)).toEqual([10, 20]);
    expect((await get('/api/departments/20', 1)).status).toBe(200);
    expect((await (await get('/api/departments/20/employees', 1)).json()).map((e) => e.id)).toEqual([200]);
  });
});
