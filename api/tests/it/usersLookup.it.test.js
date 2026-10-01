'use strict';

/**
 * usersLookup.it.test.js — INTEGRACIÓN (MySQL real + HTTP real + authenticate
 * real): alcance de GET /api/users/lookup.
 *
 * Datos SINTÉTICOS: dos empresas, sedes A y B activas, una sede inactiva y
 * un id de sede inexistente. Actores:
 *   - globales: super_admin, admin, gth, hr (sin sede);
 *   - por sede A: manager, coordinator, gestor, supervisor;
 *   - manager sin sede, con sede inactiva y con sede inexistente;
 *   - employee de A (no usa el selector → 403).
 * Candidatos: activos e inactivos de A, de B, sin sede, de la sede inactiva,
 * y dos cuentas "cruzadas": sede A con empleado de B y sede B con empleado
 * de A (prevalece users.branch_id). Nombres con %, _ y \ para la búsqueda.
 */
const { describeIT, makeConn, closeAppDb } = require('./helper');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'it-users-lookup-secret-0123456789abcdef';

const LOOKUP_FIELDS = ['employee_id', 'full_name', 'id', 'role', 'username'];

describeIT('GET /api/users/lookup (integración) — alcance por sede de la cuenta', () => {
  let conn;
  let server;
  let base;
  const ids = {};
  const jwt = require('jsonwebtoken');
  const token = (userId, role) => jwt.sign({ id: userId, role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
  const get = (url, userId, role) => fetch(base + url, { headers: { Authorization: `Bearer ${token(userId, role)}` } });
  const evidence = [];

  const CANDIDATES = ['cA1', 'cA2', 'cAInactive', 'cB', 'cNoBranch', 'cOff', 'cAwithEmpB', 'cBwithEmpA',
    'wPct', 'wPctDecoy', 'wUnd', 'wUndDecoy', 'wBs', 'wBsDecoy'];
  const ACTORS = ['superAdmin', 'admin', 'gth', 'hr', 'mgrA', 'coordA', 'gestorA', 'supA',
    'mgrNoBranch', 'mgrOff', 'mgrGhost', 'empA'];
  const nameOf = (id) => [...CANDIDATES, ...ACTORS].find((k) => ids[k] === id);
  /** Fixtures de este test presentes en la respuesta (por nombre, ordenados). */
  const fixtureNames = (rows) => rows.map((r) => nameOf(r.id)).filter(Boolean).sort();

  async function lookup(label, url, uid, role) {
    const r = await get(url, uid, role);
    const body = await r.json().catch(() => null);
    const names = Array.isArray(body) ? fixtureNames(body) : null;
    evidence.push({ request: `${label}: GET ${url.replace(ids.uniq, '<uniq>')}`, status: r.status, fixtures: names });
    return { status: r.status, body, names };
  }

  beforeAll(async () => {
    conn = await makeConn();
    const uniq = `ULK${Date.now() % 100000}`;
    ids.uniq = uniq;
    const ins = async (sql, params) => (await conn.query(sql, params))[0].insertId;
    ids.coA = await ins('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}A`, 'ITLookup A']);
    ids.coB = await ins('INSERT INTO companies (code, legal_name, active) VALUES (?, ?, 1)', [`${uniq}B`, 'ITLookup B']);
    ids.brA = await ins('INSERT INTO branches (code, company_id, name, active) VALUES (?, ?, ?, 1)', [`${uniq}BA`, ids.coA, 'ITLookup sede A']);
    ids.brB = await ins('INSERT INTO branches (code, company_id, name, active) VALUES (?, ?, ?, 1)', [`${uniq}BB`, ids.coB, 'ITLookup sede B']);
    ids.brOff = await ins('INSERT INTO branches (code, company_id, name, active) VALUES (?, ?, ?, 0)', [`${uniq}BO`, ids.coA, 'ITLookup sede inactiva']);
    ids.brGhost = 999999000 + (Date.now() % 1000);   // id de sede que no existe
    ids.dA = await ins('INSERT INTO departments (name, code, branch_id, active) VALUES (?, ?, ?, 1)', ['ITLookup DA', `${uniq}DA`, ids.brA]);
    ids.dB = await ins('INSERT INTO departments (name, code, branch_id, active) VALUES (?, ?, ?, 1)', ['ITLookup DB', `${uniq}DB`, ids.brB]);
    const emp = (tag, br, d) => ins(
      'INSERT INTO employees (code, employee_number, first_name, last_name, email, branch_id, department_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [`${uniq}${tag}`, `${uniq}N${tag}`, 'Emp', `Lk${tag}`, `${uniq.toLowerCase()}lk${tag.toLowerCase()}@it.local`, br, d, 'active'],
    );
    ids.eA = await emp('A', ids.brA, ids.dA);
    ids.eA2 = await emp('A2', ids.brA, ids.dA);
    ids.eB = await emp('B', ids.brB, ids.dB);
    let n = 0;
    const user = async (key, role, { branchId = null, employeeId = null, active = 1, name = null } = {}) => {
      n += 1;
      ids[key] = await ins(
        'INSERT INTO users (username, email, password_hash, full_name, role, employee_id, branch_id, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [`${uniq}u${n}`, `${uniq.toLowerCase()}u${n}@it.local`, 'it-no-login', name || `${uniq} ${key}`, role, employeeId, branchId, active],
      );
    };
    // Actores
    await user('superAdmin', 'super_admin');
    await user('admin', 'admin');
    await user('gth', 'gth');
    await user('hr', 'hr');
    await user('mgrA', 'manager', { branchId: ids.brA });
    await user('coordA', 'coordinator', { branchId: ids.brA });
    await user('gestorA', 'gestor', { branchId: ids.brA });
    await user('supA', 'supervisor', { branchId: ids.brA });
    await user('mgrNoBranch', 'manager');
    await user('mgrOff', 'manager', { branchId: ids.brOff });
    await user('mgrGhost', 'manager', { branchId: ids.brGhost });
    await user('empA', 'employee', { branchId: ids.brA, employeeId: ids.eA2 });
    // Candidatos
    await user('cA1', 'employee', { branchId: ids.brA, employeeId: ids.eA });
    await user('cA2', 'coordinator', { branchId: ids.brA });
    await user('cAInactive', 'manager', { branchId: ids.brA, active: 0 });
    await user('cB', 'manager', { branchId: ids.brB, employeeId: ids.eB });
    await user('cNoBranch', 'hr');
    await user('cOff', 'manager', { branchId: ids.brOff });
    await user('cAwithEmpB', 'employee', { branchId: ids.brA, employeeId: ids.eB });
    await user('cBwithEmpA', 'employee', { branchId: ids.brB, employeeId: ids.eA });
    // Búsqueda con comodines: el señuelo coincidiría si %, _ o \ no se escaparan.
    await user('wPct', 'employee', { branchId: ids.brA, name: `${uniq} 50%off` });
    await user('wPctDecoy', 'employee', { branchId: ids.brA, name: `${uniq} 50Xoff` });
    await user('wUnd', 'employee', { branchId: ids.brA, name: `${uniq} a_b` });
    await user('wUndDecoy', 'employee', { branchId: ids.brA, name: `${uniq} axb` });
    await user('wBs', 'employee', { branchId: ids.brA, name: `${uniq} c\\d` });
    await user('wBsDecoy', 'employee', { branchId: ids.brA, name: `${uniq} cd` });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/users', require('../../src/routes/users'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Error interno' }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (process.env.USERS_LOOKUP_EVIDENCE_OUT) {
      require('fs').writeFileSync(process.env.USERS_LOOKUP_EVIDENCE_OUT, JSON.stringify(evidence, null, 1));
    }
    if (server) await new Promise((r) => server.close(r));
    if (conn) {
      const userIds = [...CANDIDATES, ...ACTORS].map((k) => ids[k]).filter(Boolean);
      if (userIds.length) {
        await conn.query('DELETE FROM audit_events WHERE user_id IN (?)', [userIds]);
        await conn.query('DELETE FROM users WHERE id IN (?)', [userIds]);
      }
      await conn.query('DELETE FROM employees WHERE id IN (?)', [[ids.eA, ids.eA2, ids.eB].filter(Boolean)]);
      await conn.query('DELETE FROM departments WHERE id IN (?, ?)', [ids.dA, ids.dB]);
      await conn.query('DELETE FROM branches WHERE id IN (?, ?, ?)', [ids.brA, ids.brB, ids.brOff]);
      await conn.query('DELETE FROM companies WHERE id IN (?, ?)', [ids.coA, ids.coB]);
      await conn.end();
    }
    await closeAppDb();
  });

  /** Todos los activos del test (lo que ve un rol global). */
  const ALL_ACTIVE = () => [...CANDIDATES, ...ACTORS].filter((k) => k !== 'cAInactive').sort();
  /** Lo que debe ver un rol de la sede A: cuentas ACTIVAS con users.branch_id = A. */
  const BRANCH_A = ['cA1', 'cA2', 'cAwithEmpB', 'coordA', 'empA', 'gestorA', 'mgrA', 'supA',
    'wBs', 'wBsDecoy', 'wPct', 'wPctDecoy', 'wUnd', 'wUndDecoy'].sort();

  describe('roles globales: todas las cuentas activas (control positivo)', () => {
    test.each(['superAdmin', 'admin', 'gth', 'hr'])('%s', async (actor) => {
      const role = { superAdmin: 'super_admin' }[actor] || actor;
      const r = await lookup(actor, `/api/users/lookup?search=${ids.uniq}`, ids[actor], role);
      expect(r.status).toBe(200);
      expect(r.names).toEqual(ALL_ACTIVE());
    });
  });

  describe('roles por sede A: sólo cuentas activas con users.branch_id = A', () => {
    test.each([['mgrA', 'manager'], ['coordA', 'coordinator'], ['gestorA', 'gestor'], ['supA', 'supervisor']])('%s (%s)', async (actor, role) => {
      const r = await lookup(actor, `/api/users/lookup?search=${ids.uniq}`, ids[actor], role);
      expect(r.status).toBe(200);
      expect(r.names).toEqual(BRANCH_A);
      // Explícitamente: ni B, ni sin sede, ni sede inactiva, ni inactivos, ni la cuenta de B con empleado de A.
      for (const k of ['cB', 'cNoBranch', 'cOff', 'cAInactive', 'cBwithEmpA', 'admin', 'hr']) expect(r.names).not.toContain(k);
    });

    test('sin filtro de búsqueda (llamada de Departamentos): tampoco aparecen cuentas fuera de A', async () => {
      const r = await lookup('mgrA (sin search)', '/api/users/lookup', ids.mgrA, 'manager');
      expect(r.status).toBe(200);
      expect(r.names).toEqual(BRANCH_A);
    });

    test('prevalece la sede de la cuenta: A con empleado de B aparece; B con empleado de A no', async () => {
      const r = await lookup('mgrA (cuentas cruzadas)', `/api/users/lookup?search=${ids.uniq}`, ids.mgrA, 'manager');
      expect(r.names).toContain('cAwithEmpB');
      expect(r.names).not.toContain('cBwithEmpA');
    });

    test('el rol y la sede vigentes salen de la base, no del JWT', async () => {
      // Token que dice "admin" para una cuenta que en la base es manager de A.
      const r = await lookup('mgrA con JWT role=admin', `/api/users/lookup?search=${ids.uniq}`, ids.mgrA, 'admin');
      expect(r.status).toBe(200);
      expect(r.names).toEqual(BRANCH_A);
    });
  });

  describe('actor sin alcance: lista vacía, nunca global', () => {
    test.each([['mgrNoBranch', 'sin sede'], ['mgrOff', 'sede inactiva'], ['mgrGhost', 'sede inexistente']])('%s (%s) → []', async (actor) => {
      const r = await lookup(actor, `/api/users/lookup?search=${ids.uniq}`, ids[actor], 'manager');
      expect(r.status).toBe(200);
      expect(r.body).toEqual([]);
    });

    test('employee → 403 (no usa el selector)', async () => {
      const r = await lookup('empA', '/api/users/lookup', ids.empA, 'employee');
      expect(r.status).toBe(403);
    });
  });

  describe('filtro role: intersección con el alcance', () => {
    test('Evaluaciones (role=manager,coordinator,gestor,admin,gth,hr): manager A sólo ve los de A con esos roles', async () => {
      const r = await lookup('mgrA (Evaluaciones)', `/api/users/lookup?role=manager,coordinator,gestor,admin,gth,hr&search=${ids.uniq}`, ids.mgrA, 'manager');
      expect(r.status).toBe(200);
      expect(r.names).toEqual(['cA2', 'coordA', 'gestorA', 'mgrA']);
    });

    test('Evaluaciones como hr: todos los activos con esos roles, de cualquier sede', async () => {
      const r = await lookup('hr (Evaluaciones)', `/api/users/lookup?role=manager,coordinator,gestor,admin,gth,hr&search=${ids.uniq}`, ids.hr, 'hr');
      expect(r.status).toBe(200);
      expect(r.names).toEqual(['admin', 'cA2', 'cB', 'cNoBranch', 'cOff', 'coordA', 'gestorA', 'gth', 'hr',
        'mgrA', 'mgrGhost', 'mgrNoBranch', 'mgrOff'].sort());
    });

    test('role=employee para supervisor A: sólo employees de A (incluida la cuenta A con empleado de B)', async () => {
      const r = await lookup('supA role=employee', `/api/users/lookup?role=employee&search=${ids.uniq}`, ids.supA, 'supervisor');
      expect(r.names).toEqual(['cA1', 'cAwithEmpB', 'empA', 'wBs', 'wBsDecoy', 'wPct', 'wPctDecoy', 'wUnd', 'wUndDecoy'].sort());
    });
  });

  describe('búsqueda', () => {
    test('normal: subcadena del nombre', async () => {
      const r = await lookup('mgrA search=50', `/api/users/lookup?search=${encodeURIComponent(`${ids.uniq} 50`)}`, ids.mgrA, 'manager');
      expect(r.names).toEqual(['wPct', 'wPctDecoy']);
    });
    test.each([
      ['%', `${'50%'}off`, ['wPct']],
      ['_', 'a_b', ['wUnd']],
      ['\\', 'c\\d', ['wBs']],
    ])('comodín %s escapado: sólo la coincidencia literal', async (_c, term, expected) => {
      const r = await lookup(`mgrA search=${term}`, `/api/users/lookup?search=${encodeURIComponent(term)}`, ids.mgrA, 'manager');
      expect(r.status).toBe(200);
      expect(r.names).toEqual(expected);
    });
    test('search="%" no equivale a "todo"', async () => {
      const r = await lookup('admin search=%', `/api/users/lookup?search=${encodeURIComponent('%')}`, ids.admin, 'admin');
      expect(r.status).toBe(200);
      expect(r.names).toEqual(['wPct']);
    });
    test('se recorta: espacios alrededor no cambian el resultado', async () => {
      const r = await lookup('mgrA search con espacios', `/api/users/lookup?search=${encodeURIComponent(`  ${ids.uniq} a_b  `)}`, ids.mgrA, 'manager');
      expect(r.names).toEqual(['wUnd']);
    });
  });

  describe('parámetros inválidos → 400', () => {
    test.each([
      ['role repetido (arreglo)', '/api/users/lookup?role=manager&role=hr'],
      ['role objeto', '/api/users/lookup?role[x]=manager'],
      ['role desconocido', '/api/users/lookup?role=boss'],
      ['role con elemento vacío', '/api/users/lookup?role=manager,,hr'],
      ['role con coma final', '/api/users/lookup?role=manager,'],
      ['role con coma inicial', '/api/users/lookup?role=,manager'],
      ['search repetido (arreglo)', '/api/users/lookup?search=a&search=b'],
      ['search objeto', '/api/users/lookup?search[x]=a'],
      ['search demasiado largo', `/api/users/lookup?search=${'x'.repeat(101)}`],
    ])('%s', async (label, url) => {
      const r = await lookup(`admin ${label}`, url, ids.admin, 'admin');
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: expect.any(String), code: 'INVALID_INPUT' });
    });
  });

  describe('forma de la respuesta', () => {
    test('arreglo con sólo id, full_name, username, role y employee_id; orden por full_name', async () => {
      for (const [uid, role] of [[ids.admin, 'admin'], [ids.mgrA, 'manager']]) {
        const r = await get(`/api/users/lookup?search=${ids.uniq}`, uid, role);
        const rows = await r.json();
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(Object.keys(row).sort()).toEqual(LOOKUP_FIELDS);
        // Mismo orden que ORDER BY full_name de la base (misma intercalación).
        const got = rows.map((x) => x.id);
        const [ordered] = await conn.query('SELECT id FROM users WHERE id IN (?) ORDER BY full_name', [got]);
        expect(got).toEqual(ordered.map((x) => x.id));
      }
    });
    test('Departamentos y Evaluaciones reciben la misma forma (arreglo plano)', async () => {
      for (const url of ['/api/users/lookup', '/api/users/lookup?role=manager,coordinator,gestor,admin,gth,hr']) {
        const rows = await (await get(url, ids.admin, 'admin')).json();
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBeLessThanOrEqual(500);
        for (const row of rows) expect(Object.keys(row).sort()).toEqual(LOOKUP_FIELDS);
      }
    });
  });
});
