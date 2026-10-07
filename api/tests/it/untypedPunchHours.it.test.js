'use strict';

/**
 * untypedPunchHours.it.test.js — DIAGNÓSTICO (MySQL real + HTTP real + worker
 * real en proceso aparte) del cálculo de horas cuando el reloj NO aporta el tipo
 * entrada/salida.
 *
 * El decodificador de node-zklib (TCP, 40 bytes) entrega usuario y hora, pero no
 * el byte de estado (punch) que el registro sí trae. El reloj simulado
 * (fixtures/fakeZk.js) usa ese decodificador REAL y, en los casos sin tipo, NO
 * agrega `inOutStatus`. Los controles agregan el tipo explícito (como #250) o
 * un contexto confiable (marca manual previa).
 *
 * Por cada caso se registra:
 *   - tipo y procedencia de cada marca (explícito / contextual / sin tipo);
 *   - daily_summary del recálculo LEGACY real (lo que hoy escribe el worker);
 *   - evaluación del MOTOR de jornada existente con `apply: false` (no escribe;
 *     se verifica que daily_summary no cambia) y su emparejamiento por tramo.
 *
 * Son pruebas de CARACTERIZACIÓN: fijan el comportamiento ACTUAL para poder
 * discutirlo, no el deseado. No se activa ningún writer ni flag.
 * Con UNTYPED_HOURS_EVIDENCE_OUT se escribe la matriz completa en JSON.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeIT, makeConn, closeAppDb, cfg } = require('./helper');
const { runSyncWorker } = require('./fixtures/syncWorkerProcess');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'it-untyped-hours-secret-0123456789abcdef';
process.env.REDIS_URL = 'disabled://';
process.env.WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED = 'false';
jest.setTimeout(180000);

const FROM = '2026-10-05';   // lunes
const TO = '2026-10-06';
const CUTOVER_KEY = 'fase_e_daily_summary_cutover_date';

// [clave, descripción, marcas [hora de pared, inOutStatus?], contexto manual previo]
const CASES = [
  ['dos_marcas', 'dos marcas diurnas sin tipo', [['2026-10-05 08:00:00'], ['2026-10-05 17:00:00']]],
  ['una_marca', 'una sola marca sin tipo', [['2026-10-05 08:00:00']]],
  ['duplicados', 'ráfagas duplicadas sin tipo', [['2026-10-05 08:00:00'], ['2026-10-05 08:00:40'], ['2026-10-05 17:00:00'], ['2026-10-05 17:00:20']]],
  ['varias', 'cuatro marcas (almuerzo) sin tipo', [['2026-10-05 08:00:00'], ['2026-10-05 12:00:00'], ['2026-10-05 13:00:00'], ['2026-10-05 17:00:00']]],
  ['nocturna', 'jornada que cruza medianoche sin tipo', [['2026-10-05 22:00:00'], ['2026-10-06 06:00:00']]],
  ['ctl_explicito', 'CONTROL: dos marcas con tipo explícito', [['2026-10-05 08:00:00', 0], ['2026-10-05 17:00:00', 1]]],
  ['ctl_explicito_nocturna', 'CONTROL: nocturna con tipo explícito', [['2026-10-05 22:00:00', 0], ['2026-10-06 06:00:00', 1]]],
  ['ctl_contexto', 'CONTROL: contexto confiable (salida manual el día anterior)', [['2026-10-05 08:00:00'], ['2026-10-05 17:00:00']], ['2026-10-04 18:00:00', 'out']],
];

describeIT('horas con marcas sin tipo (diagnóstico) — legacy vs motor en evaluación', () => {
  let conn;
  let server;
  let base;
  let tmpDir;
  let recordsFile;
  let savedCutover;
  const ids = { uniq: `UTH${Date.now().toString(36).toUpperCase()}`, emp: {} };
  const uidBase = 300000000 + (Date.now() % 600000000);
  const uidOf = (i) => String(uidBase + i);
  const matrix = {};
  const jwt = require('jsonwebtoken');
  const token = () => jwt.sign({ id: ids.admin, role: 'admin' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
  const rows = async (sql, params) => (await conn.query(sql, params))[0];

  beforeAll(async () => {
    conn = await makeConn();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'untyped-hours-'));
    recordsFile = path.join(tmpDir, 'records.json');

    const [cut] = await rows('SELECT value FROM system_settings WHERE key_name = ?', [CUTOVER_KEY]).catch(() => [[]]);
    savedCutover = cut ? cut.value : undefined;
    if (savedCutover !== undefined) await conn.query('DELETE FROM system_settings WHERE key_name = ?', [CUTOVER_KEY]);

    const used = new Set((await rows("SELECT ip_address FROM devices WHERE ip_address LIKE '192.0.2.%'")).map((r) => r.ip_address));
    const octet = [...Array(254).keys()].map((i) => i + 1).find((i) => !used.has(`192.0.2.${i}`));
    ids.device = (await conn.query(
      "INSERT INTO devices (name, ip_address, port, connection_mode) VALUES (?, ?, 4370, 'auto')",
      [`${ids.uniq} reloj sintético`, `192.0.2.${octet}`],
    ))[0].insertId;
    ids.schedule = (await conn.query(
      `INSERT INTO schedules (name, check_in, check_out, tolerance_in, tolerance_out, break_minutes, work_days, active)
       VALUES (?, '08:00:00', '17:00:00', 5, 0, 60, '2,3,4,5,6', 1)`, [`${ids.uniq} horario fixture`],
    ))[0].insertId;
    ids.admin = (await conn.query(
      "INSERT INTO users (username, email, password_hash, full_name, role, active) VALUES (?, ?, 'it-no-login', 'IT horas sin tipo', 'admin', 1)",
      [`${ids.uniq}adm`, `${ids.uniq.toLowerCase()}adm@it.local`],
    ))[0].insertId;

    const records = [];
    for (const [i, [key, , marks, ctx]] of CASES.entries()) {
      ids.emp[key] = (await conn.query(
        "INSERT INTO employees (code, first_name, last_name, status, schedule_id) VALUES (?, 'Sintético', ?, 'active', ?)",
        [uidOf(i), key, ids.schedule],
      ))[0].insertId;
      for (const [wall, inOutStatus] of marks) {
        records.push({ deviceUserId: uidOf(i), wall, ...(inOutStatus !== undefined ? { inOutStatus } : {}) });
      }
      if (ctx) {
        await conn.query(
          "INSERT INTO attendance_logs (employee_id, device_id, `timestamp`, type, source) VALUES (?, NULL, ?, ?, 'manual')",
          [ids.emp[key], ctx[0], ctx[1]],
        );
      }
    }
    fs.writeFileSync(recordsFile, JSON.stringify(records));

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/devices', require('../../src/routes/devices'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Error interno' }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;

    // Lectura real por la cola, con recálculo (legacy: el writer del motor está apagado).
    const r = await fetch(`${base}/api/devices/sync-jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [ids.device], from: FROM, to: TO, attempts: 1 }),
    });
    const body = await r.json();
    if (r.status !== 202) throw new Error(`sync-jobs ${r.status}: ${JSON.stringify(body)}`);
    ids.job = body.jobs[0].id;
    await runSyncWorker({ conn, cfg, jobIds: [ids.job], tz: process.env.TZ || 'America/Asuncion', recordsFile });
  });

  afterAll(async () => {
    if (process.env.UNTYPED_HOURS_EVIDENCE_OUT) {
      fs.writeFileSync(process.env.UNTYPED_HOURS_EVIDENCE_OUT, JSON.stringify(matrix, null, 1));
    }
    if (server) await new Promise((r) => server.close(r));
    if (conn) {
      const empIds = Object.values(ids.emp);
      if (empIds.length) {
        await conn.query('DELETE FROM attendance_logs WHERE employee_id IN (?)', [empIds]).catch(() => {});
        await conn.query('DELETE FROM daily_summary WHERE employee_id IN (?)', [empIds]).catch(() => {});
      }
      await conn.query('DELETE FROM raw_device_punches WHERE device_id = ?', [ids.device]).catch(() => {});
      await conn.query('DELETE FROM device_sync_runs WHERE device_id = ?', [ids.device]).catch(() => {});
      await conn.query('DELETE FROM sync_jobs WHERE device_id = ?', [ids.device]).catch(() => {});
      await conn.query('DELETE FROM device_locks WHERE device_id = ?', [ids.device]).catch(() => {});
      if (empIds.length) await conn.query('DELETE FROM employees WHERE id IN (?)', [empIds]).catch(() => {});
      await conn.query('DELETE FROM audit_events WHERE user_id = ?', [ids.admin]).catch(() => {});
      await conn.query('DELETE FROM users WHERE id = ?', [ids.admin]).catch(() => {});
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

  /** Marcas guardadas con tipo y procedencia (deducida de la fuente y del raw enlazado). */
  async function marksOf(empId) {
    const list = await rows(
      `SELECT a.id, DATE_FORMAT(a.\`timestamp\`, '%Y-%m-%d %H:%i:%s') AS wall, a.type, a.source,
              (SELECT CAST(r.raw_json AS CHAR) FROM raw_device_punches r WHERE r.imported_attendance_log_id = a.id LIMIT 1) AS raw
         FROM attendance_logs a WHERE a.employee_id = ? ORDER BY a.\`timestamp\`, a.id`, [empId],
    );
    const { explicitTypeFromRawJson } = require('../../src/services/punchTypeResolver');
    return list.map((m) => {
      let provenance;
      if (m.source !== 'zkteco_direct') provenance = `contexto (${m.source})`;
      else if (explicitTypeFromRawJson(m.raw)) provenance = 'explícito';
      else if (m.type === 'in' || m.type === 'out') provenance = 'contextual';
      else provenance = 'sin tipo';
      return { id: m.id, wall: m.wall, type: m.type, provenance };
    });
  }
  async function legacyOf(empId) {
    return rows(
      `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, DATE_FORMAT(first_in, '%Y-%m-%d %H:%i:%s') AS first_in,
              DATE_FORMAT(last_out, '%Y-%m-%d %H:%i:%s') AS last_out, worked_minutes, late_minutes, overtime_minutes, status
         FROM daily_summary WHERE employee_id = ? AND date BETWEEN ? AND ? ORDER BY date`, [empId, FROM, TO],
    );
  }
  async function engineOf(empId) {
    const svc = require('../../src/services/workdaySummaryService');
    const out = [];
    for (const date of [FROM, TO]) {
      const { rowsByEmployee } = await svc.resolveSummaryBatchForDate([empId], date, { apply: false });
      for (const r of rowsByEmployee.get(empId) || []) {
        if (r.date !== date || (!r.first_in && !r.last_out && !r.workday_count)) continue;
        out.push({
          date: r.date, first_in: r.first_in, last_out: r.last_out,
          worked_minutes: r.worked_minutes, presence_minutes: r.presence_minutes, net_worked_minutes: r.net_worked_minutes,
          break_minutes: r.break_minutes,
          late_minutes: r.late_minutes, overtime_minutes: r.overtime_minutes, status: r.status,
          calculation_mode: r.calculation_mode, crosses_midnight: r.crosses_midnight,
          anomalies: (r.anomalies || []).map((a) => (typeof a === 'string' ? a : a.code)),
        });
      }
    }
    return out;
  }
  /**
   * Horario CON VIGENCIA de la fixture para el motor (employee_schedule_history,
   * migraciones 072/073). El motor no usa employees.schedule_id; sin esta fila
   * resuelve `historical_fallback`. Se inserta sólo durante la evaluación.
   */
  async function withScheduleHistory(empId, fn) {
    const [r] = await conn.query(
      `INSERT INTO employee_schedule_history
         (employee_id, schedule_id, schedule_name_snapshot, valid_from, check_in, check_out, tolerance_in, tolerance_out,
          break_mode, break_minutes, break_after_minutes, work_days, snapshot_source, change_reason)
       VALUES (?, ?, 'horario fixture', '2026-01-01', '08:00:00', '17:00:00', 5, 0, 'fixed_unpaid', 60, 0, '2,3,4,5,6', 'manual', 'IT diagnóstico')`,
      [empId, ids.schedule],
    );
    try { return await fn(); } finally { await conn.query('DELETE FROM employee_schedule_history WHERE id = ?', [r.insertId]); }
  }
  const summarySnapshot = async (empId) => JSON.stringify(await rows(
    'SELECT date, first_in, last_out, worked_minutes, late_minutes, overtime_minutes, status, updated_at FROM daily_summary WHERE employee_id = ? ORDER BY date', [empId],
  ));

  /** Tramos del motor y si su emparejamiento salió de tipos o de la POSICIÓN. */
  async function segmentsOf(empId, marks) {
    const engine = require('../../src/services/workdayEngine');
    const byId = new Map(marks.map((m) => [m.id, m]));
    const { workdays, anomalies } = engine.buildWorkdays(marks.map((m) => ({ id: m.id, timestamp: m.wall, type: m.type })));
    const segs = workdays.flatMap((w) => w.segments.map((s) => {
      const tipos = (s.source_logs || []).map((id) => byId.get(id)?.type || '?');
      return {
        tramo: `${s.in}→${s.out || 'abierto'}`, minutos: s.minutes,
        tipos: tipos.join('/'),
        emparejado_por: tipos.every((t) => t === 'in' || t === 'out') ? 'tipos' : 'posición (unknown)',
      };
    }));
    return { segments: segs, global_anomalies: anomalies.map((a) => a.code) };
  }

  test('el job terminó y el motor en evaluación no escribe daily_summary', async () => {
    const [job] = await rows('SELECT status, result FROM sync_jobs WHERE id = ?', [ids.job]);
    expect(job.status).toBe('success');
    const empIds = Object.values(ids.emp);
    const snap = async () => JSON.stringify(await rows(
      'SELECT employee_id, date, first_in, last_out, worked_minutes, status, updated_at FROM daily_summary WHERE employee_id IN (?) ORDER BY employee_id, date', [empIds],
    ));
    const before = await snap();
    for (const id of empIds) await engineOf(id);
    expect(await snap()).toBe(before);
    matrix._job = typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
  });

  test.each(CASES.map(([k, d]) => [k, d]))('%s — %s', async (key, desc) => {
    const empId = ids.emp[key];
    const marks = await marksOf(empId);
    const legacy = await legacyOf(empId);
    const before = await summarySnapshot(empId);
    const engineRows = await engineOf(empId);
    const engineCfg = await withScheduleHistory(empId, () => engineOf(empId));
    // Evaluar el motor (con o sin horario) no escribe daily_summary.
    expect(await summarySnapshot(empId)).toBe(before);
    const seg = await segmentsOf(empId, marks);
    matrix[key] = { descripcion: desc, marks, legacy, engine: engineRows, engine_configurado: engineCfg, ...seg };

    const clockMarks = marks.filter((m) => m.provenance !== 'contexto (manual)');
    const pick = (list, date) => list.find((r) => r.date === date) || null;
    switch (key) {
      case 'dos_marcas':
        expect(clockMarks.map((m) => `${m.wall.slice(11)} ${m.type} ${m.provenance}`)).toEqual(['08:00:00 unknown sin tipo', '17:00:00 unknown sin tipo']);
        // Legacy: sólo cuenta in/out → sin horas, 'absent'.
        expect(pick(legacy, FROM)).toMatchObject({ first_in: null, last_out: null, worked_minutes: 0, status: 'absent' });
        // Motor: empareja por POSICIÓN y da horas completas sin ninguna anomalía.
        expect(pick(engineRows, FROM)).toMatchObject({ first_in: '2026-10-05 08:00:00', last_out: '2026-10-05 17:00:00', anomalies: [] });
        expect(seg.segments).toEqual([{ tramo: '2026-10-05 08:00:00→2026-10-05 17:00:00', minutos: 540, tipos: 'unknown/unknown', emparejado_por: 'posición (unknown)' }]);
        // Con horario vigente: mismas horas (neto 480 tras 60' de descanso), tampoco marca incertidumbre.
        expect(pick(engineCfg, FROM)).toMatchObject({ calculation_mode: 'configured', presence_minutes: 540, net_worked_minutes: 480, late_minutes: 0, anomalies: [] });
        expect(pick(engineRows, FROM)).toMatchObject({ calculation_mode: 'historical_fallback', presence_minutes: 540, net_worked_minutes: 540 });
        break;
      case 'una_marca':
        expect(clockMarks.map((m) => m.type)).toEqual(['unknown']);
        expect(pick(legacy, FROM)).toMatchObject({ worked_minutes: 0, status: 'absent' });
        expect(pick(engineRows, FROM)).toMatchObject({ first_in: '2026-10-05 08:00:00', last_out: null, worked_minutes: 0, anomalies: ['entrada_sin_salida'] });
        break;
      case 'duplicados':
        expect(clockMarks.map((m) => m.type)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
        expect(pick(legacy, FROM)).toMatchObject({ worked_minutes: 0, status: 'absent' });
        expect(pick(engineRows, FROM)).toMatchObject({ first_in: '2026-10-05 08:00:00', last_out: '2026-10-05 17:00:00' });
        expect(pick(engineRows, FROM).anomalies).toEqual(['marcaje_duplicado']);
        expect(seg.segments.map((s) => s.emparejado_por)).toEqual(['posición (unknown)']);
        break;
      case 'varias':
        expect(clockMarks.map((m) => m.type)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
        expect(pick(legacy, FROM)).toMatchObject({ worked_minutes: 0, status: 'absent' });
        expect(seg.segments.map((s) => `${s.tramo} ${s.emparejado_por}`)).toEqual([
          '2026-10-05 08:00:00→2026-10-05 12:00:00 posición (unknown)',
          '2026-10-05 13:00:00→2026-10-05 17:00:00 posición (unknown)',
        ]);
        expect(pick(engineRows, FROM).anomalies).toEqual([]);
        break;
      case 'nocturna':
        expect(clockMarks.map((m) => m.type)).toEqual(['unknown', 'unknown']);
        expect(legacy.map((r) => `${r.date} ${r.worked_minutes} ${r.status}`)).toEqual(['2026-10-05 0 absent', '2026-10-06 0 absent']);
        expect(pick(engineRows, FROM)).toMatchObject({ first_in: '2026-10-05 22:00:00', last_out: '2026-10-06 06:00:00', crosses_midnight: true, anomalies: [] });
        expect(seg.segments).toEqual([{ tramo: '2026-10-05 22:00:00→2026-10-06 06:00:00', minutos: 480, tipos: 'unknown/unknown', emparejado_por: 'posición (unknown)' }]);
        // El horario de la fixture es diurno (08:00): contra él, 22:00 es 835' de atraso.
        expect(pick(engineCfg, FROM)).toMatchObject({ calculation_mode: 'configured', late_minutes: 835, status: 'late' });
        break;
      case 'ctl_explicito':
        expect(clockMarks.map((m) => `${m.type} ${m.provenance}`)).toEqual(['in explícito', 'out explícito']);
        expect(pick(legacy, FROM)).toMatchObject({ first_in: '2026-10-05 08:00:00', last_out: '2026-10-05 17:00:00', worked_minutes: 480, status: 'present' });
        expect(pick(engineRows, FROM)).toMatchObject({ first_in: '2026-10-05 08:00:00', last_out: '2026-10-05 17:00:00', anomalies: [] });
        expect(pick(engineCfg, FROM)).toMatchObject({ calculation_mode: 'configured', presence_minutes: 540, net_worked_minutes: 480, anomalies: [] });
        expect(seg.segments.map((s) => s.emparejado_por)).toEqual(['tipos']);
        break;
      case 'ctl_explicito_nocturna':
        expect(clockMarks.map((m) => `${m.type} ${m.provenance}`)).toEqual(['in explícito', 'out explícito']);
        // Legacy agrupa por fecha civil: el 05 tiene IN sin OUT, el 06 OUT sin IN.
        expect(legacy.map((r) => `${r.date} ${r.first_in} ${r.last_out} ${r.worked_minutes}`)).toEqual([
          '2026-10-05 2026-10-05 22:00:00 null 0', '2026-10-06 null 2026-10-06 06:00:00 0',
        ]);
        expect(pick(engineRows, FROM)).toMatchObject({ first_in: '2026-10-05 22:00:00', last_out: '2026-10-06 06:00:00', crosses_midnight: true });
        expect(seg.segments.map((s) => s.emparejado_por)).toEqual(['tipos']);
        break;
      case 'ctl_contexto':
        // La salida manual del día anterior es contexto confiable: el resolver
        // infiere IN y luego OUT (procedencia contextual), sin explícitos.
        expect(marks.map((m) => `${m.wall} ${m.type} ${m.provenance}`)).toEqual([
          '2026-10-04 18:00:00 out contexto (manual)', '2026-10-05 08:00:00 in contextual', '2026-10-05 17:00:00 out contextual',
        ]);
        expect(pick(legacy, FROM)).toMatchObject({ first_in: '2026-10-05 08:00:00', last_out: '2026-10-05 17:00:00', worked_minutes: 480, status: 'present' });
        expect(pick(engineRows, FROM)).toMatchObject({ first_in: '2026-10-05 08:00:00', last_out: '2026-10-05 17:00:00' });
        expect(seg.segments.map((s) => s.emparejado_por)).toEqual(['tipos']);
        break;
      default:
        throw new Error(`caso sin aserciones: ${key}`);
    }
  });
});
