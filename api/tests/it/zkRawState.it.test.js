'use strict';

/**
 * zkRawState.it.test.js — INTEGRACIÓN (MySQL real + HTTP real + worker real en
 * proceso aparte): conservación del estado CRUDO de la marcación en
 * raw_device_punches.raw_json y su reporte de diagnóstico, sin cambiar horas.
 *
 * El reloj simulado (fixtures/fakeZk.js) entrega los BYTES reales del formato
 * TCP de 40 o UDP de 16 bytes a las clases reales de node-zklib; sólo se simula
 * el transporte. Con FAKE_ZK_PRELOAD_ZKLIB=1 el worker carga node-zklib ANTES
 * que el lector, para comprobar que una captura que no ocurrió queda marcada.
 *
 * Se verifica, con valores exactos:
 *   - que cada marca conserva SUS bytes (zkPunchState / zkVerify) y el formato;
 *   - que el tipo sigue sin determinar y daily_summary es el mismo con y sin
 *     captura (los bytes NO se usan como tipo ni cambian horas);
 *   - el reporte de solo lectura por reloj y rango: conteos por formato, valor,
 *     ausentes e inválidos, sin nombres, ids de empleado ni marcas individuales.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeIT, makeConn, closeAppDb, cfg } = require('./helper');
const { runSyncWorker } = require('./fixtures/syncWorkerProcess');

jest.mock('node-zklib', () => require('./fixtures/fakeZk').FakeZK);
jest.mock('node-zklib/zklibtcp', () => require('./fixtures/fakeZk').FakeZK);
jest.mock('node-zklib/zklibudp', () => require('./fixtures/fakeZk').FakeZK);

process.env.JWT_SECRET = process.env.JWT_SECRET || 'it-zk-raw-state-secret-0123456789abcdef';
process.env.REDIS_URL = 'disabled://';
process.env.WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED = 'false';
jest.setTimeout(180000);

const DAY = '2026-10-05';
const CUTOVER_KEY = 'fase_e_daily_summary_cutover_date';
const WORKER_TZ = process.env.TZ || 'America/Asuncion';

describeIT('estado crudo de la marcación (integración) — captura y reporte sin cambiar horas', () => {
  let conn;
  let server;
  let base;
  let tmpDir;
  let recordsFile;
  let savedCutover;
  const ids = { uniq: `ZKR${Date.now().toString(36).toUpperCase()}` };
  // Ids de usuario ≤ 65535: el formato UDP los transporta en 2 bytes útiles.
  const uidA = String(10000 + (Date.now() % 50000));
  const uidB = String(Number(uidA) + 1);
  const jwt = require('jsonwebtoken');
  const token = () => jwt.sign({ id: ids.admin, role: 'admin' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
  const http = async (method, url, body) => {
    const r = await fetch(base + url, {
      method,
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const rows = async (sql, params) => (await conn.query(sql, params))[0];

  // Bytes distintos por marca para detectar cualquier desalineo.
  const RECORDS = [
    { deviceUserId: uidA, wall: '2026-10-05 08:00:00', punchByte: 1, verifyByte: 1 },
    { deviceUserId: uidA, wall: '2026-10-05 12:00:00', punchByte: 0, verifyByte: 15 },
    { deviceUserId: uidA, wall: '2026-10-05 13:00:00', punchByte: 5, verifyByte: 4 },
    { deviceUserId: uidB, wall: '2026-10-05 09:00:00', punchByte: 2, verifyByte: 1 },
    { deviceUserId: uidA, wall: '2026-10-05 17:00:00', punchByte: 255, verifyByte: 0 },
  ];
  const label = (uid) => (String(uid) === uidA ? 'A' : 'B');
  const rawExpected = (transport) => RECORDS
    .map((r) => ({ who: label(r.deviceUserId), wall: r.wall, raw: { zkCapture: 'ok', zkRecordFormat: transport, zkPunchState: r.punchByte, zkVerify: r.verifyByte } }))
    .sort((a, b) => a.wall.localeCompare(b.wall));

  async function cleanup() {
    await conn.query('DELETE FROM attendance_logs WHERE employee_id = ?', [ids.empA]);
    await conn.query('DELETE FROM daily_summary WHERE employee_id = ?', [ids.empA]);
    await conn.query('DELETE FROM raw_device_punches WHERE device_id IN (?)', [[ids.device, ids.otherDevice]]);
    await conn.query('DELETE FROM device_sync_runs WHERE device_id IN (?)', [[ids.device, ids.otherDevice]]);
    await conn.query('DELETE FROM sync_jobs WHERE device_id = ?', [ids.device]);
    await conn.query('DELETE FROM device_locks WHERE device_id = ?', [ids.device]);
  }

  async function readDay(env) {
    const r = await http('POST', '/api/devices/sync-jobs', { device_ids: [ids.device], from: DAY, to: DAY, attempts: 1 });
    expect(r.status).toBe(202);
    const jobId = r.body.jobs[0].id;
    await runSyncWorker({ conn, cfg, jobIds: [jobId], tz: WORKER_TZ, recordsFile, env });
    const [job] = await rows('SELECT status, result FROM sync_jobs WHERE id = ?', [jobId]);
    return { status: job.status, result: typeof job.result === 'string' ? JSON.parse(job.result) : job.result };
  }

  /** Lo que el circuito dejó: crudo por marca, asistencia y daily_summary. */
  async function outcome() {
    const raw = (await rows(
      `SELECT device_user_id, record_time_py, mapping_status, CAST(raw_json AS CHAR) AS raw_json
         FROM raw_device_punches WHERE device_id = ? ORDER BY record_time_py`, [ids.device],
    )).map((r) => {
      const j = JSON.parse(r.raw_json);
      const rawFields = Object.fromEntries(['zkCapture', 'zkRecordFormat', 'zkPunchState', 'zkVerify', 'zkRecordLength']
        .filter((k) => k in j).map((k) => [k, j[k]]));
      return { who: label(r.device_user_id), wall: r.record_time_py, raw: rawFields, mapping: r.mapping_status };
    });
    const attendance = (await rows(
      "SELECT DATE_FORMAT(`timestamp`, '%Y-%m-%d %H:%i:%s') AS ts, type, source FROM attendance_logs WHERE employee_id = ? ORDER BY `timestamp`",
      [ids.empA],
    )).map((r) => `${r.ts} ${r.type} ${r.source}`);
    const summary = await rows(
      `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, first_in, last_out, worked_minutes, late_minutes, overtime_minutes, status
         FROM daily_summary WHERE employee_id = ? ORDER BY date`, [ids.empA],
    );
    return { raw, attendance, summary };
  }

  beforeAll(async () => {
    conn = await makeConn();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-raw-state-'));
    recordsFile = path.join(tmpDir, 'records.json');
    process.env.FAKE_ZK_RECORDS = recordsFile;
    fs.writeFileSync(recordsFile, JSON.stringify(RECORDS));

    const [cut] = await rows('SELECT value FROM system_settings WHERE key_name = ?', [CUTOVER_KEY]).catch(() => [[]]);
    savedCutover = cut ? cut.value : undefined;
    if (savedCutover !== undefined) await conn.query('DELETE FROM system_settings WHERE key_name = ?', [CUTOVER_KEY]);

    const used = new Set((await rows("SELECT ip_address FROM devices WHERE ip_address LIKE '192.0.2.%'")).map((r) => r.ip_address));
    const free = [...Array(254).keys()].map((i) => i + 1).filter((i) => !used.has(`192.0.2.${i}`));
    ids.device = (await conn.query("INSERT INTO devices (name, ip_address, port, connection_mode) VALUES (?, ?, 4370, 'auto')",
      [`${ids.uniq} reloj sintético`, `192.0.2.${free[0]}`]))[0].insertId;
    ids.otherDevice = (await conn.query("INSERT INTO devices (name, ip_address, port, connection_mode) VALUES (?, ?, 4370, 'auto')",
      [`${ids.uniq} otro reloj`, `192.0.2.${free[1]}`]))[0].insertId;
    ids.schedule = (await conn.query(
      `INSERT INTO schedules (name, check_in, check_out, tolerance_in, tolerance_out, break_minutes, work_days, active)
       VALUES (?, '08:00:00', '17:00:00', 5, 0, 60, '2,3,4,5,6', 1)`, [`${ids.uniq} horario`]))[0].insertId;
    ids.empA = (await conn.query(
      "INSERT INTO employees (code, first_name, last_name, status, schedule_id) VALUES (?, 'Sintético', 'Crudo', 'active', ?)",
      [uidA, ids.schedule]))[0].insertId;
    ids.admin = (await conn.query(
      "INSERT INTO users (username, email, password_hash, full_name, role, active) VALUES (?, ?, 'it-no-login', 'IT estado crudo', 'admin', 1)",
      [`${ids.uniq}adm`, `${ids.uniq.toLowerCase()}adm@it.local`]))[0].insertId;

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/devices', require('../../src/routes/devices'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Error interno' }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (conn) {
      await cleanup().catch(() => {});
      await conn.query('DELETE FROM audit_events WHERE user_id = ?', [ids.admin]).catch(() => {});
      await conn.query('DELETE FROM users WHERE id = ?', [ids.admin]).catch(() => {});
      await conn.query('DELETE FROM employees WHERE id = ?', [ids.empA]).catch(() => {});
      await conn.query('DELETE FROM schedules WHERE id = ?', [ids.schedule]).catch(() => {});
      await conn.query('DELETE FROM devices WHERE id IN (?)', [[ids.device, ids.otherDevice]]).catch(() => {});
      if (savedCutover !== undefined) {
        await conn.query('INSERT INTO system_settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
          [CUTOVER_KEY, savedCutover]).catch(() => {});
      }
      await conn.end();
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await closeAppDb();
  });

  // Asistencia y daily_summary esperados: los de hoy para marcas sin tipo
  // (ver docs/design/horas-marcas-sin-tipo.md). Los bytes NO cambian nada.
  const EXP_ATTENDANCE = ['2026-10-05 08:00:00', '2026-10-05 12:00:00', '2026-10-05 13:00:00', '2026-10-05 17:00:00']
    .map((t) => `${t} unknown zkteco_direct`);
  const results = {};

  test.each([
    ['tcp40', 'tcp40', {}],
    ['udp16', 'udp16', {}],
    ['captura tardía (node-zklib cargado antes que el lector)', 'tcp40', { FAKE_ZK_PRELOAD_ZKLIB: '1' }],
  ])('%s: crudo por marca y horas sin cambios', async (name, transport, extra) => {
    await cleanup();
    const job = await readDay({ FAKE_ZK_TRANSPORT: transport, ...extra });
    expect(job.status).toBe('success');
    expect(job.result).toEqual({ total_read: 5, in_range: 5, imported: 4, skipped: 0, notFound: 1, partial: false });
    const out = await outcome();
    const late = extra.FAKE_ZK_PRELOAD_ZKLIB === '1';
    expect(out.raw.map(({ who, wall, raw }) => ({ who, wall, raw }))).toEqual(
      late
        ? rawExpected(transport).map(({ who, wall }) => ({ who, wall, raw: { zkCapture: 'no_disponible' } }))
        : rawExpected(transport),
    );
    expect(out.attendance).toEqual(EXP_ATTENDANCE);
    results[name] = { attendance: out.attendance, summary: out.summary, mapping: out.raw.map((r) => `${r.who} ${r.mapping}`) };
  });

  test('las horas, los tipos y el staging son idénticos con y sin captura', () => {
    const names = Object.keys(results);
    expect(names).toHaveLength(3);
    for (const n of names) expect(results[n]).toEqual(results[names[0]]);
    expect(results[names[0]].summary).toEqual([{
      date: DAY, first_in: null, last_out: null, worked_minutes: 0, late_minutes: 0, overtime_minutes: 0, status: 'absent',
    }]);
  });

  test('reporte de solo lectura: conteos por formato, valor, ausentes e inválidos; sin datos personales', async () => {
    await cleanup();
    await readDay({ FAKE_ZK_TRANSPORT: 'tcp40' });
    const ins = (deviceId, uid, wall, rawJson) => conn.query(
      `INSERT INTO raw_device_punches (device_id, device_user_id, record_time, record_time_py, raw_json, source, mapping_status)
       VALUES (?, ?, ?, ?, ?, 'zkteco_direct', 'unmapped')`, [deviceId, uid, wall, wall, rawJson],
    );
    // Filas que el reporte debe clasificar (datos de prueba en el staging).
    await ins(ids.device, '90001', '2026-10-05 10:00:00', JSON.stringify({ zkCapture: 'ok', zkRecordFormat: 'tcp40', zkPunchState: 300, zkVerify: 'x' }));
    await ins(ids.device, '90001', '2026-10-05 11:00:00', JSON.stringify({ deviceUserId: '90001' }));
    await ins(ids.device, '90001', '2026-10-05 11:30:00', null);
    await ins(ids.device, '90001', '2026-10-05 14:00:00', JSON.stringify({ zkCapture: 'no_disponible' }));
    await ins(ids.device, '90001', '2026-10-05 15:00:00', JSON.stringify({ zkCapture: 'ok', zkRecordFormat: 'tcp40' }));
    await ins(ids.device, '90001', '2026-10-05 15:30:00', JSON.stringify({ zkCapture: 'longitud_inesperada', zkRecordLength: 12 }));
    // Fuera del rango y de otro reloj: no deben contarse.
    await ins(ids.device, '90001', '2026-10-07 08:00:00', JSON.stringify({ zkCapture: 'ok', zkRecordFormat: 'tcp40', zkPunchState: 9, zkVerify: 9 }));
    await ins(ids.otherDevice, '90001', '2026-10-05 08:00:00', JSON.stringify({ zkCapture: 'ok', zkRecordFormat: 'udp16', zkPunchState: 7, zkVerify: 7 }));

    const r = await http('GET', `/api/devices/${ids.device}/raw-state-report?from=${DAY}&to=${DAY}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      device_id: ids.device,
      from: DAY,
      to: DAY,
      source: 'zkteco_direct',
      total: 11,
      capture: { ok: 7, no_disponible: 1, longitud_inesperada: 1, sin_registro: 1, sin_raw_json: 1, desconocido: 0 },
      formats: {
        tcp40: {
          total: 7,
          zkPunchState: { 0: 1, 1: 1, 2: 1, 5: 1, 255: 1, invalido: 1, ausente: 1 },
          zkVerify: { 0: 1, 1: 2, 4: 1, 15: 1, invalido: 1, ausente: 1 },
        },
      },
    });
    // Sin nombres, ids de usuario/empleado ni marcas individuales.
    const text = JSON.stringify(r.body);
    for (const leak of [uidA, uidB, '90001', 'Sintético', 'Crudo', '08:00', 'employee', String(ids.empA)]) {
      expect(text).not.toContain(leak);
    }
  });

  test('reporte: exige reloj existente y rango válido (máximo 92 días)', async () => {
    const q = (id, qs) => http('GET', `/api/devices/${id}/raw-state-report${qs}`);
    expect((await q(ids.device, '?from=2026-10-05')).status).toBe(400);
    expect((await q(ids.device, '?from=2026-10-06&to=2026-10-05')).status).toBe(400);
    expect((await q(ids.device, '?from=2026-02-30&to=2026-03-01')).status).toBe(400);
    expect((await q(ids.device, '?from=2026-01-01&to=2026-04-03')).status).toBe(400);
    expect((await q(ids.device, '?from=2026-01-01&to=2026-04-02')).status).toBe(200);
    expect((await q(2147480000, `?from=${DAY}&to=${DAY}`)).status).toBe(404);
  });
});
