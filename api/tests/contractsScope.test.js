/**
 * contractsScope.test.js — /api/contracts con alcance por empleado.
 *
 * Router REAL, authenticate REAL (identidad vigente desde `users`),
 * capacidades REALES (user_permissions) y resolutor de alcance REAL
 * (departmentScope); base SIMULADA. La prueba con MySQL real (dos empresas,
 * contadores de escritura y auditoría) está en tests/it/sensitiveData.it.test.js.
 */
process.env.JWT_SECRET = 'test-secret-contracts-scope-0123456789';

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const { sequelize } = require('../src/config/database');
const audit = require('../src/services/audit');

// Sede 1 → depto 10 (empleado 100); sede 2 → depto 20 (empleado 200).
const USERS = {
  1: { id: 1, username: 'adm', role: 'admin', active: 1, employee_id: null, branch_id: null },
  2: { id: 2, username: 'mgr1', role: 'manager', active: 1, employee_id: null, branch_id: 1 },
  3: { id: 3, username: 'mgr0', role: 'manager', active: 1, employee_id: null, branch_id: null },
};
const EMPS = { 100: { department_id: 10 }, 200: { department_id: 20 } };
let contracts;
let writes;

function installDb() {
  sequelize.query.mockImplementation(async (sql, opts = {}) => {
    const rp = opts.replacements || [];
    if (/FROM users WHERE id = \? LIMIT 1/.test(sql)) { const u = USERS[rp[0]]; return [u ? [u] : []]; }
    if (/FROM user_permissions/.test(sql)) return [[{ module: 'ingresos', can_view: 1, can_create: 1, can_update: 1, can_delete: 1 }]];
    if (/FROM users u\s+JOIN branches b/.test(sql)) { const u = USERS[rp[0]]; return [u && u.branch_id ? [{ branch_id: u.branch_id }] : []]; }
    if (/SELECT id FROM departments WHERE active = 1 AND branch_id = \?/.test(sql)) return [[{ id: rp[0] === 1 ? 10 : 20 }]];
    if (/FROM notification_settings/.test(sql)) return [[]];
    if (/SELECT department_id FROM employees WHERE id = \?/.test(sql)) { const e = EMPS[rp[0]]; return [e ? [e] : []]; }
    if (/SELECT id, employee_id FROM employee_contracts WHERE id = \?/.test(sql)) {
      const c = contracts.find((x) => x.id === rp[0]); return [c ? [c] : []];
    }
    if (/FROM employee_contracts c\s+JOIN employees e/.test(sql)) {
      const m = sql.match(/e\.department_id IN \(([^)]*)\)/);
      if (/1=0/.test(sql)) return [[]];
      const depts = m ? rp.slice(1) : null;
      return [contracts.filter((c) => !depts || depts.includes(EMPS[c.employee_id].department_id))];
    }
    if (/FROM employee_contracts c\s+LEFT JOIN users/.test(sql)) return [contracts.filter((c) => c.employee_id === rp[0])];
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) { writes.push(sql.trim().split(/\s+/)[0]); return /INSERT/.test(sql) ? [55, 1] : [{ affectedRows: 1 }]; }
    return [[]];
  });
}

let server; let base;
const call = (method, url, userId, body) => fetch(base + url, {
  method,
  headers: {
    Authorization: `Bearer ${jwt.sign({ id: userId, role: USERS[userId].role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })}`,
    'Content-Type': 'application/json',
  },
  body: body ? JSON.stringify(body) : undefined,
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/contracts', require('../src/routes/contracts'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  jest.clearAllMocks();
  writes = [];
  contracts = [{ id: 1, employee_id: 100, salary: '1000.00' }, { id: 2, employee_id: 200, salary: '9999.00' }];
  installDb();
});

const BODY = { type: 'Indefinido', start_date: '2026-01-01' };

describe('manager de la sede 1 (rol por sede)', () => {
  test('alertas y historial sólo de su alcance', async () => {
    const a = await (await call('GET', '/api/contracts/alerts', 2)).json();
    expect(a.expiring.map((c) => c.id)).toEqual([1]);
    expect((await call('GET', '/api/contracts/employee/100', 2)).status).toBe(200);
    const r = await call('GET', '/api/contracts/employee/200', 2);
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toMatch(/9999/);
  });

  test('alta, edición y borrado fuera de alcance → 404 sin escritura ni auditoría', async () => {
    expect((await call('POST', '/api/contracts', 2, { ...BODY, employee_id: 200 })).status).toBe(404);
    // El body dice "empleado 100" pero el contrato 2 guardado es del 200.
    expect((await call('PUT', '/api/contracts/2', 2, { ...BODY, employee_id: 100 })).status).toBe(404);
    expect((await call('DELETE', '/api/contracts/2', 2)).status).toBe(404);
    expect((await call('DELETE', '/api/contracts/404', 2)).status).toBe(404);
    expect(writes).toEqual([]);
    expect(audit.log).not.toHaveBeenCalled();
  });

  test('mover un contrato propio a otro empleado → 400; ids no canónicos → 400', async () => {
    expect((await call('PUT', '/api/contracts/1', 2, { ...BODY, employee_id: 200 })).status).toBe(400);
    expect((await call('PUT', '/api/contracts/1e0', 2, BODY)).status).toBe(400);
    expect((await call('GET', '/api/contracts/employee/0x64', 2)).status).toBe(400);
    expect((await call('POST', '/api/contracts', 2, { ...BODY, employee_id: '1e2' })).status).toBe(400);
    expect(writes).toEqual([]);
  });

  test('dentro de alcance: alta, edición (empleado del contrato guardado) y borrado', async () => {
    expect((await call('POST', '/api/contracts', 2, { ...BODY, employee_id: 100 })).status).toBe(201);
    expect((await call('PUT', '/api/contracts/1', 2, BODY)).status).toBe(200);
    expect((await call('DELETE', '/api/contracts/1', 2)).status).toBe(200);
    expect(writes).toEqual(['INSERT', 'UPDATE', 'DELETE']);
    const upd = sequelize.query.mock.calls.find(([sql]) => /^\s*UPDATE employee_contracts/.test(sql));
    expect(upd[1].replacements.slice(-2)).toEqual([1, 100]);
    expect(audit.log.mock.calls.map(([a]) => a.action)).toEqual(['contract_create', 'contract_update', 'contract_delete']);
  });
});

describe('manager sin sede → sin alcance', () => {
  test('alertas vacías; historial, alta y borrado 404', async () => {
    const a = await (await call('GET', '/api/contracts/alerts', 3)).json();
    expect([...a.expiring, ...a.probation]).toEqual([]);
    expect((await call('GET', '/api/contracts/employee/100', 3)).status).toBe(404);
    expect((await call('POST', '/api/contracts', 3, { ...BODY, employee_id: 100 })).status).toBe(404);
    expect((await call('DELETE', '/api/contracts/1', 3)).status).toBe(404);
    expect(writes).toEqual([]);
  });
});

describe('rol global (control positivo)', () => {
  test('admin opera sobre ambas sedes', async () => {
    const a = await (await call('GET', '/api/contracts/alerts', 1)).json();
    expect(a.expiring.map((c) => c.id)).toEqual([1, 2]);
    expect((await call('GET', '/api/contracts/employee/200', 1)).status).toBe(200);
    expect((await call('PUT', '/api/contracts/2', 1, { ...BODY, employee_id: 200 })).status).toBe(200);
    expect((await call('DELETE', '/api/contracts/2', 1)).status).toBe(200);
  });
});
