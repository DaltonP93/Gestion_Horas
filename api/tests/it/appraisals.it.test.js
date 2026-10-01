'use strict';

/**
 * appraisals.it.test.js — INTEGRACIÓN (MySQL real + HTTP real + authenticate
 * real): Evaluaciones de Desempeño con alcance por empleado.
 *
 * Datos SINTÉTICOS: dos empresas, sedes A y B, empleados eA1/eA2 (A) y eB (B).
 * Actores:
 *   - admin / hr                    → acceso global;
 *   - mgrA / coordA / gestorA       → gestión con alcance (sede A); mgrB (sede B);
 *   - supA                          → supervisor (fuera de la administración);
 *   - uA1 / uA2                     → employee vinculados a eA1 / eA2;
 *   - revA / revB                   → managers usados como reviewers (A / B);
 *   - revInactive / uEmpRole        → reviewer inactivo / cuenta employee.
 *
 * Cada rechazo verifica: estado esperado, cuerpo sin datos de la otra
 * empresa, CERO INSERT/UPDATE/DELETE (contadores Com_* de MySQL), filas
 * intactas y CERO auditoría del actor. Las carreras usan una segunda
 * conexión que bloquea (y opcionalmente modifica) la fila sin confirmar
 * mientras la API espera.
 */
const { describeIT, makeConn, closeAppDb } = require('./helper');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'it-appraisals-secret-0123456789abcdef';

const WRITE_COUNTERS = ['Com_insert', 'Com_insert_select', 'Com_update', 'Com_update_multi',
  'Com_delete', 'Com_delete_multi', 'Com_replace', 'Com_replace_select'];

