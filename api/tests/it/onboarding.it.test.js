'use strict';

/**
 * onboarding.it.test.js — INTEGRACIÓN (MySQL real + HTTP real + authenticate
 * real): flujo administrativo de onboarding con alcance por empleado.
 *
 * Datos SINTÉTICOS: dos empresas, una sede y un departamento por empresa,
 * empleados A1/A2/A3 (sede A) y B (sede B). Actores:
 *   - admin / hr               → gestión global;
 *   - mgrA / coordA            → gestión con alcance (sede A); mgrB (sede B);
 *   - supA / empA              → NO administran onboarding;
 *   - mgrInactive / mgrNoBranch→ cuenta desactivada / manager sin sede.
 * Responsables candidatos: uA2 (empleado de A), uB (empleado de B),
 * uInactive (cuenta desactivada), uUnlinked (sin empleado vinculado).
 *
 * Cada rechazo verifica: estado esperado, cuerpo sin datos de otra empresa,
 * CERO INSERT/UPDATE/DELETE en el servidor (contadores Com_* de MySQL),
 * filas intactas y CERO auditoría del actor. Las carreras usan una segunda
 * conexión que bloquea y modifica la fila sin confirmar mientras la API
 * espera.
 */
const { describeIT, makeConn, closeAppDb } = require('./helper');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'it-onboarding-secret-0123456789abcdef';

const WRITE_COUNTERS = ['Com_insert', 'Com_insert_select', 'Com_update', 'Com_update_multi',
  'Com_delete', 'Com_delete_multi', 'Com_replace', 'Com_replace_select'];

