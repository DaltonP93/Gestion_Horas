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
 *   - Sin sede, cuenta inactiva o rol sin alcance → conjuntos vacíos (fail-closed).
 *   - Roles globales (admin, …) → sin restricción.
 *
 * Datos sintéticos: dos empresas con una sede cada una; los departamentos se
 * crean con su sede explícita (la columna tiene DEFAULT 1 desde la 015).
 */
const { describeIT, makeConn, closeAppDb } = require('./helper');

describeIT('orgScope (integración) — alcance por empresa', () => {
  let conn;
  let orgScope;
  let governance;
  const ids = {};

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
  });

  afterAll(async () => {
    if (conn) {
      const userIds = [ids.mgrA, ids.mgrNoBranch, ids.mgrInactive, ids.coordA, ids.employeeA, ids.admin].filter(Boolean);
      if (userIds.length) await conn.query('DELETE FROM users WHERE id IN (?)', [userIds]);
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
});
