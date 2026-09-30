'use strict';

/**
 * orgScope.it.test.js — INTEGRACIÓN (MySQL real): acceso cruzado denegado.
 *
 * Verifica sobre datos reales que un rol con alcance sólo ve su empresa/centro
 * de costo y que un writer rechaza referencias fuera de alcance (403).
 *
 * Contrato vigente (30cea2d, departmentScope/orgScope):
 *   - La SEDE de la CUENTA (`users.branch_id`, usuario activo) define el
 *     alcance de los roles con alcance; se lee de la base en cada resolución.
 *   - Departamentos visibles = los ACTIVOS de esa sede (`departments.branch_id`).
 *   - Empresa visible = `branches.company_id` de esa sede.
 *   - `users.employee_id` es un vínculo personal: NO define ni amplía el alcance.
 *   - Sin sede, sede inexistente o INACTIVA, cuenta inactiva o rol sin alcance
 *     → conjuntos vacíos (fail-closed); reactivar la sede recupera el alcance.
 *   - El alcance global sólo lo emite el servidor (un literal no cuenta).
 *   - Roles globales (admin, …) → sin restricción.
 *
 * Datos sintéticos: dos empresas con una sede cada una; los departamentos se
 * crean con su sede explícita (la columna tiene DEFAULT 1 desde la 015).
 */
const { describeIT, makeConn, closeAppDb } = require('./helper');

// Proceso de PRUEBA contra MySQL aislado: se habilitan los writers de gobierno
// sólo en este proceso para ejercer las rutas reales de escritura (el flag
// operativo del servidor no se toca). JWT de prueba.
process.env.GOVERNANCE_WRITE_ENABLED = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'it-orgscope-secret-0123456789abcdef';

