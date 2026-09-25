'use strict';

/**
 * contention.it.test.js — INTEGRACIÓN contra MySQL 8 efímero (IT_DB=1).
 *
 * Rutas REALES montadas en un Express real, autenticación JWT REAL,
 * requirePermission/capabilities/departmentScope/enforceEmployeeScope/
 * permissionAccess REALES y la base REAL (esquema init.sql + migraciones).
 * No hay mocks de alcance ni inserts de auditoría hechos por el test: el
 * evento se lee de `audit_events` tal como lo escribió la app.
 *
 * Fixtures sintéticas: dos empresas (A y B), una sede y un departamento por
 * empresa, empleados propios y ajenos, usuarios con permisos definidos
 * (defaults + overrides en user_permissions). Política vigente de roles
 * globales: `hr` sigue siendo global.
 *
 * Se limpian al final (base descartable del job; nunca producción).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'it-contention-secret-0123456789abcdef';

const { describeIT, makeConn, closeAppDb } = require('./helper');

describeIT('contención: justificación y licencias con persistencia real', () => {
  let conn;
  let server;
  let base;
  const ids = {};
  const TAG = `ITC${Date.now().toString(36).slice(-6)}`;
  const D = { ok: '2031-01-05', cross: '2031-01-06', noCap: '2031-01-07', scoped: '2031-01-08', self: '2031-01-09', exp: '2031-01-10' };

  const jwt = require('jsonwebtoken');
  const token = (u) => jwt.sign({ id: u.id, role: u.role, username: u.username }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
  const call = (method, path, user, body) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${token(user)}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  async function insert(sql, params) {
    const [r] = await conn.query(sql, params);
    return r.insertId;
  }
  async function dsRow(employeeId, date) {
    const [rows] = await conn.query(
      "SELECT justification, justification_type, status FROM daily_summary WHERE employee_id = ? AND date = ?",
      [employeeId, date],
    );
    return rows[0] || null;
  }
  async function auditRows(userId, action) {
    const [rows] = await conn.query(
      'SELECT user_id, action, entity, entity_id, details FROM audit_events WHERE user_id = ? AND action = ? ORDER BY id',
      [userId, action],
    );
    return rows;
  }
  // audit.log es fire-and-forget: se espera a que la fila aparezca (máx ~3 s).
  async function waitAudit(userId, action, n = 1) {
    for (let i = 0; i < 30; i += 1) {
      const rows = await auditRows(userId, action);
      if (rows.length >= n) return rows;
      await new Promise((r) => setTimeout(r, 100));
    }
    return auditRows(userId, action);
  }

  beforeAll(async () => {
    conn = await makeConn();
    // ── Deriva de esquema PREEXISTENTE (fuera del alcance de este PR) ──────
    // En un replay limpio (init.sql + migraciones) la 011 ya crea
    // permissions.level1_at y la 024 usa esa misma columna como guarda, así
    // que nunca agrega permissions.sla_due_at, que POST /api/permissions sí
    // escribe (el alta devolvería 500 por esquema, no por autorización). No se
    // toca el historial de migraciones: se agrega la columna que la 024
    // declara, sólo en esta base descartable, y se deja constancia.
    const [slaCol] = await conn.query(
      "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permissions' AND COLUMN_NAME = 'sla_due_at'",
    );
    if (Number(slaCol[0].n) === 0) {
      // eslint-disable-next-line no-console
      console.warn('[it] deriva 011/024: permissions.sla_due_at ausente en el replay; se agrega en la base efímera');
      await conn.query('ALTER TABLE permissions ADD COLUMN sla_due_at DATETIME NULL');
    }
    // ── Organización: dos empresas con su sede y departamento ──────────────
    ids.coA = await insert('INSERT INTO companies (code, legal_name) VALUES (?, ?)', [`${TAG}-A`, 'Empresa A IT']);
    ids.coB = await insert('INSERT INTO companies (code, legal_name) VALUES (?, ?)', [`${TAG}-B`, 'Empresa B IT']);
    ids.brA = await insert('INSERT INTO branches (code, name, company_id) VALUES (?, ?, ?)', [`${TAG}BA`, 'Sede A', ids.coA]);
    ids.brB = await insert('INSERT INTO branches (code, name, company_id) VALUES (?, ?, ?)', [`${TAG}BB`, 'Sede B', ids.coB]);
    ids.dA = await insert('INSERT INTO departments (name, branch_id, active) VALUES (?, ?, 1)', [`${TAG} Depto A`, ids.brA]);
    ids.dB = await insert('INSERT INTO departments (name, branch_id, active) VALUES (?, ?, 1)', [`${TAG} Depto B`, ids.brB]);
    // ── Empleados propios (A) y ajenos (B) ─────────────────────────────────
    ids.eA1 = await insert("INSERT INTO employees (code, first_name, last_name, department_id, branch_id, status) VALUES (?, 'Ana', 'IT', ?, ?, 'active')", [`${TAG}A1`, ids.dA, ids.brA]);
    ids.eA2 = await insert("INSERT INTO employees (code, first_name, last_name, department_id, branch_id, status) VALUES (?, 'Beto', 'IT', ?, ?, 'active')", [`${TAG}A2`, ids.dA, ids.brA]);
    ids.eB1 = await insert("INSERT INTO employees (code, first_name, last_name, department_id, branch_id, status) VALUES (?, 'Ciro', 'IT', ?, ?, 'active')", [`${TAG}B1`, ids.dB, ids.brB]);
    // ── Usuarios ───────────────────────────────────────────────────────────
    const mkUser = async (key, role, { branch = null, employee = null, active = 1 } = {}) => {
      const username = `${TAG}_${key}`.toLowerCase();
      const id = await insert(
        'INSERT INTO users (username, email, password_hash, full_name, role, employee_id, branch_id, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [username, `${username}@example.invalid`, 'x', `IT ${key}`, role, employee, branch, active],
      );
      ids[key] = { id, role, username };
    };
    await mkUser('hr', 'hr');
    await mkUser('mgrA', 'manager', { branch: ids.brA });
    await mkUser('mgrA2', 'manager', { branch: ids.brA });
    await mkUser('empA1', 'employee', { employee: ids.eA1 });
    await mkUser('empOff', 'employee', { employee: ids.eA2, active: 0 });
    await mkUser('gthDenied', 'gth');
    // Overrides: mgrA2 puede justificar asistencia y crear licencias de otros
    // (siempre DENTRO de su alcance); gthDenied tiene denegación explícita.
    const perm = (userId, module, v, c, u, d) => conn.query(
      'INSERT INTO user_permissions (user_id, module, can_view, can_create, can_update, can_delete) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, module, v, c, u, d],
    );
    await perm(ids.mgrA2.id, 'asistencia', 1, 0, 1, 0);
    await perm(ids.mgrA2.id, 'permisos', 1, 1, 0, 0);
    await perm(ids.gthDenied.id, 'permisos', 0, 0, 0, 0);
    await perm(ids.gthDenied.id, 'mis_permisos', 0, 0, 0, 0);
    // ── Licencias existentes: una propia de A y una ajena de B ─────────────
    ids.pA1 = await insert("INSERT INTO permissions (employee_id, type, date_from, date_to, reason, approval_state) VALUES (?, 'personal', '2031-02-01', '2031-02-01', 'motivo A', 'pending')", [ids.eA1]);
    ids.pB1 = await insert("INSERT INTO permissions (employee_id, type, date_from, date_to, reason, approval_state) VALUES (?, 'personal', '2031-02-02', '2031-02-02', 'motivo B', 'pending')", [ids.eB1]);

    // ── App real ───────────────────────────────────────────────────────────
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/reports', require('../../src/routes/reports'));
    app.use('/api/permissions', require('../../src/routes/permissions'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Error' }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (conn) {
      const empIds = [ids.eA1, ids.eA2, ids.eB1].filter(Boolean);
      const userIds = ['hr', 'mgrA', 'mgrA2', 'empA1', 'empOff', 'gthDenied'].map((k) => ids[k] && ids[k].id).filter(Boolean);
      if (empIds.length) {
        await conn.query('DELETE FROM daily_summary WHERE employee_id IN (?)', [empIds]);
        await conn.query('DELETE FROM permission_approval_events WHERE permission_id IN (SELECT id FROM permissions WHERE employee_id IN (?))', [empIds]);
        await conn.query('DELETE FROM permissions WHERE employee_id IN (?)', [empIds]);
      }
      if (userIds.length) {
        await conn.query('DELETE FROM audit_events WHERE user_id IN (?)', [userIds]);
        await conn.query('DELETE FROM user_permissions WHERE user_id IN (?)', [userIds]);
        await conn.query('DELETE FROM users WHERE id IN (?)', [userIds]);
      }
      if (empIds.length) await conn.query('DELETE FROM employees WHERE id IN (?)', [empIds]);
      await conn.query('DELETE FROM departments WHERE id IN (?)', [[ids.dA, ids.dB].filter(Boolean)]);
      await conn.query('DELETE FROM branches WHERE id IN (?)', [[ids.brA, ids.brB].filter(Boolean)]);
      await conn.query('DELETE FROM companies WHERE id IN (?)', [[ids.coA, ids.coB].filter(Boolean)]);
      await conn.end();
    }
    await closeAppDb();
  });

  // ── Justificación ──────────────────────────────────────────────────────
  describe('POST /api/reports/attendance/justify', () => {
    const body = (employeeId, date) => ({ employeeId, date, justification: '  Certificado medico IT sensible  ', justificationType: 'enfermedad' });

    test('hr (global) justifica → fila en daily_summary + evento real en audit_events sin texto libre', async () => {
      const r = await call('POST', '/api/reports/attendance/justify', ids.hr, body(ids.eB1, D.ok));
      expect(r.status).toBe(200);
      expect(await dsRow(ids.eB1, D.ok)).toEqual({ justification: 'Certificado medico IT sensible', justification_type: 'enfermedad', status: 'permission' });
      const ev = await waitAudit(ids.hr.id, 'attendance.justify');
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ user_id: ids.hr.id, action: 'attendance.justify', entity: 'employee', entity_id: String(ids.eB1) });
      expect(JSON.parse(ev[0].details)).toEqual({ employee_id: ids.eB1, date: D.ok, type: 'enfermedad' });
      expect(ev[0].details).not.toMatch(/Certificado|sensible/i);
    });

    test('manager con asistencia.update sobre empleado de OTRA empresa → 404, sin escritura ni auditoría', async () => {
      const r = await call('POST', '/api/reports/attendance/justify', ids.mgrA2, body(ids.eB1, D.cross));
      expect(r.status).toBe(404);
      expect(await dsRow(ids.eB1, D.cross)).toBeNull();
      expect(await auditRows(ids.mgrA2.id, 'attendance.justify')).toHaveLength(0);
    });

    test('manager SIN capacidad sobre empleado en alcance → 403, sin escritura (el alcance no concede)', async () => {
      const r = await call('POST', '/api/reports/attendance/justify', ids.mgrA, body(ids.eA1, D.noCap));
      expect(r.status).toBe(403);
      expect(await dsRow(ids.eA1, D.noCap)).toBeNull();
      expect(await auditRows(ids.mgrA.id, 'attendance.justify')).toHaveLength(0);
    });

    test('manager con capacidad sobre empleado en alcance → 200 con auditoría', async () => {
      const r = await call('POST', '/api/reports/attendance/justify', ids.mgrA2, body(ids.eA1, D.scoped));
      expect(r.status).toBe(200);
      expect(await dsRow(ids.eA1, D.scoped)).not.toBeNull();
      const ev = await waitAudit(ids.mgrA2.id, 'attendance.justify');
      expect(ev).toHaveLength(1);
      expect(JSON.parse(ev[0].details)).toEqual({ employee_id: ids.eA1, date: D.scoped, type: 'enfermedad' });
    });

    test('employee sobre sí mismo → 403 (no tiene asistencia.update)', async () => {
      const r = await call('POST', '/api/reports/attendance/justify', ids.empA1, body(ids.eA1, D.self));
      expect(r.status).toBe(403);
      expect(await dsRow(ids.eA1, D.self)).toBeNull();
    });

    test("id no canónico ('1e2', '0x1', decimal, array) → 400 y ninguna fila en la fecha", async () => {
      for (const bad of ['1e2', '0x1', `${ids.eA1}.0`, [ids.eA1]]) {
        const r = await call('POST', '/api/reports/attendance/justify', ids.hr, body(bad, D.exp));
        expect(r.status).toBe(400);
      }
      const [rows] = await conn.query('SELECT COUNT(*) AS n FROM daily_summary WHERE date = ?', [D.exp]);
      expect(Number(rows[0].n)).toBe(0);
    });

    test('sin token → 401', async () => {
      const r = await call('POST', '/api/reports/attendance/justify', null, body(ids.eA1, D.exp));
      expect(r.status).toBe(401);
    });
  });

  // ── Licencias ──────────────────────────────────────────────────────────
  describe('/api/permissions', () => {
    const listIds = async (user) => {
      const r = await call('GET', '/api/permissions', user);
      return { status: r.status, ids: r.status === 200 ? (await r.json()).map((p) => p.id) : [] };
    };

    test('employee: el listado contiene sólo lo propio', async () => {
      const { status, ids: got } = await listIds(ids.empA1);
      expect(status).toBe(200);
      expect(got).toContain(ids.pA1);
      expect(got).not.toContain(ids.pB1);
    });

    test('hr (global): ve ambas empresas (política vigente)', async () => {
      const { ids: got } = await listIds(ids.hr);
      expect(got).toEqual(expect.arrayContaining([ids.pA1, ids.pB1]));
    });

    test('manager de A: detalle de A 200; de B 404', async () => {
      expect((await call('GET', `/api/permissions/${ids.pA1}`, ids.mgrA)).status).toBe(200);
      expect((await call('GET', `/api/permissions/${ids.pB1}`, ids.mgrA)).status).toBe(404);
    });

    test('alta: manager sin permisos.create → 403; con create pero empleado de B → 404; en alcance → 201', async () => {
      const count = async (emp) => { const [r] = await conn.query('SELECT COUNT(*) AS n FROM permissions WHERE employee_id = ?', [emp]); return Number(r[0].n); };
      const beforeA2 = await count(ids.eA2);
      const beforeB1 = await count(ids.eB1);
      const body = (employee_id) => ({ employee_id, type: 'personal', date_from: '2031-03-01', date_to: '2031-03-01' });

      expect((await call('POST', '/api/permissions', ids.mgrA, body(ids.eA2))).status).toBe(403);
      expect((await call('POST', '/api/permissions', ids.mgrA2, body(ids.eB1))).status).toBe(404);
      expect(await count(ids.eA2)).toBe(beforeA2);
      expect(await count(ids.eB1)).toBe(beforeB1);

      expect((await call('POST', '/api/permissions', ids.mgrA2, body(ids.eA2))).status).toBe(201);
      expect(await count(ids.eA2)).toBe(beforeA2 + 1);
    });

    test('gth con denegación explícita en user_permissions → 403 aunque sea rol global', async () => {
      expect((await listIds(ids.gthDenied)).status).toBe(403);
      expect((await call('GET', `/api/permissions/${ids.pB1}`, ids.gthDenied)).status).toBe(404);
    });

    test('usuario inactivo con token todavía válido → 403', async () => {
      expect((await listIds(ids.empOff)).status).toBe(403);
    });
  });
});
