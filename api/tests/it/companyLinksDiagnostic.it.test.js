'use strict';

/**
 * companyLinksDiagnostic.it.test.js — INTEGRACIÓN (MySQL real): el
 * diagnóstico de vínculos sede ↔ empresa ↔ centro de costo detecta cada caso
 * y NO escribe.
 *
 * Se ejecuta el CLI real (`node scripts/diagnose-company-links.js --json`)
 * contra la base aislada de pruebas. Datos sintéticos:
 *   - sede A con empresa A; sede N SIN empresa;
 *   - centros de costo de A, de B y sin empresa;
 *   - depto OK (sede A + centro A), MISMATCH (sede A + centro B),
 *     indeterminados (sede N + centro A; sede A + centro sin empresa);
 *   - empleado en sede N, empleado en sede A y empleado con sede inexistente.
 * Verifica también que durante la corrida el servidor no ejecutó
 * INSERT/UPDATE/DELETE (contadores globales Com_*) y que nada cambió.
 */
const path = require('path');
const { execFile } = require('child_process');
const { describeIT, makeConn, cfg } = require('./helper');

const WRITE_COUNTERS = ['Com_insert', 'Com_insert_select', 'Com_update', 'Com_update_multi',
  'Com_delete', 'Com_delete_multi', 'Com_replace', 'Com_replace_select'];

