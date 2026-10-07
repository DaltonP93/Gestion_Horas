'use strict';

/**
 * syncJobsCivilRange.it.test.js — INTEGRACIÓN (MySQL real + HTTP real +
 * authenticate real + worker real en proceso aparte): el rango de lectura
 * manual por cola debe llegar al lector como FECHAS CIVILES de Paraguay.
 *
 * Circuito ejercido, sin atajos:
 *   POST /api/devices/sync-jobs (readRange) → INSERT en sync_jobs (DATE) →
 *   proceso real `src/workers/syncWorker.js` (claimNext → processJob) →
 *   backupDeviceDirect (filtro por día de Paraguay, staging, dedup e
 *   importación) → attendance_logs / raw_device_punches / device_sync_runs.
 *
 * Lo ÚNICO simulado es la comunicación con el reloj (`node-zklib`, ver
 * fixtures/fakeZk.js): devuelve marcaciones SINTÉTICAS. API y worker corren
 * sin Redis (REDIS_URL inválida → sus propios caminos de respaldo: lock por
 * reloj en MySQL y worker «sin WebSocket») y con el auto-polling bloqueado
 * (ZKTECO_AUTO_POLL=false). No hay relojes reales,
 * att2000 no participa y no se recalcula daily_summary (recalc:false).
 *
 * Las expectativas se derivan de los LITERALES de fecha civil de cada marca,
 * no del código bajo prueba.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeIT, makeConn, closeAppDb, cfg } = require('./helper');
const { runSyncWorker } = require('./fixtures/syncWorkerProcess');

jest.mock('node-zklib', () => require('./fixtures/fakeZk').FakeZK);
jest.mock('node-zklib/zklibtcp', () => require('./fixtures/fakeZk').FakeZK);
jest.mock('node-zklib/zklibudp', () => require('./fixtures/fakeZk').FakeZK);

process.env.JWT_SECRET = process.env.JWT_SECRET || 'it-sync-civil-range-secret-0123456789abcdef';
// Sin Redis: URL inválida → la app usa su propio respaldo (lock por reloj en la
// tabla device_locks de MySQL). Una URL válida sin servidor deja connect() colgado.
process.env.REDIS_URL = 'disabled://';
jest.setTimeout(120000);

const ZONES = ['UTC', 'America/Asuncion', 'Asia/Tokyo'];
// Zona que DECLARA ecosystem.config.js para el worker (el entorno efectivo de
// producción no está verificado). Las pruebas de un solo escenario usan esta;
// la prueba entre zonas recorre las tres.
const WORKER_TZ = 'America/Asuncion';

// Marcaciones sintéticas: hora de pared del reloj (Paraguay).
const MAPPED_WALL = [
  '2026-09-30 23:59:59',
  '2026-10-01 00:00:00',
  '2026-10-01 08:00:00',
  '2026-10-04 23:59:59',
  '2026-10-05 00:00:00',
  '2026-10-05 17:00:00',
  '2026-10-05 23:59:59',
  '2026-10-06 00:00:00',
  '2026-10-07 00:30:00',
  '2026-10-30 23:59:59',
  '2026-10-31 00:00:00',
  '2026-10-31 12:00:00',
  '2026-11-01 23:59:59',
  '2026-11-02 00:00:00',
];
const UNMAPPED_WALL = ['2026-10-03 09:00:00'];
const inCivilRange = (wall, from, to) => wall.slice(0, 10) >= from && wall.slice(0, 10) <= to;

describeIT('lectura manual por cola (integración) — rango civil de Paraguay de punta a punta', () => {
  let conn;
  let server;
  let base;
  let tmpDir;
  let recordsFile;
  const ids = { uniq: `SCR${Date.now().toString(36).toUpperCase()}` };
  // Ids de usuario del reloj: el registro de 40 bytes admite hasta 9 caracteres.
  const uidBase = 100000000 + (Date.now() % 800000000);
  const codeA = () => String(uidBase);
  const codeU = () => String(uidBase + 1);
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

  function writeRecords(list) {
    fs.writeFileSync(recordsFile, JSON.stringify(list));
  }
  const allRecords = () => [
    ...MAPPED_WALL.map((w) => ({ deviceUserId: codeA(), wall: w })),
    ...UNMAPPED_WALL.map((w) => ({ deviceUserId: codeU(), wall: w })),
  ];

  async function cleanup() {
    await conn.query('DELETE FROM attendance_logs WHERE employee_id = ?', [ids.empA]);
    await conn.query('DELETE FROM raw_device_punches WHERE device_id = ?', [ids.device]);
    await conn.query('DELETE FROM device_sync_runs WHERE device_id = ?', [ids.device]);
    await conn.query('DELETE FROM sync_jobs WHERE device_id = ?', [ids.device]);
    await conn.query('DELETE FROM device_locks WHERE device_id = ?', [ids.device]);
  }

  /** Corre el worker REAL en un proceso aparte hasta que terminen los trabajos. */
  const runWorker = (jobIds, tz) => runSyncWorker({ conn, cfg, jobIds, tz, recordsFile });

  async function enqueue(body) {
    const r = await post('/api/devices/sync-jobs', { device_ids: [ids.device], recalc: false, attempts: 1, ...body });
    expect(r.status).toBe(202);
    expect(r.body.ok).toBe(true);
    return r;
  }

  /** Lo que el circuito dejó en MySQL para un trabajo. */
  async function outcome(jobId) {
    const [job] = await rows(
      `SELECT status, error, result, DATE_FORMAT(date_from, '%Y-%m-%d') AS date_from,
              DATE_FORMAT(date_to, '%Y-%m-%d') AS date_to
         FROM sync_jobs WHERE id = ?`, [jobId],
    );
    const result = typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
    const runs = await rows(
      'SELECT from_date, to_date FROM device_sync_runs WHERE device_id = ? ORDER BY id', [ids.device],
    );
    const imported = (await rows(
      "SELECT DATE_FORMAT(`timestamp`, '%Y-%m-%d %H:%i:%s') AS ts FROM attendance_logs WHERE employee_id = ? ORDER BY `timestamp`",
      [ids.empA],
    )).map((r) => r.ts);
    const staged = (await rows(
      'SELECT device_user_id, record_time_py FROM raw_device_punches WHERE device_id = ? ORDER BY record_time_py, device_user_id',
      [ids.device],
    )).map((r) => `${r.device_user_id === codeA() ? 'A' : 'U'} ${r.record_time_py}`);
    return { job: { ...job, result }, runs, imported, staged };
  }

  function expected(from, to) {
    const mapped = MAPPED_WALL.filter((w) => inCivilRange(w, from, to));
    const unmapped = UNMAPPED_WALL.filter((w) => inCivilRange(w, from, to));
    return {
      imported: mapped,
      // Mismo orden que la consulta: hora civil y luego usuario.
      staged: [...mapped.map((w) => `A ${w}`), ...unmapped.map((w) => `U ${w}`)]
        .sort((a, b) => a.slice(2).localeCompare(b.slice(2)) || a.localeCompare(b)),
      result: {
        total_read: MAPPED_WALL.length + UNMAPPED_WALL.length,
        in_range: mapped.length + unmapped.length,
        imported: mapped.length,
        skipped: 0,
        notFound: unmapped.length,
        partial: false,
      },
    };
  }

  async function readRangeThroughCircuit(from, to, tz = WORKER_TZ) {
    const r = await enqueue({ from, to });
    expect({ from: r.body.from, to: r.body.to }).toEqual({ from, to });
    const jobId = r.body.jobs[0].id;
    await runWorker([jobId], tz);
    return outcome(jobId);
  }

  beforeAll(async () => {
    conn = await makeConn();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-civil-range-'));
    recordsFile = path.join(tmpDir, 'records.json');
    process.env.FAKE_ZK_RECORDS = recordsFile;   // reloj simulado de este proceso (rutas /backup)
    writeRecords(allRecords());

    // IP de documentación (TEST-NET-1, RFC 5737): nunca es un reloj real.
    const used = new Set((await rows("SELECT ip_address FROM devices WHERE ip_address LIKE '192.0.2.%'"))
      .map((r) => r.ip_address));
    const octet = [...Array(254).keys()].map((i) => i + 1).find((i) => !used.has(`192.0.2.${i}`));
    const [dev] = await conn.query(
      "INSERT INTO devices (name, ip_address, port, connection_mode) VALUES (?, ?, 4370, 'auto')",
      [`${ids.uniq} reloj sintético`, `192.0.2.${octet}`],
    );
    ids.device = dev.insertId;
    const [emp] = await conn.query(
      "INSERT INTO employees (code, first_name, last_name, status) VALUES (?, 'Sintético', 'Rango', 'active')",
      [codeA()],
    );
    ids.empA = emp.insertId;
    const [usr] = await conn.query(
      "INSERT INTO users (username, email, password_hash, full_name, role, active) VALUES (?, ?, 'it-no-login', 'IT rango civil', 'admin', 1)",
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

  afterEach(() => { jest.useRealTimers(); });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (conn) {
      await cleanup().catch(() => {});
      await conn.query('DELETE FROM audit_events WHERE user_id = ?', [ids.admin]).catch(() => {});
      await conn.query('DELETE FROM users WHERE id = ?', [ids.admin]).catch(() => {});
      await conn.query('DELETE FROM employees WHERE id = ?', [ids.empA]).catch(() => {});
      await conn.query('DELETE FROM devices WHERE id = ?', [ids.device]).catch(() => {});
      await conn.end();
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await closeAppDb();
  });

  beforeEach(async () => {
    writeRecords(allRecords());
    await cleanup();
  });

  test('2026-10-01..2026-10-05 llega idéntico al lector e importa el primer y el último día', async () => {
    const out = await readRangeThroughCircuit('2026-10-01', '2026-10-05');
    const exp = expected('2026-10-01', '2026-10-05');
    // Columnas DATE de la cola: el día pedido, sin corrimiento.
    expect({ from: out.job.date_from, to: out.job.date_to }).toEqual({ from: '2026-10-01', to: '2026-10-05' });
    // Lo que recibió el lector (backupDeviceDirect registra opts.from/opts.to).
    expect(out.runs).toEqual([{ from_date: '2026-10-01', to_date: '2026-10-05' }]);
    expect(out.job.status).toBe('success');
    expect(out.job.result).toEqual(exp.result);
    // Primer instante del primer día y último instante del último día: dentro.
    expect(out.imported).toEqual(exp.imported);
    expect(out.imported).toContain('2026-10-01 00:00:00');
    expect(out.imported).toContain('2026-10-05 23:59:59');
    // Vecinos inmediatos fuera del rango: excluidos de asistencia y de staging.
    expect(out.imported).not.toContain('2026-09-30 23:59:59');
    expect(out.imported).not.toContain('2026-10-06 00:00:00');
    expect(out.staged).toEqual(exp.staged);
  });

  test('rango de un solo día (2026-10-05..2026-10-05)', async () => {
    const out = await readRangeThroughCircuit('2026-10-05', '2026-10-05');
    const exp = expected('2026-10-05', '2026-10-05');
    expect(out.runs).toEqual([{ from_date: '2026-10-05', to_date: '2026-10-05' }]);
    expect(out.job.result).toEqual(exp.result);
    expect(out.imported).toEqual(['2026-10-05 00:00:00', '2026-10-05 17:00:00', '2026-10-05 23:59:59']);
    expect(out.staged).toEqual(exp.staged);
  });

  test('rango que cruza de mes (2026-10-31..2026-11-01)', async () => {
    const out = await readRangeThroughCircuit('2026-10-31', '2026-11-01');
    const exp = expected('2026-10-31', '2026-11-01');
    expect(out.runs).toEqual([{ from_date: '2026-10-31', to_date: '2026-11-01' }]);
    expect(out.job.result).toEqual(exp.result);
    expect(out.imported).toEqual(['2026-10-31 00:00:00', '2026-10-31 12:00:00', '2026-11-01 23:59:59']);
    expect(out.imported).not.toContain('2026-10-30 23:59:59');
    expect(out.imported).not.toContain('2026-11-02 00:00:00');
  });

  test('repetir la lectura no duplica asistencia ni staging en MySQL', async () => {
    const first = await readRangeThroughCircuit('2026-10-01', '2026-10-05');
    const exp = expected('2026-10-01', '2026-10-05');
    expect(first.imported).toEqual(exp.imported);
    const again = await enqueue({ from: '2026-10-01', to: '2026-10-05' });
    await runWorker([again.body.jobs[0].id], WORKER_TZ);
    const second = await outcome(again.body.jobs[0].id);
    expect(second.job.status).toBe('success');
    expect(second.job.result).toEqual({ ...exp.result, imported: 0, skipped: exp.imported.length });
    expect(second.imported).toEqual(first.imported);
    expect(second.staged).toEqual(first.staged);
    const [{ n }] = await rows('SELECT COUNT(*) AS n FROM attendance_logs WHERE employee_id = ?', [ids.empA]);
    expect(Number(n)).toBe(exp.imported.length);
  });

  // Rango, filtro, contadores, staging y horas importadas no dependen de la
  // zona del proceso del worker (el reloj simulado decodifica con node-zklib
  // real, que arma la hora en la zona local del proceso).
  test('el resultado es idéntico con el worker en UTC, America/Asuncion y Asia/Tokyo', async () => {
    const exp = expected('2026-10-01', '2026-10-05');
    const byZone = {};
    for (const tz of ZONES) {
      await cleanup();
      const out = await readRangeThroughCircuit('2026-10-01', '2026-10-05', tz);
      byZone[tz] = {
        job: { from: out.job.date_from, to: out.job.date_to, status: out.job.status },
        runs: out.runs, result: out.job.result, staged: out.staged, imported: out.imported,
      };
    }
    for (const tz of ZONES) {
      expect({ tz, ...byZone[tz] }).toEqual({
        tz,
        job: { from: '2026-10-01', to: '2026-10-05', status: 'success' },
        runs: [{ from_date: '2026-10-01', to_date: '2026-10-05' }],
        result: exp.result,
        staged: exp.staged,
        imported: exp.imported,
      });
    }
  });

  // Valores por defecto (sin from/to) cerca de la medianoche UTC. Paraguay
  // está en UTC-3: entre las 21:00 y las 23:59 de Paraguay ya es «mañana» en UTC.
  const NOT_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
    'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate',
    'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
  const freezeNow = (instant) => jest.useFakeTimers({ doNotFake: NOT_DATE, now: new Date(instant) });
  const DEFAULT_CASES = [
    // [instante UTC, hora de Paraguay, desde, hasta]
    ['2026-10-06T15:00:00Z', '2026-10-06 12:00', '2026-10-03', '2026-10-06'],
    ['2026-10-06T23:59:59Z', '2026-10-06 20:59', '2026-10-03', '2026-10-06'],
    ['2026-10-07T00:00:00Z', '2026-10-06 21:00', '2026-10-03', '2026-10-06'],
    ['2026-10-07T01:30:00Z', '2026-10-06 22:30', '2026-10-03', '2026-10-06'],
    ['2026-10-07T02:59:59Z', '2026-10-06 23:59', '2026-10-03', '2026-10-06'],
    ['2026-10-07T03:00:00Z', '2026-10-07 00:00', '2026-10-04', '2026-10-07'],
    ['2026-11-01T01:00:00Z', '2026-10-31 22:00', '2026-10-28', '2026-10-31'],
  ];

  test.each(DEFAULT_CASES)('sync-jobs sin fechas a las %s (Paraguay %s) usa %s..%s', async (instant, _py, from, to) => {
    freezeNow(instant);
    const r = await post('/api/devices/sync-jobs', { device_ids: [ids.device], recalc: false, attempts: 1 });
    expect(r.status).toBe(202);
    expect({ from: r.body.from, to: r.body.to }).toEqual({ from, to });
    const [job] = await rows(
      "SELECT DATE_FORMAT(date_from, '%Y-%m-%d') AS f, DATE_FORMAT(date_to, '%Y-%m-%d') AS t FROM sync_jobs WHERE id = ?",
      [r.body.jobs[0].id],
    );
    expect({ from: job.f, to: job.t }).toEqual({ from, to });
  });

  test('los demás consumidores de readRange usan el mismo día de Paraguay por defecto', async () => {
    writeRecords([]);   // el reloj simulado no devuelve marcas: sólo interesa el rango
    freezeNow('2026-10-07T01:30:00Z');   // 2026-10-06 22:30 en Paraguay
    const want = { from: '2026-10-03', to: '2026-10-06' };
    const backup = await post(`/api/devices/${ids.device}/backup`, { attempts: 1 });
    expect(backup.status).toBe(200);
    expect({ from: backup.body.from, to: backup.body.to }).toEqual(want);
    const reprocess = await post('/api/devices/reprocess-unmapped', {});
    expect({ from: reprocess.body.from, to: reprocess.body.to }).toEqual(want);
    const all = await post('/api/devices/backup-all', { attempts: 1 });
    expect({ from: all.body.from, to: all.body.to }).toEqual(want);
    // El lector recibió ese mismo rango (device_sync_runs del reloj sintético).
    const runs = await rows('SELECT from_date, to_date FROM device_sync_runs WHERE device_id = ? ORDER BY id', [ids.device]);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    for (const run of runs) expect({ from: run.from_date, to: run.to_date }).toEqual(want);
  });

  test('«Sincronizar ahora» sin fechas de día importa las marcas de HOY en Paraguay', async () => {
    freezeNow('2026-10-06T15:00:00Z');   // 2026-10-06 12:00 en Paraguay
    const r = await post('/api/devices/sync-jobs', { device_ids: [ids.device], recalc: false, attempts: 1 });
    expect(r.status).toBe(202);
    jest.useRealTimers();
    await runWorker([r.body.jobs[0].id], WORKER_TZ);
    const out = await outcome(r.body.jobs[0].id);
    const exp = expected('2026-10-03', '2026-10-06');
    expect(out.runs).toEqual([{ from_date: '2026-10-03', to_date: '2026-10-06' }]);
    expect(out.imported).toEqual(exp.imported);
    expect(out.imported).toContain('2026-10-06 00:00:00');
    expect(out.imported).not.toContain('2026-10-07 00:30:00');
    expect(out.job.result).toEqual(exp.result);
  });
});
