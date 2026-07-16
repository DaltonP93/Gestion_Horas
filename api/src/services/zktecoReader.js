/**
 * zktecoReader.js — Lectura DIRECTA de relojes ZKTeco → attendance_logs.
 *
 * Reutilizable por la ruta (/api/devices/backup-all, /:id/backup) y por el
 * script scripts/read-zkteco-now.js (sin Nginx, para lecturas largas).
 *
 * Claves:
 *  - Filtro por RANGO (from/to en hora Paraguay): el reloj devuelve TODO su
 *    buffer histórico; sólo se importan las marcas del rango pedido (evita
 *    re-importar años de datos al buscar sólo el hueco reciente).
 *  - source='zkteco_direct'.
 *  - Deduplicación CROSS-SOURCE por (employee_id, fecha-hora PY) contra
 *    cualquier origen (att2000/device/zkteco_direct/manual) + INSERT IGNORE.
 *  - Recalcula daily_summary de las fechas afectadas.
 *  - Timeout de lectura por reloj (no cuelga indefinidamente).
 */
const { sequelize } = require('../config/database');

// ─── Conexión ZKTeco (según connection_mode del device) ─────────
async function openZK(device) {
  const timeout = parseInt(device.timeout_ms || 12000);
  const mode = String(device.connection_mode || 'auto').toLowerCase();
  if (mode === 'udp') {
    const ZKLibUDP = require('node-zklib/zklibudp');
    const c = new ZKLibUDP(device.ip_address, device.port, timeout, 0);
    await c.createSocket(); await c.connect(); return c;
  }
  if (mode === 'tcp') {
    const ZKLibTCP = require('node-zklib/zklibtcp');
    const c = new ZKLibTCP(device.ip_address, device.port, timeout);
    await c.createSocket(); await c.connect(); return c;
  }
  const ZKLib = require('node-zklib');
  const zk = new ZKLib(device.ip_address, device.port, timeout, 0);
  await zk.createSocket(); return zk;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withZK(device, fn, { maxAttempts = 2, delayMs = 3000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let zk;
    try {
      zk = await openZK(device);
      const result = await fn(zk);
      try { await zk.disconnect(); } catch {}
      return result;
    } catch (err) {
      if (zk) { try { await zk.disconnect(); } catch {} }
      lastErr = err;
      const msg = err?.message || err?.err?.message || '';
      const isBusy = msg.includes('TIMEOUT_ON_WRITING');
      if (isBusy && attempt < maxAttempts) { await sleep(delayMs); continue; }
      break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr?.message || lastErr || 'Error de lectura'));
}

// ─── Helpers de hora Paraguay ───────────────────────────────────
const _pyDT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
function pyDateTimeStr(d) {
  const p = Object.fromEntries(_pyDT.formatToParts(d).map(x => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hh}:${p.minute}:${p.second}`;
}
function pyDateStr(d) { return pyDateTimeStr(d).slice(0, 10); }

function withTimeout(promise, ms, label) {
  if (!ms) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${label}) tras ${Math.round(ms / 1000)}s`)), ms)),
  ]);
}

/**
 * Lee un reloj y guarda en attendance_logs.
 * opts: { from, to, recalc=true, pushAtt2000=false, readTimeoutMs=45000 }
 *   from/to: 'YYYY-MM-DD' (hora Paraguay). Filtra el buffer del reloj a ese rango.
 * Devuelve un reporte por reloj (siempre; los errores se capturan arriba).
 */