describeIT('evaluaciones (integración) — alcance, validación y consistencia', () => {
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
  const actionCount = (userId, action, entityId) => count(
    'SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND action = ? AND entity_id = ?', [userId, action, String(entityId)],
  );
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function writeCounter() {
    const [rows] = await conn.query('SHOW GLOBAL STATUS WHERE Variable_name IN (?)', [WRITE_COUNTERS]);
    return rows.reduce((acc, r) => acc + Number(r.Value), 0);
  }
  /** Espera el N-ésimo evento exacto (la auditoría se graba tras responder). */
  async function waitAudit(userId, action, entityId, atLeast = 1) {
    for (let i = 0; i < 250; i += 1) {
      if ((await actionCount(userId, action, entityId)) >= atLeast) return;
      await sleep(20);
    }
    throw new Error(`sin evento ${action} #${atLeast}`);
  }
  const emps = () => [ids.eA1, ids.eA2, ids.eB];
  const snapshot = async () => JSON.stringify([
    (await conn.query('SELECT * FROM appraisals WHERE employee_id IN (?) ORDER BY id', [emps()]))[0],
    (await conn.query(
      'SELECT s.* FROM appraisal_scores s JOIN appraisals a ON a.id = s.appraisal_id WHERE a.employee_id IN (?) ORDER BY s.id', [emps()],
    ))[0],
  ]);

  const LEAK_RE = /ApB|EvB-|evb@/g;
  const evidence = [];
  const nameOf = (n) => Object.keys(ids).find((k) => /^ap/.test(k) && String(ids[k]) === n);
  const describeUrl = (url) => url.replace(/appraisals\/(\d+)(?=\/|\?|$)/, (_m, n) => `appraisals/${nameOf(n) || n}`);

  async function expectRejected({ method, url, uid, role, body, status, code }) {
    const beforeRows = await snapshot();
    const beforeAudit = await auditCount(uid);
    const beforeWrites = await writeCounter();
    const r = await http(method, url, uid, role, body);
    const text = await r.text();
    // Una auditoría indebida se grabaría tras responder: se consulta hasta que
    // el contador quede estable entre lecturas consecutivas.
    let audits = (await auditCount(uid)) - beforeAudit;
    for (let i = 0; i < 5; i += 1) { await sleep(30); audits = (await auditCount(uid)) - beforeAudit; }
    const writes = (await writeCounter()) - beforeWrites;
    const rowsChanged = (await snapshot()) !== beforeRows;
    evidence.push({
      request: `${method} ${describeUrl(url)} ${body === undefined ? '' : JSON.stringify(body).slice(0, 70)} (${role})`,
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

  /**
   * Carrera DETERMINISTA: c2 abre una transacción, `lock(c2)` bloquea (y puede
   * modificar) la fila; las `requests` se disparan y se espera a que queden
   * bloqueadas; recién entonces c2 confirma.
   */
  async function raceCase({ label, lock, requests }) {
    const c2 = await makeConn();
    try {
      await c2.query('START TRANSACTION');
      await lock(c2);
      const w0 = await writeCounter();
      let settled = 0;
      const ps = requests.map((fn) => fn().then(async (r) => { settled += 1; return { status: r.status, text: await r.text() }; }));
      let blocked = 0;
      for (let i = 0; i < 200 && settled === 0; i += 1) {
        const [rows] = await conn.query(
          `SELECT ID FROM information_schema.PROCESSLIST
            WHERE ID NOT IN (?) AND INFO IS NOT NULL
              AND (INFO LIKE '%FOR UPDATE%' OR INFO LIKE '%FOR SHARE%' OR INFO LIKE 'UPDATE %' OR INFO LIKE 'INSERT %' OR INFO LIKE 'DELETE %')`,
          [[conn.threadId, c2.threadId]],
        );
        blocked = rows.length;
        if (blocked >= requests.length) { await sleep(100); break; }
        await sleep(20);
      }
      await c2.query('COMMIT');
      const out = await Promise.all(ps);
      await sleep(200);
      const res = { statuses: out.map((o) => o.status), texts: out.map((o) => o.text), blocked, writes: (await writeCounter()) - w0 };
      evidence.push({ request: `RACE ${label}`, got: res.statuses, blocked, writes: res.writes });
      return res;
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
  async function insertAppraisal(employeeId, status, { reviewerId = null, templateId = ids.tpl, period = '2026-S1' } = {}) {
    return (await conn.query(
      'INSERT INTO appraisals (template_id, employee_id, reviewer_id, period_label, status) VALUES (?, ?, ?, ?, ?)',
      [templateId, employeeId, reviewerId, period, status],
    ))[0].insertId;
  }
  async function insertScores(appraisalId, role, values) {
    const crit = [ids.c1, ids.c2];
    for (let i = 0; i < values.length; i += 1) {
      await conn.query('INSERT INTO appraisal_scores (appraisal_id, criteria_id, scorer_role, score) VALUES (?, ?, ?, ?)',
        [appraisalId, crit[i], role, values[i]]);
    }
  }
  /** Puntajes completos y válidos para la plantilla principal. */
  const full = (a = 4, b = 3, extra = {}) => [
    { criteria_id: ids.c1, score: a, comment: 'ok', ...extra }, { criteria_id: ids.c2, score: b },
  ];

  beforeAll(async () => {
    conn = await makeConn();
    const uniq = `EV${Date.now() % 100000}`;
    ids.uniq = uniq;
    const ins = async (sql, params) => (await conn.query(sql, params))[0].insertId;
    ids.coA = await ins('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}A`, 'ITEv A']);
    ids.coB = await ins('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}B`, 'ITEv B']);
    ids.brA = await ins('INSERT INTO branches (code, company_id, name, active) VALUES (?, ?, ?, 1)', [`${uniq}BA`, ids.coA, 'ITEv sede A']);
    ids.brB = await ins('INSERT INTO branches (code, company_id, name, active) VALUES (?, ?, ?, 1)', [`${uniq}BB`, ids.coB, 'ITEv sede B']);
    ids.dA = await ins('INSERT INTO departments (name, code, branch_id, active) VALUES (?, ?, ?, 1)', ['ITEv DA', `${uniq}DA`, ids.brA]);
    ids.dB = await ins('INSERT INTO departments (name, code, branch_id, active) VALUES (?, ?, ?, 1)', ['ITEv DB', `${uniq}DB`, ids.brB]);
    const emp = (tag, br, d) => ins(
      'INSERT INTO employees (code, employee_number, first_name, last_name, email, branch_id, department_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [`${uniq}${tag}`, `${uniq}N${tag}`, 'Emp', tag === 'B' ? 'ApB' : `Ap${tag}`, `${uniq.toLowerCase()}ev${tag.toLowerCase()}@it.local`, br, d, 'active'],
    );
    ids.eA1 = await emp('A1', ids.brA, ids.dA);
    ids.eA2 = await emp('A2', ids.brA, ids.dA);
    ids.eB = await emp('B', ids.brB, ids.dB);

    ids.admin = await insertUser('ad', 'admin');
    ids.hr = await insertUser('hr', 'hr');
    ids.mgrA = await insertUser('mA', 'manager', { branchId: ids.brA });
    ids.coordA = await insertUser('cA', 'coordinator', { branchId: ids.brA });
    ids.gestorA = await insertUser('gA', 'gestor', { branchId: ids.brA });
    ids.mgrB = await insertUser('mB', 'manager', { branchId: ids.brB });
    ids.supA = await insertUser('sA', 'supervisor', { branchId: ids.brA });
    ids.uA1 = await insertUser('uA1', 'employee', { branchId: ids.brA, employeeId: ids.eA1 });
    ids.uA2 = await insertUser('uA2', 'employee', { branchId: ids.brA, employeeId: ids.eA2 });
    ids.revA = await insertUser('rA', 'manager', { branchId: ids.brA });
    ids.revB = await insertUser('rB', 'manager', { branchId: ids.brB });
    ids.revInactive = await insertUser('rI', 'manager', { branchId: ids.brA, active: 0 });
    ids.uEmpRole = await insertUser('uE', 'employee', { branchId: ids.brA });

    ids.tpl = await ins('INSERT INTO appraisal_templates (name, scale_min, scale_max, active) VALUES (?, 1, 5, 1)', [`${uniq} plantilla`]);
    ids.c1 = await ins('INSERT INTO appraisal_template_criteria (template_id, name, weight, sort_order) VALUES (?, ?, 1, 0)', [ids.tpl, 'Calidad']);
    ids.c2 = await ins('INSERT INTO appraisal_template_criteria (template_id, name, weight, sort_order) VALUES (?, ?, 2, 1)', [ids.tpl, 'Equipo']);
    ids.tplOff = await ins('INSERT INTO appraisal_templates (name, scale_min, scale_max, active) VALUES (?, 1, 5, 0)', [`${uniq} inactiva`]);
    ids.tpl2 = await ins('INSERT INTO appraisal_templates (name, scale_min, scale_max, active) VALUES (?, 1, 5, 1)', [`${uniq} otra`]);
    ids.c3 = await ins('INSERT INTO appraisal_template_criteria (template_id, name, weight, sort_order) VALUES (?, ?, 1, 0)', [ids.tpl2, 'Ajeno']);

    // Lectura
    ids.apA = await insertAppraisal(ids.eA1, 'self_pending', { reviewerId: ids.revA, period: 'EvA-2026' });
    ids.apA2 = await insertAppraisal(ids.eA2, 'self_pending', { period: 'EvA2-2026' });
    ids.apB = await insertAppraisal(ids.eB, 'self_pending', { reviewerId: ids.revB, period: 'EvB-2026' });
    ids.apSupRev = await insertAppraisal(ids.eA2, 'manager_pending', { reviewerId: ids.supA, period: 'EvSup-2026' });
    // Puntuación
    ids.apSelf = await insertAppraisal(ids.eA1, 'self_pending', { reviewerId: ids.revA });
    ids.apSelfBad = await insertAppraisal(ids.eA1, 'self_pending', { reviewerId: ids.revA });
    ids.apMgr = await insertAppraisal(ids.eA1, 'manager_pending', { reviewerId: ids.revA });
    await insertScores(ids.apMgr, 'self', [3, 3]);
    ids.apMgrOverride = await insertAppraisal(ids.eA2, 'manager_pending', { reviewerId: ids.revA });
    await insertScores(ids.apMgrOverride, 'self', [2, 2]);
    ids.apMgrMoved = await insertAppraisal(ids.eA2, 'manager_pending', { reviewerId: ids.revA });
    await insertScores(ids.apMgrMoved, 'self', [2, 2]);
    ids.apHr = await insertAppraisal(ids.eA2, 'hr_review', { reviewerId: ids.revA });
    await insertScores(ids.apHr, 'self', [2, 2]);
    await insertScores(ids.apHr, 'manager', [4, 4]);
    // Cierre
    ids.apDraft = await insertAppraisal(ids.eA1, 'draft');
    ids.apClosed = await insertAppraisal(ids.eA1, 'closed');
    ids.apCloseSelf = await insertAppraisal(ids.eA2, 'manager_pending', { reviewerId: ids.revA });
    await insertScores(ids.apCloseSelf, 'self', [4, 2]);
    ids.apCloseMgr = await insertAppraisal(ids.eA2, 'hr_review', { reviewerId: ids.revA });
    await insertScores(ids.apCloseMgr, 'self', [1, 1]);
    await insertScores(ids.apCloseMgr, 'manager', [5, 5]);
    // Carreras
    ids.apRaceSS = await insertAppraisal(ids.eA1, 'self_pending', { reviewerId: ids.revA });
    ids.apRaceSC = await insertAppraisal(ids.eA1, 'manager_pending', { reviewerId: ids.revA });
    await insertScores(ids.apRaceSC, 'self', [3, 3]);
    ids.apRaceCS = await insertAppraisal(ids.eA2, 'manager_pending', { reviewerId: ids.revA });
    await insertScores(ids.apRaceCS, 'self', [1, 1]);
    ids.apRaceCC = await insertAppraisal(ids.eA2, 'hr_review', { reviewerId: ids.revA });
    await insertScores(ids.apRaceCC, 'manager', [4, 4]);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/appraisals', require('../../src/routes/appraisals'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Error interno' }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (process.env.APPRAISALS_EVIDENCE_OUT) {
      require('fs').writeFileSync(process.env.APPRAISALS_EVIDENCE_OUT, JSON.stringify(evidence, null, 1));
    }
    if (server) await new Promise((r) => server.close(r));
    if (conn) {
      const userIds = ['admin', 'hr', 'mgrA', 'coordA', 'gestorA', 'mgrB', 'supA', 'uA1', 'uA2', 'revA', 'revB', 'revInactive', 'uEmpRole']
        .map((k) => ids[k]).filter(Boolean);
      await conn.query('DELETE FROM appraisals WHERE employee_id IN (?)', [emps().filter(Boolean)]);
      await conn.query('DELETE FROM appraisal_templates WHERE name LIKE ?', [`${ids.uniq}%`]);
      if (userIds.length) {
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

  // ───────────────────────────── Lectura ─────────────────────────────
  describe('lectura: listado, detalle e historial', () => {
    const listIds = async (uid, role, qs = '') => {
      const r = await http('GET', `/api/appraisals?limit=100${qs}`, uid, role);
      const body = await r.json();
      return { status: r.status, body, ids: (body.data || []).map((a) => a.id) };
    };

    test('manager A: el listado y el total sólo incluyen empleados de su alcance', async () => {
      const r = await listIds(ids.mgrA, 'manager');
      evidence.push({ request: 'GET /api/appraisals (manager A)', got: r.status, containsB: r.ids.includes(ids.apB), total: r.body.total, rows: r.ids.length });
      expect(r.status).toBe(200);
      expect(r.ids).toContain(ids.apA);
      expect(r.ids).not.toContain(ids.apB);
      expect(r.body.total).toBe(r.ids.length);
      const [[{ n }]] = await conn.query(
        'SELECT COUNT(*) AS n FROM appraisals a JOIN employees e ON e.id = a.employee_id WHERE e.department_id = ?', [ids.dA],
      );
      expect(r.body.total).toBe(Number(n));
    });

    test('total y listado usan el mismo filtro (status)', async () => {
      const r = await listIds(ids.mgrA, 'manager', '&status=self_pending');
      expect(r.status).toBe(200);
      expect(r.ids).not.toContain(ids.apB);
      expect(r.body.total).toBe(r.ids.length);
    });

    test('global ve ambas empresas', async () => {
      const r = await listIds(ids.admin, 'admin');
      expect(r.ids).toEqual(expect.arrayContaining([ids.apA, ids.apB]));
    });

    test('employee: el listado devuelve sólo sus propias evaluaciones (aunque pida otro empleado)', async () => {
      const r = await listIds(ids.uA1, 'employee');
      evidence.push({ request: 'GET /api/appraisals (employee A1)', got: r.status, ids: r.ids.length });
      expect(r.status).toBe(200);
      expect(r.ids).toContain(ids.apA);
      expect(r.ids).not.toContain(ids.apA2);
      const other = await listIds(ids.uA1, 'employee', `&employee_id=${ids.eA2}`);
      expect(other.status).toBe(200);
      expect(other.ids).toEqual([]);
      expect(other.body.total).toBe(0);
    });

    test.each([
      ['supervisor lista', () => ({ url: '/api/appraisals', uid: ids.supA, role: 'supervisor', status: 403 })],
      ['filtro status inválido', () => ({ url: '/api/appraisals?status=bogus', uid: ids.mgrA, role: 'manager', status: 400 })],
      ['filtro employee_id no canónico', () => ({ url: '/api/appraisals?employee_id=1e2', uid: ids.mgrA, role: 'manager', status: 400 })],
      ['limit fuera de rango', () => ({ url: '/api/appraisals?limit=0', uid: ids.mgrA, role: 'manager', status: 400 })],
      ['limit excesivo', () => ({ url: '/api/appraisals?limit=1000', uid: ids.mgrA, role: 'manager', status: 400 })],
      ['offset negativo', () => ({ url: '/api/appraisals?offset=-1', uid: ids.mgrA, role: 'manager', status: 400 })],
      ['filtro period demasiado largo', () => ({ url: `/api/appraisals?period=${'x'.repeat(61)}`, uid: ids.mgrA, role: 'manager', status: 400 })],
    ])('listado: %s → rechazado', async (_l, mk) => {
      await expectRejected({ method: 'GET', ...mk() });
    });

    test('detalle: ajeno e inexistente → mismo 404 sin datos; propio, de alcance y global → 200', async () => {
      const ajeno = await expectRejected({ method: 'GET', url: `/api/appraisals/${ids.apB}`, uid: ids.mgrA, role: 'manager', status: 404 });
      const nada = await expectRejected({ method: 'GET', url: '/api/appraisals/999999999', uid: ids.mgrA, role: 'manager', status: 404 });
      expect(ajeno).toBe(nada);
      expect((await http('GET', `/api/appraisals/${ids.apA}`, ids.coordA, 'coordinator')).status).toBe(200);
      expect((await http('GET', `/api/appraisals/${ids.apA}`, ids.uA1, 'employee')).status).toBe(200);
      expect((await http('GET', `/api/appraisals/${ids.apB}`, ids.hr, 'hr')).status).toBe(200);
    });

    test.each([
      ['employee abre una evaluación ajena', () => ({ url: `/api/appraisals/${ids.apA2}`, uid: ids.uA1, role: 'employee', status: 404 })],
      ['supervisor no reviewer', () => ({ url: `/api/appraisals/${ids.apA}`, uid: ids.supA, role: 'supervisor', status: 404 })],
      ['manager B abre una de A', () => ({ url: `/api/appraisals/${ids.apA}`, uid: ids.mgrB, role: 'manager', status: 404 })],
      ['id no canónico', () => ({ url: '/api/appraisals/1e2', uid: ids.admin, role: 'admin', status: 400 })],
      ['id negativo', () => ({ url: '/api/appraisals/-1', uid: ids.admin, role: 'admin', status: 400 })],
      ['id cero', () => ({ url: '/api/appraisals/0', uid: ids.admin, role: 'admin', status: 400 })],
    ])('detalle: %s → rechazado', async (_l, mk) => {
      await expectRejected({ method: 'GET', ...mk() });
    });

    test('detalle: el reviewer asignado (aun supervisor) lo ve mientras el empleado esté en su alcance', async () => {
      expect((await http('GET', `/api/appraisals/${ids.apSupRev}`, ids.supA, 'supervisor')).status).toBe(200);
    });

    test('historial: fuera de alcance e inexistente → mismo 404; propio y de alcance → 200', async () => {
      const fuera = await expectRejected({ method: 'GET', url: `/api/appraisals/employee/${ids.eB}`, uid: ids.mgrA, role: 'manager', status: 404 });
      const nada = await expectRejected({ method: 'GET', url: '/api/appraisals/employee/999999999', uid: ids.mgrA, role: 'manager', status: 404 });
      expect(fuera).toBe(nada);
      await expectRejected({ method: 'GET', url: `/api/appraisals/employee/${ids.eA2}`, uid: ids.uA1, role: 'employee', status: 404 });
      await expectRejected({ method: 'GET', url: '/api/appraisals/employee/1e2', uid: ids.admin, role: 'admin', status: 400 });
      await expectRejected({ method: 'GET', url: `/api/appraisals/employee/${ids.eA1}`, uid: ids.supA, role: 'supervisor', status: 403 });
      const own = await http('GET', `/api/appraisals/employee/${ids.eA1}`, ids.uA1, 'employee');
      expect(own.status).toBe(200);
      expect((await own.json()).data.map((a) => a.id)).toContain(ids.apA);
      expect((await http('GET', `/api/appraisals/employee/${ids.eA1}`, ids.gestorA, 'gestor')).status).toBe(200);
      expect((await http('GET', `/api/appraisals/employee/${ids.eB}`, ids.admin, 'admin')).status).toBe(200);
    });
  });

  // ───────────────────────────── Alta ─────────────────────────────
  describe('alta de evaluaciones', () => {
    const OK = (over = {}) => ({ template_id: ids.tpl, employee_id: ids.eA1, reviewer_id: ids.revA, period_label: '2026-S2', due_date: '2026-12-15', ...over });

    test('positivos: manager A en su alcance y global en otra sede; auditados tras commit', async () => {
      const r = await http('POST', '/api/appraisals', ids.mgrA, 'manager', OK());
      expect(r.status).toBe(201);
      const { id } = await r.json();
      await waitAudit(ids.mgrA, 'appraisal_create', id);
      const [[row]] = await conn.query("SELECT template_id, employee_id, reviewer_id, period_label, DATE_FORMAT(due_date, '%Y-%m-%d') AS due, status, created_by FROM appraisals WHERE id = ?", [id]);
      expect(row).toEqual({ template_id: ids.tpl, employee_id: ids.eA1, reviewer_id: ids.revA, period_label: '2026-S2', due: '2026-12-15', status: 'self_pending', created_by: ids.mgrA });
      const g = await http('POST', '/api/appraisals', ids.admin, 'admin', OK({ employee_id: ids.eB, reviewer_id: ids.revB, due_date: undefined }));
      expect(g.status).toBe(201);
      const s = await http('POST', '/api/appraisals', ids.hr, 'hr', OK({ employee_id: ids.eA2, reviewer_id: null }));
      expect(s.status).toBe(201);
      await waitAudit(ids.hr, 'appraisal_create', (await s.json()).id);
    });

    test.each([
      ['manager A para empleado de B', () => ({ uid: ids.mgrA, role: 'manager', status: 404, body: OK({ employee_id: ids.eB, reviewer_id: null }) })],
      ['empleado inexistente', () => ({ uid: ids.hr, role: 'hr', status: 404, body: OK({ employee_id: 999999999, reviewer_id: null }) })],
      ['plantilla inexistente', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ template_id: 999999999 }) })],
      ['plantilla inactiva', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ template_id: ids.tplOff }) })],
      ['reviewer inexistente', () => ({ uid: ids.hr, role: 'hr', status: 400, code: 'INVALID_REVIEWER', body: OK({ reviewer_id: 999999999 }) })],
      ['reviewer inactivo', () => ({ uid: ids.mgrA, role: 'manager', status: 400, code: 'INVALID_REVIEWER', body: OK({ reviewer_id: ids.revInactive }) })],
      ['reviewer de otra sede (manager A)', () => ({ uid: ids.mgrA, role: 'manager', status: 400, code: 'INVALID_REVIEWER', body: OK({ reviewer_id: ids.revB }) })],
      ['reviewer que no ve al empleado (global)', () => ({ uid: ids.admin, role: 'admin', status: 400, code: 'INVALID_REVIEWER', body: OK({ reviewer_id: ids.revB }) })],
      ['reviewer con rol employee', () => ({ uid: ids.mgrA, role: 'manager', status: 400, code: 'INVALID_REVIEWER', body: OK({ reviewer_id: ids.uEmpRole }) })],
      ['template_id exponencial', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ template_id: '1e2' }) })],
      ['template_id negativo', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ template_id: -1 }) })],
      ['employee_id cero', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ employee_id: 0 }) })],
      ['employee_id texto', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ employee_id: 'abc' }) })],
      ['reviewer_id hexadecimal', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ reviewer_id: '0x10' }) })],
      ['period_label ausente', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ period_label: undefined }) })],
      ['period_label vacío', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ period_label: '   ' }) })],
      ['period_label demasiado largo', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ period_label: 'x'.repeat(61) }) })],
      ['period_label no texto', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ period_label: 2026 }) })],
      ['due_date inexistente', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ due_date: '2026-02-30' }) })],
      ['due_date en otro formato', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ due_date: '30/12/2026' }) })],
      ['due_date fuera de rango', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ due_date: '1999-12-31' }) })],
      ['campo no permitido', () => ({ uid: ids.hr, role: 'hr', status: 400, body: OK({ status: 'closed' }) })],
      ['supervisor', () => ({ uid: ids.supA, role: 'supervisor', status: 403, body: OK() })],
      ['employee', () => ({ uid: ids.uA1, role: 'employee', status: 403, body: OK() })],
    ])('alta rechazada (%s) sin INSERT ni auditoría', async (_l, mk) => {
      await expectRejected({ method: 'POST', url: '/api/appraisals', ...mk() });
    });
  });

  // ─────────────────────────── Puntuación ───────────────────────────
  describe('puntuación', () => {
    const score = (ap) => `/api/appraisals/${ids[ap]}/score`;

    test('self: el propio empleado en self_pending → 200, avanza a manager_pending, auditado', async () => {
      const r = await http('POST', score('apSelf'), ids.uA1, 'employee', { scorer_role: 'self', scores: full(4, 3) });
      expect(r.status).toBe(200);
      await waitAudit(ids.uA1, 'appraisal_score', ids.apSelf);
      const [[a]] = await conn.query('SELECT status FROM appraisals WHERE id = ?', [ids.apSelf]);
      expect(a.status).toBe('manager_pending');
      expect(await count("SELECT COUNT(*) AS n FROM appraisal_scores WHERE appraisal_id = ? AND scorer_role = 'self'", [ids.apSelf])).toBe(2);
    });

    test('manager: el reviewer asignado en manager_pending → 200 → hr_review; global como override → 200', async () => {
      const r = await http('POST', score('apMgr'), ids.revA, 'manager', { scorer_role: 'manager', scores: full(5, 4) });
      expect(r.status).toBe(200);
      await waitAudit(ids.revA, 'appraisal_score', ids.apMgr);
      expect((await conn.query('SELECT status FROM appraisals WHERE id = ?', [ids.apMgr]))[0][0].status).toBe('hr_review');
      const o = await http('POST', score('apMgrOverride'), ids.admin, 'admin', { scorer_role: 'manager', scores: full(3, 3) });
      expect(o.status).toBe(200);
      await waitAudit(ids.admin, 'appraisal_score', ids.apMgrOverride);
    });

    test('hr: rol global en hr_review → 200; un segundo envío → 409 sin pisar', async () => {
      const r = await http('POST', score('apHr'), ids.hr, 'hr', { scorer_role: 'hr', scores: full(3, 4) });
      expect(r.status).toBe(200);
      await waitAudit(ids.hr, 'appraisal_score', ids.apHr);
      await expectRejected({ method: 'POST', url: score('apHr'), uid: ids.hr, role: 'hr', status: 409, body: { scorer_role: 'hr', scores: full(1, 1) } });
    });

    test.each([
      ['autoevaluación enviada por otro empleado', () => ({ ap: 'apSelfBad', uid: ids.uA2, role: 'employee', status: 404, body: { scorer_role: 'self', scores: full() } })],
      ['autoevaluación suplantada por un administrador', () => ({ ap: 'apSelfBad', uid: ids.admin, role: 'admin', status: 403, body: { scorer_role: 'self', scores: full() } })],
      ['autoevaluación enviada por un manager del alcance', () => ({ ap: 'apSelfBad', uid: ids.mgrA, role: 'manager', status: 403, body: { scorer_role: 'self', scores: full() } })],
      ['manager no asignado puntúa como manager', () => ({ ap: 'apMgrMoved', uid: ids.mgrA, role: 'manager', status: 403, body: { scorer_role: 'manager', scores: full() } })],
      ['manager de otra sede', () => ({ ap: 'apMgrMoved', uid: ids.mgrB, role: 'manager', status: 404, body: { scorer_role: 'manager', scores: full() } })],
      ['hr enviado por un manager', () => ({ ap: 'apHr', uid: ids.mgrA, role: 'manager', status: 403, body: { scorer_role: 'hr', scores: full() } })],
      ['criterio de otra plantilla', () => ({ ap: 'apSelfBad', uid: ids.uA1, role: 'employee', status: 400, body: { scorer_role: 'self', scores: [{ criteria_id: ids.c1, score: 3 }, { criteria_id: ids.c3, score: 3 }] } })],
      ['criterio duplicado', () => ({ ap: 'apSelfBad', uid: ids.uA1, role: 'employee', status: 400, body: { scorer_role: 'self', scores: [{ criteria_id: ids.c1, score: 3 }, { criteria_id: ids.c1, score: 4 }, { criteria_id: ids.c2, score: 3 }] } })],
      ['criterio faltante', () => ({ ap: 'apSelfBad', uid: ids.uA1, role: 'employee', status: 400, body: { scorer_role: 'self', scores: [{ criteria_id: ids.c1, score: 3 }] } })],
      ['puntaje sobre la escala', () => ({ ap: 'apSelfBad', uid: ids.uA1, role: 'employee', status: 400, body: { scorer_role: 'self', scores: full(6, 3) } })],
      ['puntaje bajo la escala', () => ({ ap: 'apSelfBad', uid: ids.uA1, role: 'employee', status: 400, body: { scorer_role: 'self', scores: full(0, 3) } })],
      ['puntaje fraccionario', () => ({ ap: 'apSelfBad', uid: ids.uA1, role: 'employee', status: 400, body: { scorer_role: 'self', scores: full(2.5, 3) } })],
      ['puntaje textual', () => ({ ap: 'apSelfBad', uid: ids.uA1, role: 'employee', status: 400, body: { scorer_role: 'self', scores: full('3', 3) } })],
      ['comentario demasiado largo', () => ({ ap: 'apSelfBad', uid: ids.uA1, role: 'employee', status: 400, body: { scorer_role: 'self', scores: full(3, 3, { comment: 'x'.repeat(2001) }) } })],
      ['campo desconocido en un puntaje', () => ({ ap: 'apSelfBad', uid: ids.uA1, role: 'employee', status: 400, body: { scorer_role: 'self', scores: full(3, 3, { weight: 9 }) } })],
      ['campo desconocido en el cuerpo', () => ({ ap: 'apSelfBad', uid: ids.uA1, role: 'employee', status: 400, body: { scorer_role: 'self', scores: full(), status: 'closed' } })],
      ['scorer_role inválido', () => ({ ap: 'apSelfBad', uid: ids.uA1, role: 'employee', status: 400, body: { scorer_role: 'boss', scores: full() } })],
      ['scores vacío', () => ({ ap: 'apSelfBad', uid: ids.uA1, role: 'employee', status: 400, body: { scorer_role: 'self', scores: [] } })],
      ['self fuera de estado (manager_pending)', () => ({ ap: 'apMgrMoved', uid: ids.uA2, role: 'employee', status: 409, body: { scorer_role: 'self', scores: full() } })],
      ['manager fuera de estado (self_pending)', () => ({ ap: 'apSelfBad', uid: ids.revA, role: 'manager', status: 409, body: { scorer_role: 'manager', scores: full() } })],
      ['hr fuera de estado (manager_pending)', () => ({ ap: 'apMgrMoved', uid: ids.hr, role: 'hr', status: 409, body: { scorer_role: 'hr', scores: full() } })],
      ['evaluación cerrada', () => ({ ap: 'apClosed', uid: ids.hr, role: 'hr', status: 409, body: { scorer_role: 'hr', scores: full() } })],
    ])('%s → rechazado sin escritura ni auditoría', async (_l, mk) => {
      const { ap, ...rest } = mk();
      await expectRejected({ method: 'POST', url: score(ap), ...rest });
    });

    test('id de evaluación no canónico → 400', async () => {
      await expectRejected({ method: 'POST', url: '/api/appraisals/1e2/score', uid: ids.hr, role: 'hr', status: 400, body: { scorer_role: 'hr', scores: full() } });
    });

    test('reviewer cuyo alcance ya no incluye al empleado → 404 sin escritura', async () => {
      try {
        await conn.query('UPDATE users SET branch_id = ? WHERE id = ?', [ids.brB, ids.revA]);
        await expectRejected({ method: 'POST', url: score('apMgrMoved'), uid: ids.revA, role: 'manager', status: 404, body: { scorer_role: 'manager', scores: full() } });
        await expectRejected({ method: 'GET', url: `/api/appraisals/${ids.apMgrMoved}`, uid: ids.revA, role: 'manager', status: 404 });
      } finally {
        await conn.query('UPDATE users SET branch_id = ? WHERE id = ?', [ids.brA, ids.revA]);
      }
    });
  });

  // ───────────────────────────── Cierre ─────────────────────────────
  describe('cierre', () => {
    const close = (ap) => `/api/appraisals/${ids[ap]}/close`;
    test.each([
      ['desde self_pending', () => ({ url: close('apSelfBad'), uid: ids.hr, role: 'hr', status: 409 })],
      ['desde draft', () => ({ url: close('apDraft'), uid: ids.hr, role: 'hr', status: 409 })],
      ['ya cerrada', () => ({ url: close('apClosed'), uid: ids.hr, role: 'hr', status: 409 })],
      ['manager (no global)', () => ({ url: close('apCloseSelf'), uid: ids.mgrA, role: 'manager', status: 403 })],
      ['inexistente', () => ({ url: '/api/appraisals/999999999/close', uid: ids.hr, role: 'hr', status: 404 })],
      ['id no canónico', () => ({ url: '/api/appraisals/1e2/close', uid: ids.hr, role: 'hr', status: 400 })],
      ['comentario demasiado largo', () => ({ url: close('apCloseSelf'), uid: ids.hr, role: 'hr', status: 400, body: { hr_comment: 'x'.repeat(2001) } })],
      ['campo desconocido', () => ({ url: close('apCloseSelf'), uid: ids.hr, role: 'hr', status: 400, body: { final_score: 5 } })],
    ])('cierre rechazado (%s) sin escritura ni auditoría', async (_l, mk) => {
      await expectRejected({ method: 'POST', body: {}, ...mk() });
    });

    test('desde manager_pending usa la autoevaluación; desde hr_review usa la del manager', async () => {
      const a = await http('POST', close('apCloseSelf'), ids.hr, 'hr', { hr_comment: 'ok' });
      expect(a.status).toBe(200);
      expect((await a.json()).final_score).toBeCloseTo(2.67, 2);       // (4·1 + 2·2) / 3
      await waitAudit(ids.hr, 'appraisal_close', ids.apCloseSelf);
      const b = await http('POST', close('apCloseMgr'), ids.admin, 'admin', {});
      expect(b.status).toBe(200);
      expect((await b.json()).final_score).toBe(5);
      const [[row]] = await conn.query('SELECT status, final_score, closed_at IS NOT NULL AS closed FROM appraisals WHERE id = ?', [ids.apCloseMgr]);
      expect({ status: row.status, score: Number(row.final_score), closed: Number(row.closed) }).toEqual({ status: 'closed', score: 5, closed: 1 });
    });
  });

  // ───────────────────────────── Carreras ─────────────────────────────
  describe('carreras deterministas (MySQL real)', () => {
    const lockOnly = (key) => async (c2) => { await c2.query('SELECT id FROM appraisals WHERE id = ? FOR UPDATE', [ids[key]]); };

    test('score/score: dos autoevaluaciones simultáneas → una 200 y otra 409; puntajes y auditoría una sola vez', async () => {
      const req = () => http('POST', `/api/appraisals/${ids.apRaceSS}/score`, ids.uA1, 'employee', { scorer_role: 'self', scores: full(4, 4) });
      const r = await raceCase({ label: 'score/score (self ×2)', lock: lockOnly('apRaceSS'), requests: [req, req] });
      expect([...r.statuses].sort()).toEqual([200, 409]);
      await waitAudit(ids.uA1, 'appraisal_score', ids.apRaceSS);
      await sleep(150);
      expect(await actionCount(ids.uA1, 'appraisal_score', ids.apRaceSS)).toBe(1);
      expect(await count('SELECT COUNT(*) AS n FROM appraisal_scores WHERE appraisal_id = ?', [ids.apRaceSS])).toBe(2);
      expect((await conn.query('SELECT status FROM appraisals WHERE id = ?', [ids.apRaceSS]))[0][0].status).toBe('manager_pending');
    });

    test('score/close: la evaluación se cierra mientras el reviewer puntúa → 409, sin escritura ni auditoría', async () => {
      const a0 = await auditCount(ids.revA);
      const r = await raceCase({
        label: 'score/close (cierre concurrente)',
        lock: async (c2) => {
          await c2.query('SELECT id FROM appraisals WHERE id = ? FOR UPDATE', [ids.apRaceSC]);
          await c2.query("UPDATE appraisals SET status = 'closed', closed_at = NOW() WHERE id = ?", [ids.apRaceSC]);
        },
        requests: [() => http('POST', `/api/appraisals/${ids.apRaceSC}/score`, ids.revA, 'manager', { scorer_role: 'manager', scores: full(5, 5) })],
      });
      await sleep(150);
      expect({ statuses: r.statuses, writes: r.writes, audits: (await auditCount(ids.revA)) - a0 }).toEqual({ statuses: [409], writes: 0, audits: 0 });
      expect(await count("SELECT COUNT(*) AS n FROM appraisal_scores WHERE appraisal_id = ? AND scorer_role = 'manager'", [ids.apRaceSC])).toBe(0);
    });

    test('close/score: el manager puntúa mientras RR.HH. cierra → el cierre usa el estado y puntajes vigentes', async () => {
      const r = await raceCase({
        label: 'close/score (puntaje concurrente)',
        lock: async (c2) => {
          await c2.query('SELECT id FROM appraisals WHERE id = ? FOR UPDATE', [ids.apRaceCS]);
          await c2.query("INSERT INTO appraisal_scores (appraisal_id, criteria_id, scorer_role, score) VALUES (?, ?, 'manager', 5), (?, ?, 'manager', 5)",
            [ids.apRaceCS, ids.c1, ids.apRaceCS, ids.c2]);
          await c2.query("UPDATE appraisals SET status = 'hr_review' WHERE id = ?", [ids.apRaceCS]);
        },
        requests: [() => http('POST', `/api/appraisals/${ids.apRaceCS}/close`, ids.hr, 'hr', {})],
      });
      expect(r.statuses).toEqual([200]);
      expect(JSON.parse(r.texts[0]).final_score).toBe(5);          // manager (5,5), no la autoevaluación (1,1)
    });

    test('close/close: dos cierres simultáneos → uno 200 y otro 409; auditoría una sola vez', async () => {
      const r = await raceCase({
        label: 'close/close',
        lock: lockOnly('apRaceCC'),
        requests: [
          () => http('POST', `/api/appraisals/${ids.apRaceCC}/close`, ids.hr, 'hr', { hr_comment: 'uno' }),
          () => http('POST', `/api/appraisals/${ids.apRaceCC}/close`, ids.admin, 'admin', { hr_comment: 'dos' }),
        ],
      });
      expect([...r.statuses].sort()).toEqual([200, 409]);
      await sleep(200);
      const closes = (await actionCount(ids.hr, 'appraisal_close', ids.apRaceCC)) + (await actionCount(ids.admin, 'appraisal_close', ids.apRaceCC));
      expect(closes).toBe(1);
      const winner = r.statuses[0] === 200 ? 'uno' : 'dos';
      const [[row]] = await conn.query('SELECT status, hr_comment FROM appraisals WHERE id = ?', [ids.apRaceCC]);
      expect(row).toEqual({ status: 'closed', hr_comment: winner });
    });
  });
});
