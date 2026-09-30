/**
 * employeeNotesScope.test.js — /api/employee-notes con alcance por empleado.
 *
 * Router REAL, authenticate REAL (identidad vigente desde `users`),
 * capacidades REALES y resolutor de alcance REAL; base SIMULADA. La prueba con
 * MySQL real está en tests/it/sensitiveData.it.test.js.
 */
process.env.JWT_SECRET = 'test-secret-notes-scope-0123456789';

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn(), transaction: jest.fn() } }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const { sequelize } = require('../src/config/database');
const audit = require('../src/services/audit');

// Sede 1 → depto 10 (empleados 100 y 101); sede 2 → depto 20 (empleado 200).
const USERS = {
  1: { id: 1, username: 'adm', role: 'admin', active: 1, employee_id: null, branch_id: null },
  2: { id: 2, username: 'mgr1', role: 'manager', active: 1, employee_id: null, branch_id: 1 },
  4: { id: 4, username: 'emp', role: 'employee', active: 1, employee_id: 100, branch_id: 1 },
  5: { id: 5, username: 'hr', role: 'hr', active: 1, employee_id: null, branch_id: null },
};
const EMPS = { 100: { department_id: 10 }, 101: { department_id: 10 }, 200: { department_id: 20 } };
let NOTES;
let writes;
let events;
let locks;
let affected;

function installDb() {
  sequelize.transaction.mockImplementation(async () => ({
    commit: jest.fn(async () => { events.push('commit'); }),
    rollback: jest.fn(async () => { events.push('rollback'); }),
  }));
  audit.log.mockImplementation((a) => { events.push(`audit:${a.action}`); });
  sequelize.query.mockImplementation(async (sql, opts = {}) => {
    const rp = opts.replacements || [];
    if (/FOR UPDATE/.test(sql)) locks.push({ table: /employee_notes/.test(sql) ? 'note' : 'employee', tx: !!opts.transaction });
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) {
      writes.push(`${sql.trim().split(/\s+/)[0]}${opts.transaction ? '@tx' : ''}`);
      if (/INSERT/.test(sql)) return [77, 1];
      return [{ affectedRows: affected }];
    }
    if (/FROM users WHERE id = \? LIMIT 1/.test(sql)) { const u = USERS[rp[0]]; return [u ? [u] : []]; }
    if (/FROM user_permissions/.test(sql)) return [[{ module: 'empleados', can_view: 1, can_create: 1, can_update: 1, can_delete: 0 }]];
    if (/FROM users u\s+JOIN branches b/.test(sql)) { const u = USERS[rp[0]]; return [u && u.branch_id ? [{ branch_id: u.branch_id }] : []]; }
    if (/SELECT id FROM departments WHERE active = 1 AND branch_id = \?/.test(sql)) return [[{ id: rp[0] === 1 ? 10 : 20 }]];
    if (/FROM employees WHERE id = \?/.test(sql)) { const e = EMPS[rp[0]]; return [e ? [{ id: rp[0], ...e }] : []]; }
    if (/FROM employee_notes WHERE id = \?/.test(sql)) { const n = NOTES.find((x) => x.id === rp[0]); return [n ? [n] : []]; }
    if (/FROM employee_notes n/.test(sql)) {
      const [emp, ...vis] = rp;
      return [NOTES.filter((n) => n.employee_id === emp && (!vis.length || vis.includes(n.visibility)))];
    }
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
const titles = async (r) => (await r.json()).data.map((n) => n.title).sort();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/employee-notes', require('../src/routes/employeeNotes'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  jest.clearAllMocks();
  writes = [];
  events = [];
  locks = [];
  affected = 1;
  NOTES = [
    { id: 1, employee_id: 100, author_id: 1, visibility: 'hr_only', title: 'A-HR' },
    { id: 2, employee_id: 100, author_id: 1, visibility: 'managers', title: 'A-MGR' },
    { id: 3, employee_id: 100, author_id: 1, visibility: 'employee', title: 'A-EMP' },
    { id: 4, employee_id: 101, author_id: 1, visibility: 'employee', title: 'A2-EMP' },
    { id: 5, employee_id: 200, author_id: 2, visibility: 'managers', title: 'B-BYMGR' },
    { id: 6, employee_id: 100, author_id: 2, visibility: 'managers', title: 'A-BYMGR' },
  ];
  installDb();
});