async function backupDeviceDirect(device, opts = {}) {
  const { from = null, to = null, recalc = true, pushAtt2000 = false, readTimeoutMs = 45000, dryRun = false } = opts;
  const t0 = Date.now();
  const report = {
    device_id: device.id, device: device.name, ip: device.ip_address, dry_run: !!dryRun,
    range: { from, to },
    total_read: 0, in_range: 0, imported: 0, would_import: 0, skipped: 0, notFound: 0, dates: [], att2000: null,
    duration_ms: 0, sample: [],
  };

  const logs = await withTimeout(
    withZK(device, async zk => (await zk.getAttendances()).data, { maxAttempts: 2, delayMs: 3000 }),
    readTimeoutMs, 'lectura del reloj'
  );
  report.total_read = logs.length;
  if (!dryRun) await sequelize.query('UPDATE devices SET last_sync=NOW() WHERE id=?', { replacements: [device.id] });
  if (!logs.length) { report.duration_ms = Date.now() - t0; return report; }

  // Códigos → empleados activos.
  const codes = [...new Set(logs.map(l => String(l.deviceUserId)))];
  const [emps] = await sequelize.query(
    `SELECT id, code FROM employees WHERE status='active' AND code IN (${codes.map(() => '?').join(',')})`,
    { replacements: codes }
  );
  const empByCode = new Map(emps.map(e => [String(e.code), e.id]));

  // Candidatos válidos, filtrados por RANGO (hora Paraguay).
  const candidates = [];
  let minTs = null, maxTs = null;
  for (const l of logs) {
    const ts = new Date(l.attTime);
    if (isNaN(ts.getTime())) continue;
    const day = pyDateStr(ts);
    if (from && day < from) continue;
    if (to && day > to) continue;
    report.in_range++;
    const empId = empByCode.get(String(l.deviceUserId));
    if (!empId) { report.notFound++; continue; }
    const type = l.inOutStatus === 0 ? 'in' : (l.inOutStatus === 1 ? 'out' : 'unknown');
    candidates.push({ empId, ts, type });
    if (!minTs || ts < minTs) minTs = ts;
    if (!maxTs || ts > maxTs) maxTs = ts;
  }
  if (!candidates.length) { report.duration_ms = Date.now() - t0; return report; }

  // Dedup cross-source por (emp, fecha-hora PY).
  const empIds = [...new Set(candidates.map(c => c.empId))];
  const [existing] = await sequelize.query(
    `SELECT employee_id, DATE_FORMAT(\`timestamp\`, '%Y-%m-%d %H:%i:%s') AS ts
     FROM attendance_logs
     WHERE employee_id IN (${empIds.map(() => '?').join(',')}) AND \`timestamp\` BETWEEN ? AND ?`,
    { replacements: [...empIds, minTs, maxTs] }
  );
  const seen = new Set(existing.map(r => `${r.employee_id}|${r.ts}`));

  const toInsert = [];
  const dates = new Set();
  for (const c of candidates) {
    const key = `${c.empId}|${pyDateTimeStr(c.ts)}`;
    if (seen.has(key)) { report.skipped++; continue; }
    seen.add(key);
    toInsert.push([c.empId, device.id, c.ts, c.type, 'zkteco_direct']);
    dates.add(pyDateStr(c.ts));
  }

  // Modo dry-run: NO inserta ni recalcula. Sólo reporta lo que haría.
  if (dryRun) {
    report.would_import = toInsert.length;
    report.dates = [...dates].sort();
    report.sample = toInsert.slice(0, 20).map(([empId, , ts, type]) => ({
      employee_id: empId, ts_py: pyDateTimeStr(ts), type,
    }));
    report.duration_ms = Date.now() - t0;
    return report;
  }

  const CHUNK = 500;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const vals = chunk.map(() => '(?,?,?,?,?)').join(',');
    const [r] = await sequelize.query(
      `INSERT IGNORE INTO attendance_logs (employee_id, device_id, \`timestamp\`, type, source) VALUES ${vals}`,
      { replacements: chunk.flat() }
    );
    const affected = r?.affectedRows ?? 0;
    report.imported += affected;
    report.skipped += chunk.length - affected;
  }
  report.dates = [...dates].sort();

  if (recalc && report.dates.length) {
    const { bulkRecalcDailySummary, materializeAbsents } = require('./scheduler');
    for (const d of report.dates) {
      try { await bulkRecalcDailySummary(d); await materializeAbsents(d); } catch (e) { /* seguir */ }
    }
  }

  if (pushAtt2000) {
    try {
      const { writeCheckinOut } = require('../config/att2000');
      report.att2000 = await writeCheckinOut(logs.map(l => ({
        userId: l.deviceUserId, attTime: l.attTime, inOutStatus: l.inOutStatus,
        sensorId: device.id, verifyMode: l.verifyType ?? 0,
      })));
    } catch (e) { report.att2000 = { error: e.message }; }
  }

  report.duration_ms = Date.now() - t0;
  return report;
}