describeIT('diagnose-company-links (integración, solo lectura)', () => {
  let conn;
  const ids = {};

  const runCli = () => new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'diagnose-company-links.js'), '--json', '--limit', '10000'], {
      env: {
        PATH: process.env.PATH,
        DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_USER: cfg.user, DB_PASSWORD: cfg.password, DB_NAME: cfg.database,
      },
      cwd: path.join(__dirname, '..', '..'),
    }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve({ stdout, stderr })));
  });
  async function writeCounter() {
    const [rows] = await conn.query('SHOW GLOBAL STATUS WHERE Variable_name IN (?)', [WRITE_COUNTERS]);
    return rows.reduce((acc, r) => acc + Number(r.Value), 0);
  }
  const fingerprint = async () => JSON.stringify(await Promise.all([
    conn.query('SELECT id, company_id FROM branches ORDER BY id'),
    conn.query('SELECT id, branch_id, cost_center_id FROM departments ORDER BY id'),
    conn.query('SELECT id, company_id FROM cost_centers ORDER BY id'),
    conn.query('SELECT id, branch_id FROM employees ORDER BY id'),
  ]).then((rs) => rs.map((r) => r[0])));

  beforeAll(async () => {
    conn = await makeConn();
    const u = `DL${Date.now() % 100000}`;
    ids.u = u;
    const ins = async (sql, params) => (await conn.query(sql, params))[0].insertId;
    ids.coA = await ins('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${u}A`, 'ITDiag A']);
    ids.coB = await ins('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${u}B`, 'ITDiag B']);
    ids.brA = await ins('INSERT INTO branches (code, company_id, name, active) VALUES (?, ?, ?, 1)', [`${u}BA`, ids.coA, 'ITDiag sede A']);
    ids.brN = await ins('INSERT INTO branches (code, company_id, name, active) VALUES (?, NULL, ?, 1)', [`${u}BN`, 'ITDiag sede sin empresa']);
    ids.ccA = await ins('INSERT INTO cost_centers (company_id, code, name, active) VALUES (?, ?, ?, 1)', [ids.coA, `${u}CA`, 'CC A']);
    ids.ccB = await ins('INSERT INTO cost_centers (company_id, code, name, active) VALUES (?, ?, ?, 1)', [ids.coB, `${u}CB`, 'CC B']);
    ids.ccN = await ins('INSERT INTO cost_centers (company_id, code, name, active) VALUES (NULL, ?, ?, 1)', [`${u}CN`, 'CC sin empresa']);
    const dept = (code, br, cc) => ins('INSERT INTO departments (name, code, branch_id, cost_center_id, active) VALUES (?, ?, ?, ?, 1)', [`ITDiag ${code}`, `${u}${code}`, br, cc]);
    ids.dOk = await dept('DOK', ids.brA, ids.ccA);
    ids.dMis = await dept('DMIS', ids.brA, ids.ccB);
    ids.dIndN = await dept('DIN', ids.brN, ids.ccA);
    ids.dIndC = await dept('DIC', ids.brA, ids.ccN);
    const [[mx]] = await conn.query('SELECT COALESCE(MAX(id), 0) + 1000 AS id FROM branches');
    ids.ghost = Number(mx.id);
    const emp = (tag, br, dept_) => ins(
      'INSERT INTO employees (code, employee_number, first_name, last_name, email, branch_id, department_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [`${u}${tag}`, `${u}N${tag}`, 'Emp', `Diag${tag}`, `${u.toLowerCase()}${tag.toLowerCase()}@it.local`, br, dept_, 'active'],
    );
    ids.eN = await emp('EN', ids.brN, ids.dIndN);
    ids.eA = await emp('EA', ids.brA, ids.dOk);
    ids.eG = await emp('EG', ids.ghost, ids.dOk);
  });

  afterAll(async () => {
    if (conn) {
      await conn.query('DELETE FROM employees WHERE id IN (?)', [[ids.eN, ids.eA, ids.eG].filter(Boolean)]);
      await conn.query('DELETE FROM departments WHERE id IN (?)', [[ids.dOk, ids.dMis, ids.dIndN, ids.dIndC].filter(Boolean)]);
      await conn.query('DELETE FROM cost_centers WHERE id IN (?)', [[ids.ccA, ids.ccB, ids.ccN].filter(Boolean)]);
      await conn.query('DELETE FROM branches WHERE id IN (?)', [[ids.brA, ids.brN].filter(Boolean)]);
      await conn.query('DELETE FROM companies WHERE id IN (?)', [[ids.coA, ids.coB].filter(Boolean)]);
      await conn.end();
    }
  });

  let result;
  let writes;
  let unchanged;
  let stdout;
  beforeAll(async () => {
    const before = await fingerprint();
    const w0 = await writeCounter();
    ({ stdout } = await runCli());
    writes = (await writeCounter()) - w0;
    unchanged = (await fingerprint()) === before;
    result = JSON.parse(stdout);
  });

  test('esquema FASE F detectado como aplicado', () => {
    expect(result.schema).toEqual({ applied: true, missing: [] });
  });

  test('1. sede sin empresa detectada (con su empleado); la sede con empresa no', () => {
    const rows = result.findings.branches_without_company.rows;
    expect(rows.find((r) => r.id === ids.brN)).toMatchObject({ code: `${ids.u}BN`, employees: 1 });
    expect(rows.map((r) => r.id)).not.toContain(ids.brA);
  });

  test('2. departamento con centro de costo de otra empresa: sólo el MISMATCH', () => {
    const mis = result.findings.departments_cost_center_company_mismatch.rows;
    expect(mis.find((r) => r.id === ids.dMis)).toMatchObject({
      branch_id: ids.brA, branch_company_id: ids.coA, cost_center_id: ids.ccB, cost_center_company_id: ids.coB,
    });
    expect(mis.map((r) => r.id)).not.toContain(ids.dOk);
    expect(mis.map((r) => r.id)).not.toContain(ids.dIndN);
    expect(mis.map((r) => r.id)).not.toContain(ids.dIndC);
  });

  test('2b. indeterminados listados aparte, sin clasificarlos como mismatch', () => {
    const ind = result.findings.departments_cost_center_company_indeterminate.rows.map((r) => r.id);
    expect(ind).toEqual(expect.arrayContaining([ids.dIndN, ids.dIndC]));
    expect(ind).not.toContain(ids.dOk);
    expect(ind).not.toContain(ids.dMis);
  });

  test('3. empleados en sede sin empresa y con sede inexistente', () => {
    const e = result.findings.employees_in_branch_without_company;
    expect(e.sample.map((r) => r.id)).toContain(ids.eN);
    expect(e.sample.map((r) => r.id)).not.toContain(ids.eA);
    expect(e.by_branch_status).toEqual(expect.arrayContaining([{ branch_id: ids.brN, status: 'active', n: 1 }]));
    const g = result.findings.employees_with_missing_branch;
    expect(g.sample).toEqual(expect.arrayContaining([{ id: ids.eG, branch_id: ids.ghost, status: 'active' }]));
  });

  test('sin datos personales en la salida', () => {
    expect(stdout).not.toMatch(/Diag(EN|EA|EG)|@it\.local|ITDiag A|ITDiag B/);
  });

  test('solo lectura: cero INSERT/UPDATE/DELETE en el servidor y datos intactos', () => {
    expect(writes).toBe(0);
    expect(unchanged).toBe(true);
  });

  test('la sesión READ ONLY rechaza una escritura (la garantía no depende del código)', async () => {
    const c = await makeConn();
    try {
      await c.query('SET SESSION TRANSACTION READ ONLY');
      await c.query('START TRANSACTION READ ONLY');
      await expect(c.query('UPDATE branches SET code = code WHERE id = ?', [ids.brN])).rejects.toMatchObject({ code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' });
      await c.query('ROLLBACK');
    } finally { await c.end(); }
  });
});