describeIT('onboarding (integración) — alcance, validación y consistencia', () => {
  let conn;
  let server;
  let base;
  const ids = {};
  const jwt = require('jsonwebtoken');
  const token = (userId, role) => jwt.sign({ id: userId, role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
  const http = (method, url, userId, role, body) => fetch(base + url, {
    method,
    headers: { Authorization: `Bearer ${token(userId, role)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  const emps = () => [ids.eA1, ids.eA2, ids.eA3, ids.eB];
  const snapshot = async () => JSON.stringify([
    (await conn.query('SELECT * FROM onboarding_processes WHERE employee_id IN (?) ORDER BY id', [emps()]))[0],
    (await conn.query(
      'SELECT t.* FROM onboarding_tasks t JOIN onboarding_processes p ON p.id = t.process_id WHERE p.employee_id IN (?) ORDER BY t.id', [emps()],
    ))[0],
    (await conn.query('SELECT id, name, description, active FROM onboarding_templates WHERE id IN (?) ORDER BY id', [[ids.tpl, ids.tplOff]]))[0],
    // Totales: ninguna plantilla ni tarea de plantilla creada por un rechazo.
    await count('SELECT COUNT(*) AS n FROM onboarding_templates'),
    await count('SELECT COUNT(*) AS n FROM onboarding_template_tasks'),
  ]);

  const LEAK_RE = /OnbB|NOTA-B|TAREA-B|onbb@|uB-full/g;
  const evidence = [];
  /** URL legible: ids reemplazados por el nombre del fixture según el contexto. */
  function describeUrl(url) {
    const name = (group, n) => Object.keys(ids).find((k) => group.test(k) && String(ids[k]) === n) || n;
    return url
      .replace(/tasks\/(\d+)/, (_m, n) => `tasks/${name(/^t(?!pl|t)/, n)}`)
      .replace(/templates\/(\d+)/, (_m, n) => `templates/${name(/^tpl/, n)}`)
      .replace(/onboarding\/(\d+)/, (_m, n) => `onboarding/${name(/^p[A-Z]/, n)}`);
  }

  async function expectRejected({ method, url, uid, role, body, status, code }) {
    const beforeRows = await snapshot();
    const beforeAudit = await auditCount(uid);
    const beforeWrites = await writeCounter();
    const r = await http(method, url, uid, role, body);
    const text = await r.text();
    await sleep(150);
    const writes = (await writeCounter()) - beforeWrites;
    const rowsChanged = (await snapshot()) !== beforeRows;
    const audits = (await auditCount(uid)) - beforeAudit;
    evidence.push({
      request: `${method} ${describeUrl(url)} ${body === undefined ? '' : JSON.stringify(body).slice(0, 60)} (${role})`,
      expected: status, got: r.status, leaked: [...new Set(text.match(LEAK_RE) || [])], writes, rowsChanged, audits,
    });
    expect({ url, status: r.status }).toEqual({ url, status });
    expect(text).not.toMatch(LEAK_RE);
    expect(writes).toBe(0);
    expect(rowsChanged).toBe(false);
    expect(audits).toBe(0);
    if (code) expect(JSON.parse(text).code).toBe(code);
    return text;
  }

  async function raceCase({ label, lock, request, uid }) {
    const c2 = await makeConn();
    try {
      await c2.query('START TRANSACTION');
      await lock(c2);
      const beforeAudit = await auditCount(uid);
      const w0 = await writeCounter();
      let settled = false;
      const p = request().then(async (r) => { settled = true; return { status: r.status, text: await r.text() }; });
      let blocked = false;
      for (let i = 0; i < 150 && !settled; i += 1) {
        const [rows] = await conn.query(
          `SELECT ID FROM information_schema.PROCESSLIST
            WHERE ID NOT IN (?) AND INFO IS NOT NULL
              AND (INFO LIKE '%FOR UPDATE%' OR INFO LIKE '%FOR SHARE%' OR INFO LIKE 'UPDATE %' OR INFO LIKE 'INSERT %' OR INFO LIKE 'DELETE %')`,
          [[conn.threadId, c2.threadId]],
        );
        if (rows.length) { blocked = true; await sleep(100); break; }
        await sleep(20);
      }
      await c2.query('COMMIT');
      const res = await p;
      await sleep(150);
      const out = { ...res, blocked, writes: (await writeCounter()) - w0, audits: (await auditCount(uid)) - beforeAudit };
      evidence.push({ request: `RACE ${label}`, got: out.status, leaked: [...new Set(out.text.match(LEAK_RE) || [])], writes: out.writes, rowsChanged: null, audits: out.audits, blocked });
      return out;
    } finally {
      try { await c2.query('ROLLBACK'); } catch { /* ya confirmada */ }
      await c2.end();
    }
  }

  async function insertUser(tag, role, { branchId = null, employeeId = null, active = 1 } = {}) {
    const [r] = await conn.query(
      'INSERT INTO users (username, email, password_hash, full_name, role, employee_id, branch_id, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [`${ids.uniq}${tag}`, `${ids.uniq.toLowerCase()}${tag.toLowerCase()}@it.local`, 'it-no-login', `${tag}-full`, role, employeeId, branchId, active],
    );
    return r.insertId;
  }
  async function insertProcess(employeeId, status = 'active') {
    return (await conn.query(
      "INSERT INTO onboarding_processes (template_id, employee_id, type, start_date, status) VALUES (?, ?, 'onboarding', '2026-01-05', ?)",
      [ids.tpl, employeeId, status],
    ))[0].insertId;
  }
  async function insertTask(processId, title, assigneeId = null) {
    return (await conn.query(
      "INSERT INTO onboarding_tasks (process_id, title, assignee_id, due_date) VALUES (?, ?, ?, '2026-01-10')",
      [processId, title, assigneeId],
    ))[0].insertId;
  }

  beforeAll(async () => {
    conn = await makeConn();
    const uniq = `OB${Date.now() % 100000}`;
    ids.uniq = uniq;
    const ins = async (sql, params) => (await conn.query(sql, params))[0].insertId;
    ids.coA = await ins('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}A`, 'ITOnb A']);
    ids.coB = await ins('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}B`, 'ITOnb B']);
    ids.brA = await ins('INSERT INTO branches (code, company_id, name, active) VALUES (?, ?, ?, 1)', [`${uniq}BA`, ids.coA, 'ITOnb sede A']);
    ids.brB = await ins('INSERT INTO branches (code, company_id, name, active) VALUES (?, ?, ?, 1)', [`${uniq}BB`, ids.coB, 'ITOnb sede B']);
    ids.dA = await ins('INSERT INTO departments (name, code, branch_id, active) VALUES (?, ?, ?, 1)', ['ITOnb DA', `${uniq}DA`, ids.brA]);
    ids.dB = await ins('INSERT INTO departments (name, code, branch_id, active) VALUES (?, ?, ?, 1)', ['ITOnb DB', `${uniq}DB`, ids.brB]);
    const emp = (tag, br, d) => ins(
      'INSERT INTO employees (code, employee_number, first_name, last_name, email, branch_id, department_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [`${uniq}${tag}`, `${uniq}N${tag}`, 'Emp', `Onb${tag}`, `${uniq.toLowerCase()}onb${tag.toLowerCase()}@it.local`, br, d, 'active'],
    );
    ids.eA1 = await emp('A1', ids.brA, ids.dA);
    ids.eA2 = await emp('A2', ids.brA, ids.dA);
    ids.eA3 = await emp('A3', ids.brA, ids.dA);
    ids.eB = await emp('B', ids.brB, ids.dB);

    ids.admin = await insertUser('ad', 'admin');
    ids.hr = await insertUser('hr', 'hr');
    ids.mgrA = await insertUser('mA', 'manager', { branchId: ids.brA });
    ids.coordA = await insertUser('cA', 'coordinator', { branchId: ids.brA });
    ids.mgrB = await insertUser('mB', 'manager', { branchId: ids.brB });
    ids.supA = await insertUser('sA', 'supervisor', { branchId: ids.brA });
    ids.empA = await insertUser('eA', 'employee', { branchId: ids.brA, employeeId: ids.eA1 });
    ids.mgrInactive = await insertUser('mI', 'manager', { branchId: ids.brA, active: 0 });
    ids.mgrNoBranch = await insertUser('mN', 'manager');
    ids.uA2 = await insertUser('uA2', 'employee', { branchId: ids.brA, employeeId: ids.eA2 });
    ids.uB = await insertUser('uB', 'employee', { branchId: ids.brB, employeeId: ids.eB });
    ids.uInactive = await insertUser('uI', 'employee', { branchId: ids.brA, employeeId: ids.eA3, active: 0 });
    ids.uUnlinked = await insertUser('uU', 'hr');

    ids.tpl = await ins("INSERT INTO onboarding_templates (name, type, active) VALUES (?, 'onboarding', 1)", [`${uniq} plantilla`]);
    ids.tplOff = await ins("INSERT INTO onboarding_templates (name, type, active) VALUES (?, 'onboarding', 0)", [`${uniq} inactiva`]);
    ids.tt1 = await ins('INSERT INTO onboarding_template_tasks (template_id, title, due_days, sort_order) VALUES (?, ?, 3, 0)', [ids.tpl, 'Crear cuenta']);
    ids.tt2 = await ins('INSERT INTO onboarding_template_tasks (template_id, title, due_days, sort_order) VALUES (?, ?, 30, 1)', [ids.tpl, 'Entregar equipo']);

    ids.pA = await insertProcess(ids.eA1);
    ids.tA1 = await insertTask(ids.pA, 'TAREA-A1');
    ids.tA2 = await insertTask(ids.pA, 'TAREA-A2');
    ids.tA3 = await insertTask(ids.pA, 'TAREA-A3');
    ids.pB = await insertProcess(ids.eB);
    ids.tB1 = await insertTask(ids.pB, 'TAREA-B1', ids.uB);
    ids.tB2 = await insertTask(ids.pB, 'TAREA-B2');
    ids.pA2 = await insertProcess(ids.eA2);           // completar
    ids.pAcancel = await insertProcess(ids.eA2);      // cancelar
    ids.pAclosed = await insertProcess(ids.eA2, 'completed');
    ids.tClosed = await insertTask(ids.pAclosed, 'TAREA-CERRADA');
    ids.pAuto = await insertProcess(ids.eA2);         // autocompletado
    ids.tAuto1 = await insertTask(ids.pAuto, 'TAREA-AUTO1');
    ids.tAuto2 = await insertTask(ids.pAuto, 'TAREA-AUTO2');
    ids.pRace = await insertProcess(ids.eA2);         // cierre concurrente
    ids.tRace = await insertTask(ids.pRace, 'TAREA-RACE');
    ids.pRace2 = await insertProcess(ids.eA2);        // completar vs cancelar
    ids.tplZero = await ins("INSERT INTO onboarding_templates (name, type, active) VALUES (?, 'onboarding', 1)", [`${uniq} cero`]);
    ids.ttZero = await ins('INSERT INTO onboarding_template_tasks (template_id, title, due_days, sort_order) VALUES (?, ?, 0, 0)', [ids.tplZero, 'Mismo día']);
    ids.ttOne = await ins('INSERT INTO onboarding_template_tasks (template_id, title, due_days, sort_order) VALUES (?, ?, 1, 1)', [ids.tplZero, 'Al día siguiente']);
    ids.pMeta = await insertProcess(ids.eA2);         // metadatos de finalización
    ids.tMeta = await insertTask(ids.pMeta, 'TAREA-META');
    ids.tMetaKeep = await insertTask(ids.pMeta, 'TAREA-META-PENDIENTE'); // mantiene el proceso activo

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/onboarding', require('../../src/routes/onboarding'));
    app.use('/api/users', require('../../src/routes/users'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Error interno' }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (process.env.ONBOARDING_EVIDENCE_OUT) {
      require('fs').writeFileSync(process.env.ONBOARDING_EVIDENCE_OUT, JSON.stringify(evidence, null, 1));
    }
    if (server) await new Promise((r) => server.close(r));
    if (conn) {
      const userIds = ['admin', 'hr', 'mgrA', 'coordA', 'mgrB', 'supA', 'empA', 'mgrInactive', 'mgrNoBranch', 'uA2', 'uB', 'uInactive', 'uUnlinked']
        .map((k) => ids[k]).filter(Boolean);
      await conn.query('DELETE FROM onboarding_processes WHERE employee_id IN (?)', [emps().filter(Boolean)]);
      // Fixtures y plantillas creadas por los tests (todas con el prefijo único).
      await conn.query('DELETE FROM onboarding_templates WHERE name LIKE ?', [`${ids.uniq}%`]);
      if (userIds.length) {
        await conn.query('DELETE FROM onboarding_templates WHERE created_by IN (?)', [userIds]);
        await conn.query('DELETE FROM audit_events WHERE user_id IN (?)', [userIds]);
        await conn.query('DELETE FROM users WHERE id IN (?)', [userIds]);
      }
      await conn.query('DELETE FROM employees WHERE id IN (?)', [emps().filter(Boolean)]);
      await conn.query('DELETE FROM departments WHERE id IN (?, ?)', [ids.dA, ids.dB]);
      await conn.query('DELETE FROM branches WHERE id IN (?, ?)', [ids.brA, ids.brB]);
      await conn.query('DELETE FROM companies WHERE id IN (?, ?)', [ids.coA, ids.coB]);
      await conn.end();
    }
    await closeAppDb();
  });

  // ───────────────────────────── Roles ─────────────────────────────
  describe('roles', () => {
    test('plantillas: los roles de gestión (global y con alcance) pueden consultar', async () => {
      expect((await http('GET', '/api/onboarding/templates', ids.mgrA, 'manager')).status).toBe(200);
      expect((await http('GET', `/api/onboarding/templates/${ids.tpl}`, ids.coordA, 'coordinator')).status).toBe(200);
      expect((await http('GET', '/api/onboarding/templates?all=1', ids.hr, 'hr')).status).toBe(200);
    });

    const ROLE_REJECTIONS = [
      ['supervisor lista plantillas', () => ({ method: 'GET', url: '/api/onboarding/templates', uid: ids.supA, role: 'supervisor', status: 403 })],
      ['employee abre una plantilla', () => ({ method: 'GET', url: `/api/onboarding/templates/${ids.tpl}`, uid: ids.empA, role: 'employee', status: 403 })],
      ['manager crea plantilla', () => ({ method: 'POST', url: '/api/onboarding/templates', uid: ids.mgrA, role: 'manager', status: 403, body: { name: 'x', tasks: [{ title: 'y' }] } })],
      ['manager desactiva plantilla', () => ({ method: 'PUT', url: `/api/onboarding/templates/${ids.tpl}`, uid: ids.mgrA, role: 'manager', status: 403, body: { active: 0 } })],
      ['plantilla con id no canónico', () => ({ method: 'GET', url: '/api/onboarding/templates/1e2', uid: ids.hr, role: 'hr', status: 400 })],
      ['editar plantilla inexistente', () => ({ method: 'PUT', url: '/api/onboarding/templates/999999999', uid: ids.hr, role: 'hr', status: 404, body: { name: 'otro' } })],
      ['desactivar plantilla inexistente', () => ({ method: 'DELETE', url: '/api/onboarding/templates/999999999', uid: ids.hr, role: 'hr', status: 404 })],
      ['plantilla con active inválido', () => ({ method: 'PUT', url: `/api/onboarding/templates/${ids.tpl}`, uid: ids.hr, role: 'hr', status: 400, body: { active: 'si' } })],
      ['supervisor lista procesos', () => ({ method: 'GET', url: '/api/onboarding', uid: ids.supA, role: 'supervisor', status: 403 })],
      ['employee abre un proceso', () => ({ method: 'GET', url: `/api/onboarding/${ids.pA}`, uid: ids.empA, role: 'employee', status: 403 })],
      ['supervisor modifica una tarea', () => ({ method: 'PATCH', url: `/api/onboarding/tasks/${ids.tA1}`, uid: ids.supA, role: 'supervisor', status: 403, body: { status: 'done' } })],
      ['employee modifica una tarea ajena', () => ({ method: 'PATCH', url: `/api/onboarding/tasks/${ids.tB1}`, uid: ids.empA, role: 'employee', status: 403, body: { assignee_id: ids.empA, notes: 'cambiado' } })],
    ];
    test.each(ROLE_REJECTIONS)('%s → rechazado sin escritura', async (_label, mk) => { await expectRejected(mk()); });

    test('cuenta desactivada → 401; manager sin sede → listado vacío y 404', async () => {
      await expectRejected({ method: 'PATCH', url: `/api/onboarding/tasks/${ids.tA1}`, uid: ids.mgrInactive, role: 'manager', status: 401, body: { status: 'done' } });
      const l = await http('GET', '/api/onboarding?status=', ids.mgrNoBranch, 'manager');
      expect(l.status).toBe(200);
      expect((await l.json()).data).toEqual([]);
      await expectRejected({ method: 'GET', url: `/api/onboarding/${ids.pA}`, uid: ids.mgrNoBranch, role: 'manager', status: 404 });
      await expectRejected({ method: 'PATCH', url: `/api/onboarding/tasks/${ids.tA1}`, uid: ids.mgrNoBranch, role: 'manager', status: 404, body: { status: 'done' } });
    });
  });

  // ──────────────────────────── Procesos ────────────────────────────
  describe('procesos: alcance', () => {
    test('listado: manager A ve sólo procesos de su alcance; global ve ambos', async () => {
      const a = (await (await http('GET', '/api/onboarding?status=', ids.mgrA, 'manager')).json()).data.map((p) => p.id);
      expect(a).toContain(ids.pA);
      expect(a).not.toContain(ids.pB);
      const g = (await (await http('GET', '/api/onboarding?status=', ids.admin, 'admin')).json()).data.map((p) => p.id);
      expect(g).toEqual(expect.arrayContaining([ids.pA, ids.pB]));
      const b = (await (await http('GET', '/api/onboarding?status=', ids.mgrB, 'manager')).json()).data.map((p) => p.id);
      expect(b).toContain(ids.pB);
      expect(b).not.toContain(ids.pA);
    });

    test('listado: filtros inválidos → 400', async () => {
      await expectRejected({ method: 'GET', url: '/api/onboarding?status=bogus', uid: ids.mgrA, role: 'manager', status: 400 });
      await expectRejected({ method: 'GET', url: '/api/onboarding?type=otro', uid: ids.mgrA, role: 'manager', status: 400 });
      await expectRejected({ method: 'GET', url: '/api/onboarding?employee_id=1e2', uid: ids.mgrA, role: 'manager', status: 400 });
    });

    test('detalle: ajeno e inexistente → mismo 404 sin datos; no canónico → 400; propio y global → 200', async () => {
      const ajeno = await expectRejected({ method: 'GET', url: `/api/onboarding/${ids.pB}`, uid: ids.mgrA, role: 'manager', status: 404 });
      const inexistente = await expectRejected({ method: 'GET', url: '/api/onboarding/999999999', uid: ids.mgrA, role: 'manager', status: 404 });
      expect(ajeno).toBe(inexistente);
      await expectRejected({ method: 'GET', url: '/api/onboarding/1e2', uid: ids.mgrA, role: 'manager', status: 400 });
      const own = await http('GET', `/api/onboarding/${ids.pA}`, ids.coordA, 'coordinator');
      expect(own.status).toBe(200);
      expect((await own.json()).data.tasks.map((t) => t.id)).toEqual([ids.tA1, ids.tA2, ids.tA3]);
      expect((await http('GET', `/api/onboarding/${ids.pB}`, ids.hr, 'hr')).status).toBe(200);
    });

    test('candidatos a responsable: filtrados por el servidor', async () => {
      const a = await http('GET', `/api/onboarding/${ids.pA}/assignee-candidates`, ids.mgrA, 'manager');
      expect(a.status).toBe(200);
      const aIds = (await a.json()).data.map((u) => u.id);
      expect(aIds).toContain(ids.uA2);
      for (const k of ['uB', 'uInactive', 'uUnlinked']) expect(aIds).not.toContain(ids[k]);
      const g = (await (await http('GET', `/api/onboarding/${ids.pB}/assignee-candidates`, ids.admin, 'admin')).json()).data.map((u) => u.id);
      expect(g).toEqual(expect.arrayContaining([ids.uA2, ids.uB, ids.uUnlinked]));
      expect(g).not.toContain(ids.uInactive);
      await expectRejected({ method: 'GET', url: `/api/onboarding/${ids.pB}/assignee-candidates`, uid: ids.mgrA, role: 'manager', status: 404 });
      await expectRejected({ method: 'GET', url: `/api/onboarding/${ids.pA}/assignee-candidates`, uid: ids.supA, role: 'supervisor', status: 403 });
    });

    test('relevamiento: /api/users/lookup (global, otros módulos) sigue devolviendo usuarios de otra sede', async () => {
      // Fuera del alcance de este PR: se documenta, no se corrige. Onboarding
      // ya no lo usa (ver candidatos filtrados).
      const r = await http('GET', '/api/users/lookup', ids.mgrA, 'manager');
      const list = await r.json();
      evidence.push({ request: 'GET /api/users/lookup (manager A) [relevamiento]', got: r.status, containsUserOfB: Array.isArray(list) && list.some((u) => u.id === ids.uB) });
      expect(r.status).toBe(200);
    });
  });

  describe('procesos: alta, cierre y cancelación', () => {
    test('alta global: valida plantilla, empleado, fecha y responsables; fechas civiles sin corrimiento', async () => {
      const r = await http('POST', '/api/onboarding', ids.hr, 'hr', { template_id: ids.tpl, employee_id: ids.eA3, start_date: '2026-03-01', assignees: { [ids.tt1]: ids.uA2 } });
      expect(r.status).toBe(201);
      const { id } = await r.json();
      await waitAudit(ids.hr, 'onboarding_process_create', id);
      const [rows] = await conn.query("SELECT title, assignee_id, DATE_FORMAT(due_date, '%Y-%m-%d') AS due FROM onboarding_tasks WHERE process_id = ? ORDER BY sort_order", [id]);
      expect(rows).toEqual([
        { title: 'Crear cuenta', assignee_id: ids.uA2, due: '2026-03-04' },
        { title: 'Entregar equipo', assignee_id: null, due: '2026-03-31' },
      ]);
    });

    test('due_days = 0 vence el mismo día que start_date (MySQL real)', async () => {
      const r = await http('POST', '/api/onboarding', ids.hr, 'hr', { template_id: ids.tplZero, employee_id: ids.eA3, start_date: '2026-10-05' });
      expect(r.status).toBe(201);
      const { id } = await r.json();
      const [rows] = await conn.query("SELECT title, DATE_FORMAT(due_date, '%Y-%m-%d') AS due FROM onboarding_tasks WHERE process_id = ? ORDER BY sort_order", [id]);
      evidence.push({ request: 'POST /api/onboarding (plantilla con due_days 0 y 1, start 2026-10-05) (hr)', got: r.status, due: rows.map((x) => x.due) });
      expect(rows).toEqual([
        { title: 'Mismo día', due: '2026-10-05' },
        { title: 'Al día siguiente', due: '2026-10-06' },
      ]);
    });

    const OK = () => ({ template_id: ids.tpl, employee_id: ids.eA3, start_date: '2026-03-01' });
    test.each([
      ['manager', () => ({ uid: ids.mgrA, role: 'manager', status: 403, body: OK() })],
      ['empleado inexistente', () => ({ uid: ids.hr, role: 'hr', status: 404, body: { ...OK(), employee_id: 999999999 } })],
      ['plantilla inexistente', () => ({ uid: ids.hr, role: 'hr', status: 404, body: { ...OK(), template_id: 999999999 } })],
      ['plantilla inactiva', () => ({ uid: ids.hr, role: 'hr', status: 404, body: { ...OK(), template_id: ids.tplOff } })],
      ['fecha inexistente', () => ({ uid: ids.hr, role: 'hr', status: 400, body: { ...OK(), start_date: '2026-02-30' } })],
      ['empleado no canónico', () => ({ uid: ids.hr, role: 'hr', status: 400, body: { ...OK(), employee_id: '1e2' } })],
      ['responsable inactivo', () => ({ uid: ids.hr, role: 'hr', status: 400, body: { ...OK(), assignees: { [ids.tt1]: ids.uInactive } } })],
      ['responsable para una tarea que no es de la plantilla', () => ({ uid: ids.hr, role: 'hr', status: 400, body: { ...OK(), assignees: { 999999999: ids.uA2 } } })],
    ])('alta rechazada (%s) sin INSERT', async (_label, mk) => {
      await expectRejected({ method: 'POST', url: '/api/onboarding', ...mk() });
    });

    test('completar y cancelar: transacción y auditoría tras commit', async () => {
      expect((await http('POST', `/api/onboarding/${ids.pA2}/complete`, ids.hr, 'hr')).status).toBe(200);
      await waitAudit(ids.hr, 'onboarding_process_complete', ids.pA2);
      expect((await http('POST', `/api/onboarding/${ids.pAcancel}/cancel`, ids.admin, 'admin')).status).toBe(200);
      await waitAudit(ids.admin, 'onboarding_process_cancel', ids.pAcancel);
    });

    test.each([
      ['completar un proceso ya cerrado', () => ({ url: `/api/onboarding/${ids.pAclosed}/complete`, uid: ids.hr, role: 'hr', status: 409 })],
      ['cancelar un proceso ya cerrado', () => ({ url: `/api/onboarding/${ids.pAclosed}/cancel`, uid: ids.hr, role: 'hr', status: 409 })],
      ['completar inexistente', () => ({ url: '/api/onboarding/999999999/complete', uid: ids.hr, role: 'hr', status: 404 })],
      ['cancelar con id no canónico', () => ({ url: '/api/onboarding/1e2/cancel', uid: ids.hr, role: 'hr', status: 400 })],
      ['manager completa', () => ({ url: `/api/onboarding/${ids.pA}/complete`, uid: ids.mgrA, role: 'manager', status: 403 })],
    ])('%s → rechazado sin escritura ni auditoría', async (_label, mk) => {
      await expectRejected({ method: 'POST', ...mk() });
    });
  });

  // ─────────────────────── Alta de plantillas ───────────────────────
  describe('POST /templates: validación estricta antes de la transacción', () => {
    const name = () => `${ids.uniq} nueva`;
    const tk = (over = {}) => ({ title: 'Tarea', ...over });
    test.each([
      ['tasks no arreglo', () => ({ name: name(), tasks: 'x' })],
      ['tasks objeto', () => ({ name: name(), tasks: { 0: tk() } })],
      ['tasks vacío', () => ({ name: name(), tasks: [] })],
      ['tipo inválido', () => ({ name: name(), type: 'otro', tasks: [tk()] })],
      ['nombre ausente', () => ({ tasks: [tk()] })],
      ['nombre demasiado largo', () => ({ name: `${ids.uniq}${'x'.repeat(121)}`, tasks: [tk()] })],
      ['título vacío', () => ({ name: name(), tasks: [tk({ title: '' })] })],
      ['título demasiado largo', () => ({ name: name(), tasks: [tk({ title: 'x'.repeat(201) })] })],
      ['una tarea válida y otra inválida (no se omite)', () => ({ name: name(), tasks: [tk(), tk({ title: '   ' })] })],
      ['due_days negativo', () => ({ name: name(), tasks: [tk({ due_days: -1 })] })],
      ['due_days fraccionario', () => ({ name: name(), tasks: [tk({ due_days: 1.5 })] })],
      ['due_days textual', () => ({ name: name(), tasks: [tk({ due_days: '5' })] })],
      ['due_days fuera de rango', () => ({ name: name(), tasks: [tk({ due_days: 3651 })] })],
      ['campo desconocido en la plantilla', () => ({ name: name(), active: 0, tasks: [tk()] })],
      ['campo desconocido en una tarea', () => ({ name: name(), tasks: [tk({ sort_order: 9 })] })],
      ['descripción no texto', () => ({ name: name(), description: 5, tasks: [tk()] })],
      ['rol por defecto demasiado largo', () => ({ name: name(), tasks: [tk({ default_assignee_role: 'x'.repeat(61) })] })],
    ])('%s → 400 sin plantillas ni tareas creadas', async (_label, mk) => {
      await expectRejected({ method: 'POST', url: '/api/onboarding/templates', uid: ids.hr, role: 'hr', status: 400, code: 'INVALID_INPUT', body: mk() });
    });

    test('positivo con cero días: 201 y filas exactas; el proceso vence el mismo día', async () => {
      const r = await http('POST', '/api/onboarding/templates', ids.hr, 'hr', {
        name: `${ids.uniq} cero dias`, type: 'offboarding', description: null,
        tasks: [
          { title: 'Día cero', description: '', default_assignee_role: '', due_days: 0 },
          { title: 'Sin plazo', description: 'd', default_assignee_role: 'IT' },
        ],
      });
      expect(r.status).toBe(201);
      const { id } = await r.json();
      const [[tpl]] = await conn.query('SELECT name, type, description, created_by FROM onboarding_templates WHERE id = ?', [id]);
      expect(tpl).toEqual({ name: `${ids.uniq} cero dias`, type: 'offboarding', description: null, created_by: ids.hr });
      const [tasks] = await conn.query(
        'SELECT title, description, default_assignee_role, due_days, sort_order FROM onboarding_template_tasks WHERE template_id = ? ORDER BY sort_order', [id],
      );
      expect(tasks).toEqual([
        { title: 'Día cero', description: null, default_assignee_role: null, due_days: 0, sort_order: 0 },
        { title: 'Sin plazo', description: 'd', default_assignee_role: 'IT', due_days: 3, sort_order: 1 },
      ]);
      const p = await http('POST', '/api/onboarding', ids.hr, 'hr', { template_id: id, employee_id: ids.eA3, start_date: '2026-10-05' });
      expect(p.status).toBe(201);
      const [due] = await conn.query("SELECT DATE_FORMAT(due_date, '%Y-%m-%d') AS due FROM onboarding_tasks WHERE process_id = ? ORDER BY sort_order", [(await p.json()).id]);
      expect(due.map((x) => x.due)).toEqual(['2026-10-05', '2026-10-08']);
    });
  });

  // ─────────────────── Metadatos de finalización ───────────────────
  describe('PATCH de tareas: metadatos de finalización (proceso activo con otra tarea pendiente)', () => {
    const OLD = '2020-01-02 03:04:05';
    const meta = async () => (await conn.query(
      "SELECT status, completed_by, DATE_FORMAT(completed_at, '%Y-%m-%d %H:%i:%s') AS at FROM onboarding_tasks WHERE id = ?", [ids.tMeta],
    ))[0][0];
    // La sesión de la API usa DB_TIMEZONE: NOW() de otra sesión no es comparable.
    // "Reciente" = dentro de la mayor diferencia horaria posible respecto de UTC.
    const isRecent = async () => Number((await conn.query(
      'SELECT ABS(TIMESTAMPDIFF(MINUTE, completed_at, UTC_TIMESTAMP())) <= 14 * 60 + 5 AS ok FROM onboarding_tasks WHERE id = ?', [ids.tMeta],
    ))[0][0].ok) === 1;
    const patch = (uid, role, body) => http('PATCH', `/api/onboarding/tasks/${ids.tMeta}`, uid, role, body);
    /** Deja la tarea finalizada con metadatos conocidos (fecha antigua). */
    const setDoneOld = () => conn.query("UPDATE onboarding_tasks SET status = 'done', completed_by = ?, completed_at = ? WHERE id = ?", [ids.mgrA, OLD, ids.tMeta]);

    test('a done: registra actor y fecha; el proceso sigue activo', async () => {
      expect((await patch(ids.mgrA, 'manager', { status: 'done' })).status).toBe(200);
      const m = await meta();
      expect({ status: m.status, by: m.completed_by }).toEqual({ status: 'done', by: ids.mgrA });
      expect(await isRecent()).toBe(true);
      const [[p]] = await conn.query('SELECT status FROM onboarding_processes WHERE id = ?', [ids.pMeta]);
      expect(p.status).toBe('active');
    });

    test.each([
      ['notas', () => ({ notes: 'nota' })],
      ['fecha', () => ({ due_date: '2026-11-30' })],
      ['responsable', () => ({ assignee_id: ids.uA2 })],
      ['notas, fecha y responsable a null', () => ({ notes: null, due_date: null, assignee_id: null })],
    ])('PATCH sólo de %s conserva completed_at y completed_by', async (_label, mk) => {
      await setDoneOld();
      expect((await patch(ids.coordA, 'coordinator', mk())).status).toBe(200);
      expect(await meta()).toEqual({ status: 'done', completed_by: ids.mgrA, at: OLD });
    });

    test.each(['pending', 'in_progress', 'skipped'])('done → %s limpia completed_at y completed_by', async (status) => {
      await setDoneOld();
      const r = await patch(ids.coordA, 'coordinator', { status });
      const m = await meta();
      evidence.push({ request: `PATCH tasks/tMeta done → ${status} (coordinator)`, got: r.status, completed_by: m.completed_by, completed_at: m.at });
      expect(r.status).toBe(200);
      expect(m).toEqual({ status, completed_by: null, at: null });
    });

    test.each([
      ['{status:"done"}', () => ({ status: 'done' }), null],
      ['{status:"done", notes:"nueva"}', () => ({ status: 'done', notes: 'nueva' }), 'nueva'],
    ])('reintento done → done %s por otro actor: conserva exactamente actor y fecha originales', async (label, mk, notes) => {
      await setDoneOld();
      await conn.query('UPDATE onboarding_tasks SET notes = NULL WHERE id = ?', [ids.tMeta]);
      const r = await patch(ids.hr, 'hr', mk());
      const m = await meta();
      const [[row]] = await conn.query('SELECT notes FROM onboarding_tasks WHERE id = ?', [ids.tMeta]);
      evidence.push({ request: `PATCH tasks/tMeta done → done ${label} (hr; original mgrA ${OLD})`, got: r.status, completed_by: m.completed_by, completed_at: m.at, notes: row.notes });
      expect(r.status).toBe(200);
      expect(m).toEqual({ status: 'done', completed_by: ids.mgrA, at: OLD });
      expect(row.notes).toBe(notes);
      await waitAudit(ids.hr, 'onboarding_task_update', ids.tMeta);
    });

    test('volver a done registra el nuevo actor y la nueva fecha', async () => {
      await setDoneOld();
      expect((await patch(ids.mgrA, 'manager', { status: 'pending' })).status).toBe(200);
      expect(await meta()).toEqual({ status: 'pending', completed_by: null, at: null });
      expect((await patch(ids.hr, 'hr', { status: 'done' })).status).toBe(200);
      const m = await meta();
      expect({ status: m.status, by: m.completed_by }).toEqual({ status: 'done', by: ids.hr });
      expect(m.at > OLD).toBe(true);
      expect(await isRecent()).toBe(true);
      await waitAudit(ids.hr, 'onboarding_task_update', ids.tMeta);
    });

    test('fuera de alcance: manager B no reabre la tarea finalizada → 404, metadatos intactos', async () => {
      await setDoneOld();
      await expectRejected({ method: 'PATCH', url: `/api/onboarding/tasks/${ids.tMeta}`, uid: ids.mgrB, role: 'manager', status: 404, body: { status: 'pending' } });
      expect(await meta()).toEqual({ status: 'done', completed_by: ids.mgrA, at: OLD });
    });
  });

  // ───────────────────────────── Tareas ─────────────────────────────
  describe('PATCH de tareas: alcance y validación', () => {
    test('manager A: tarea de B y tarea inexistente → mismo 404, sin escritura', async () => {
      const b = await expectRejected({ method: 'PATCH', url: `/api/onboarding/tasks/${ids.tB1}`, uid: ids.mgrA, role: 'manager', status: 404, body: { status: 'done' } });
      const x = await expectRejected({ method: 'PATCH', url: '/api/onboarding/tasks/999999999', uid: ids.mgrA, role: 'manager', status: 404, body: { status: 'done' } });
      expect(b).toBe(x);
    });

    test.each([
      ['id no canónico', '1e2', { status: 'done' }],
      ['estado inválido', 'tA1', { status: 'bogus' }],
      ['responsable no entero', 'tA1', { assignee_id: 'abc' }],
      ['responsable no canónico', 'tA1', { assignee_id: '1e2' }],
      ['fecha inexistente', 'tA1', { due_date: '2026-02-30' }],
      ['fecha en otro formato', 'tA1', { due_date: '30/12/2026' }],
      ['notas no texto', 'tA1', { notes: { x: 1 } }],
      ['notas demasiado largas', 'tA1', { notes: 'x'.repeat(2001) }],
      ['campo no permitido', 'tA1', { status: 'done', process_id: 'pB' }],
      ['sin cambios', 'tA1', {}],
    ])('%s → 400 sin escritura', async (_label, task, body) => {
      const url = `/api/onboarding/tasks/${task === '1e2' ? '1e2' : ids[task]}`;
      const b = { ...body };
      if (b.process_id === 'pB') b.process_id = ids.pB;
      await expectRejected({ method: 'PATCH', url, uid: ids.mgrA, role: 'manager', status: 400, body: b });
    });

    test.each([
      ['manager asigna un empleado de otra sede', () => [ids.mgrA, 'manager', ids.uB]],
      ['manager asigna una cuenta sin empleado', () => [ids.mgrA, 'manager', ids.uUnlinked]],
      ['manager asigna una cuenta desactivada', () => [ids.mgrA, 'manager', ids.uInactive]],
      ['global asigna una cuenta desactivada', () => [ids.admin, 'admin', ids.uInactive]],
      ['global asigna una cuenta inexistente', () => [ids.admin, 'admin', 999999999]],
    ])('%s → 400 INVALID_ASSIGNEE sin escritura', async (_label, mk) => {
      const [uid, role, assignee] = mk();
      await expectRejected({ method: 'PATCH', url: `/api/onboarding/tasks/${ids.tA1}`, uid, role, status: 400, code: 'INVALID_ASSIGNEE', body: { assignee_id: assignee } });
    });

    test('tarea de un proceso cerrado → 409 sin escritura', async () => {
      await expectRejected({ method: 'PATCH', url: `/api/onboarding/tasks/${ids.tClosed}`, uid: ids.mgrA, role: 'manager', status: 409, body: { status: 'done' } });
    });

    test('controles positivos: manager dentro de su alcance y global en cualquier sede, auditados', async () => {
      expect((await http('PATCH', `/api/onboarding/tasks/${ids.tA1}`, ids.mgrA, 'manager', { status: 'in_progress' })).status).toBe(200);
      await waitAudit(ids.mgrA, 'onboarding_task_update', ids.tA1);
      expect((await http('PATCH', `/api/onboarding/tasks/${ids.tA1}`, ids.coordA, 'coordinator', { assignee_id: String(ids.uA2), due_date: '2026-12-31', notes: 'ok' })).status).toBe(200);
      const [[row]] = await conn.query("SELECT status, assignee_id, DATE_FORMAT(due_date, '%Y-%m-%d') AS due, notes FROM onboarding_tasks WHERE id = ?", [ids.tA1]);
      expect(row).toEqual({ status: 'in_progress', assignee_id: ids.uA2, due: '2026-12-31', notes: 'ok' });
      expect((await http('PATCH', `/api/onboarding/tasks/${ids.tA1}`, ids.mgrA, 'manager', { assignee_id: null, due_date: null, notes: null })).status).toBe(200);
      expect((await http('PATCH', `/api/onboarding/tasks/${ids.tB2}`, ids.admin, 'admin', { assignee_id: ids.uB })).status).toBe(200);
      expect((await http('PATCH', `/api/onboarding/tasks/${ids.tB2}`, ids.hr, 'hr', { assignee_id: ids.uUnlinked })).status).toBe(200);
      await waitAudit(ids.hr, 'onboarding_task_update', ids.tB2);
    });

    test('autocompletado: al terminar la última tarea el proceso queda completado (contrato actual)', async () => {
      expect((await http('PATCH', `/api/onboarding/tasks/${ids.tAuto1}`, ids.mgrA, 'manager', { status: 'done' })).status).toBe(200);
      expect((await http('PATCH', `/api/onboarding/tasks/${ids.tAuto2}`, ids.mgrA, 'manager', { status: 'skipped' })).status).toBe(200);
      const [[p]] = await conn.query('SELECT status, completed_at IS NOT NULL AS closed FROM onboarding_processes WHERE id = ?', [ids.pAuto]);
      expect({ status: p.status, closed: Number(p.closed) }).toEqual({ status: 'completed', closed: 1 });
      const [[t]] = await conn.query('SELECT completed_by FROM onboarding_tasks WHERE id = ?', [ids.tAuto1]);
      expect(t.completed_by).toBe(ids.mgrA);
      await expectRejected({ method: 'PATCH', url: `/api/onboarding/tasks/${ids.tAuto1}`, uid: ids.mgrA, role: 'manager', status: 409, body: { status: 'pending' } });
    });
  });

  // ───────────────────────────── Carreras ─────────────────────────────
  describe('carreras deterministas (MySQL real)', () => {
    test('empleado cambiado de sede mientras el manager edita su tarea → 404, sin escritura ni auditoría', async () => {
      try {
        const r = await raceCase({
          label: 'PATCH tarea (mudanza de sede)', uid: ids.mgrA,
          lock: async (c2) => {
            await c2.query('SELECT id FROM employees WHERE id = ? FOR UPDATE', [ids.eA1]);
            await c2.query('UPDATE employees SET department_id = ?, branch_id = ? WHERE id = ?', [ids.dB, ids.brB, ids.eA1]);
          },
          request: () => http('PATCH', `/api/onboarding/tasks/${ids.tA2}`, ids.mgrA, 'manager', { status: 'done' }),
        });
        expect({ status: r.status, writes: r.writes, audits: r.audits }).toEqual({ status: 404, writes: 0, audits: 0 });
        const [[t]] = await conn.query('SELECT status FROM onboarding_tasks WHERE id = ?', [ids.tA2]);
        expect(t.status).toBe('pending');
      } finally {
        await conn.query('UPDATE employees SET department_id = ?, branch_id = ? WHERE id = ?', [ids.dA, ids.brA, ids.eA1]);
      }
    });

    test('tarea eliminada mientras se edita → 404, sin auditoría', async () => {
      const r = await raceCase({
        label: 'PATCH tarea (borrado concurrente)', uid: ids.mgrA,
        lock: async (c2) => {
          await c2.query('SELECT id FROM onboarding_tasks WHERE id = ? FOR UPDATE', [ids.tA3]);
          await c2.query('DELETE FROM onboarding_tasks WHERE id = ?', [ids.tA3]);
        },
        request: () => http('PATCH', `/api/onboarding/tasks/${ids.tA3}`, ids.mgrA, 'manager', { status: 'done' }),
      });
      expect({ status: r.status, writes: r.writes, audits: r.audits }).toEqual({ status: 404, writes: 0, audits: 0 });
    });

    test('proceso cerrado mientras se edita su tarea → 409, sin escritura ni auditoría', async () => {
      const r = await raceCase({
        label: 'PATCH tarea (cierre concurrente)', uid: ids.mgrA,
        lock: async (c2) => {
          await c2.query('SELECT id FROM onboarding_processes WHERE id = ? FOR UPDATE', [ids.pRace]);
          await c2.query("UPDATE onboarding_processes SET status = 'cancelled' WHERE id = ?", [ids.pRace]);
        },
        request: () => http('PATCH', `/api/onboarding/tasks/${ids.tRace}`, ids.mgrA, 'manager', { status: 'done' }),
      });
      expect({ status: r.status, writes: r.writes, audits: r.audits }).toEqual({ status: 409, writes: 0, audits: 0 });
      const [[t]] = await conn.query('SELECT status FROM onboarding_tasks WHERE id = ?', [ids.tRace]);
      expect(t.status).toBe('pending');
    });

    test('responsable desactivado mientras se lo asigna → 400, sin escritura ni auditoría', async () => {
      try {
        const r = await raceCase({
          label: 'PATCH asignación (responsable desactivado)', uid: ids.mgrA,
          lock: async (c2) => {
            await c2.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [ids.uA2]);
            await c2.query('UPDATE users SET active = 0 WHERE id = ?', [ids.uA2]);
          },
          request: () => http('PATCH', `/api/onboarding/tasks/${ids.tA2}`, ids.mgrA, 'manager', { assignee_id: ids.uA2 }),
        });
        expect({ status: r.status, writes: r.writes, audits: r.audits }).toEqual({ status: 400, writes: 0, audits: 0 });
        const [[t]] = await conn.query('SELECT assignee_id FROM onboarding_tasks WHERE id = ?', [ids.tA2]);
        expect(t.assignee_id).toBeNull();
      } finally {
        await conn.query('UPDATE users SET active = 1 WHERE id = ?', [ids.uA2]);
      }
    });

    test('completar mientras otro lo cancela → 409, sin auditoría de completado', async () => {
      const r = await raceCase({
        label: 'POST complete (cancelación concurrente)', uid: ids.hr,
        lock: async (c2) => {
          await c2.query('SELECT id FROM onboarding_processes WHERE id = ? FOR UPDATE', [ids.pRace2]);
          await c2.query("UPDATE onboarding_processes SET status = 'cancelled' WHERE id = ?", [ids.pRace2]);
        },
        request: () => http('POST', `/api/onboarding/${ids.pRace2}/complete`, ids.hr, 'hr'),
      });
      expect({ status: r.status, writes: r.writes, audits: r.audits }).toEqual({ status: 409, writes: 0, audits: 0 });
      const [[p]] = await conn.query('SELECT status FROM onboarding_processes WHERE id = ?', [ids.pRace2]);
      expect(p.status).toBe('cancelled');
    });
  });
});
