'use strict';

/**
 * appraisalTemplates.it.test.js — INTEGRACIÓN (MySQL real + HTTP real +
 * authenticate real): CRUD de plantillas de Evaluaciones de Desempeño.
 *
 * Datos SINTÉTICOS: una empresa, sede A, empleados eA (employee uEmp) y eA2
 * (vinculado al supervisor supA).
 * Actores:
 *   - superAdmin / admin / gth / hr  → globales: leen y administran plantillas;
 *   - mgrA / coordA / gestorA        → gestión con alcance: sólo lectura;
 *   - supA / uEmp                    → sin acceso a plantillas (403);
 *   - revA                           → manager reviewer de la evaluación abierta.
 *
 * Cada rechazo verifica: estado, CERO INSERT/UPDATE/DELETE (contadores Com_*
 * del servidor), filas intactas y CERO auditoría del actor. Las carreras usan
 * una segunda conexión que retiene un bloqueo mientras la API espera.
 */
const { describeIT, makeConn, closeAppDb } = require('./helper');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'it-appraisal-templates-secret-0123456789abcdef';

const WRITE_COUNTERS = ['Com_insert', 'Com_insert_select', 'Com_update', 'Com_update_multi',
  'Com_delete', 'Com_delete_multi', 'Com_replace', 'Com_replace_select'];
const MISSING = 2147480000;
jest.setTimeout(30000);
const T = '/api/appraisals/templates';