describe('employee', () => {
  test('sus notas con visibilidad employee; las de otro empleado → 404', async () => {
    expect(await titles(await call('GET', '/api/employee-notes/by-employee/100', 4))).toEqual(['A-EMP']);
    for (const id of [101, 200]) {
      const r = await call('GET', `/api/employee-notes/by-employee/${id}`, 4);
      expect(r.status).toBe(404);
      expect(JSON.stringify(await r.json())).not.toMatch(/EMP|MGR/);
    }
  });
  test('editar: nota no visible → 404; visible sin ser autor → 403; sin escritura', async () => {
    expect((await call('PUT', '/api/employee-notes/1', 4, { pinned: 1 })).status).toBe(404);
    expect((await call('PUT', '/api/employee-notes/4', 4, { pinned: 1 })).status).toBe(404);
    expect((await call('PUT', '/api/employee-notes/3', 4, { pinned: 1 })).status).toBe(403);
    expect(writes).toEqual([]);
  });
});

describe('manager de la sede 1', () => {
  test('empleado propio: managers/employee; ajeno o inexistente 404; id no canónico 400', async () => {
    expect(await titles(await call('GET', '/api/employee-notes/by-employee/100', 2))).toEqual(['A-BYMGR', 'A-EMP', 'A-MGR']);
    expect((await call('GET', '/api/employee-notes/by-employee/200', 2)).status).toBe(404);
    expect((await call('GET', '/api/employee-notes/by-employee/999', 2)).status).toBe(404);
    expect((await call('GET', '/api/employee-notes/by-employee/1e2', 2)).status).toBe(400);
  });
  test('crear y editar fuera de alcance → 404 sin escritura ni auditoría', async () => {
    expect((await call('POST', '/api/employee-notes', 2, { employee_id: 200, title: 'x', visibility: 'managers' })).status).toBe(404);
    expect((await call('PUT', '/api/employee-notes/5', 2, { pinned: 1 })).status).toBe(404); // autor, empleado ajeno
    expect((await call('PUT', '/api/employee-notes/1', 2, { pinned: 1 })).status).toBe(404); // hr_only
    expect((await call('POST', '/api/employee-notes', 2, { employee_id: '0x64', title: 'x' })).status).toBe(400);
    expect(writes).toEqual([]);
    expect(audit.log).not.toHaveBeenCalled();
  });
  test('dentro de alcance: crea y edita su nota; auditoría sin contenido', async () => {
    expect((await call('POST', '/api/employee-notes', 2, { employee_id: 101, title: 'secreto', body: 'texto libre', visibility: 'managers' })).status).toBe(201);
    expect((await call('PUT', '/api/employee-notes/6', 2, { pinned: 1 })).status).toBe(200);
    expect(writes).toEqual(['INSERT@tx', 'UPDATE@tx']);
    expect(audit.log.mock.calls.map(([a]) => a.action)).toEqual(['employee_note_create', 'employee_note_update']);
    expect(events).toEqual(['commit', 'audit:employee_note_create', 'commit', 'audit:employee_note_update']);
    // Nota y empleado leídos con FOR UPDATE dentro de la transacción.
    expect(locks).toEqual([{ table: 'employee', tx: true }, { table: 'note', tx: true }, { table: 'employee', tx: true }]);
    expect(JSON.stringify(audit.log.mock.calls.map(([a]) => a.details))).not.toMatch(/secreto|texto libre/);
  });
  test('borrar → 403 (sólo RR.HH. global)', async () => {
    expect((await call('DELETE', '/api/employee-notes/2', 2)).status).toBe(403);
    expect(writes).toEqual([]);
  });
});

