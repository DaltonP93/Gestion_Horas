'use strict';

/**
 * sensitiveData.it.test.js — INTEGRACIÓN (MySQL real + HTTP real): datos
 * sensibles por empleado (contratos, notas internas, planillas legales).
 *
 * Datos SINTÉTICOS: dos empresas, una sede por empresa, un departamento por
 * sede y empleados separados. Actores:
 *   - admin / hr        → roles globales de RR.HH. (comportamiento actual);
 *   - mgrA / coordA     → roles por sede (sede A); capacidades funcionales
 *                          otorgadas por user_permissions: decide el ALCANCE;
 *   - employeeA         → rol employee vinculado al empleado A1.
 *
 * Cada rechazo se verifica con: estado 404/403/400, cuerpo sin nombres,
 * salarios ni notas, CERO sentencias INSERT/UPDATE/DELETE en el servidor
 * (contadores globales Com_* de MySQL; en la ventana del rechazo sólo corre
 * esta prueba), filas intactas y CERO eventos de auditoría del actor.
 */
const { describeIT, makeConn, closeAppDb } = require('./helper');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'it-sensitive-secret-0123456789abcdef';

const WRITE_COUNTERS = ['Com_insert', 'Com_insert_select', 'Com_update', 'Com_update_multi',
  'Com_delete', 'Com_delete_multi', 'Com_replace', 'Com_replace_select'];

