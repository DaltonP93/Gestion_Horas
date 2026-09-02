'use strict';

/**
 * people.it.test.js — INTEGRACIÓN (MySQL real): atomicidad y concurrencia de
 * conversión de candidatos y de asignaciones con vigencia.
 */
const { describeIT, makeConn, closeAppDb } = require('./helper');

describeIT('personas (integración) — atomicidad y concurrencia', () => {
  let conn;
  let people;
  const ids = {};

  beforeAll(async () => {
    conn = await makeConn();
    people = require('../../src/services/people');
    const uniq = `ITP${Date.now() % 100000}`;

    const [emp] = await conn.query(
      'INSERT INTO employees (code, employee_number, first_name, last_name, email, status) VALUES (?, ?, ?, ?, ?, ?)',
      [`${uniq}E`, `${uniq}N`, 'Emp', 'IT', `${uniq.toLowerCase()}@it.local`, 'active'],
    );
    ids.emp = emp.insertId;
    const [emp2] = await conn.query(
      'INSERT INTO employees (code, employee_number, first_name, last_name, email, status) VALUES (?, ?, ?, ?, ?, ?)',
      [`${uniq}E2`, `${uniq}N2`, 'Emp2', 'IT', `${uniq.toLowerCase()}2@it.local`, 'active'],
    );
    ids.emp2 = emp2.insertId;
    ids.uniq = uniq;
  });

  afterAll(async () => {
    if (conn) {
      await conn.query('DELETE FROM employee_assignments WHERE employee_id IN (?, ?)', [ids.emp, ids.emp2]);
      await conn.query('DELETE FROM candidates WHERE first_name = ?', ['CandIT']);
      await conn.query('DELETE FROM employees WHERE id IN (?, ?)', [ids.emp, ids.emp2]);
      await conn.end();
    }
    // El pool de la app (sequelize) lo cierra el ÚLTIMO describe del archivo,
    // para no dejar sin conexión a los bloques posteriores.
  });

  test('doble conversión concurrente → exactamente una gana, la otra 409', async () => {
    const [c] = await conn.query(
      "INSERT INTO candidates (first_name, last_name, status) VALUES ('CandIT', 'X', 'offer')",
    );
    const candId = c.insertId;

    const results = await Promise.allSettled([
      people.convertCandidate(candId, ids.emp),
      people.convertCandidate(candId, ids.emp2),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rej = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(rej).toHaveLength(1);
    expect(rej[0].reason.status).toBe(409);

    // La fila quedó enlazada a UNA sola de las dos, coherente con la ganadora.
    const [[row]] = await conn.query('SELECT status, converted_employee_id FROM candidates WHERE id = ?', [candId]);
    expect(row.status).toBe('hired');
    expect([ids.emp, ids.emp2]).toContain(row.converted_employee_id);
    expect(row.converted_employee_id).toBe(ok[0].value.converted_employee_id);
  });

  test('doble creación de asignación concurrente → NUNCA dos vigencias abiertas', async () => {
    const results = await Promise.allSettled([
      people.createAssignment(ids.emp2, { valid_from: '2026-03-01' }, 1),
      people.createAssignment(ids.emp2, { valid_from: '2026-04-01' }, 1),
    ]);
    // Al menos una tuvo éxito; ninguna dejó dos vigencias abiertas.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    const [[{ n }]] = await conn.query(
      'SELECT COUNT(*) AS n FROM employee_assignments WHERE employee_id = ? AND valid_to IS NULL',
      [ids.emp2],
    );
    expect(Number(n)).toBe(1);
  });

  test('inserción fuera de orden rechazada (vigencia abierta posterior)', async () => {
    // Ya hay una vigencia abierta 2026-04-01 (del test anterior). Una nueva con
    // fecha anterior debe rechazarse.
    await expect(
      people.createAssignment(ids.emp2, { valid_from: '2026-02-01' }, 1),
    ).rejects.toMatchObject({ status: 409, code: 'ASSIGNMENT_OUT_OF_ORDER' });
  });
});

// ── P1-A: aislamiento por alcance organizacional (cross-scope) ───────────────
describeIT('personas (integración) — aislamiento por alcance', () => {
  let conn;
  let people;
  const s = {};

  beforeAll(async () => {
    conn = await makeConn();
    people = require('../../src/services/people');
    const uniq = `ITS${Date.now() % 100000}`;
    s.uniq = uniq;

    const [coA] = await conn.query('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}CA`, 'A']);
    const [coB] = await conn.query('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}CB`, 'B']);
    s.coA = coA.insertId; s.coB = coB.insertId;
    const [brA] = await conn.query('INSERT INTO branches (name, code, company_id) VALUES (?, ?, ?)', [`${uniq}BA`, `${uniq}BA`, s.coA]);
    const [brA2] = await conn.query('INSERT INTO branches (name, code, company_id) VALUES (?, ?, ?)', [`${uniq}BA2`, `${uniq}BA2`, s.coA]); // MISMA empresa A, otra sucursal
    const [brB] = await conn.query('INSERT INTO branches (name, code, company_id) VALUES (?, ?, ?)', [`${uniq}BB`, `${uniq}BB`, s.coB]);
    s.brA = brA.insertId; s.brA2 = brA2.insertId; s.brB = brB.insertId;
    // Centros de costo por empresa y un departamento ligado a un CC de la empresa B.
    const [ccA] = await conn.query('INSERT INTO cost_centers (code, name, company_id, active) VALUES (?, ?, ?, 1)', [`${uniq}CCA`, 'CCA', s.coA]);
    const [ccB] = await conn.query('INSERT INTO cost_centers (code, name, company_id, active) VALUES (?, ?, ?, 1)', [`${uniq}CCB`, 'CCB', s.coB]);
    s.ccA = ccA.insertId; s.ccB = ccB.insertId;
    const [dpA] = await conn.query('INSERT INTO departments (name, cost_center_id) VALUES (?, ?)', [`${uniq}DA`, s.ccA]);   // depto → empresa A
    const [dpB] = await conn.query('INSERT INTO departments (name) VALUES (?)', [`${uniq}DB`]);
    const [dpCCB] = await conn.query('INSERT INTO departments (name, cost_center_id) VALUES (?, ?)', [`${uniq}DCCB`, s.ccB]); // depto → empresa B
    s.dpA = dpA.insertId; s.dpB = dpB.insertId; s.dpCCB = dpCCB.insertId;

    const [eA] = await conn.query(
      'INSERT INTO employees (code, employee_number, first_name, last_name, status, branch_id, department_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [`${uniq}EA`, `${uniq}NA`, 'EmpA', 'IT', 'active', s.brA, s.dpA],
    );
    const [eB] = await conn.query(
      'INSERT INTO employees (code, employee_number, first_name, last_name, status, branch_id, department_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [`${uniq}EB`, `${uniq}NB`, 'EmpB', 'IT', 'active', s.brB, s.dpB],
    );
    s.empA = eA.insertId; s.empB = eB.insertId;

    const [cA] = await conn.query('INSERT INTO candidates (first_name, last_name, status, company_id, branch_id) VALUES (?, ?, ?, ?, ?)', ['ScopeIT', 'A', 'offer', s.coA, s.brA]);
    // MISMA empresa A pero sucursal A2 (fuera del alcance del actor de brA), con PII distintiva.
    const [cA2] = await conn.query('INSERT INTO candidates (first_name, last_name, email, phone, status, company_id, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?)', ['ScopeIT', 'A2', 'leak_a2@it.local', '0999111222', 'offer', s.coA, s.brA2]);
    const [cB] = await conn.query('INSERT INTO candidates (first_name, last_name, email, phone, status, company_id, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?)', ['ScopeIT', 'B', 'leak_b@it.local', '0999333444', 'offer', s.coB, s.brB]);
    const [cN] = await conn.query('INSERT INTO candidates (first_name, last_name, status) VALUES (?, ?, ?)', ['ScopeIT', 'NULLscope', 'offer']);
    s.candA = cA.insertId; s.candA2 = cA2.insertId; s.candB = cB.insertId; s.candN = cN.insertId;

    // Alcance del actor: sólo empresa A / sucursal A / depto A.
    s.scope = { unrestricted: false, companyIds: [s.coA], branchIds: [s.brA], departmentIds: [s.dpA] };
  });

  afterAll(async () => {
    if (conn) {
      // Orden respetando FKs RESTRICT (assignments → employees) y SET NULL.
      await conn.query('DELETE FROM employee_assignments WHERE employee_id IN (?, ?)', [s.empA, s.empB]);
      await conn.query('DELETE FROM candidates WHERE first_name = ?', ['ScopeIT']);
      await conn.query('DELETE FROM employees WHERE id IN (?, ?)', [s.empA, s.empB]);
      await conn.query('DELETE FROM departments WHERE id IN (?, ?, ?)', [s.dpA, s.dpB, s.dpCCB]);
      await conn.query('DELETE FROM cost_centers WHERE id IN (?, ?)', [s.ccA, s.ccB]);
      await conn.query('DELETE FROM branches WHERE id IN (?, ?, ?)', [s.brA, s.brA2, s.brB]);
      await conn.query('DELETE FROM companies WHERE id IN (?, ?)', [s.coA, s.coB]);
      await conn.end();
    }
    await closeAppDb();
  });

  test('listCandidates: rol con alcance ve sólo su SUCURSAL (no otra sucursal de la misma empresa)', async () => {
    const rows = await people.listCandidates({}, s.scope);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(s.candA);
    expect(ids).not.toContain(s.candA2);  // MISMA empresa A pero sucursal B → NO (anti-fuga)
    expect(ids).not.toContain(s.candB);   // otra empresa/sucursal
    expect(ids).not.toContain(s.candN);   // sin alcance → sólo global
    // La PII de candidatos fuera de alcance NO aparece en la lista del actor.
    const serial = JSON.stringify(rows);
    expect(serial).not.toMatch(/leak_a2@it\.local|0999111222/); // candA2 (sucursal B, empresa A)
    expect(serial).not.toMatch(/leak_b@it\.local|0999333444/);  // candB (empresa B)
  });

  test('candidato de MISMA empresa, otra sucursal → GET/convert 404 (anti-fuga PII)', async () => {
    expect(await people.getCandidate(s.candA2)).toBeTruthy(); // existe en la base…
    // …pero el actor de la sucursal A no puede verlo/convertirlo.
    const orgScope = require('../../src/services/orgScope');
    const row = await people.getCandidate(s.candA2);
    expect(orgScope.canSeeCandidateRefs(s.scope, row)).toBe(false);
    await expect(people.convertCandidate(s.candA2, s.empA, s.scope))
      .rejects.toMatchObject({ status: 404, code: 'CANDIDATE_NOT_FOUND' });
  });

  test('actor con alcance NO puede crear candidato sin alcance → 403', async () => {
    await expect(people.validateCandidateRefs(s.scope, { company_id: null, branch_id: null }))
      .rejects.toMatchObject({ status: 403, code: 'OUT_OF_SCOPE' });
  });

  test('listCandidates: rol global ve todos (incluido sin alcance)', async () => {
    const rows = await people.listCandidates({ status: 'offer' }, { unrestricted: true });
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([s.candA, s.candB, s.candN]));
  });

  test('convertCandidate: candidato de otra empresa → 404 (no filtra existencia)', async () => {
    await expect(people.convertCandidate(s.candB, s.empA, s.scope))
      .rejects.toMatchObject({ status: 404, code: 'CANDIDATE_NOT_FOUND' });
  });

  test('convertCandidate: empleado destino fuera de alcance → 403', async () => {
    await expect(people.convertCandidate(s.candA, s.empB, s.scope))
      .rejects.toMatchObject({ status: 403, code: 'OUT_OF_SCOPE' });
  });

  test('convertCandidate: candidato y empleado en alcance → convierte', async () => {
    const r = await people.convertCandidate(s.candA, s.empA, s.scope);
    expect(r).toMatchObject({ candidate_id: s.candA, converted_employee_id: s.empA });
  });

  // ── P1-B: coherencia mutua de referencias (createAssignment, en transacción) ──
  test('coherencia: sucursal empresa A + centro de costo empresa B → 400 INCOHERENT_SCOPE (sin crear fila)', async () => {
    const before = (await conn.query('SELECT COUNT(*) AS n FROM employee_assignments WHERE employee_id = ?', [s.empA]))[0][0].n;
    await expect(
      people.createAssignment(s.empA, { valid_from: '2026-02-01', branch_id: s.brA, cost_center_id: s.ccB }, 1, { unrestricted: true }),
    ).rejects.toMatchObject({ status: 400, code: 'INCOHERENT_SCOPE' });
    const after = (await conn.query('SELECT COUNT(*) AS n FROM employee_assignments WHERE employee_id = ?', [s.empA]))[0][0].n;
    expect(Number(after)).toBe(Number(before)); // rollback: no se creó nada
  });

  test('coherencia: departamento (vía CC) de empresa B + sucursal empresa A → 400 INCOHERENT_SCOPE', async () => {
    await expect(
      people.createAssignment(s.empA, { valid_from: '2026-02-01', branch_id: s.brA, department_id: s.dpCCB }, 1, { unrestricted: true }),
    ).rejects.toMatchObject({ status: 400, code: 'INCOHERENT_SCOPE' });
  });

  test('coherencia: todas de la misma empresa A → crea (201-equivalente)', async () => {
    const r = await people.createAssignment(
      s.empA, { valid_from: '2026-03-01', branch_id: s.brA, cost_center_id: s.ccA, department_id: s.dpA }, 1, { unrestricted: true },
    );
    expect(r.id).toBeGreaterThan(0);
  });

  test('scoped: no puede usar una sucursal fuera de su alcance → 403 OUT_OF_SCOPE', async () => {
    await expect(
      people.createAssignment(s.empA, { valid_from: '2026-04-01', branch_id: s.brB }, 1, s.scope),
    ).rejects.toMatchObject({ status: 403, code: 'OUT_OF_SCOPE' });
  });
});