/**
 * readDeviceRaw — Diagnóstico READ-ONLY de un reloj. NO escribe nada
 * (ni attendance_logs, ni devices.last_sync). Sirve para verificar si el
 * reloj sigue registrando marcas.
 * opts: { timeoutMs=45000, recentSample=20, recentDays=10 }
 * Devuelve: conexión, cantidad leída, primera/última marca cruda,
 *   últimas N marcas, histograma por día de las marcas recientes,
 *   hora del reloj (si la librería lo permite) y duración.
 */
async function readDeviceRaw(device, opts = {}) {
  const { timeoutMs = 45000, recentSample = 20, recentDays = 10 } = opts;
  const t0 = Date.now();
  const report = {
    device_id: device.id, device: device.name, ip: device.ip_address,
    port: device.port, connection_mode: device.connection_mode || 'auto',
    connected: false, total_read: 0,
    first_mark: null, last_mark: null,
    device_time: null, device_info: null,
    recent: [], per_day: [], error: null, duration_ms: 0,
  };

  try {
    const data = await withTimeout(
      withZK(device, async zk => {
        const out = { logs: (await zk.getAttendances()).data, info: null, time: null };
        // Intentos best-effort de metadata; nunca deben tumbar el diagnóstico.
        try { if (typeof zk.getInfo === 'function') out.info = await zk.getInfo(); } catch {}
        try { if (typeof zk.getTime === 'function') out.time = await zk.getTime(); } catch {}
        return out;
      }, { maxAttempts: 2, delayMs: 3000 }),
      timeoutMs, 'lectura del reloj'
    );

    report.connected = true;
    const logs = data.logs || [];
    report.total_read = logs.length;
    report.device_info = data.info || null;
    if (data.time) { try { report.device_time = pyDateTimeStr(new Date(data.time)); } catch { report.device_time = String(data.time); } }

    if (logs.length) {
      const parsed = logs
        .map(l => ({ ts: new Date(l.attTime), userId: String(l.deviceUserId), st: l.inOutStatus }))
        .filter(x => !isNaN(x.ts.getTime()))
        .sort((a, b) => a.ts - b.ts);

      if (parsed.length) {
        const fmt = x => ({ user_id: x.userId, ts_py: pyDateTimeStr(x.ts), in_out: x.st });
        report.first_mark = fmt(parsed[0]);
        report.last_mark = fmt(parsed[parsed.length - 1]);
        report.recent = parsed.slice(-recentSample).reverse().map(fmt);

        // Histograma por día (últimos N días con marcas).
        const byDay = new Map();
        for (const x of parsed) {
          const d = pyDateStr(x.ts);
          byDay.set(d, (byDay.get(d) || 0) + 1);
        }
        report.per_day = [...byDay.entries()]
          .sort((a, b) => (a[0] < b[0] ? 1 : -1))
          .slice(0, recentDays)
          .map(([date, count]) => ({ date, count }));
      }
    }
  } catch (err) {
    report.error = err?.message || String(err);
  }

  report.duration_ms = Date.now() - t0;
  return report;
}

// Lee todos los relojes válidos (con IP), uno por uno, capturando errores.
// opts.deviceIds (array) → limita a esos relojes (para no bloquear los demás
// cuando uno está lento, p.ej. Lavadero con --device-id 2).
async function backupAllDevices(opts = {}) {
  const { deviceIds = null, ...deviceOpts } = opts;
  let sql = "SELECT * FROM devices WHERE ip_address IS NOT NULL AND TRIM(ip_address) <> ''";
  const replacements = [];
  if (Array.isArray(deviceIds) && deviceIds.length) {
    sql += ` AND id IN (${deviceIds.map(() => '?').join(',')})`;
    replacements.push(...deviceIds);
  }
  sql += ' ORDER BY id';
  const [devices] = await sequelize.query(sql, { replacements });
  const results = [];
  const totals = { imported: 0, skipped: 0, notFound: 0, would_import: 0 };
  for (const device of devices) {
    try {
      const r = await backupDeviceDirect(device, deviceOpts);
      totals.imported += r.imported; totals.skipped += r.skipped;
      totals.notFound += r.notFound; totals.would_import += (r.would_import || 0);
      results.push({ ...r, ok: true });
    } catch (err) {
      results.push({ device_id: device.id, device: device.name, ip: device.ip_address, ok: false, error: err.message });
    }
  }
  return { devices: devices.length, totals, results };
}

module.exports = { openZK, withZK, backupDeviceDirect, backupAllDevices, readDeviceRaw, pyDateStr, pyDateTimeStr };