describeIT('plantillas de evaluaciones (integración) — roles, validación, consistencia y carreras', () => {
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const count = async (sql, params) => Number((await conn.query(sql, params))[0][0].n);
  const auditCount = (userId) => count('SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ?', [userId]);
  const actionCount = (userId, action, entityId) => count(
    'SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND action = ? AND entity_id = ?', [userId, action, String(entityId)],
  );
  const auditRows = async (userId, action, entityId) => (await conn.query(
    'SELECT details FROM audit_events WHERE user_id = ? AND action = ? AND entity_id = ? ORDER BY id', [userId, action, String(entityId)],
  ))[0];
  async function writeCounter() {
    const [rows] = await conn.query('SHOW GLOBAL STATUS WHERE Variable_name IN (?)', [WRITE_COUNTERS]);
    return rows.reduce((acc, r) => acc + Number(r.Value), 0);
  }
  async function waitAudit(userId, action, entityId, atLeast = 1) {
    for (let i = 0; i < 250; i += 1) {
      if ((await actionCount(userId, action, entityId)) >= atLeast) return;
      await sleep(20);
    }
    throw new Error(`sin evento ${action} #${atLeast}`);
  }
  /** Audits indebidas se grabarían tras responder: se relee hasta estabilizar. */
  async function settledAudits(userId, before) {
    let n = (await auditCount(userId)) - before;
    for (let i = 0; i < 5; i += 1) { await sleep(30); n = (await auditCount(userId)) - before; }
    return n;
  }
  const tplRow = async (id) => (await conn.query('SELECT * FROM appraisal_templates WHERE id = ?', [id]))[0][0];
  const critRows = async (id) => (await conn.query(
    'SELECT name, description, weight, sort_order FROM appraisal_template_criteria WHERE template_id = ? ORDER BY sort_order, id', [id],
  ))[0];
  const snapshot = async () => JSON.stringify([
    (await conn.query('SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM appraisal_templates'))[0],
    (await conn.query('SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM appraisal_template_criteria'))[0],
    (await conn.query('SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM appraisals'))[0],
    (await conn.query('SELECT * FROM appraisal_templates WHERE name LIKE ? ORDER BY id', [`${ids.uniq}%`]))[0],
  ]);

  const evidence = [];
  const nameOf = (n) => Object.keys(ids).find((k) => /^tpl/.test(k) && String(ids[k]) === n);
  const describeUrl = (url) => url.replace(/templates\/(\d+)(?=\/|\?|$)/, (_m, n) => `templates/${nameOf(n) || n}`);

  async function expectRejected({ method, url, uid, role, body, status, code }) {
    const beforeRows = await snapshot();
    const beforeAudit = await auditCount(uid);
    const beforeWrites = await writeCounter();
    const r = await http(method, url, uid, role, body);
    const text = await r.text();
    const audits = await settledAudits(uid, beforeAudit);
    const writes = (await writeCounter()) - beforeWrites;
    const rowsChanged = (await snapshot()) !== beforeRows;
    evidence.push({
      request: `${method} ${describeUrl(url)} ${body === undefined ? '' : JSON.stringify(body).slice(0, 70)} (${role})`,
      expected: status, got: r.status, writes, rowsChanged, audits,
    });
    expect({ url, status: r.status }).toEqual({ url, status });
    expect(writes).toBe(0);
    expect(rowsChanged).toBe(false);
    expect(audits).toBe(0);
    if (code) expect(JSON.parse(text).code).toBe(code);
    return text;
  }

  /** Espera a que una sentencia de la API (no de `exclude`) quede en curso, bloqueada. */
  async function waitBlocked(like, exclude) {
    for (let i = 0; i < 250; i += 1) {
      const [rows] = await conn.query(
        'SELECT ID FROM information_schema.PROCESSLIST WHERE ID NOT IN (?) AND INFO LIKE ?', [exclude, like],
      );
      if (rows.length) { await sleep(80); return true; }
      await sleep(20);
    }
    return false;
  }
  const track = (p) => {
    const box = { settled: false };
    box.promise = p.then(async (r) => { box.settled = true; return { status: r.status, body: await r.json().catch(() => null) }; });
    return box;
  };

  async function insertUser(tag, role, { branchId = null, employeeId = null } = {}) {
    const [r] = await conn.query(
      'INSERT INTO users (username, email, password_hash, full_name, role, employee_id, branch_id, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      [`${ids.uniq}${tag}`, `${ids.uniq.toLowerCase()}${tag.toLowerCase()}@it.local`, 'it-no-login', `${tag}-full`, role, employeeId, branchId],
    );
    return r.insertId;
  }
  async function insertTemplate(tag, active, criteria) {
    const [r] = await conn.query(
      'INSERT INTO appraisal_templates (name, description, scale_min, scale_max, active) VALUES (?, ?, 1, 5, ?)',
      [`${ids.uniq} ${tag}`, `descripción ${tag}`, active],
    );
    const out = { id: r.insertId, crit: [] };
    for (let i = 0; i < criteria.length; i += 1) {
      const [c] = await conn.query(
        'INSERT INTO appraisal_template_criteria (template_id, name, weight, sort_order) VALUES (?, ?, ?, ?)',
        [r.insertId, criteria[i][0], criteria[i][1], i],
      );
      out.crit.push(c.insertId);
    }
    return out;
  }
  const validBody = (tag, extra = {}) => ({
    name: `${ids.uniq} ${tag}`, description: 'Texto descriptivo PRIVADO', scale_min: 1, scale_max: 5,
    criteria: [{ name: 'Calidad', description: 'Detalle PRIVADO del criterio', weight: 2.5 }, { name: 'Equipo' }],
    ...extra,
  });

  const GLOBAL = [['superAdmin', 'super_admin'], ['admin', 'admin'], ['gth', 'gth'], ['hr', 'hr']];
  const SCOPED = [['mgrA', 'manager'], ['coordA', 'coordinator'], ['gestorA', 'gestor']];
  const NO_ACCESS = [['supA', 'supervisor'], ['uEmp', 'employee']];

  beforeAll(async () => {
    conn = await makeConn();
    const uniq = `TP${Date.now() % 100000}`;
    ids.uniq = uniq;
    const ins = async (sql, params) => (await conn.query(sql, params))[0].insertId;
    ids.co = await ins('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}C`, 'ITTpl']);
    ids.br = await ins('INSERT INTO branches (code, company_id, name, active) VALUES (?, ?, ?, 1)', [`${uniq}BA`, ids.co, 'ITTpl sede A']);
    ids.d = await ins('INSERT INTO departments (name, code, branch_id, active) VALUES (?, ?, ?, 1)', ['ITTpl DA', `${uniq}DA`, ids.br]);
    const emp = (tag) => ins(
      'INSERT INTO employees (code, employee_number, first_name, last_name, email, branch_id, department_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [`${uniq}${tag}`, `${uniq}N${tag}`, 'Emp', `Tp${tag}`, `${uniq.toLowerCase()}tp${tag.toLowerCase()}@it.local`, ids.br, ids.d, 'active'],
    );
    ids.eA = await emp('A');
    ids.eA2 = await emp('A2');

    ids.superAdmin = await insertUser('su', 'super_admin');
    ids.admin = await insertUser('ad', 'admin');
    ids.gth = await insertUser('gt', 'gth');
    ids.hr = await insertUser('hr', 'hr');
    ids.mgrA = await insertUser('mA', 'manager', { branchId: ids.br });
    ids.coordA = await insertUser('cA', 'coordinator', { branchId: ids.br });
    ids.gestorA = await insertUser('gA', 'gestor', { branchId: ids.br });
    ids.supA = await insertUser('sA', 'supervisor', { branchId: ids.br, employeeId: ids.eA2 });
    ids.uEmp = await insertUser('uE', 'employee', { branchId: ids.br, employeeId: ids.eA });
    ids.revA = await insertUser('rA', 'manager', { branchId: ids.br });

    ids.tplRead = (await insertTemplate('lectura', 1, [['Calidad', 1], ['Equipo', 2]])).id;
    ids.tplOff = (await insertTemplate('inactiva', 0, [['Calidad', 1]])).id;
    ids.tplEdit = (await insertTemplate('edición', 1, [['Calidad', 1]])).id;
    ids.tplDel = (await insertTemplate('baja', 1, [['Calidad', 1]])).id;
    ids.tplReuse = (await insertTemplate('reuso', 1, [['Calidad', 1]])).id;
    const open = await insertTemplate('abierta', 1, [['Calidad', 1], ['Equipo', 2]]);
    ids.tplOpen = open.id; [ids.cOpen1, ids.cOpen2] = open.crit;
    ids.tplRaceA = (await insertTemplate('carrera A', 1, [['Calidad', 1]])).id;
    const rb = await insertTemplate('carrera B', 1, [['Calidad', 1]]);
    ids.tplRaceB = rb.id; [ids.cRaceB] = rb.crit;

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
    if (process.env.APPRAISAL_TEMPLATES_EVIDENCE_OUT) {
      require('fs').writeFileSync(process.env.APPRAISAL_TEMPLATES_EVIDENCE_OUT, JSON.stringify(evidence, null, 1));
    }
    if (server) await new Promise((r) => server.close(r));
    if (conn) {
      const userIds = ['superAdmin', 'admin', 'gth', 'hr', 'mgrA', 'coordA', 'gestorA', 'supA', 'uEmp', 'revA']
        .map((k) => ids[k]).filter(Boolean);
      await conn.query('DELETE FROM appraisals WHERE employee_id IN (?)', [[ids.eA, ids.eA2].filter(Boolean)]);
      await conn.query('DELETE FROM appraisal_templates WHERE name LIKE ?', [`${ids.uniq}%`]);
      if (userIds.length) {
        await conn.query('DELETE FROM audit_events WHERE user_id IN (?)', [userIds]);
        await conn.query('DELETE FROM users WHERE id IN (?)', [userIds]);
      }
      await conn.query('DELETE FROM employees WHERE id IN (?)', [[ids.eA, ids.eA2].filter(Boolean)]);
      await conn.query('DELETE FROM departments WHERE id = ?', [ids.d]);
      await conn.query('DELETE FROM branches WHERE id = ?', [ids.br]);
      await conn.query('DELETE FROM companies WHERE id = ?', [ids.co]);
      await conn.end();
    }
    await closeAppDb();
  });

  // ─────────────────────────── Matriz de roles ───────────────────────────
  describe('matriz de roles', () => {
    test.each([...GLOBAL, ...SCOPED])('%s (%s): listado y detalle → 200', async (who, role) => {
      const l = await http('GET', `${T}?all=1`, ids[who], role);
      const body = await l.json();
      expect(l.status).toBe(200);
      const listed = body.data.map((t) => t.id);
      expect(listed).toEqual(expect.arrayContaining([ids.tplRead, ids.tplOff]));
      const d = await http('GET', `${T}/${ids.tplRead}`, ids[who], role);
      expect(d.status).toBe(200);
      expect((await d.json()).data.criteria.map((c) => c.name)).toEqual(['Calidad', 'Equipo']);
    });

    test.each(NO_ACCESS)('%s (%s): listado → 403 sin escritura ni auditoría', async (who, role) => {
      await expectRejected({ method: 'GET', url: T, uid: ids[who], role, status: 403 });
    });
    test.each(NO_ACCESS)('%s (%s): detalle existente e inexistente → mismo 403', async (who, role) => {
      const a = await expectRejected({ method: 'GET', url: `${T}/${ids.tplRead}`, uid: ids[who], role, status: 403 });
      const b = await expectRejected({ method: 'GET', url: `${T}/${MISSING}`, uid: ids[who], role, status: 403 });
      expect(a).toBe(b);
    });
    test.each([...SCOPED, ...NO_ACCESS])('%s (%s): crear, editar y desactivar → 403 sin escritura ni auditoría', async (who, role) => {
      await expectRejected({ method: 'POST', url: T, uid: ids[who], role, body: validBody(`no-${role}`), status: 403 });
      await expectRejected({ method: 'PUT', url: `${T}/${ids.tplEdit}`, uid: ids[who], role, body: { name: `${ids.uniq} hack` }, status: 403 });
      await expectRejected({ method: 'DELETE', url: `${T}/${ids.tplEdit}`, uid: ids[who], role, status: 403 });
      expect(Number((await tplRow(ids.tplEdit)).active)).toBe(1);
    });
    test('listado sin parámetros: sólo activas; all=1: también inactivas; con conteo de criterios', async () => {
      const act = await (await http('GET', T, ids.mgrA, 'manager')).json();
      expect(act.data.map((t) => t.id)).toContain(ids.tplRead);
      expect(act.data.map((t) => t.id)).not.toContain(ids.tplOff);
      const row = act.data.find((t) => t.id === ids.tplRead);
      expect(Number(row.criteria_count)).toBe(2);
      const all = await (await http('GET', `${T}?all=1`, ids.mgrA, 'manager')).json();
      expect(all.data.map((t) => t.id)).toContain(ids.tplOff);
    });
    test('detalle inexistente para un rol con lectura → 404 sin datos', async () => {
      const r = await http('GET', `${T}/${MISSING}`, ids.mgrA, 'manager');
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'Plantilla no encontrada' });
    });
  });

  // ─────────────────────── IDs y parámetros ───────────────────────
  describe('IDs no canónicos y parámetros del listado → 400 INVALID_INPUT', () => {
    const BAD_IDS = ['1e2', '0x10', '-1', '1.5', '0', '007', '%207', '7%20', 'abc'];
    test.each(BAD_IDS)('id %s en detalle, edición y desactivación', async (bad) => {
      await expectRejected({ method: 'GET', url: `${T}/${bad}`, uid: ids.admin, role: 'admin', status: 400, code: 'INVALID_INPUT' });
      await expectRejected({ method: 'PUT', url: `${T}/${bad}`, uid: ids.admin, role: 'admin', body: { name: `${ids.uniq} x` }, status: 400, code: 'INVALID_INPUT' });
      await expectRejected({ method: 'DELETE', url: `${T}/${bad}`, uid: ids.admin, role: 'admin', status: 400, code: 'INVALID_INPUT' });
    });
    test.each([
      'all=0', 'all=true', 'all=', 'all=1&all=1', 'all[x]=1', 'foo=1', 'all=1&status=closed', 'all=%201',
    ])('listado ?%s', async (qs) => {
      await expectRejected({ method: 'GET', url: `${T}?${qs}`, uid: ids.mgrA, role: 'manager', status: 400, code: 'INVALID_INPUT' });
    });
  });

  // ─────────────────────────── Alta ───────────────────────────
  describe('alta de plantilla', () => {
    const crit = (name, extra = {}) => ({ name, ...extra });
    test.each([
      ['cuerpo arreglo', () => [validBody('arr')]],
      ['campo desconocido', () => validBody('unk', { active: 1 })],
      ['nombre ausente', () => validBody('x', { name: undefined })],
      ['nombre vacío', () => validBody('x', { name: '   ' })],
      ['nombre demasiado largo', () => validBody('x', { name: `${ids.uniq}${'x'.repeat(120)}` })],
      ['nombre no texto', () => validBody('x', { name: 12 })],
      ['descripción no texto', () => validBody('dnt', { description: 5 })],
      ['descripción de más de 65535 bytes', () => validBody('dl', { description: 'é'.repeat(32768) })],
      ['escala textual', () => validBody('st', { scale_min: '1' })],
      ['escala fraccionaria', () => validBody('sf', { scale_max: 4.5 })],
      ['escala fuera de límites', () => validBody('so', { scale_max: 11 })],
      ['escala negativa', () => validBody('sn', { scale_min: -1 })],
      ['mínimo igual al máximo', () => validBody('se', { scale_min: 3, scale_max: 3 })],
      ['mínimo mayor que el máximo', () => validBody('sg', { scale_min: 5, scale_max: 2 })],
      ['criterios ausentes', () => validBody('ca', { criteria: undefined })],
      ['criterios no arreglo', () => validBody('cn', { criteria: { a: 1 } })],
      ['criterios vacíos', () => validBody('cv', { criteria: [] })],
      ['más de 50 criterios', () => validBody('cm', { criteria: Array.from({ length: 51 }, (_, i) => crit(`C${i}`)) })],
      ['criterio no objeto', () => validBody('co', { criteria: ['Calidad'] })],
      ['criterio con clave desconocida', () => validBody('ck', { criteria: [crit('A', { sort_order: 3 })] })],
      ['criterio incompleto (sin nombre)', () => validBody('ci', { criteria: [{ weight: 1 }] })],
      ['criterio con nombre vacío', () => validBody('cnv', { criteria: [crit('   ')] })],
      ['criterio con nombre largo', () => validBody('cnl', { criteria: [crit('x'.repeat(121))] })],
      ['peso cero', () => validBody('p0', { criteria: [crit('A', { weight: 0 })] })],
      ['peso negativo', () => validBody('pn', { criteria: [crit('A', { weight: -2 })] })],
      ['peso textual', () => validBody('pt', { criteria: [crit('A', { weight: '2' })] })],
      ['peso nulo', () => validBody('pnu', { criteria: [crit('A', { weight: null })] })],
      ['peso fuera de DECIMAL(5,2)', () => validBody('pd', { criteria: [crit('A', { weight: 1000 })] })],
      ['peso con 3 decimales', () => validBody('p3', { criteria: [crit('A', { weight: 1.005 })] })],
      ['un criterio válido y otro inválido', () => validBody('mix', { criteria: [crit('A'), crit('')] })],
      ['criterios duplicados', () => validBody('dup', { criteria: [crit('Calidad'), crit('Calidad')] })],
      ['duplicados normalizados', () => validBody('dupn', { criteria: [crit('Trabajo en equipo'), crit(' TRABAJO  en equipo ')] })],
      ['duplicados por acentos', () => validBody('dupa', { criteria: [crit('Comunicación'), crit('comunicacion')] })],
    ])('%s → 400 sin escritura ni auditoría', async (_l, make) => {
      await expectRejected({ method: 'POST', url: T, uid: ids.admin, role: 'admin', body: make(), status: 400, code: 'INVALID_INPUT' });
    });

    test('alta válida: atómica, normalizada y auditada sólo después del commit (sin textos)', async () => {
      const body = validBody('  alta válida  ');
      body.name = `  ${ids.uniq} alta válida  `;
      const c2 = await makeConn();
      let res;
      try {
        await c2.query('START TRANSACTION');
        // El INSERT de la plantilla verifica la FK created_by → users: queda
        // esperando el bloqueo de c2 con la transacción de la API abierta.
        await c2.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [ids.admin]);
        const req = track(http('POST', T, ids.admin, 'admin', body));
        const blocked = await waitBlocked('INSERT INTO appraisal_templates%', [conn.threadId, c2.threadId]);
        const during = {
          blocked,
          settled: req.settled,
          rows: await count('SELECT COUNT(*) AS n FROM appraisal_templates WHERE name = ?', [`${ids.uniq} alta válida`]),
          audits: await count("SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND action = 'appraisal_template_create'", [ids.admin]),
        };
        await c2.query('COMMIT');
        res = await req.promise;
        evidence.push({ request: 'POST plantilla válida (bloqueada en la FK)', during, got: res.status });
        expect(during).toEqual({ blocked: true, settled: false, rows: 0, audits: 0 });
      } finally {
        try { await c2.query('ROLLBACK'); } catch { /* confirmada */ }
        await c2.end();
      }
      expect(res.status).toBe(201);
      const id = res.body.id;
      ids.tplCreated = id;
      const row = await tplRow(id);
      expect(row).toMatchObject({ name: `${ids.uniq} alta válida`, description: 'Texto descriptivo PRIVADO', scale_min: 1, scale_max: 5, created_by: ids.admin });
      expect(Number(row.active)).toBe(1);
      expect(await critRows(id)).toEqual([
        { name: 'Calidad', description: 'Detalle PRIVADO del criterio', weight: '2.50', sort_order: 0 },
        { name: 'Equipo', description: null, weight: '1.00', sort_order: 1 },
      ]);
      await waitAudit(ids.admin, 'appraisal_template_create', id);
      const rows = await auditRows(ids.admin, 'appraisal_template_create', id);
      expect(rows).toHaveLength(1);
      const details = typeof rows[0].details === 'string' ? rows[0].details : JSON.stringify(rows[0].details);
      expect(JSON.parse(details)).toEqual({ count: 2 });
      expect(details).not.toMatch(/PRIVADO|Calidad|Equipo/);
    });

    test('escala 0–10 y pesos límite (0.01 / 999.99): aceptados', async () => {
      const r = await http('POST', T, ids.hr, 'hr', validBody('bordes', {
        scale_min: 0, scale_max: 10, criteria: [{ name: 'A', weight: 0.01 }, { name: 'B', weight: 999.99 }],
      }));
      expect(r.status).toBe(201);
      const { id } = await r.json();
      expect((await critRows(id)).map((c) => c.weight)).toEqual(['0.01', '999.99']);
      expect(await tplRow(id)).toMatchObject({ scale_min: 0, scale_max: 10 });
    });
  });

  // ─────────────────────────── Edición ───────────────────────────
  describe('edición (sólo nombre, descripción y estado)', () => {
    test.each([
      ['cuerpo vacío', {}],
      ['cuerpo arreglo', [{ name: 'x' }]],
      ['clave desconocida', { name: 'x', foo: 1 }],
      ['criterios', { criteria: [{ name: 'A' }] }],
      ['escala', { scale_min: 0 }],
      ['nombre vacío', { name: '  ' }],
      ['nombre largo', { name: 'x'.repeat(121) }],
      ['nombre nulo', { name: null }],
      ['descripción no texto', { description: 1 }],
      ['active textual', { active: '1' }],
      ['active 2', { active: 2 }],
      ['active nulo', { active: null }],
    ])('%s → 400 sin escritura ni auditoría', async (_l, body) => {
      await expectRejected({ method: 'PUT', url: `${T}/${ids.tplEdit}`, uid: ids.admin, role: 'admin', body, status: 400, code: 'INVALID_INPUT' });
    });

    test('inexistente → 404 sin UPDATE ni auditoría', async () => {
      await expectRejected({ method: 'PUT', url: `${T}/${MISSING}`, uid: ids.admin, role: 'admin', body: { name: `${ids.uniq} z` }, status: 404 });
    });

    test('cambio efectivo → 200, fila actualizada, auditoría tras commit con nombres de campo (sin valores)', async () => {
      const r = await http('PUT', `${T}/${ids.tplEdit}`, ids.admin, 'admin', { name: `  ${ids.uniq} edición nueva `, description: 'Nueva desc PRIVADA' });
      expect(r.status).toBe(200);
      expect(await tplRow(ids.tplEdit)).toMatchObject({ name: `${ids.uniq} edición nueva`, description: 'Nueva desc PRIVADA' });
      await waitAudit(ids.admin, 'appraisal_template_update', ids.tplEdit);
      const rows = await auditRows(ids.admin, 'appraisal_template_update', ids.tplEdit);
      expect(rows).toHaveLength(1);
      const details = typeof rows[0].details === 'string' ? rows[0].details : JSON.stringify(rows[0].details);
      expect(JSON.parse(details)).toEqual({ fields: ['name', 'description'] });
      expect(details).not.toMatch(/PRIVADA|edición/);
    });

    test('PUT idéntico → 200 idempotente: sin escritura ni auditoría (no se confunde con inexistente)', async () => {
      const before = await tplRow(ids.tplEdit);
      const audits0 = await auditCount(ids.admin);
      const w0 = await writeCounter();
      const r = await http('PUT', `${T}/${ids.tplEdit}`, ids.admin, 'admin', { name: `${ids.uniq} edición nueva`, description: 'Nueva desc PRIVADA', active: true });
      const audits = await settledAudits(ids.admin, audits0);
      const writes = (await writeCounter()) - w0;
      evidence.push({ request: 'PUT idéntico', got: r.status, writes, audits });
      expect(r.status).toBe(200);
      expect(writes).toBe(0);
      expect(audits).toBe(0);
      expect(await tplRow(ids.tplEdit)).toEqual(before);
    });

    test('descripción a null y desactivar/reactivar por PUT (0/1 y booleanos)', async () => {
      expect((await http('PUT', `${T}/${ids.tplEdit}`, ids.gth, 'gth', { description: null })).status).toBe(200);
      expect((await tplRow(ids.tplEdit)).description).toBeNull();
      expect((await http('PUT', `${T}/${ids.tplEdit}`, ids.gth, 'gth', { active: false })).status).toBe(200);
      expect(Number((await tplRow(ids.tplEdit)).active)).toBe(0);
      expect((await http('PUT', `${T}/${ids.tplEdit}`, ids.gth, 'gth', { active: 1 })).status).toBe(200);
      expect(Number((await tplRow(ids.tplEdit)).active)).toBe(1);
      await waitAudit(ids.gth, 'appraisal_template_update', ids.tplEdit, 3);
      const fields = (await auditRows(ids.gth, 'appraisal_template_update', ids.tplEdit))
        .map((r) => JSON.parse(typeof r.details === 'string' ? r.details : JSON.stringify(r.details)).fields);
      expect(fields).toEqual([['description'], ['active'], ['active']]);
    });
  });

  // ─────────────────────────── Desactivación ───────────────────────────
  describe('desactivación (soft-delete)', () => {
    test('inexistente → 404 sin UPDATE ni auditoría', async () => {
      await expectRejected({ method: 'DELETE', url: `${T}/${MISSING}`, uid: ids.admin, role: 'admin', status: 404 });
    });

    test('activa → 200, active = 0, criterios intactos, auditada una vez', async () => {
      const r = await http('DELETE', `${T}/${ids.tplDel}`, ids.admin, 'admin');
      expect(r.status).toBe(200);
      expect(Number((await tplRow(ids.tplDel)).active)).toBe(0);
      expect(await critRows(ids.tplDel)).toHaveLength(1);
      await waitAudit(ids.admin, 'appraisal_template_deactivate', ids.tplDel);
      const rows = await auditRows(ids.admin, 'appraisal_template_deactivate', ids.tplDel);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(typeof rows[0].details === 'string' ? rows[0].details : JSON.stringify(rows[0].details)))
        .toEqual({ active: 0, count: 1 });
    });

    test('ya inactiva → 200 idempotente, sin escritura ni auditoría nueva', async () => {
      const audits0 = await auditCount(ids.admin);
      const w0 = await writeCounter();
      const r = await http('DELETE', `${T}/${ids.tplDel}`, ids.admin, 'admin');
      const audits = await settledAudits(ids.admin, audits0);
      const writes = (await writeCounter()) - w0;
      evidence.push({ request: 'DELETE repetido', got: r.status, writes, audits });
      expect(r.status).toBe(200);
      expect(writes).toBe(0);
      expect(audits).toBe(0);
      expect(await actionCount(ids.admin, 'appraisal_template_deactivate', ids.tplDel)).toBe(1);
    });

    test('plantilla inactiva: crear una evaluación → 400 INVALID_TEMPLATE sin escritura ni auditoría', async () => {
      await expectRejected({
        method: 'POST', url: '/api/appraisals', uid: ids.admin, role: 'admin',
        body: { template_id: ids.tplDel, employee_id: ids.eA, period_label: 'TP-2026' }, status: 400, code: 'INVALID_TEMPLATE',
      });
    });

    test('reactivación válida por PUT → se puede volver a usar', async () => {
      expect((await http('DELETE', `${T}/${ids.tplReuse}`, ids.hr, 'hr')).status).toBe(200);
      expect((await http('PUT', `${T}/${ids.tplReuse}`, ids.hr, 'hr', { active: true })).status).toBe(200);
      const r = await http('POST', '/api/appraisals', ids.hr, 'hr', { template_id: ids.tplReuse, employee_id: ids.eA, period_label: 'TP-reuso' });
      expect(r.status).toBe(201);
    });

    test('evaluación abierta creada antes de desactivar: se ve, se puntúa y se cierra', async () => {
      const c = await http('POST', '/api/appraisals', ids.admin, 'admin',
        { template_id: ids.tplOpen, employee_id: ids.eA, reviewer_id: ids.revA, period_label: 'TP-abierta' });
      expect(c.status).toBe(201);
      const apId = (await c.json()).id;
      expect((await http('DELETE', `${T}/${ids.tplOpen}`, ids.admin, 'admin')).status).toBe(200);
      expect(Number((await tplRow(ids.tplOpen)).active)).toBe(0);

      const d = await http('GET', `/api/appraisals/${apId}`, ids.uEmp, 'employee');
      expect(d.status).toBe(200);
      expect((await d.json()).data.criteria).toHaveLength(2);
      const list = await (await http('GET', '/api/appraisals?period=TP-abierta', ids.hr, 'hr')).json();
      expect(list.data.map((a) => a.id)).toContain(apId);
      const scores = (a, b) => [{ criteria_id: ids.cOpen1, score: a }, { criteria_id: ids.cOpen2, score: b }];
      const s1 = await http('POST', `/api/appraisals/${apId}/score`, ids.uEmp, 'employee', { scorer_role: 'self', scores: scores(4, 3) });
      expect(s1.status).toBe(200);
      const s2 = await http('POST', `/api/appraisals/${apId}/score`, ids.revA, 'manager', { scorer_role: 'manager', scores: scores(5, 4) });
      expect(s2.status).toBe(200);
      const cl = await http('POST', `/api/appraisals/${apId}/close`, ids.hr, 'hr', {});
      expect(cl.status).toBe(200);
      expect((await cl.json()).final_score).toBe(4.33);
      evidence.push({ request: 'evaluación abierta tras desactivar', detail: d.status, self: s1.status, manager: s2.status, close: cl.status });
    });
  });

  // ─────────────────────────── Carreras ───────────────────────────
  describe('carreras deterministas creación/desactivación (MySQL real)', () => {
    test('la creación toma la plantilla primero → confirma; la desactivación espera y luego desactiva', async () => {
      const c2 = await makeConn();
      let out;
      try {
        await c2.query('START TRANSACTION');
        // La creación toma la plantilla (FOR SHARE) y queda esperando el empleado.
        await c2.query('SELECT id FROM employees WHERE id = ? FOR UPDATE', [ids.eA2]);
        const create = track(http('POST', '/api/appraisals', ids.admin, 'admin',
          { template_id: ids.tplRaceA, employee_id: ids.eA2, period_label: 'TP-carrera-A' }));
        const createBlocked = await waitBlocked('%FROM employees WHERE id =%FOR UPDATE%', [conn.threadId, c2.threadId]);
        const del = track(http('DELETE', `${T}/${ids.tplRaceA}`, ids.hr, 'hr'));
        const delBlocked = await waitBlocked('%FROM appraisal_templates WHERE id =%FOR UPDATE%', [conn.threadId, c2.threadId]);
        const during = { createBlocked, delBlocked, createSettled: create.settled, delSettled: del.settled };
        await c2.query('COMMIT');
        out = { during, create: await create.promise, del: await del.promise };
      } finally {
        try { await c2.query('ROLLBACK'); } catch { /* confirmada */ }
        await c2.end();
      }
      evidence.push({ request: 'RACE creación→desactivación', during: out.during, got: [out.create.status, out.del.status] });
      expect(out.during).toEqual({ createBlocked: true, delBlocked: true, createSettled: false, delSettled: false });
      expect([out.create.status, out.del.status]).toEqual([201, 200]);
      const [aps] = await conn.query('SELECT id, template_id FROM appraisals WHERE period_label = ?', ['TP-carrera-A']);
      expect(aps).toHaveLength(1);
      expect(Number((await tplRow(ids.tplRaceA)).active)).toBe(0);
      await waitAudit(ids.admin, 'appraisal_create', aps[0].id);
      await waitAudit(ids.hr, 'appraisal_template_deactivate', ids.tplRaceA);
    });

    test('la desactivación toma la plantilla primero → confirma; la creación espera, la ve inactiva y falla sin escribir', async () => {
      const c2 = await makeConn();
      let out;
      try {
        await c2.query('START TRANSACTION');
        // La desactivación toma la plantilla (FOR UPDATE) y queda esperando el
        // conteo de criterios (FOR SHARE) que c2 retiene.
        await c2.query('SELECT id FROM appraisal_template_criteria WHERE id = ? FOR UPDATE', [ids.cRaceB]);
        const del = track(http('DELETE', `${T}/${ids.tplRaceB}`, ids.hr, 'hr'));
        const delBlocked = await waitBlocked('%FROM appraisal_template_criteria WHERE template_id =%FOR SHARE%', [conn.threadId, c2.threadId]);
        const create = track(http('POST', '/api/appraisals', ids.admin, 'admin',
          { template_id: ids.tplRaceB, employee_id: ids.eA2, period_label: 'TP-carrera-B' }));
        const createBlocked = await waitBlocked('%FROM appraisal_templates WHERE id =%FOR SHARE%', [conn.threadId, c2.threadId]);
        const during = {
          delBlocked, createBlocked, delSettled: del.settled, createSettled: create.settled,
          deactivateAudits: await actionCount(ids.hr, 'appraisal_template_deactivate', ids.tplRaceB),
        };
        await c2.query('COMMIT');
        out = { during, del: await del.promise, create: await create.promise };
      } finally {
        try { await c2.query('ROLLBACK'); } catch { /* confirmada */ }
        await c2.end();
      }
      evidence.push({ request: 'RACE desactivación→creación', during: out.during, got: [out.del.status, out.create.status] });
      expect(out.during).toEqual({ delBlocked: true, createBlocked: true, delSettled: false, createSettled: false, deactivateAudits: 0 });
      expect(out.del.status).toBe(200);
      expect(out.create.status).toBe(400);
      expect(out.create.body.code).toBe('INVALID_TEMPLATE');
      expect(await count('SELECT COUNT(*) AS n FROM appraisals WHERE template_id = ?', [ids.tplRaceB])).toBe(0);
      expect(Number((await tplRow(ids.tplRaceB)).active)).toBe(0);
      await waitAudit(ids.hr, 'appraisal_template_deactivate', ids.tplRaceB);
    });
  });
});
