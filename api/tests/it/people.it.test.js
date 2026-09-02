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
    await closeAppDb();
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