describe('roles globales (control positivo)', () => {
  test('admin ve todas las visibilidades de cualquier empleado y edita', async () => {
    expect(await titles(await call('GET', '/api/employee-notes/by-employee/100', 1))).toEqual(['A-BYMGR', 'A-EMP', 'A-HR', 'A-MGR']);
    expect((await call('PUT', '/api/employee-notes/5', 1, { pinned: 1 })).status).toBe(200);
  });
  test('hr borra una nota existente; inexistente 404 y no canónica 400 sin DELETE', async () => {
    expect((await call('DELETE', '/api/employee-notes/999', 5)).status).toBe(404);
    expect((await call('DELETE', '/api/employee-notes/1e2', 5)).status).toBe(400);
    expect(writes).toEqual([]);
    expect((await call('DELETE', '/api/employee-notes/5', 5)).status).toBe(200);
    expect(writes).toEqual(['DELETE@tx']);
  });
  test('empleado inexistente: historial y alta → 404 sin INSERT', async () => {
    expect((await call('GET', '/api/employee-notes/by-employee/999', 1)).status).toBe(404);
    expect((await call('POST', '/api/employee-notes', 5, { employee_id: 999, title: 'x' })).status).toBe(404);
    expect(writes).toEqual([]);
    expect(audit.log).not.toHaveBeenCalled();
  });
  test('rol global sin visibility → `hr_only`', async () => {
    expect((await call('POST', '/api/employee-notes', 5, { employee_id: 200, title: 'x' })).status).toBe(201);
    const ins = sequelize.query.mock.calls.find(([sql]) => /^\s*INSERT INTO employee_notes/.test(sql));
    expect(ins[1].replacements[3]).toBe('hr_only');
  });
});

describe('visibilidad por rol y consistencia', () => {
  test('manager sin visibility → `managers`', async () => {
    expect((await call('POST', '/api/employee-notes', 2, { employee_id: 101, title: 'x' })).status).toBe(201);
    const ins = sequelize.query.mock.calls.find(([sql]) => /^\s*INSERT INTO employee_notes/.test(sql));
    expect(ins[1].replacements[3]).toBe('managers');
  });
  test('manager con `hr_only` al crear o al editar → 403 VISIBILITY_NOT_ALLOWED sin escritura', async () => {
    const c = await call('POST', '/api/employee-notes', 2, { employee_id: 101, title: 'x', visibility: 'hr_only' });
    expect([c.status, (await c.json()).code]).toEqual([403, 'VISIBILITY_NOT_ALLOWED']);
    const u = await call('PUT', '/api/employee-notes/6', 2, { visibility: 'hr_only' });
    expect([u.status, (await u.json()).code]).toEqual([403, 'VISIBILITY_NOT_ALLOWED']);
    expect((await call('PUT', '/api/employee-notes/6', 2, { visibility: 'employee' })).status).toBe(200);
    expect(writes).toEqual(['UPDATE@tx']);
  });
  test('affectedRows = 0 en PUT y DELETE → 404, rollback, sin auditoría', async () => {
    affected = 0;
    expect((await call('PUT', '/api/employee-notes/6', 2, { pinned: 1 })).status).toBe(404);
    expect((await call('DELETE', '/api/employee-notes/5', 5)).status).toBe(404);
    expect(events).toEqual(['rollback', 'rollback']);
    expect(audit.log).not.toHaveBeenCalled();
  });
  test('rechazos dentro de la transacción → rollback sin commit', async () => {
    expect((await call('PUT', '/api/employee-notes/5', 2, { pinned: 1 })).status).toBe(404);
    expect((await call('PUT', '/api/employee-notes/2', 2, { pinned: 1 })).status).toBe(403);
    expect(events).toEqual(['rollback', 'rollback']);
  });
});
