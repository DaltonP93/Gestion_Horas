'use strict';

/**
 * currentIdentity.it.test.js — INTEGRACIÓN contra MySQL 8 efímero (IT_DB=1).
 *
 * Identidad VIGENTE: el JWT se emite ANTES de cambiar el rol o el estado de la
 * cuenta en la base y se reutiliza el MISMO token. Rutas reales (empleados,
 * asistencia, configuración, reportes), authenticate/requirePermission/alcance
 * reales, archivos reales en un UPLOAD_DIR temporal y la base real. Nada de
 * mocks de identidad ni de alcance.
 *
 * Las solicitudes denegadas no deben entregar archivos, escribir asistencia ni
 * registrar auditoría de éxito. Se mantienen controles positivos (cuentas
 * activas sin cambios) y el alcance entre empresas.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-identity-it-'));
process.env.UPLOAD_DIR = TMP;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'it-identity-secret-0123456789abcdef';

const { describeIT, makeConn, closeAppDb } = require('./helper');

describeIT('identidad vigente: token emitido antes del cambio de rol/estado', () => {
  let conn;
  let server;
  let base;
  const ids = {};
  const TAG = `ITI${Date.now().toString(36).slice(-6)}`;
  const SIG_KEY = 'system_signature_url';
  let prevSignature; // valor previo del ajuste (se restaura al final)

  const jwt = require('jsonwebtoken');
  const token = (u) => jwt.sign({ id: u.id, role: u.role, username: u.username }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
  const req = (method, p, tok, body) => fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const insert = async (sql, params) => (await conn.query(sql, params))[0].insertId;
  const setUser = (u, fields) => conn.query(
    `UPDATE users SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    [...Object.values(fields), u.id],
  );
  const dsCount = async (emp, date) => Number((await conn.query('SELECT COUNT(*) AS n FROM daily_summary WHERE employee_id = ? AND date = ?', [emp, date]))[0][0].n);
  const auditCount = async (userId) => Number((await conn.query("SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND action = 'attendance.justify'", [userId]))[0][0].n);
  const isImage = (r) => /^image\//.test(r.headers.get('content-type') || '');

  beforeAll(async () => {
    conn = await makeConn();
    const sharp = require('sharp');
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const jpg = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 9, g: 8, b: 7 } } }).jpeg().toBuffer();

    ids.coA = await insert('INSERT INTO companies (code, legal_name) VALUES (?, ?)', [`${TAG}-A`, 'Empresa A IT']);
    ids.coB = await insert('INSERT INTO companies (code, legal_name) VALUES (?, ?)', [`${TAG}-B`, 'Empresa B IT']);
    ids.brA = await insert('INSERT INTO branches (code, name, company_id) VALUES (?, ?, ?)', [`${TAG}BA`, 'Sede A', ids.coA]);
    ids.brB = await insert('INSERT INTO branches (code, name, company_id) VALUES (?, ?, ?)', [`${TAG}BB`, 'Sede B', ids.coB]);
    ids.dA = await insert('INSERT INTO departments (name, branch_id, active) VALUES (?, ?, 1)', [`${TAG} Depto A`, ids.brA]);
    ids.dB = await insert('INSERT INTO departments (name, branch_id, active) VALUES (?, ?, 1)', [`${TAG} Depto B`, ids.brB]);
    const mkEmp = (k, dept, br) => insert("INSERT INTO employees (code, first_name, last_name, department_id, branch_id, status) VALUES (?, 'Sint', 'IT', ?, ?, 'active')", [`${TAG}${k}`, dept, br]);
    ids.eA1 = await mkEmp('A1', ids.dA, ids.brA);
    ids.eB1 = await mkEmp('B1', ids.dB, ids.brB);

    // Archivos privados reales: foto de eA1, selfie de eA1 y firma institucional.
    const photo = `avatar_${ids.eA1}_ab12cd.png`;
    fs.writeFileSync(path.join(TMP, photo), png);
    await conn.query('UPDATE employees SET photo_url = ? WHERE id = ?', [`/uploads/${photo}`, ids.eA1]);
    fs.mkdirSync(path.join(TMP, 'selfies'));
    const selfie = `selfie_${ids.eA1}_1.jpg`;
    fs.writeFileSync(path.join(TMP, 'selfies', selfie), jpg);
    ids.log = await insert("INSERT INTO attendance_logs (employee_id, `timestamp`, type, source, selfie_url) VALUES (?, '2031-04-01 08:00:00', 'in', 'mobile', ?)", [ids.eA1, `/uploads/selfies/${selfie}`]);
    // Nombre numérico real del formulario de firma (fecha + sufijo aleatorio).
    const sig = '1789990000000_ab12cd34.png';
    fs.writeFileSync(path.join(TMP, sig), png);
    const [[prev]] = await conn.query('SELECT setting_value FROM notification_settings WHERE setting_key = ? LIMIT 1', [SIG_KEY]);
    prevSignature = prev ? prev.setting_value : undefined;
    await conn.query(
      'INSERT INTO notification_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
      [SIG_KEY, `/uploads/${sig}`],
    );

    const mkUser = async (key, role, { branch = null, employee = null } = {}) => {
      const username = `${TAG}_${key}`.toLowerCase();
      const id = await insert(
        'INSERT INTO users (username, email, password_hash, full_name, role, employee_id, branch_id, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
        [username, `${username}@example.invalid`, 'x', `IT ${key}`, role, employee, branch],
      );
      ids[key] = { id, role, username };
    };
    // Una cuenta por caso: cada test cambia la suya después de emitir el token.
    await mkUser('adminPhoto', 'admin');
    await mkUser('adminSig', 'admin');
    await mkUser('hrSelfie', 'hr');
    await mkUser('hrJustify', 'hr');
    await mkUser('adminOk', 'admin');
    await mkUser('hrOk', 'hr');
    await mkUser('mgrA', 'manager', { branch: ids.brA });
    await conn.query(
      "INSERT INTO user_permissions (user_id, module, can_view, can_create, can_update, can_delete) VALUES (?, 'asistencia', 1, 0, 1, 0)",
      [ids.mgrA.id],
    );

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/employees', require('../../src/routes/employees'));
    app.use('/api/attendance', require('../../src/routes/attendance'));
    app.use('/api/settings', require('../../src/routes/settings'));
    app.use('/api/reports', require('../../src/routes/reports'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Error' }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (conn) {
      const userIds = Object.values(ids).filter((v) => v && typeof v === 'object' && v.id).map((u) => u.id);
      const empIds = [ids.eA1, ids.eB1].filter(Boolean);
      if (empIds.length) {
        await conn.query('DELETE FROM daily_summary WHERE employee_id IN (?)', [empIds]);
        await conn.query('DELETE FROM attendance_logs WHERE employee_id IN (?)', [empIds]);
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
      if (prevSignature === undefined) await conn.query('DELETE FROM notification_settings WHERE setting_key = ?', [SIG_KEY]);
      else await conn.query('UPDATE notification_settings SET setting_value = ? WHERE setting_key = ?', [prevSignature, SIG_KEY]);
      await conn.end();
    }
    await closeAppDb();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  // ── Controles positivos: cuentas activas sin cambios ───────────────────
  test('control: admin activo ve la foto y la firma; hr activo ve la selfie', async () => {
    const tAdmin = token(ids.adminOk);
    const photo = await req('GET', `/api/employees/${ids.eA1}/photo`, tAdmin);
    expect(photo.status).toBe(200);
    expect(isImage(photo)).toBe(true);
    expect(photo.headers.get('cache-control')).toBe('private, no-store');
    expect((await req('GET', '/api/settings/assets/signature', tAdmin)).status).toBe(200);
    expect((await req('GET', `/api/attendance/logs/${ids.log}/selfie`, token(ids.hrOk))).status).toBe(200);
  });

  test('control: alcance entre empresas — manager de A no ve la foto de B (404)', async () => {
    const t = token(ids.mgrA);
    expect((await req('GET', `/api/attendance/logs/${ids.log}/selfie`, t)).status).toBe(200);
    // eB1 no tiene foto pero la respuesta es la de fuera de alcance, no la de "sin foto".
    const r = await req('GET', `/api/employees/${ids.eB1}/photo`, t);
    expect([403, 404]).toContain(r.status);
    expect(isImage(r)).toBe(false);
  });

  // ── Token viejo reutilizado tras el cambio ─────────────────────────────
  test('admin degradado a employee: foto de otro empleado → 403, sin archivo', async () => {
    const t = token(ids.adminPhoto);
    await setUser(ids.adminPhoto, { role: 'employee', employee_id: ids.eB1 });
    const r = await req('GET', `/api/employees/${ids.eA1}/photo`, t);
    expect(r.status).toBe(403);
    expect(isImage(r)).toBe(false);
  });

  test('hr desactivado: selfie de asistencia → 401, sin archivo', async () => {
    const t = token(ids.hrSelfie);
    await setUser(ids.hrSelfie, { active: 0 });
    const r = await req('GET', `/api/attendance/logs/${ids.log}/selfie`, t);
    expect(r.status).toBe(401);
    expect(isImage(r)).toBe(false);
  });

  test('admin degradado a employee: firma de configuración → 403, sin archivo', async () => {
    const t = token(ids.adminSig);
    await setUser(ids.adminSig, { role: 'employee' });
    const r = await req('GET', '/api/settings/assets/signature', t);
    expect(r.status).toBe(403);
    expect(isImage(r)).toBe(false);
  });

  test('hr desactivado: justificar asistencia → 401, sin escritura ni auditoría', async () => {
    const date = '2031-04-02';
    const t = token(ids.hrJustify);
    // Antes del cambio el mismo token sí justifica (control).
    const ok = await req('POST', '/api/reports/attendance/justify', t, { employeeId: ids.eA1, date: '2031-04-03', justification: 'control', justificationType: 'enfermedad' });
    expect(ok.status).toBe(200);
    // audit.log es fire-and-forget: se espera el evento del control antes de contar.
    for (let i = 0; i < 30 && (await auditCount(ids.hrJustify.id)) < 1; i += 1) {
      await new Promise((res) => setTimeout(res, 100));
    }
    const auditBefore = await auditCount(ids.hrJustify.id);
    expect(auditBefore).toBe(1);

    await setUser(ids.hrJustify, { active: 0 });
    const r = await req('POST', '/api/reports/attendance/justify', t, { employeeId: ids.eA1, date, justification: 'texto', justificationType: 'enfermedad' });
    expect(r.status).toBe(401);
    expect(await dsCount(ids.eA1, date)).toBe(0);
    // La auditoría es asíncrona: se da margen antes de verificar que no llegó nada nuevo.
    await new Promise((res) => setTimeout(res, 300));
    expect(await auditCount(ids.hrJustify.id)).toBe(auditBefore);
  });
});