describeIT('datos sensibles por empleado (integración)', () => {
  let conn;
  let server;
  let base;
  const ids = {};
  const jwt = require('jsonwebtoken');
  const token = (userId, role) => jwt.sign({ id: userId, role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
  const http = (method, url, userId, role, body) => fetch(base + url, {
    method,
    headers: { Authorization: `Bearer ${token(userId, role)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const count = async (sql, params) => Number((await conn.query(sql, params))[0][0].n);
  const auditCount = (userId) => count('SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ?', [userId]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function writeCounter() {
    const [rows] = await conn.query('SHOW GLOBAL STATUS WHERE Variable_name IN (?)', [WRITE_COUNTERS]);
    return rows.reduce((acc, r) => acc + Number(r.Value), 0);
  }
  async function waitAudit(userId, action, entityId) {
    for (let i = 0; i < 100; i += 1) {
      const n = await count('SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND action = ? AND entity_id = ?', [userId, action, String(entityId)]);
      if (n > 0) return;
      await sleep(20);
    }
    throw new Error(`sin evento ${action}`);
  }
  const snapshot = async () => JSON.stringify([
    (await conn.query('SELECT * FROM employee_contracts WHERE employee_id IN (?) ORDER BY id', [[ids.empA1, ids.empA2, ids.empB]]))[0],
    (await conn.query('SELECT * FROM employee_notes WHERE employee_id IN (?) ORDER BY id', [[ids.empA1, ids.empA2, ids.empB]]))[0],
  ]);

  /**
   * Ejecuta un request que DEBE ser rechazado y verifica: estado esperado,
   * cuerpo sin datos sensibles, cero escrituras, filas intactas y cero
   * auditoría del actor. Devuelve el cuerpo (texto).
   */
  const LEAK_RE = /Sens(A1|A2|B)|2222222|1111111|NOTA-[A-Z0-9-]+/g;
  // Evidencia por caso (estado, datos filtrados, escrituras, auditoría). Se
  // registra ANTES de las aserciones para que una corrida sobre el código sin
  // corregir también deje constancia de qué se filtró o escribió.
  const evidence = [];
  /** URL legible: reemplaza ids por el nombre del fixture (empB, cA, nBmgr…). */
  function describeUrl(url) {
    const name = (group, n) => Object.keys(ids).find((k) => group.test(k) && String(ids[k]) === n) || n;
    return url
      .replace(/(employee|by-employee)\/(\d+)/, (_m, p, n) => `${p}/${name(/^emp/, n)}`)
      .replace(/contracts\/(\d+)/, (_m, n) => `contracts/${name(/^c[AB]$/, n)}`)
      .replace(/employee-notes\/(\d+)/, (_m, n) => `employee-notes/${name(/^n[AB]/, n)}`);
  }
  async function expectRejected({ method, url, uid, role, body, status }) {
    const beforeRows = await snapshot();
    const beforeAudit = await auditCount(uid);
    const beforeWrites = await writeCounter();
    const r = await http(method, url, uid, role, body);
    const text = await r.text();
    await sleep(150); // la auditoría es asíncrona: dar tiempo a que aparezca si existiera
    const writes = (await writeCounter()) - beforeWrites;
    const rowsChanged = (await snapshot()) !== beforeRows;
    const audits = (await auditCount(uid)) - beforeAudit;
    evidence.push({
      request: `${method} ${describeUrl(url)} (${role})`,
      expected: status, got: r.status,
      leaked: [...new Set(text.match(LEAK_RE) || [])], writes, rowsChanged, audits,
    });
    expect({ url, status: r.status }).toEqual({ url, status });
    expect(text).not.toMatch(LEAK_RE);
    expect(writes).toBe(0);
    expect(rowsChanged).toBe(false);
    expect(audits).toBe(0);
    return text;
  }

  async function insertUser(tag, role, { branchId = null, employeeId = null } = {}) {
    const [r] = await conn.query(
      'INSERT INTO users (username, email, password_hash, full_name, role, employee_id, branch_id, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      [`${ids.uniq}${tag}`, `${ids.uniq.toLowerCase()}${tag}@it.local`, 'it-no-login', `IT ${tag}`, role, employeeId, branchId],
    );
    return r.insertId;
  }
  async function grant(uid, module, v, c, u, d) {
    await conn.query(
      'INSERT INTO user_permissions (user_id, module, can_view, can_create, can_update, can_delete) VALUES (?, ?, ?, ?, ?, ?)',
      [uid, module, v, c, u, d],
    );
  }
  async function insertNote(employeeId, authorId, visibility, title) {
    const [r] = await conn.query(
      'INSERT INTO employee_notes (employee_id, author_id, type, visibility, title, body) VALUES (?, ?, ?, ?, ?, ?)',
      [employeeId, authorId, 'observation', visibility, title, `cuerpo ${title}`],
    );
    return r.insertId;
  }

  beforeAll(async () => {
    conn = await makeConn();
    const uniq = `SD${Date.now() % 100000}`;
    ids.uniq = uniq;
    ids.companyA = (await conn.query('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}A`, 'ITSens A']))[0].insertId;
    ids.companyB = (await conn.query('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}B`, 'ITSens B']))[0].insertId;
    ids.branchA = (await conn.query('INSERT INTO branches (code, company_id, name, active) VALUES (?, ?, ?, 1)', [`${uniq}BRA`, ids.companyA, 'ITSensBranch A']))[0].insertId;
    ids.branchB = (await conn.query('INSERT INTO branches (code, company_id, name, active) VALUES (?, ?, ?, 1)', [`${uniq}BRB`, ids.companyB, 'ITSensBranch B']))[0].insertId;
    const dept = async (code, branchId) => (await conn.query(
      'INSERT INTO departments (name, code, branch_id, active) VALUES (?, ?, ?, 1)', [`ITSens ${code}`, `${uniq}${code}`, branchId],
    ))[0].insertId;
    ids.deptA = await dept('DA', ids.branchA);
    ids.deptB = await dept('DB', ids.branchB);
    const emp = async (tag, branchId, deptId) => (await conn.query(
      'INSERT INTO employees (code, employee_number, first_name, last_name, email, branch_id, department_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [`${uniq}${tag}`, `${uniq}N${tag}`, 'Emp', `Sens${tag}`, `${uniq.toLowerCase()}${tag.toLowerCase()}@it.local`, branchId, deptId, 'active'],
    ))[0].insertId;
    ids.empA1 = await emp('A1', ids.branchA, ids.deptA);
    ids.empA2 = await emp('A2', ids.branchA, ids.deptA);
    ids.empB = await emp('B', ids.branchB, ids.deptB);

    ids.admin = await insertUser('ad', 'admin');
    ids.hr = await insertUser('hr', 'hr');
    ids.mgrA = await insertUser('mA', 'manager', { branchId: ids.branchA });
    ids.coordA = await insertUser('cA', 'coordinator', { branchId: ids.branchA });
    ids.employeeA = await insertUser('eA', 'employee', { branchId: ids.branchA, employeeId: ids.empA1 });
    // Capacidades funcionales EXPLÍCITAS: lo que decide es el alcance.
    await grant(ids.mgrA, 'ingresos', 1, 1, 1, 1);
    await grant(ids.mgrA, 'empleados', 1, 1, 1, 0);
    await grant(ids.mgrA, 'reportes', 1, 0, 0, 0);
    await grant(ids.coordA, 'reportes', 1, 0, 0, 0);

    // Contratos que vencen en 10 días (aparecen en /alerts) con salarios reconocibles.
    const contract = async (employeeId, salary) => (await conn.query(
      `INSERT INTO employee_contracts (employee_id, type, start_date, end_date, probation_end_date, salary, status, created_by)
       VALUES (?, 'Plazo fijo', '2026-01-01', DATE_ADD(CURDATE(), INTERVAL 10 DAY), DATE_ADD(CURDATE(), INTERVAL 5 DAY), ?, 'active', ?)`,
      [employeeId, salary, ids.admin],
    ))[0].insertId;
    ids.cA = await contract(ids.empA1, 1111111);
    ids.cB = await contract(ids.empB, 2222222);

    ids.nA1hr = await insertNote(ids.empA1, ids.admin, 'hr_only', 'NOTA-A1-HR');
    ids.nA1mgr = await insertNote(ids.empA1, ids.admin, 'managers', 'NOTA-A1-MGR');
    ids.nA1emp = await insertNote(ids.empA1, ids.admin, 'employee', 'NOTA-A1-EMP');
    ids.nA2emp = await insertNote(ids.empA2, ids.admin, 'employee', 'NOTA-A2-EMP');
    ids.nBmgr = await insertNote(ids.empB, ids.admin, 'managers', 'NOTA-B-MGR');
    ids.nBemp = await insertNote(ids.empB, ids.admin, 'employee', 'NOTA-B-EMP');
    // Nota que el propio mgrA escribió sobre un empleado de B (p. ej. antes de
    // un cambio de sede) y otra hr_only sobre A: ser autor no da alcance.
    ids.nBbyMgr = await insertNote(ids.empB, ids.mgrA, 'managers', 'NOTA-B-BYMGR');
    ids.nA1hrByMgr = await insertNote(ids.empA1, ids.mgrA, 'hr_only', 'NOTA-A1-HRBYMGR');

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/contracts', require('../../src/routes/contracts'));
    app.use('/api/employee-notes', require('../../src/routes/employeeNotes'));
    app.use('/api/legal', require('../../src/routes/legal'));
    app.use('/api/legal-data', require('../../src/routes/legalData'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Error interno' }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (process.env.SENSITIVE_EVIDENCE_OUT) {
      require('fs').writeFileSync(process.env.SENSITIVE_EVIDENCE_OUT, JSON.stringify(evidence, null, 1));
    }
    if (server) await new Promise((r) => server.close(r));
    if (conn) {
      const emps = [ids.empA1, ids.empA2, ids.empB].filter(Boolean);
      const userIds = [ids.admin, ids.hr, ids.mgrA, ids.coordA, ids.employeeA].filter(Boolean);
      if (emps.length) {
        await conn.query('DELETE FROM employee_notes WHERE employee_id IN (?)', [emps]);
        await conn.query('DELETE FROM employee_contracts WHERE employee_id IN (?)', [emps]);
      }
      if (userIds.length) {
        await conn.query('DELETE FROM user_permissions WHERE user_id IN (?)', [userIds]);
        await conn.query('DELETE FROM audit_events WHERE user_id IN (?)', [userIds]);
        await conn.query('DELETE FROM users WHERE id IN (?)', [userIds]);
      }
      if (emps.length) await conn.query('DELETE FROM employees WHERE id IN (?)', [emps]);
      await conn.query('DELETE FROM departments WHERE id IN (?, ?)', [ids.deptA, ids.deptB]);
      await conn.query('DELETE FROM branches WHERE id IN (?, ?)', [ids.branchA, ids.branchB]);
      await conn.query('DELETE FROM companies WHERE id IN (?, ?)', [ids.companyA, ids.companyB]);
      await conn.end();
    }
    await closeAppDb();
  });

  // ─────────────────────────────── Contratos ───────────────────────────────
  describe('contratos', () => {
    test('alertas: el rol por sede ve sólo contratos de su alcance', async () => {
      const r = await http('GET', '/api/contracts/alerts', ids.mgrA, 'manager');
      expect(r.status).toBe(200);
      const j = await r.json();
      const seen = [...j.expiring, ...j.probation].map((c) => c.id);
      expect(seen).toContain(ids.cA);
      expect(seen).not.toContain(ids.cB);
      expect(JSON.stringify(j)).not.toMatch(/SensB/);
    });

    test('alertas: rol global ve ambas empresas (sin cambio)', async () => {
      const j = await (await http('GET', '/api/contracts/alerts', ids.hr, 'hr')).json();
      const seen = j.expiring.map((c) => c.id);
      expect(seen).toEqual(expect.arrayContaining([ids.cA, ids.cB]));
    });

    test('historial: propio 200 con su contrato; ajeno e inexistente 404 sin salario', async () => {
      const own = await http('GET', `/api/contracts/employee/${ids.empA1}`, ids.mgrA, 'manager');
      expect(own.status).toBe(200);
      expect((await own.json()).data.map((c) => c.id)).toEqual([ids.cA]);
      await expectRejected({ method: 'GET', url: `/api/contracts/employee/${ids.empB}`, uid: ids.mgrA, role: 'manager', status: 404 });
      await expectRejected({ method: 'GET', url: '/api/contracts/employee/999999999', uid: ids.mgrA, role: 'manager', status: 404 });
      await expectRejected({ method: 'GET', url: '/api/contracts/employee/1e2', uid: ids.mgrA, role: 'manager', status: 400 });
    });

    test('alta: empleado fuera de alcance → 404 sin INSERT ni auditoría', async () => {
      await expectRejected({
        method: 'POST', url: '/api/contracts', uid: ids.mgrA, role: 'manager', status: 404,
        body: { employee_id: ids.empB, type: 'Indefinido', start_date: '2026-02-01', salary: 3333333 },
      });
      expect(await count('SELECT COUNT(*) AS n FROM employee_contracts WHERE salary = 3333333')).toBe(0);
    });

    test('edición: contrato ajeno con employee_id propio en el body → 404; no cambia', async () => {
      await expectRejected({
        method: 'PUT', url: `/api/contracts/${ids.cB}`, uid: ids.mgrA, role: 'manager', status: 404,
        body: { employee_id: ids.empA1, type: 'Indefinido', start_date: '2026-01-01', salary: 1 },
      });
      await expectRejected({
        method: 'PUT', url: `/api/contracts/${ids.cB}`, uid: ids.mgrA, role: 'manager', status: 404,
        body: { type: 'Indefinido', start_date: '2026-01-01', salary: 1 },
      });
    });

    test('edición: contrato propio intentando moverlo a un empleado ajeno → 400; no cambia', async () => {
      await expectRejected({
        method: 'PUT', url: `/api/contracts/${ids.cA}`, uid: ids.mgrA, role: 'manager', status: 400,
        body: { employee_id: ids.empB, type: 'Indefinido', start_date: '2026-01-01', salary: 1 },
      });
    });

    test('borrado: contrato ajeno e inexistente → 404; el contrato sigue', async () => {
      await expectRejected({ method: 'DELETE', url: `/api/contracts/${ids.cB}`, uid: ids.mgrA, role: 'manager', status: 404 });
      await expectRejected({ method: 'DELETE', url: '/api/contracts/999999999', uid: ids.mgrA, role: 'manager', status: 404 });
      expect(await count('SELECT COUNT(*) AS n FROM employee_contracts WHERE id = ?', [ids.cB])).toBe(1);
    });

    test('employee: sin capacidad sobre ingresos → 403 sin datos ni escritura', async () => {
      await expectRejected({ method: 'GET', url: `/api/contracts/employee/${ids.empA1}`, uid: ids.employeeA, role: 'employee', status: 403 });
      await expectRejected({ method: 'DELETE', url: `/api/contracts/${ids.cA}`, uid: ids.employeeA, role: 'employee', status: 403 });
    });

    test('dentro del alcance: alta, edición y borrado permitidos y auditados', async () => {
      const c = await http('POST', '/api/contracts', ids.mgrA, 'manager', { employee_id: ids.empA2, type: 'Indefinido', start_date: '2026-03-01', salary: 4444444 });
      expect(c.status).toBe(201);
      const { id } = await c.json();
      await waitAudit(ids.mgrA, 'contract_create', id);
      // La web reenvía la fila con su employee_id: coincide → 200.
      const u = await http('PUT', `/api/contracts/${id}`, ids.mgrA, 'manager', { employee_id: ids.empA2, type: 'Plazo fijo', start_date: '2026-03-01', salary: 4444445 });
      expect(u.status).toBe(200);
      await waitAudit(ids.mgrA, 'contract_update', id);
      const [[row]] = await conn.query('SELECT employee_id, type, salary FROM employee_contracts WHERE id = ?', [id]);
      expect({ ...row, salary: Number(row.salary) }).toEqual({ employee_id: ids.empA2, type: 'Plazo fijo', salary: 4444445 });
      const d = await http('DELETE', `/api/contracts/${id}`, ids.mgrA, 'manager');
      expect(d.status).toBe(200);
      await waitAudit(ids.mgrA, 'contract_delete', id);
      expect(await count('SELECT COUNT(*) AS n FROM employee_contracts WHERE id = ?', [id])).toBe(0);
    });

    test('rol global: historial y edición del contrato de B (sin cambio)', async () => {
      const g = await http('GET', `/api/contracts/employee/${ids.empB}`, ids.admin, 'admin');
      expect(g.status).toBe(200);
      expect((await g.json()).data.map((c) => c.id)).toEqual([ids.cB]);
      const u = await http('PUT', `/api/contracts/${ids.cB}`, ids.admin, 'admin', { employee_id: ids.empB, type: 'Plazo fijo', start_date: '2026-01-01', end_date: null, salary: 2222222 });
      expect(u.status).toBe(200);
      await waitAudit(ids.admin, 'contract_update', ids.cB);
    });
  });

  // ─────────────────────────────── Notas ───────────────────────────────────
  describe('notas internas', () => {
    const titles = async (r) => (await r.json()).data.map((n) => n.title).sort();

    test('employee: lee sólo sus notas con visibilidad employee', async () => {
      const r = await http('GET', `/api/employee-notes/by-employee/${ids.empA1}`, ids.employeeA, 'employee');
      expect(r.status).toBe(200);
      expect(await titles(r)).toEqual(['NOTA-A1-EMP']);
    });

    test('employee: notas de otro empleado (misma sede y otra empresa) → 404 sin contenido', async () => {
      await expectRejected({ method: 'GET', url: `/api/employee-notes/by-employee/${ids.empA2}`, uid: ids.employeeA, role: 'employee', status: 404 });
      await expectRejected({ method: 'GET', url: `/api/employee-notes/by-employee/${ids.empB}`, uid: ids.employeeA, role: 'employee', status: 404 });
    });

    test('rol por sede: empleado propio → visibilidades managers/employee (no hr_only)', async () => {
      const r = await http('GET', `/api/employee-notes/by-employee/${ids.empA1}`, ids.coordA, 'coordinator');
      expect(r.status).toBe(200);
      expect(await titles(r)).toEqual(['NOTA-A1-EMP', 'NOTA-A1-MGR']);
    });

    test('rol por sede: empleado ajeno o inexistente → 404 sin contenido', async () => {
      await expectRejected({ method: 'GET', url: `/api/employee-notes/by-employee/${ids.empB}`, uid: ids.mgrA, role: 'manager', status: 404 });
      await expectRejected({ method: 'GET', url: '/api/employee-notes/by-employee/999999999', uid: ids.mgrA, role: 'manager', status: 404 });
      await expectRejected({ method: 'GET', url: '/api/employee-notes/by-employee/0x10', uid: ids.mgrA, role: 'manager', status: 400 });
    });

    test('rol por sede: crear nota sobre empleado ajeno → 404 sin INSERT', async () => {
      await expectRejected({
        method: 'POST', url: '/api/employee-notes', uid: ids.mgrA, role: 'manager', status: 404,
        body: { employee_id: ids.empB, visibility: 'managers', title: 'NOTA-NUEVA-B' },
      });
      expect(await count("SELECT COUNT(*) AS n FROM employee_notes WHERE title = 'NOTA-NUEVA-B'")).toBe(0);
    });

    test('rol por sede: editar nota propia sobre empleado ajeno → 404; ser autor no da alcance', async () => {
      await expectRejected({ method: 'PUT', url: `/api/employee-notes/${ids.nBbyMgr}`, uid: ids.mgrA, role: 'manager', status: 404, body: { pinned: 1 } });
    });

    test('rol por sede: editar nota hr_only de su alcance (aunque sea autor) → 404', async () => {
      await expectRejected({ method: 'PUT', url: `/api/employee-notes/${ids.nA1hrByMgr}`, uid: ids.mgrA, role: 'manager', status: 404, body: { pinned: 1 } });
    });

    test('rol por sede: editar nota visible de su alcance escrita por otro → 403 (regla de autor vigente)', async () => {
      await expectRejected({ method: 'PUT', url: `/api/employee-notes/${ids.nA1mgr}`, uid: ids.mgrA, role: 'manager', status: 403, body: { pinned: 1 } });
    });

    test('employee: editar nota ajena → 404; nota propia visible pero no es autor → 403', async () => {
      await expectRejected({ method: 'PUT', url: `/api/employee-notes/${ids.nBemp}`, uid: ids.employeeA, role: 'employee', status: 404, body: { pinned: 1 } });
      await expectRejected({ method: 'PUT', url: `/api/employee-notes/${ids.nA1hr}`, uid: ids.employeeA, role: 'employee', status: 404, body: { pinned: 1 } });
      await expectRejected({ method: 'PUT', url: `/api/employee-notes/${ids.nA1emp}`, uid: ids.employeeA, role: 'employee', status: 403, body: { pinned: 1 } });
    });

    test('borrado: rol por sede → 403 (sólo RR.HH. global); inexistente y no canónico para global → 404/400', async () => {
      await expectRejected({ method: 'DELETE', url: `/api/employee-notes/${ids.nBmgr}`, uid: ids.mgrA, role: 'manager', status: 403 });
      await expectRejected({ method: 'DELETE', url: '/api/employee-notes/999999999', uid: ids.hr, role: 'hr', status: 404 });
      await expectRejected({ method: 'DELETE', url: '/api/employee-notes/1e2', uid: ids.hr, role: 'hr', status: 400 });
    });

    test('dentro del alcance: el rol por sede crea y edita su nota; queda auditado', async () => {
      const c = await http('POST', '/api/employee-notes', ids.mgrA, 'manager', { employee_id: ids.empA2, visibility: 'managers', title: 'NOTA-MGR-A2' });
      expect(c.status).toBe(201);
      const { id } = await c.json();
      await waitAudit(ids.mgrA, 'employee_note_create', id);
      const u = await http('PUT', `/api/employee-notes/${id}`, ids.mgrA, 'manager', { pinned: 1 });
      expect(u.status).toBe(200);
      await waitAudit(ids.mgrA, 'employee_note_update', id);
      expect(await count('SELECT COUNT(*) AS n FROM employee_notes WHERE id = ? AND pinned = 1', [id])).toBe(1);
    });

    test('rol global: ve todas las visibilidades de B, edita y borra (sin cambio)', async () => {
      const r = await http('GET', `/api/employee-notes/by-employee/${ids.empB}`, ids.admin, 'admin');
      expect(await titles(r)).toEqual(['NOTA-B-BYMGR', 'NOTA-B-EMP', 'NOTA-B-MGR']);
      expect((await http('PUT', `/api/employee-notes/${ids.nBmgr}`, ids.admin, 'admin', { pinned: 1 })).status).toBe(200);
      const tmp = await insertNote(ids.empB, ids.admin, 'hr_only', 'NOTA-B-TMP');
      expect((await http('DELETE', `/api/employee-notes/${tmp}`, ids.hr, 'hr')).status).toBe(200);
      await waitAudit(ids.hr, 'employee_note_delete', tmp);
      expect(await count('SELECT COUNT(*) AS n FROM employee_notes WHERE id = ?', [tmp])).toBe(0);
    });
  });
});