describeIT('orgScope (integración) — alcance por empresa', () => {
  let conn;
  let orgScope;
  let governance;
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
  /** Espera a que aparezca el evento de auditoría del control positivo (audit.log es asíncrono). */
  async function waitAudit(userId, action, entityId) {
    for (let i = 0; i < 100; i += 1) {
      const n = await count('SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND action = ? AND entity_id = ?', [userId, action, String(entityId)]);
      if (n > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`sin evento ${action}`);
  }

  async function insertUser(tag, role, { branchId = null, employeeId = null, active = 1 } = {}) {
    const [r] = await conn.query(
      'INSERT INTO users (username, email, password_hash, full_name, role, employee_id, branch_id, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [`${ids.uniq}${tag}`, `${ids.uniq.toLowerCase()}${tag}@it.local`, 'it-no-login', `IT ${tag}`, role, employeeId, branchId, active],
    );
    return r.insertId;
  }
  /** Identidad como la arma `authenticate` (id + rol + vínculo de la base). */
  const who = (userId, role, employeeId = null) => ({ id: userId, role, employee_id: employeeId });

  beforeAll(async () => {
    conn = await makeConn();
    orgScope = require('../../src/services/orgScope');
    governance = require('../../src/services/governance');

    const uniq = `IT${Date.now() % 100000}`;
    ids.uniq = uniq;
    const [ca] = await conn.query('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}A`, 'ITScope A']);
    ids.companyA = ca.insertId;
    const [cb] = await conn.query('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}B`, 'ITScope B']);
    ids.companyB = cb.insertId;

    const [bra] = await conn.query('INSERT INTO branches (code, company_id, name, active) VALUES (?, ?, ?, 1)', [`${uniq}BRA`, ids.companyA, 'ITBranch A']);
    ids.branchA = bra.insertId;
    const [brb] = await conn.query('INSERT INTO branches (code, company_id, name, active) VALUES (?, ?, ?, 1)', [`${uniq}BRB`, ids.companyB, 'ITBranch B']);
    ids.branchB = brb.insertId;

    const dept = async (name, code, branchId, active) => (await conn.query(
      'INSERT INTO departments (name, code, branch_id, active) VALUES (?, ?, ?, ?)', [name, code, branchId, active],
    ))[0].insertId;
    ids.deptA = await dept('ITScope Dept A', `${uniq}DA`, ids.branchA, 1);
    ids.deptAOff = await dept('ITScope Dept A inactivo', `${uniq}DX`, ids.branchA, 0);
    ids.deptB = await dept('ITScope Dept B', `${uniq}DB`, ids.branchB, 1);

    const emp = async (tag, branchId, deptId) => (await conn.query(
      'INSERT INTO employees (code, employee_number, first_name, last_name, email, branch_id, department_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [`${uniq}${tag}`, `${uniq}N${tag}`, 'Emp', `Scope ${tag}`, `${uniq.toLowerCase()}${tag.toLowerCase()}@it.local`, branchId, deptId, 'active'],
    ))[0].insertId;
    ids.empA = await emp('EA', ids.branchA, ids.deptA);
    ids.empB = await emp('EB', ids.branchB, ids.deptB);

    const [cca] = await conn.query('INSERT INTO cost_centers (company_id, code, name, active) VALUES (?, ?, ?, 1)', [ids.companyA, `${uniq}CCA`, 'CC A']);
    ids.ccA = cca.insertId;
    const [ccb] = await conn.query('INSERT INTO cost_centers (company_id, code, name, active) VALUES (?, ?, ?, 1)', [ids.companyB, `${uniq}CCB`, 'CC B']);
    ids.ccB = ccb.insertId;

    // Gerente de la sede A cuyo empleado vinculado es de la sede B: el vínculo
    // no debe darle nada de B.
    ids.mgrA = await insertUser('mA', 'manager', { branchId: ids.branchA, employeeId: ids.empB });
    // Gerente sin sede, vinculado a un empleado de A: sin alcance.
    ids.mgrNoBranch = await insertUser('mN', 'manager', { employeeId: ids.empA });
    // Gerente de la sede A desactivado: sin alcance.
    ids.mgrInactive = await insertUser('mI', 'manager', { branchId: ids.branchA, active: 0 });
    ids.coordA = await insertUser('cA', 'coordinator', { branchId: ids.branchA });
    ids.employeeA = await insertUser('eA', 'employee', { branchId: ids.branchA, employeeId: ids.empA });
    ids.admin = await insertUser('ad', 'admin');
    // Cuenta con una sede que NO existe (users.branch_id no tiene FK).
    const [[mx]] = await conn.query('SELECT COALESCE(MAX(id), 0) + 1000 AS id FROM branches');
    ids.ghostBranch = Number(mx.id);
    ids.mgrGhost = await insertUser('mG', 'manager', { branchId: ids.ghostBranch });
    // Calendario GLOBAL (sin empresa ni sede): sólo visible con sede activa o rol global.
    const [cal] = await conn.query(
      'INSERT INTO labor_calendars (code, name, valid_from) VALUES (?, ?, ?)', [`${uniq}GCAL`, 'IT global', '2031-01-01'],
    );
    ids.globalCal = cal.insertId;

    // Capacidades EXPLÍCITAS para los gerentes: el permiso funcional está
    // otorgado; lo que decide es el ALCANCE.
    for (const uid of [ids.mgrA, ids.mgrNoBranch, ids.mgrGhost]) {
      for (const module of ['empresas', 'centros_costo']) {
        await conn.query(
          'INSERT INTO user_permissions (user_id, module, can_view, can_create, can_update, can_delete) VALUES (?, ?, 1, 1, 1, 0)',
          [uid, module],
        );
      }
    }

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/companies', require('../../src/routes/companies'));
    app.use('/api/cost-centers', require('../../src/routes/costCenters'));
    app.use('/api/branches', require('../../src/routes/branches'));
    app.use('/api/departments', require('../../src/routes/departments'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (conn) {
      await conn.query('UPDATE branches SET active = 1 WHERE id = ?', [ids.branchA]);
      if (ids.globalCal) await conn.query('DELETE FROM labor_calendars WHERE id = ?', [ids.globalCal]);
      await conn.query('DELETE FROM employee_assignments WHERE employee_id IN (?, ?)', [ids.empA, ids.empB]);
      const userIds = [ids.mgrA, ids.mgrNoBranch, ids.mgrInactive, ids.coordA, ids.employeeA, ids.admin, ids.mgrGhost].filter(Boolean);
      if (userIds.length) {
        await conn.query('DELETE FROM user_permissions WHERE user_id IN (?)', [userIds]);
        await conn.query('DELETE FROM audit_events WHERE user_id IN (?)', [userIds]);
        await conn.query('DELETE FROM cost_centers WHERE created_by IN (?)', [userIds]);
        await conn.query('DELETE FROM companies WHERE created_by IN (?)', [userIds]);
        await conn.query('DELETE FROM users WHERE id IN (?)', [userIds]);
      }
      await conn.query('DELETE FROM cost_centers WHERE id IN (?, ?)', [ids.ccA, ids.ccB]);
      await conn.query('DELETE FROM employees WHERE id IN (?, ?)', [ids.empA, ids.empB]);
      await conn.query('DELETE FROM departments WHERE id IN (?, ?, ?)', [ids.deptA, ids.deptAOff, ids.deptB]);
      await conn.query('DELETE FROM branches WHERE id IN (?, ?)', [ids.branchA, ids.branchB]);
      await conn.query('DELETE FROM companies WHERE id IN (?, ?)', [ids.companyA, ids.companyB]);
      await conn.end();
    }
    await closeAppDb();
  });

  describe('acceso permitido', () => {
    test('manager deriva alcance a su empresa/sucursal/departamento desde la sede de la cuenta', async () => {
      const scope = await orgScope.getOrgScope(who(ids.mgrA, 'manager', ids.empB));
      expect(scope.unrestricted).toBe(false);
      expect(scope.companyIds).toEqual([ids.companyA]);
      expect(scope.branchIds).toEqual([ids.branchA]);
      expect(scope.departmentIds).toEqual(expect.arrayContaining([ids.deptA]));
      // Sólo departamentos activos de su sede; el empleado vinculado (sede B) no suma nada.
      expect(scope.departmentIds).not.toContain(ids.deptAOff);
      expect(scope.departmentIds).not.toContain(ids.deptB);
    });

    test('otro rol con alcance (coordinator) sigue la misma regla', async () => {
      const scope = await orgScope.getOrgScope(who(ids.coordA, 'coordinator'));
      expect(scope).toMatchObject({ unrestricted: false, companyIds: [ids.companyA], branchIds: [ids.branchA] });
    });

    test('listCompanies filtra: ve su empresa, NO la ajena', async () => {
      const scope = await orgScope.getOrgScope(who(ids.mgrA, 'manager', ids.empB));
      const seen = (await governance.listCompanies(scope)).map((r) => r.id);
      expect(seen).toContain(ids.companyA);
      expect(seen).not.toContain(ids.companyB);
    });

    test('listCostCenters filtra por empresa del alcance', async () => {
      const scope = await orgScope.getOrgScope(who(ids.mgrA, 'manager', ids.empB));
      const seen = (await governance.listCostCenters(scope)).map((r) => r.id);
      expect(seen).toContain(ids.ccA);
      expect(seen).not.toContain(ids.ccB);
    });

    test('rol global (admin) ve ambas empresas', async () => {
      const scope = await orgScope.getOrgScope(who(ids.admin, 'admin'));
      expect(scope).toEqual({ unrestricted: true });
      const seen = (await governance.listCompanies(scope)).map((r) => r.id);
      expect(seen).toEqual(expect.arrayContaining([ids.companyA, ids.companyB]));
      const cc = (await governance.listCostCenters(scope)).map((r) => r.id);
      expect(cc).toEqual(expect.arrayContaining([ids.ccA, ids.ccB]));
    });
  });

  describe('acceso denegado', () => {
    test('writer rechaza referencia a empresa, sede o departamento fuera de alcance (403)', async () => {
      const scope = await orgScope.getOrgScope(who(ids.mgrA, 'manager', ids.empB));
      const denied = [
        () => orgScope.assertCompanyInScope(scope, ids.companyB),
        () => orgScope.assertBranchInScope(scope, ids.branchB),
        () => orgScope.assertDepartmentInScope(scope, ids.deptB),
      ];
      for (const fn of denied) {
        let err;
        try { fn(); } catch (e) { err = e; }
        expect(err).toMatchObject({ status: 403, code: 'OUT_OF_SCOPE' });
        expect(err.message).toMatch(/alcance/i);
      }
      expect(() => orgScope.assertCompanyInScope(scope, ids.companyA)).not.toThrow();
      expect(() => orgScope.assertBranchInScope(scope, ids.branchA)).not.toThrow();
      expect(() => orgScope.assertDepartmentInScope(scope, ids.deptA)).not.toThrow();
    });

    test.each([
      ['manager sin sede (su empleado vinculado es de A)', () => who(ids.mgrNoBranch, 'manager', ids.empA)],
      ['manager de A con la cuenta desactivada', () => who(ids.mgrInactive, 'manager')],
      ['rol sin alcance (employee) de la sede A', () => who(ids.employeeA, 'employee', ids.empA)],
      ['identidad sin id de usuario (sólo employee_id)', () => ({ role: 'manager', employee_id: ids.empA })],
    ])('%s → alcance vacío: no ve empresas ni centros y todo writer rechaza', async (_label, identity) => {
      const scope = await orgScope.getOrgScope(identity());
      expect(scope).toEqual({ unrestricted: false, companyIds: [], branchIds: [], departmentIds: [] });
      const companies = (await governance.listCompanies(scope)).map((r) => r.id);
      expect(companies).not.toContain(ids.companyA);
      expect(companies).not.toContain(ids.companyB);
      expect(await governance.listCostCenters(scope)).toEqual([]);
      expect(() => orgScope.assertCompanyInScope(scope, ids.companyA)).toThrow(/alcance/i);
    });

    test('un cambio administrativo de sede tiene efecto inmediato (se lee de la base en cada resolución)', async () => {
      try {
        await conn.query('UPDATE users SET branch_id = ? WHERE id = ?', [ids.branchB, ids.mgrA]);
        const moved = await orgScope.getOrgScope(who(ids.mgrA, 'manager', ids.empB));
        expect(moved).toMatchObject({ companyIds: [ids.companyB], branchIds: [ids.branchB] });
        expect(moved.departmentIds).toContain(ids.deptB);
        expect(moved.departmentIds).not.toContain(ids.deptA);
        expect(() => orgScope.assertCompanyInScope(moved, ids.companyA)).toThrow(/alcance/i);
      } finally {
        await conn.query('UPDATE users SET branch_id = ? WHERE id = ?', [ids.branchA, ids.mgrA]);
      }
      const back = await orgScope.getOrgScope(who(ids.mgrA, 'manager', ids.empB));
      expect(back.companyIds).toEqual([ids.companyA]);
    });
  });
  describe('alcance obligatorio (base real)', () => {
    test.each([
      ['ausente', undefined],
      ['null', null],
      ['literal { unrestricted: true } no emitido', { unrestricted: true }],
      ['mal formado', { unrestricted: false, companyIds: ['1'] }],
    ])('servicio con alcance %s → sin filas y sin lectura por id', async (_label, bad) => {
      expect(await governance.listCompanies(bad)).toEqual([]);
      expect(await governance.listCostCenters(bad)).toEqual([]);
      expect(await governance.getCompany(ids.companyA, bad)).toBeNull();
      expect(await governance.getCostCenter(ids.ccA, bad)).toBeNull();
    });

    test('el mismo servicio con el global emitido para admin ve ambas empresas (control positivo)', async () => {
      const scope = await orgScope.getOrgScope(who(ids.admin, 'admin'));
      const seen = (await governance.listCompanies(scope)).map((r) => r.id);
      expect(seen).toEqual(expect.arrayContaining([ids.companyA, ids.companyB]));
      expect((await governance.getCompany(ids.companyB, scope)).id).toBe(ids.companyB);
    });
  });

  describe('rutas HTTP: permitido y denegado sin escritura (base real)', () => {
    test('manager de A: lee su empresa, no la ajena', async () => {
      const list = await (await http('GET', '/api/companies', ids.mgrA, 'manager')).json();
      const seen = list.data.map((r) => r.id);
      expect(seen).toContain(ids.companyA);
      expect(seen).not.toContain(ids.companyB);
      expect((await http('GET', `/api/companies/${ids.companyA}`, ids.mgrA, 'manager')).status).toBe(200);
      expect((await http('GET', `/api/companies/${ids.companyB}`, ids.mgrA, 'manager')).status).toBe(404);
      const cc = (await (await http('GET', '/api/cost-centers', ids.mgrA, 'manager')).json()).data.map((r) => r.id);
      expect(cc).toContain(ids.ccA);
      expect(cc).not.toContain(ids.ccB);
    });

    test('manager de A con permiso de alta: denegado todo lo que sale de su alcance, sin filas ni auditoría', async () => {
      const auditBefore = await auditCount(ids.mgrA);
      const code = `${ids.uniq}NEW`;

      // Crear una empresa exige alcance global aunque tenga el permiso.
      const r1 = await http('POST', '/api/companies', ids.mgrA, 'manager', { code, legal_name: 'IT nueva' });
      expect(r1.status).toBe(403);
      expect(await count('SELECT COUNT(*) AS n FROM companies WHERE code = ?', [code])).toBe(0);

      // Editar la empresa ajena → 404 y sin cambios.
      const r2 = await http('PATCH', `/api/companies/${ids.companyB}`, ids.mgrA, 'manager', { legal_name: 'pisada' });
      expect(r2.status).toBe(404);
      expect((await conn.query('SELECT legal_name FROM companies WHERE id = ?', [ids.companyB]))[0][0].legal_name).toBe('ITScope B');

      // Centro de costo en la empresa ajena o sin empresa → 403 sin fila.
      for (const body of [{ company_id: ids.companyB, code: `${code}CB`, name: 'x' }, { code: `${code}CN`, name: 'x' }]) {
        const r = await http('POST', '/api/cost-centers', ids.mgrA, 'manager', body);
        expect(r.status).toBe(403);
        expect(await count('SELECT COUNT(*) AS n FROM cost_centers WHERE code = ?', [body.code])).toBe(0);
      }

      // Mover un centro propio a la empresa ajena → 403 sin cambio.
      const r3 = await http('PATCH', `/api/cost-centers/${ids.ccA}`, ids.mgrA, 'manager', { company_id: ids.companyB });
      expect(r3.status).toBe(403);
      expect(Number((await conn.query('SELECT company_id FROM cost_centers WHERE id = ?', [ids.ccA]))[0][0].company_id)).toBe(ids.companyA);

      // Control positivo del mismo usuario: centro en SU empresa → 201 + evento.
      const ok = await http('POST', '/api/cost-centers', ids.mgrA, 'manager', { company_id: ids.companyA, code: `${code}CA`, name: 'propio' });
      expect(ok.status).toBe(201);
      const created = await ok.json();
      await waitAudit(ids.mgrA, 'cost_center.create', created.id);
      // El único evento nuevo es el del control positivo.
      expect(await auditCount(ids.mgrA)).toBe(auditBefore + 1);
    });

    test('admin (global emitido): crea empresa y ve ambas (control positivo)', async () => {
      const code = `${ids.uniq}ADM`;
      const r = await http('POST', '/api/companies', ids.admin, 'admin', { code, legal_name: 'IT admin' });
      expect(r.status).toBe(201);
      const { id } = await r.json();
      await waitAudit(ids.admin, 'company.create', id);
      const seen = (await (await http('GET', '/api/companies', ids.admin, 'admin')).json()).data.map((x) => x.id);
      expect(seen).toEqual(expect.arrayContaining([ids.companyA, ids.companyB, id]));
    });
  });
  describe('sede existente y activa para roles por sede (base real)', () => {
    const calendar = () => require('../../src/services/calendarService');
    const EMPTY = { unrestricted: false, companyIds: [], branchIds: [], departmentIds: [] };

    test('sede inexistente → alcance vacío; no ve empresas, centros ni calendarios globales', async () => {
      const scope = await orgScope.getOrgScope(who(ids.mgrGhost, 'manager'));
      expect(scope).toEqual(EMPTY);
      expect((await calendar().listCalendars(scope)).map((c) => c.id)).not.toContain(ids.globalCal);
      expect((await (await http('GET', '/api/companies', ids.mgrGhost, 'manager')).json()).data).toEqual([]);
      expect(await (await http('GET', '/api/branches', ids.mgrGhost, 'manager')).json()).toEqual([]);
      const r = await http('POST', '/api/cost-centers', ids.mgrGhost, 'manager', { company_id: ids.companyA, code: `${ids.uniq}GH`, name: 'x' });
      expect(r.status).toBe(403);
      expect(await count('SELECT COUNT(*) AS n FROM cost_centers WHERE code = ?', [`${ids.uniq}GH`])).toBe(0);
    });

    test('sede inactiva: sin consulta ni modificación; admin sigue administrando; reactivar recupera el alcance sin perder datos', async () => {
      const before = await orgScope.getOrgScope(who(ids.mgrA, 'manager', ids.empB));
      expect(before.companyIds).toEqual([ids.companyA]);
      expect((await calendar().listCalendars(before)).map((c) => c.id)).toContain(ids.globalCal);
      const snapshot = async () => ({
        company: (await conn.query('SELECT legal_name, active FROM companies WHERE id = ?', [ids.companyA]))[0][0],
        cc: (await conn.query('SELECT company_id, name, active FROM cost_centers WHERE id = ?', [ids.ccA]))[0][0],
        dept: (await conn.query('SELECT branch_id, active FROM departments WHERE id = ?', [ids.deptA]))[0][0],
        user: (await conn.query('SELECT branch_id, active FROM users WHERE id = ?', [ids.mgrA]))[0][0],
      });
      const data0 = await snapshot();
      const audit0 = await auditCount(ids.mgrA);

      await conn.query('UPDATE branches SET active = 0 WHERE id = ?', [ids.branchA]);
      try {
        const off = await orgScope.getOrgScope(who(ids.mgrA, 'manager', ids.empB));
        expect(off).toEqual(EMPTY);
        expect((await calendar().listCalendars(off)).map((c) => c.id)).not.toContain(ids.globalCal);

        // Consultas por HTTP: nada.
        expect((await (await http('GET', '/api/companies', ids.mgrA, 'manager')).json()).data).toEqual([]);
        expect((await http('GET', `/api/companies/${ids.companyA}`, ids.mgrA, 'manager')).status).toBe(404);
        expect((await (await http('GET', '/api/cost-centers', ids.mgrA, 'manager')).json()).data).toEqual([]);
        expect(await (await http('GET', '/api/branches', ids.mgrA, 'manager')).json()).toEqual([]);

        // Modificaciones: rechazadas, sin filas nuevas ni cambios.
        const code = `${ids.uniq}OFF`;
        expect((await http('POST', '/api/cost-centers', ids.mgrA, 'manager', { company_id: ids.companyA, code, name: 'x' })).status).toBe(403);
        expect((await http('PATCH', `/api/cost-centers/${ids.ccA}`, ids.mgrA, 'manager', { name: 'pisado' })).status).toBe(404);
        expect((await http('PATCH', `/api/companies/${ids.companyA}`, ids.mgrA, 'manager', { legal_name: 'pisada' })).status).toBe(404);
        expect(await count('SELECT COUNT(*) AS n FROM cost_centers WHERE code = ?', [code])).toBe(0);
        expect(await snapshot()).toEqual(data0);
        expect(await auditCount(ids.mgrA)).toBe(audit0);

        // Administración global autorizada: admin ve y administra durante la baja.
        const adminSeen = (await (await http('GET', '/api/companies', ids.admin, 'admin')).json()).data.map((x) => x.id);
        expect(adminSeen).toEqual(expect.arrayContaining([ids.companyA, ids.companyB]));
        const adminBranches = (await (await http('GET', '/api/branches', ids.admin, 'admin')).json()).map((b) => b.id);
        expect(adminBranches).toContain(ids.branchA);
        const adm = await http('POST', '/api/cost-centers', ids.admin, 'admin', { company_id: ids.companyA, code: `${code}AD`, name: 'admin' });
        expect(adm.status).toBe(201);
        await waitAudit(ids.admin, 'cost_center.create', (await adm.json()).id);
      } finally {
        await conn.query('UPDATE branches SET active = 1 WHERE id = ?', [ids.branchA]);
      }

      // Reactivada: el mismo alcance y los mismos datos que antes de la baja.
      const back = await orgScope.getOrgScope(who(ids.mgrA, 'manager', ids.empB));
      expect(back).toEqual(before);
      expect((await calendar().listCalendars(back)).map((c) => c.id)).toContain(ids.globalCal);
      const seen = (await (await http('GET', '/api/companies', ids.mgrA, 'manager')).json()).data.map((x) => x.id);
      expect(seen).toContain(ids.companyA);
      expect(seen).not.toContain(ids.companyB);
      expect((await http('GET', `/api/cost-centers/${ids.ccA}`, ids.mgrA, 'manager')).status).toBe(200);
      expect(await snapshot()).toEqual(data0);
    });
  });
  describe('lecturas de Departamentos con alcance (HTTP y autenticación reales)', () => {
    const list = async (uid, role) => (await (await http('GET', '/api/departments', uid, role)).json()).map((d) => d.id);
    const bodyOf = async (r) => JSON.stringify(await r.json());

    test('manager de A: su departamento activo sí; el de otra sede no se revela', async () => {
      const seen = await list(ids.mgrA, 'manager');
      expect(seen).toContain(ids.deptA);
      expect(seen).not.toContain(ids.deptB);
      expect(seen).not.toContain(ids.deptAOff);
      expect((await http('GET', `/api/departments/${ids.deptA}`, ids.mgrA, 'manager')).status).toBe(200);
      const own = await (await http('GET', `/api/departments/${ids.deptA}/employees`, ids.mgrA, 'manager')).json();
      expect(own.map((e) => e.id)).toEqual([ids.empA]);
      for (const url of [`/api/departments/${ids.deptB}`, `/api/departments/${ids.deptB}/employees`]) {
        const r = await http('GET', url, ids.mgrA, 'manager');
        expect([url, r.status]).toEqual([url, 404]);
        expect(await bodyOf(r)).not.toMatch(new RegExp(`${ids.uniq}eb|Scope EB|ITScope Dept B`, 'i'));
      }
    });

    test('sede inexistente → listado vacío; detalle y empleados 404', async () => {
      expect(await list(ids.mgrGhost, 'manager')).toEqual([]);
      expect((await http('GET', `/api/departments/${ids.deptA}`, ids.mgrGhost, 'manager')).status).toBe(404);
      expect((await http('GET', `/api/departments/${ids.deptA}/employees`, ids.mgrGhost, 'manager')).status).toBe(404);
    });

    test('sede inactiva → sin lecturas; reactivada → las recupera', async () => {
      await conn.query('UPDATE branches SET active = 0 WHERE id = ?', [ids.branchA]);
      try {
        expect(await list(ids.mgrA, 'manager')).toEqual([]);
        const r1 = await http('GET', `/api/departments/${ids.deptA}`, ids.mgrA, 'manager');
        const r2 = await http('GET', `/api/departments/${ids.deptA}/employees`, ids.mgrA, 'manager');
        expect([r1.status, r2.status]).toEqual([404, 404]);
        expect(await bodyOf(r2)).not.toMatch(new RegExp(`${ids.uniq}ea`, 'i'));
      } finally {
        await conn.query('UPDATE branches SET active = 1 WHERE id = ?', [ids.branchA]);
      }
      expect(await list(ids.mgrA, 'manager')).toContain(ids.deptA);
      expect((await http('GET', `/api/departments/${ids.deptA}/employees`, ids.mgrA, 'manager')).status).toBe(200);
    });

    test('sin alcance (employee, manager sin sede) → vacío y 404', async () => {
      for (const [uid, role] of [[ids.employeeA, 'employee'], [ids.mgrNoBranch, 'manager']]) {
        expect(await list(uid, role)).toEqual([]);
        expect((await http('GET', `/api/departments/${ids.deptA}/employees`, uid, role)).status).toBe(404);
      }
    });

    test('admin (control positivo): ve ambos departamentos y sus empleados', async () => {
      expect(await list(ids.admin, 'admin')).toEqual(expect.arrayContaining([ids.deptA, ids.deptB]));
      const emps = await (await http('GET', `/api/departments/${ids.deptB}/employees`, ids.admin, 'admin')).json();
      expect(emps.map((e) => e.id)).toEqual([ids.empB]);
    });
  });

  describe('createAssignment exige alcance en el servicio (base real)', () => {
    const people = () => require('../../src/services/people');
    const rows = async (empId) => (await conn.query(
      'SELECT id, valid_from, valid_to FROM employee_assignments WHERE employee_id = ? ORDER BY valid_from', [empId],
    ))[0];

    test('denegado sin INSERT ni cierre de la vigencia previa; global y empleado propio sí', async () => {
      const global = await orgScope.getOrgScope(who(ids.admin, 'admin'));
      // Vigencia previa abierta del empleado de la sede B, creada como global.
      await people().createAssignment(ids.empB, { valid_from: '2030-01-01' }, ids.admin, global);
      const before = await rows(ids.empB);
      expect(before).toHaveLength(1);
      expect(before[0].valid_to).toBeNull();

      const mgrA = await orgScope.getOrgScope(who(ids.mgrA, 'manager', ids.empB));
      for (const [label, scope] of [
        ['undefined', undefined], ['null', null], ['{}', {}],
        ['literal global', { unrestricted: true }],
        ['vacío', { unrestricted: false, companyIds: [], branchIds: [], departmentIds: [] }],
        ['manager de A sobre empleado de B', mgrA],
      ]) {
        let err;
        try { await people().createAssignment(ids.empB, { valid_from: '2031-01-01' }, ids.mgrA, scope); } catch (e) { err = e; }
        expect([label, err && err.status, err && err.code]).toEqual([label, 403, 'OUT_OF_SCOPE']);
        expect(await rows(ids.empB)).toEqual(before);
      }

      // Controles positivos.
      const r1 = await people().createAssignment(ids.empB, { valid_from: '2031-01-01' }, ids.admin, global);
      expect(r1.closed_previous).toBe(before[0].id);
      expect(await rows(ids.empB)).toHaveLength(2);
      const r2 = await people().createAssignment(ids.empA, { valid_from: '2031-01-01' }, ids.mgrA, mgrA);
      expect(r2.id).toBeTruthy();
      expect(await rows(ids.empA)).toHaveLength(1);
    });
  });
  describe('companyFilter con includeNull (base real)', () => {
    test('alcance inválido o vacío no habilita las filas sin empresa; alcances autorizados sí', async () => {
      const [cn] = await conn.query('INSERT INTO cost_centers (company_id, code, name, active) VALUES (NULL, ?, ?, 1)', [`${ids.uniq}CCN`, 'CC sin empresa']);
      try {
        const run = async (scope) => {
          const f = orgScope.companyFilter(scope, 'company_id', { includeNull: true });
          const [rows] = await conn.query(`SELECT id FROM cost_centers WHERE id IN (?, ?, ?) ${f.clause}`, [ids.ccA, ids.ccB, cn.insertId, ...f.params]);
          return rows.map((r) => r.id).sort((a, b) => a - b);
        };
        for (const bad of [undefined, null, { unrestricted: false, companyIds: ['1'] }, { unrestricted: true },
          await orgScope.getOrgScope(who(ids.mgrGhost, 'manager'))]) {
          expect(await run(bad)).toEqual([]);
        }
        await conn.query('UPDATE branches SET active = 0 WHERE id = ?', [ids.branchA]);
        try {
          expect(await run(await orgScope.getOrgScope(who(ids.mgrA, 'manager', ids.empB)))).toEqual([]);
        } finally {
          await conn.query('UPDATE branches SET active = 1 WHERE id = ?', [ids.branchA]);
        }
        // Controles positivos.
        expect(await run(await orgScope.getOrgScope(who(ids.mgrA, 'manager', ids.empB)))).toEqual([ids.ccA, cn.insertId].sort((a, b) => a - b));
        expect(await run(await orgScope.getOrgScope(who(ids.admin, 'admin')))).toEqual([ids.ccA, ids.ccB, cn.insertId].sort((a, b) => a - b));
      } finally {
        await conn.query('DELETE FROM cost_centers WHERE id = ?', [cn.insertId]);
      }
    });
  });
});
