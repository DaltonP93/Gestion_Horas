'use strict';

/**
 * zkWallClock.it.test.js — INTEGRACIÓN (MySQL real + HTTP real + worker real en
 * proceso aparte): la hora de pared del reloj se guarda igual sin importar la
 * zona horaria del proceso.
 *
 * El reloj guarda la hora de pared (sin zona) en un uint32 y node-zklib la
 * decodifica con `new Date(año, mes, día, h, m, s)`, es decir, en la zona LOCAL
 * del proceso. El reloj simulado (fixtures/fakeZk.js) empaqueta cada marcación
 * como el reloj y la pasa por ese decodificador REAL, en el proceso y la zona de
 * la prueba. Lo único simulado es la comunicación con el reloj.
 *
 * Por cada zona del worker (UTC, America/Asuncion, Asia/Tokyo) se verifican con
 * valores EXACTOS: filtro del rango, staging (record_time y record_time_py),
 * attendance_logs, enlace raw → asistencia, búsqueda de duplicados al repetir
 * la lectura, reproceso de marcas sin empleado (por la API, en la zona de jest;
 * CI corre el archivo en las tres) y el recálculo REAL de daily_summary con el
 * horario explícito de la fixture (motor legacy; el writer del motor de jornada
 * queda apagado y no se activa FASE E).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeIT, makeConn, closeAppDb, cfg } = require('./helper');
const { runSyncWorker } = require('./fixtures/syncWorkerProcess');

jest.mock('node-zklib', () => require('./fixtures/fakeZk').FakeZK);
jest.mock('node-zklib/zklibtcp', () => require('./fixtures/fakeZk').FakeZK);
jest.mock('node-zklib/zklibudp', () => require('./fixtures/fakeZk').FakeZK);

process.env.JWT_SECRET = process.env.JWT_SECRET || 'it-zk-wall-clock-secret-0123456789abcdef';
// Sin Redis: la app usa su respaldo (lock por reloj en MySQL).
process.env.REDIS_URL = 'disabled://';
// Recálculo legacy (el writer del motor de jornada queda apagado, como el default).
process.env.WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED = 'false';
jest.setTimeout(180000);

const ZONES = ['UTC', 'America/Asuncion', 'Asia/Tokyo'];
const DAY = '2026-10-05';                 // lunes
const CUTOVER_KEY = 'fase_e_daily_summary_cutover_date';

describeIT('hora de pared del reloj (integración) — independiente de la zona del proceso', () => {
  let conn;
  let server;
  let base;
  let tmpDir;
  let recordsFile;
  let savedCutover;
  const ids = { uniq: `ZKW${Date.now().toString(36).toUpperCase()}` };
  // Ids de usuario del reloj (≤ 9 caracteres, como el registro de 40 bytes).
  const uidBase = 200000000 + (Date.now() % 700000000);
  const uidA = String(uidBase);
  const uidB = String(uidBase + 1);
  const jwt = require('jsonwebtoken');
  const token = () => jwt.sign({ id: ids.admin, role: 'admin' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
  const post = async (url, body) => {
    const r = await fetch(base + url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const rows = async (sql, params) => (await conn.query(sql, params))[0];

  // inOutStatus: 0 = entrada, 1 = salida (tipo explícito para el recálculo).
  const RECORDS = [
    { deviceUserId: uidA, wall: '2026-10-04 23:59:59', inOutStatus: 1 },  // fuera (día anterior)
    { deviceUserId: uidA, wall: '2026-10-05 00:00:00', inOutStatus: 1 },  // primer instante del día
    { deviceUserId: uidA, wall: '2026-10-05 08:12:00', inOutStatus: 0 },
    { deviceUserId: uidA, wall: '2026-10-05 17:45:00', inOutStatus: 1 },
    { deviceUserId: uidA, wall: '2026-10-05 23:59:59', inOutStatus: 0 },  // último instante del día
    { deviceUserId: uidA, wall: '2026-10-06 00:00:00', inOutStatus: 1 },  // fuera (día siguiente)
    { deviceUserId: uidB, wall: '2026-10-05 07:58:00', inOutStatus: 0 },  // sin empleado al leer
    { deviceUserId: uidB, wall: '2026-10-05 16:03:00', inOutStatus: 1 },
  ];

  // Esperado, a partir de los literales de la fixture.
  const EXP_A_LOGS = [
    '2026-10-05 00:00:00 out', '2026-10-05 08:12:00 in', '2026-10-05 17:45:00 out', '2026-10-05 23:59:59 in',
  ];
  const EXP_STAGING_READ = [
    `A 2026-10-05 00:00:00 2026-10-05 00:00:00 mapped → 2026-10-05 00:00:00`,
    `B 2026-10-05 07:58:00 2026-10-05 07:58:00 unmapped → -`,
    `A 2026-10-05 08:12:00 2026-10-05 08:12:00 mapped → 2026-10-05 08:12:00`,
    `B 2026-10-05 16:03:00 2026-10-05 16:03:00 unmapped → -`,
    `A 2026-10-05 17:45:00 2026-10-05 17:45:00 mapped → 2026-10-05 17:45:00`,
    `A 2026-10-05 23:59:59 2026-10-05 23:59:59 mapped → 2026-10-05 23:59:59`,
  ];
  // Al releer, el staging marca 'duplicate' lo ya importado y CONSERVA el enlace.
  const EXP_STAGING_REPEAT = EXP_STAGING_READ.map((l) => l.replace(/^A (.*) mapped → /, 'A $1 duplicate → '));
  // Horario de la fixture: 08:00–17:00, tolerancia de entrada 5', de salida 0',
  // descanso 60'. A: 08:12→17:45 = 573' − 60' = 513'; tarde 7'; extra 45'.
  const EXP_SUMMARY_A = {
    first_in: '2026-10-05 08:12:00', last_out: '2026-10-05 17:45:00',
    worked_minutes: 513, late_minutes: 7, overtime_minutes: 45, status: 'late',
  };
  // B (tras vincularse y reprocesar): 07:58→16:03 = 485' − 60' = 425'; sin tarde ni extra.
  const EXP_SUMMARY_B = {
    first_in: '2026-10-05 07:58:00', last_out: '2026-10-05 16:03:00',
    worked_minutes: 425, late_minutes: 0, overtime_minutes: 0, status: 'present',
  };

  const label = (uid) => (uid === uidA ? 'A' : 'B');
  async function staging() {
    return (await rows(
      `SELECT r.device_user_id, DATE_FORMAT(r.record_time, '%Y-%m-%d %H:%i:%s') AS rt, r.record_time_py,
              r.mapping_status, DATE_FORMAT(a.\`timestamp\`, '%Y-%m-%d %H:%i:%s') AS linked
         FROM raw_device_punches r
         LEFT JOIN attendance_logs a ON a.id = r.imported_attendance_log_id
        WHERE r.device_id = ? ORDER BY r.record_time, r.device_user_id`, [ids.device],
    )).map((r) => `${label(r.device_user_id)} ${r.rt} ${r.record_time_py} ${r.mapping_status} → ${r.linked || '-'}`);
  }
  async function logsOf(empId) {
    return (await rows(
      "SELECT DATE_FORMAT(`timestamp`, '%Y-%m-%d %H:%i:%s') AS ts, type, source FROM attendance_logs WHERE employee_id = ? ORDER BY `timestamp`",
      [empId],
    )).map((r) => `${r.ts} ${r.type}${r.source === 'zkteco_direct' ? '' : ` (${r.source})`}`);
  }
  async function summaryOf(empId) {
    const [r] = await rows(
      `SELECT DATE_FORMAT(first_in, '%Y-%m-%d %H:%i:%s') AS first_in, DATE_FORMAT(last_out, '%Y-%m-%d %H:%i:%s') AS last_out,
              worked_minutes, late_minutes, overtime_minutes, status
         FROM daily_summary WHERE employee_id = ? AND date = ?`, [empId, DAY],
    );
    return r || null;
  }
  async function counts() {
    const [[a]] = await conn.query('SELECT COUNT(*) AS n FROM attendance_logs WHERE employee_id IN (?)', [[ids.empA, ids.empB || 0]]);
    const [[r]] = await conn.query('SELECT COUNT(*) AS n FROM raw_device_punches WHERE device_id = ?', [ids.device]);
    const [[s]] = await conn.query('SELECT COUNT(*) AS n FROM daily_summary WHERE employee_id IN (?) AND date = ?', [[ids.empA, ids.empB || 0], DAY]);
    return { attendance: Number(a.n), staging: Number(r.n), summary: Number(s.n) };
  }

  async function readDay(tz) {
    const r = await post('/api/devices/sync-jobs', { device_ids: [ids.device], from: DAY, to: DAY, attempts: 1 });
    expect(r.status).toBe(202);
    const jobId = r.body.jobs[0].id;
    await runSyncWorker({ conn, cfg, jobIds: [jobId], tz, recordsFile });
    const [job] = await rows('SELECT status, error, result FROM sync_jobs WHERE id = ?', [jobId]);
    return { ...job, result: typeof job.result === 'string' ? JSON.parse(job.result) : job.result };
  }

  async function removeEmployeeB() {
    if (!ids.empB) return;
    await conn.query('DELETE FROM attendance_logs WHERE employee_id = ?', [ids.empB]);
    await conn.query('DELETE FROM daily_summary WHERE employee_id = ?', [ids.empB]);
    await conn.query('DELETE FROM employees WHERE id = ?', [ids.empB]);
    ids.empB = null;
  }
  async function cleanup() {
    await removeEmployeeB();
    await conn.query('DELETE FROM attendance_logs WHERE employee_id = ?', [ids.empA]);
    await conn.query('DELETE FROM daily_summary WHERE employee_id = ?', [ids.empA]);
    await conn.query('DELETE FROM raw_device_punches WHERE device_id = ?', [ids.device]);
    await conn.query('DELETE FROM device_sync_runs WHERE device_id = ?', [ids.device]);
    await conn.query('DELETE FROM sync_jobs WHERE device_id = ?', [ids.device]);
    await conn.query('DELETE FROM device_locks WHERE device_id = ?', [ids.device]);
  }

  beforeAll(async () => {
    conn = await makeConn();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-wall-clock-'));
    recordsFile = path.join(tmpDir, 'records.json');
    process.env.FAKE_ZK_RECORDS = recordsFile;
    fs.writeFileSync(recordsFile, JSON.stringify(RECORDS));

    // Sin fecha de corte de FASE E durante la prueba (otra IT puede haberla
    // dejado): el recálculo automático usa el camino legacy. Se restaura al final.
    const [cut] = await rows('SELECT value FROM system_settings WHERE key_name = ?', [CUTOVER_KEY]).catch(() => [[]]);
    savedCutover = cut ? cut.value : undefined;
    if (savedCutover !== undefined) await conn.query('DELETE FROM system_settings WHERE key_name = ?', [CUTOVER_KEY]);

    const used = new Set((await rows("SELECT ip_address FROM devices WHERE ip_address LIKE '192.0.2.%'")).map((r) => r.ip_address));
    const octet = [...Array(254).keys()].map((i) => i + 1).find((i) => !used.has(`192.0.2.${i}`));
    const [dev] = await conn.query(
      "INSERT INTO devices (name, ip_address, port, connection_mode) VALUES (?, ?, 4370, 'auto')",
      [`${ids.uniq} reloj sintético`, `192.0.2.${octet}`],
    );
    ids.device = dev.insertId;
    const [sch] = await conn.query(
      `INSERT INTO schedules (name, check_in, check_out, tolerance_in, tolerance_out, break_minutes, work_days, active)
       VALUES (?, '08:00:00', '17:00:00', 5, 0, 60, '2,3,4,5,6', 1)`, [`${ids.uniq} horario fixture`],
    );
    ids.schedule = sch.insertId;
    const [emp] = await conn.query(
      "INSERT INTO employees (code, first_name, last_name, status, schedule_id) VALUES (?, 'Sintético', 'Pared', 'active', ?)",
      [uidA, ids.schedule],
    );
    ids.empA = emp.insertId;
    const [usr] = await conn.query(
      "INSERT INTO users (username, email, password_hash, full_name, role, active) VALUES (?, ?, 'it-no-login', 'IT hora de pared', 'admin', 1)",
      [`${ids.uniq}adm`, `${ids.uniq.toLowerCase()}adm@it.local`],
    );
    ids.admin = usr.insertId;

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
      await conn.query('DELETE FROM devices WHERE id = ?', [ids.device]).catch(() => {});
      if (savedCutover !== undefined) {
        await conn.query('INSERT INTO system_settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
          [CUTOVER_KEY, savedCutover]).catch(() => {});
      }
      await conn.end();
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await closeAppDb();
  });

  test.each(ZONES)('worker en %s: filtro, staging, asistencia, enlaces, duplicados, reproceso y daily_summary exactos', async (tz) => {
    await cleanup();

    // 1) Lectura del día: filtro por día de pared + staging + asistencia + recálculo.
    const first = await readDay(tz);
    expect(first.status).toBe('success');
    expect(first.result).toEqual({ total_read: 8, in_range: 6, imported: 4, skipped: 0, notFound: 2, partial: false });
    expect(await logsOf(ids.empA)).toEqual(EXP_A_LOGS);
    expect(await staging()).toEqual(EXP_STAGING_READ);
    expect(await summaryOf(ids.empA)).toEqual(EXP_SUMMARY_A);
    const afterFirst = await counts();
    expect(afterFirst).toEqual({ attendance: 4, staging: 6, summary: 1 });

    // 2) Repetir la lectura: la búsqueda de duplicados reconoce las 4 marcas.
    const again = await readDay(tz);
    expect(again.status).toBe('success');
    expect(again.result).toEqual({ total_read: 8, in_range: 6, imported: 0, skipped: 4, notFound: 2, partial: false });
    expect(await counts()).toEqual(afterFirst);
    expect(await logsOf(ids.empA)).toEqual(EXP_A_LOGS);
    expect(await staging()).toEqual(EXP_STAGING_REPEAT);
    expect(await summaryOf(ids.empA)).toEqual(EXP_SUMMARY_A);

    // 3) Alta del empleado de B y reproceso de sus marcas sin empleado (API, zona de jest).
    const [empB] = await conn.query(
      "INSERT INTO employees (code, first_name, last_name, status, schedule_id) VALUES (?, 'Sintético', 'Reproceso', 'active', ?)",
      [uidB, ids.schedule],
    );
    ids.empB = empB.insertId;
    const rep = await post('/api/devices/reprocess-unmapped', { from: DAY, to: DAY });
    expect(rep.body).toMatchObject({ ok: true, from: DAY, to: DAY, candidates: 2, mapped: 2, still_unmapped: 0, duplicate: 0, errors: 0 });
    expect(await logsOf(ids.empB)).toEqual(['2026-10-05 07:58:00 in', '2026-10-05 16:03:00 out']);
    expect(await staging()).toEqual(EXP_STAGING_REPEAT.map((l) => l
      .replace('B 2026-10-05 07:58:00 2026-10-05 07:58:00 unmapped → -', 'B 2026-10-05 07:58:00 2026-10-05 07:58:00 mapped → 2026-10-05 07:58:00')
      .replace('B 2026-10-05 16:03:00 2026-10-05 16:03:00 unmapped → -', 'B 2026-10-05 16:03:00 2026-10-05 16:03:00 mapped → 2026-10-05 16:03:00')));
    expect(await summaryOf(ids.empB)).toEqual(EXP_SUMMARY_B);
    expect(await summaryOf(ids.empA)).toEqual(EXP_SUMMARY_A);

    // 4) Reprocesar otra vez no crea filas.
    const before = await counts();
    const rep2 = await post('/api/devices/reprocess-unmapped', { from: DAY, to: DAY });
    expect(rep2.body).toMatchObject({ ok: true, candidates: 0 });
    expect(await counts()).toEqual(before);
  });
});
