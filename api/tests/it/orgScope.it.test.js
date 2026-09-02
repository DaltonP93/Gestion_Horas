'use strict';

/**
 * orgScope.it.test.js — INTEGRACIÓN (MySQL real): acceso cruzado denegado.
 *
 * Verifica sobre datos reales que un rol con alcance sólo ve su empresa/centro
 * de costo y que un writer rechaza referencias fuera de alcance (403).
 */
const { describeIT, makeConn, closeAppDb } = require('./helper');

describeIT('orgScope (integración) — alcance por empresa', () => {
  let conn;
  let orgScope;
  let governance;
  const ids = {};

  beforeAll(async () => {
    conn = await makeConn();
    orgScope = require('../../src/services/orgScope');
    governance = require('../../src/services/governance');

    const uniq = `IT${Date.now() % 100000}`;
    const [ca] = await conn.query('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}A`, 'ITScope A']);
    ids.companyA = ca.insertId;
    const [cb] = await conn.query('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}B`, 'ITScope B']);
    ids.companyB = cb.insertId;

    const [bra] = await conn.query('INSERT INTO branches (code, company_id, name, active) VALUES (?, ?, ?, 1)', [`${uniq}BRA`, ids.companyA, 'ITBranch A']);
    ids.branchA = bra.insertId;

    const [da] = await conn.query('INSERT INTO departments (name, code) VALUES (?, ?)', ['ITScope Dept A', `${uniq}DA`]);
    ids.deptA = da.insertId;

    const [ea] = await conn.query(
      'INSERT INTO employees (code, employee_number, first_name, last_name, email, branch_id, department_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [`${uniq}E`, `${uniq}N`, 'Emp', 'Scope', `${uniq.toLowerCase()}@it.local`, ids.branchA, ids.deptA, 'active'],
    );
    ids.empA = ea.insertId;

    const [cca] = await conn.query('INSERT INTO cost_centers (company_id, code, name, active) VALUES (?, ?, ?, 1)', [ids.companyA, `${uniq}CCA`, 'CC A']);
    ids.ccA = cca.insertId;
    const [ccb] = await conn.query('INSERT INTO cost_centers (company_id, code, name, active) VALUES (?, ?, ?, 1)', [ids.companyB, `${uniq}CCB`, 'CC B']);
    ids.ccB = ccb.insertId;
  });

  afterAll(async () => {
    if (conn) {
      await conn.query('DELETE FROM cost_centers WHERE id IN (?, ?)', [ids.ccA, ids.ccB]);
      await conn.query('DELETE FROM employees WHERE id = ?', [ids.empA]);
      await conn.query('DELETE FROM departments WHERE id = ?', [ids.deptA]);
      await conn.query('DELETE FROM branches WHERE id = ?', [ids.branchA]);
      await conn.query('DELETE FROM companies WHERE id IN (?, ?)', [ids.companyA, ids.companyB]);
      await conn.end();
    }
    await closeAppDb();
  });

  test('manager deriva alcance a su empresa/sucursal/departamento', async () => {
    const scope = await orgScope.getOrgScope({ role: 'manager', employee_id: ids.empA });
    expect(scope.unrestricted).toBe(false);
    expect(scope.companyIds).toEqual([ids.companyA]);
    expect(scope.branchIds).toEqual([ids.branchA]);
    expect(scope.departmentIds).toEqual(expect.arrayContaining([ids.deptA]));
  });

  test('listCompanies filtra: ve su empresa, NO la ajena', async () => {
    const scope = await orgScope.getOrgScope({ role: 'manager', employee_id: ids.empA });
    const rows = await governance.listCompanies(scope);
    const seen = rows.map((r) => r.id);
    expect(seen).toContain(ids.companyA);
    expect(seen).not.toContain(ids.companyB);
  });

  test('listCostCenters filtra por empresa del alcance', async () => {
    const scope = await orgScope.getOrgScope({ role: 'manager', employee_id: ids.empA });
    const seen = (await governance.listCostCenters(scope)).map((r) => r.id);
    expect(seen).toContain(ids.ccA);
    expect(seen).not.toContain(ids.ccB);
  });

  test('writer rechaza referencia a empresa fuera de alcance (403)', async () => {
    const scope = await orgScope.getOrgScope({ role: 'manager', employee_id: ids.empA });
    expect(() => orgScope.assertCompanyInScope(scope, ids.companyB)).toThrow(/alcance/i);
    expect(() => orgScope.assertCompanyInScope(scope, ids.companyA)).not.toThrow();
  });

  test('rol global (admin) ve ambas empresas', async () => {
    const scope = await orgScope.getOrgScope({ role: 'admin', employee_id: ids.empA });
    const seen = (await governance.listCompanies(scope)).map((r) => r.id);
    expect(seen).toEqual(expect.arrayContaining([ids.companyA, ids.companyB]));
  });
});
