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

// ─── Normalización de registros ZKTeco ──────────────────────────
// node-zklib decodifica getAttendances() como { deviceUserId, recordTime }
// (decodeRecordData40/16). Otras versiones/firmwares usan attTime, timestamp,
// userId, uid, etc. y algunos exponen in/out (inOutStatus/state). Aceptamos
// varias formas para no depender de un único nombre de campo.
const TS_FIELDS = ['recordTime', 'attTime', 'timestamp', 'punchTime', 'verifyTime', 'time', 'dateTime', 'logTime', 'attendanceTime', 'checkTime'];
const UID_FIELDS = ['deviceUserId', 'userId', 'uid', 'user_id', 'enrollNumber', 'enrollNo', 'userSn', 'id'];
const INOUT_FIELDS = ['inOutStatus', 'state', 'status', 'type'];

function pickField(obj, fields) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const f of fields) {
    const v = obj[f];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// Decodifica el entero compuesto ZK ("segundos desde 2000") a Date local.
// (Misma fórmula que node-zklib parseTimeToDate, por si un registro llega
// como número crudo en vez de Date.)
function zkIntToDate(t) {
  let time = t;
  const second = time % 60; time = (time - second) / 60;
  const minute = time % 60; time = (time - minute) / 60;
  const hour = time % 24; time = (time - hour) / 24;
  const day = time % 31 + 1; time = (time - (day - 1)) / 31;
  const month = time % 12; time = (time - month) / 12;
  const year = time + 2000;
  const d = new Date(year, month, day, hour, minute, second);
  return isNaN(d.getTime()) ? null : d;
}

// Convierte cualquier forma de timestamp (Date, string, número, Buffer) a Date.
function coerceDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const sane = d => d && !isNaN(d.getTime()) && d.getFullYear() >= 2010 && d.getFullYear() <= 2100 ? d : null;
  if (typeof v === 'string') { const d = new Date(v); return sane(d); }
  if (typeof v === 'number') {
    return sane(new Date(v))            // epoch ms
      || sane(new Date(v * 1000))       // epoch segundos
      || sane(zkIntToDate(v));          // entero compuesto ZK
  }
  if (Buffer.isBuffer(v)) {
    try {
      if (v.length >= 6) return sane(new Date(2000 + v[0], Math.max(0, (v[1] || 1) - 1), v[2] || 1, v[3] || 0, v[4] || 0, v[5] || 0));
      if (v.length >= 4) return sane(zkIntToDate(v.readUInt32LE(0)));
    } catch { /* ignore */ }
  }
  return null;
}

// Devuelve { ts:Date|null, userId:string|null, inout } desde un registro crudo.
function normalizeRecord(l) {
  const ts = coerceDate(pickField(l, TS_FIELDS));
  const uid = pickField(l, UID_FIELDS);
  const inout = pickField(l, INOUT_FIELDS);
  return { ts, userId: uid != null ? String(uid) : null, inout };
}

// Mapea un valor de in/out explícito a 'in'/'out'; null si no es concluyente.
function explicitType(inout) {
  if (inout === 0 || inout === '0' || inout === 'in') return 'in';
  if (inout === 1 || inout === '1' || inout === 'out') return 'out';
  return null;
}

// Qué campos trae un registro (para el diagnóstico crudo).
const ALL_KNOWN_FIELDS = ['uid', 'id', 'userSn', 'userId', 'user_id', 'deviceUserId', 'enrollNumber', 'enrollNo',
  'timestamp', 'recordTime', 'attTime', 'verifyTime', 'punchTime', 'checkTime', 'time', 'dateTime', 'logTime', 'attendanceTime',
  'inOutStatus', 'state', 'status', 'type'];
function detectFields(sample) {
  if (!sample || typeof sample !== 'object') return [];
  return ALL_KNOWN_FIELDS.filter(f => sample[f] !== undefined);
}

// Los registros masivos de getAttendances() no traen in/out. Inferimos por
// orden temporal por (empleado, día PY): la primera marca = 'in', la última =
// 'out', las intermedias alternan. Respeta el in/out explícito si existe.
function resolveTypes(candidates) {
  const groups = new Map();
  for (const c of candidates) {
    const k = `${c.empId}|${pyDateStr(c.ts)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.ts - b.ts);
    arr.forEach((c, i) => { if (!c.type) c.type = i % 2 === 0 ? 'in' : 'out'; });
    // Con ≥2 marcas, garantizar que la última cuente como salida (para que
    // daily_summary calcule last_out y las horas trabajadas).
    const last = arr[arr.length - 1];
    if (arr.length >= 2 && !last.explicit && last.type === 'in') last.type = 'out';
  }
}

// Recomendación operativa según el error de conexión/lectura.
function recommendationFor(errMsg) {
  const m = String(errMsg || '');
  if (/TIMEOUT_ON_WRITING/i.test(m))
    return 'El reloj acepta la conexión pero no responde a la lectura. Causas típicas: el software "Attendance Management" (Windows) mantiene tomado el equipo, el reloj está ocupado, o saturación de red. Cerrar cualquier software conectado al reloj, verificar el puerto 4370 y reintentar. Probar el otro modo (TCP/UDP).';
  if (/ECONNREFUSED/i.test(m))
    return 'Conexión rechazada: puerto cerrado o servicio del reloj caído. Verificar IP y puerto 4370, y que el reloj esté encendido en red.';
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/i.test(m))
    return 'El reloj no es alcanzable en la red. Verificar IP, cableado/switch y VLAN.';
  if (/ETIMEDOUT|Timeout/i.test(m))
    return 'Sin respuesta del reloj (timeout). Verificar que esté encendido, en red, y que el puerto 4370 no esté bloqueado por firewall u otro software.';
  return 'Revisar equipo, red y puerto 4370; verificar que ningún otro software (p.ej. Attendance Management) tenga tomado el reloj.';
}

// Prueba de conexión aislada por modo (sólo abre/cierra socket; no lee marcas).
async function probeMode(device, mode, timeoutMs = 8000) {
  const d = { ...device, connection_mode: mode, timeout_ms: Math.min(timeoutMs, device.timeout_ms || timeoutMs) };
  try {
    const zk = await withTimeout(openZK(d), timeoutMs, `conexión ${mode}`);
    try { await zk.disconnect(); } catch {}
    return { mode, ok: true };
  } catch (e) {
    return { mode, ok: false, error: e?.message || e?.err?.message || String(e) };
  }
}

// ─── Limpieza de registros basura ───────────────────────────────
// El buffer del reloj suele traer relleno: userSn=0, deviceUserId vacío y
// recordTime=2000-01-01. Esos registros no son marcas reales.
function isJunkRaw(l) {
  if (!l || typeof l !== 'object') return true;
  const uid = pickField(l, UID_FIELDS);
  if (uid == null || String(uid).trim() === '') return true;   // sin usuario (incluye relleno userSn=0)
  const ts = coerceDate(pickField(l, TS_FIELDS));
  if (!ts || ts.getFullYear() <= 2001) return true;            // recordTime 2000-01-01 (relleno)
  return false;
}

// Lee attendances con reintentos y elige la MEJOR lectura. El buffer del GT200
// llega truncado: node-zklib readWithBuffer tiene un timeout INTER-PAQUETE fijo
// (10s) y, al vencer, RESUELVE con el buffer parcial + un `err` que el resto del
// código ignoraba. Ahora capturamos ese `err` (= lectura incompleta) y damos
// prioridad a las lecturas completas.
// Criterio de "mejor" (en orden): (a) NO truncada, (b) más marcas EN RANGO,
// (c) fecha válida más reciente, (d) más válidas, (e) menos basura.
async function readAttendancesStable(device, { readTimeoutMs = 45000, attempts = 1, from = null, to = null, cooldownMs = 0 } = {}) {
  const scoreOf = (logs, truncated) => {
    let valid = 0, inRange = 0, garbage = 0, maxTs = 0, minTs = 0;
    for (const l of logs) {
      if (isJunkRaw(l)) { garbage++; continue; }
      valid++;
      const ts = coerceDate(pickField(l, TS_FIELDS));
      if (!ts) continue;
      const t = ts.getTime();
      if (t > maxTs) maxTs = t;
      if (!minTs || t < minTs) minTs = t;
      if (from || to) { const d = pyDateStr(ts); if ((from && d < from) || (to && d > to)) continue; }
      inRange++;
    }
    return { total: logs.length, valid, inRange, garbage, maxTs, minTs, truncated: !!truncated };
  };

  const reads = [];
  const detail = [];
  const covers = r => !r.truncated && (r.inRange > 0 || (!from && !to));
  for (let i = 0; i < Math.max(1, attempts); i++) {
    if (i > 0 && cooldownMs > 0) await sleep(cooldownMs);   // enfriar y NO reusar sesión
    const t0 = Date.now();
    let logs = [], truncated = false, err = null;
    try {
      const res = await withTimeout(
        withZK(device, async zk => await zk.getAttendances(), { maxAttempts: 2, delayMs: 3000 }),
        readTimeoutMs, 'lectura del reloj'
      );
      logs = (res && Array.isArray(res.data)) ? res.data : (Array.isArray(res) ? res : []);
      truncated = !!(res && res.err);   // buffer incompleto (TIMEOUT WHEN RECEIVING PACKET)
    } catch (e) {
      // Si TODOS los intentos fallan, relanzamos al final; acá seguimos probando.
      err = e?.message || String(e);
    }
    const sc = err ? { total: 0, valid: 0, inRange: 0, garbage: 0, maxTs: 0, minTs: 0, truncated: true }
      : scoreOf(logs, truncated);
    reads.push({ logs, err, ...sc });
    detail.push({
      attempt: i + 1, mode: device.connection_mode || 'auto',
      raw: sc.total, valid: sc.valid, in_range: sc.inRange, garbage: sc.garbage,
      truncated: sc.truncated,
      first_valid: sc.minTs ? pyDateTimeStr(new Date(sc.minTs)) : null,
      last_valid: sc.maxTs ? pyDateTimeStr(new Date(sc.maxTs)) : null,
      duration_ms: Date.now() - t0, error: err,
    });
    // Early-stop: si ya tenemos una lectura COMPLETA que cubre el rango, basta.
    if (covers(reads[reads.length - 1])) break;
  }

  const okReads = reads.filter(r => !r.err);
  if (!okReads.length) {
    // Ningún intento devolvió datos: relanzar el último error real.
    throw new Error(reads[reads.length - 1]?.err || 'lectura del reloj falló');
  }
  const best = okReads.reduce((a, b) => {
    if (a.truncated !== b.truncated) return a.truncated ? b : a;   // completa > truncada
    if (b.inRange !== a.inRange) return b.inRange > a.inRange ? b : a;
    if (b.maxTs !== a.maxTs) return b.maxTs > a.maxTs ? b : a;
    if (b.valid !== a.valid) return b.valid > a.valid ? b : a;
    return b.garbage < a.garbage ? b : a;
  });
  const valids = okReads.map(r => r.valid);
  const spread = valids.length > 1 ? Math.max(...valids) - Math.min(...valids) : 0;
  const unstable = valids.length > 1 && spread > Math.max(20, 0.2 * Math.max(...valids));
  return {
    logs: best.logs, attempts: reads.length, detail,
    truncated: best.truncated, valids, inRanges: okReads.map(r => r.inRange), unstable,
  };
}

// Columnas de `employees` para AUTO-mapear deviceUserId (sólo las que existen).
// Sólo columnas confirmadas: code y employee_number. document_number es sólo
// PISTA de diagnóstico (no auto-mapea) porque no siempre corresponde.
const EMP_AUTO_MATCH = ['code', 'employee_number'];
const EMP_HINT_COLUMNS = ['code', 'employee_number', 'document_number'];
async function getExistingColumns(table, wanted) {
  const [cols] = await sequelize.query(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    { replacements: [table] }
  );
  const present = new Set(cols.map(x => x.c));
  return wanted.filter(c => present.has(c));
}
async function getEmployeeMatchColumns() {
  const cols = await getExistingColumns('employees', EMP_AUTO_MATCH);
  return cols.length ? cols : ['code'];
}
async function tableExists(table) {
  const [r] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    { replacements: [table] }
  );
  return (r[0]?.n || 0) > 0;
}

// Matcher deviceUserId → empleado con prioridad:
//   1) employee_device_map (device-específico, luego global)
//   2) employees.code
//   3) employees.employee_number
// Además expone `any` (todas las columnas de pista + estado) para diagnóstico.
async function buildEmployeeMatcher() {
  const columns = await getEmployeeMatchColumns();
  const hintCols = await getExistingColumns('employees', EMP_HINT_COLUMNS);
  const allCols = [...new Set([...columns, ...hintCols])];
  const [emps] = await sequelize.query(
    `SELECT id, status, ${allCols.map(c => `\`${c}\``).join(', ')} FROM employees`
  );
  const active = new Map();   // clave (code/employee_number) → id (sólo activos)
  const any = new Map();      // clave (cualquier col de pista) → {id, via, status}
  for (const e of emps) {
    for (const col of hintCols) {
      const v = e[col];
      if (v == null || String(v).trim() === '') continue;
      const key = String(v).trim();
      if (!any.has(key)) any.set(key, { id: e.id, via: col, status: e.status });
    }
    for (const col of columns) {  // sólo columnas de AUTO-mapeo van a `active`
      const v = e[col];
      if (v == null || String(v).trim() === '') continue;
      const key = String(v).trim();
      if (e.status === 'active' && !active.has(key)) active.set(key, e.id);
    }
  }

  // employee_device_map (si la tabla existe): clave `${device|*}|uid` → id.
  const byDevice = new Map();
  if (await tableExists('employee_device_map')) {
    const [maps] = await sequelize.query(
      `SELECT edm.employee_id, edm.device_id, edm.device_user_id
       FROM employee_device_map edm
       JOIN employees e ON e.id = edm.employee_id
       WHERE edm.active = 1 AND e.status = 'active'`
    );
    for (const m of maps) {
      const uid = String(m.device_user_id).trim();
      const dk = m.device_id == null ? '*' : String(m.device_id);
      byDevice.set(`${dk}|${uid}`, m.employee_id);
    }
  }

  const resolve = (deviceId, uid) => {
    if (uid == null) return null;
    const key = String(uid).trim();
    if (key === '') return null;
    return byDevice.get(`${deviceId}|${key}`)
      || byDevice.get(`*|${key}`)
      || active.get(key)
      || null;
  };

  return { active, any, byDevice, columns, resolve };
}

// Registra una lectura de reloj en device_sync_runs (auditoría). No dry-run.
// Best-effort: nunca debe tumbar la lectura.
async function recordSyncRun(device, { startedAt, report = null, error = null, opts = {}, sanitizeErr }) {
  try {
    if (!(await tableExists('device_sync_runs'))) return;
    const now = new Date();
    let status = 'success';
    let note = null;
    if (error) {
      status = /timeout/i.test(String(error?.message || error)) ? 'timeout' : 'error';
    } else if (report) {
      status = (report.partial || report.read_unstable || report.warn_unmapped) ? 'partial' : 'success';
      if (report.read_truncated) note = 'Lectura incompleta: el buffer del reloj llegó truncado (reintentá con más --attempts).';
      else if (report.partial) note = `Lectura completada pero NO cubre el rango solicitado (recibido ${report.first_valid || '?'} → ${report.last_valid || '?'}).`;
    }
    const errMsg = error ? String((sanitizeErr ? sanitizeErr(error) : (error.message || error))).slice(0, 500) : note;
    // attempts = intentos REALMENTE ejecutados (early-stop puede cortar antes);
    // attempts_requested = los pedidos. Antes `attempts` guardaba los pedidos.
    const executed = report?.read_attempts_detail?.length || (report ? 1 : (opts.attempts || 1));
    const requested = opts.attempts || executed;
    const detailJson = report?.read_attempts_detail?.length ? JSON.stringify(report.read_attempts_detail).slice(0, 4000) : null;
    const extraCols = await getExistingColumns('device_sync_runs', ['attempts_detail', 'attempts_requested']);
    const hasDetailCol = extraCols.includes('attempts_detail');
    const hasReqCol = extraCols.includes('attempts_requested');
    const cols = ['device_id', 'started_at', 'finished_at', 'status', 'raw_count', 'valid_count', 'in_range_count',
      'imported_count', 'duplicate_count', 'unmapped_count', 'garbage_count', 'first_valid_time',
      'last_valid_time', 'attempts', 'duration_ms', 'from_date', 'to_date', 'error_message', 'created_by'];
    const vals = [
      device.id, startedAt, now, status,
      report?.total_read || 0, report?.valid || 0, report?.in_range || 0,
      report?.imported || 0, report?.skipped || 0, report?.notFound || 0, report?.junk || 0,
      report?.first_valid || null, report?.last_valid || null,
      executed, report?.duration_ms ?? (now - startedAt),
      opts.from || null, opts.to || null, errMsg, opts.createdBy || null,
    ];
    if (hasReqCol) { cols.push('attempts_requested'); vals.push(requested); }
    if (hasDetailCol) { cols.push('attempts_detail'); vals.push(detailJson); }
    await sequelize.query(
      `INSERT INTO device_sync_runs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`,
      { replacements: vals }
    );
  } catch { /* auditoría best-effort */ }
}

/**
 * Lee un reloj y guarda en attendance_logs. Envuelve la lógica real y registra
 * el resultado en device_sync_runs (salvo dry-run).
 * opts: { from, to, recalc, pushAtt2000, readTimeoutMs, dryRun, attempts, createdBy }
 */
async function backupDeviceDirect(device, opts = {}) {
  const startedAt = new Date();
  try {
    const report = await _backupDeviceDirectImpl(device, opts);
    if (!opts.dryRun) await recordSyncRun(device, { startedAt, report, opts });
    return report;
  } catch (err) {
    if (!opts.dryRun) await recordSyncRun(device, { startedAt, error: err, opts });
    throw err;
  }
}

async function _backupDeviceDirectImpl(device, opts = {}) {
  const { from = null, to = null, recalc = true, pushAtt2000 = false, readTimeoutMs = 45000, dryRun = false, debugRaw = false, attempts = 1, cooldownMs = 0 } = opts;
  const t0 = Date.now();
  const report = {
    device_id: device.id, device: device.name, ip: device.ip_address, dry_run: !!dryRun,
    range: { from, to },
    total_read: 0, junk: 0, valid: 0, with_date: 0, without_date: 0, with_user: 0,
    in_range: 0, out_of_range: 0, first_valid: null, last_valid: null,
    staged: 0, imported: 0, would_import: 0, skipped: 0, notFound: 0,
    unmapped_distinct: 0, unmapped_top: [], warn_unmapped: false,
    match_columns: [], read_unstable: false, read_truncated: false, partial: false,
    read_attempts_detail: [], dates: [], att2000: null,
    duration_ms: 0, sample: [], debug: null,
  };

  // Lectura estable (varios intentos con cooldown, mejor lectura por
  // completa/en-rango/fecha/válidos; detecta buffers truncados del GT200).
  const stable = await readAttendancesStable(device, { readTimeoutMs, attempts, from, to, cooldownMs });
  const rawLogs = stable.logs;
  report.total_read = rawLogs.length;
  report.read_unstable = stable.unstable;
  report.read_truncated = stable.truncated;
  report.read_attempts_detail = stable.detail;
  if (stable.attempts > 1) report.read_attempts = { attempts: stable.attempts, valids: stable.valids };
  if (!dryRun) await sequelize.query('UPDATE devices SET last_sync=NOW() WHERE id=?', { replacements: [device.id] });
  if (!rawLogs.length) { report.duration_ms = Date.now() - t0; return report; }

  // Descartar registros basura (relleno del buffer) ANTES de normalizar.
  const logs = rawLogs.filter(l => !isJunkRaw(l));
  report.junk = rawLogs.length - logs.length;
  report.valid = logs.length;

  // Normalizar los registros limpios (acepta recordTime/attTime/… y varios uid).
  const norm = logs.map(normalizeRecord);

  // Contadores globales de diagnóstico (independientes del rango).
  let minValid = null, maxValid = null;
  for (const n of norm) {
    if (n.ts) {
      report.with_date++;
      if (!minValid || n.ts < minValid) minValid = n.ts;
      if (!maxValid || n.ts > maxValid) maxValid = n.ts;
    } else report.without_date++;
    if (n.userId) report.with_user++;
  }
  report.first_valid = minValid ? pyDateTimeStr(minValid) : null;
  report.last_valid = maxValid ? pyDateTimeStr(maxValid) : null;

  // Volcado de depuración (sólo si se pide): forma cruda + normalizada.
  if (debugRaw) {
    report.debug = {
      detected_fields: detectFields(logs[0]),
      raw_first5: rawLogs.slice(0, 5).map(safeStringify),
      raw_last20: rawLogs.slice(-20).map(safeStringify),
      normalized_last20: norm.filter(n => n.ts).slice(-20)
        .map(n => ({ user: n.userId, ts_py: pyDateTimeStr(n.ts), inout: n.inout ?? null })),
    };
  }

  // Mapeo deviceUserId → empleado, contra TODAS las columnas disponibles
  // (code, employee_number, …), no sólo `code`.
  const matcher = await buildEmployeeMatcher();
  report.match_columns = matcher.columns;

  // Recorrer válidos: filtrar por RANGO, resolver empleado y preparar STAGING.
  // Regla clave: NUNCA se descarta una marca; toda marca en rango se guardará
  // en raw_device_punches (mapeada o no).
  const punches = [];        // { raw, ts, userId, empId, type, explicit }
  const unmapped = new Map();
  let minTs = null, maxTs = null;
  for (let i = 0; i < norm.length; i++) {
    const n = norm[i];
    if (!n.ts) continue;
    const day = pyDateStr(n.ts);
    if ((from && day < from) || (to && day > to)) { report.out_of_range++; continue; }
    report.in_range++;
    const empId = matcher.resolve(device.id, n.userId) || null;
    if (!empId) {
      report.notFound++;
      if (n.userId != null) unmapped.set(n.userId, (unmapped.get(n.userId) || 0) + 1);
    }
    const t = explicitType(n.inout);
    punches.push({ raw: logs[i], ts: n.ts, userId: n.userId, empId, type: t, explicit: !!t });
    if (!minTs || n.ts < minTs) minTs = n.ts;
    if (!maxTs || n.ts > maxTs) maxTs = n.ts;
  }

  // Diagnóstico de no-mapeados: top 30 con conteo y pista si existe por otra columna/estado.
  report.unmapped_distinct = unmapped.size;
  report.unmapped_top = [...unmapped.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([id, count]) => {
      const alt = matcher.any.get(id);
      return { device_user_id: id, count, employee: alt ? { id: alt.id, via: alt.via, status: alt.status } : null };
    });
  report.warn_unmapped = report.in_range > 0 && report.notFound / report.in_range > 0.5;
  // Lectura PARCIAL: buffer truncado, o se pidió un rango pero la mejor lectura
  // no trajo ninguna marca en ese rango (típico bloque histórico del GT200).
  report.partial = report.read_truncated || ((!!from || !!to) && report.in_range === 0 && report.valid > 0);

  if (!punches.length) { report.duration_ms = Date.now() - t0; return report; }

  // Inferir in/out por orden temporal para las marcas mapeadas.
  const mapped = punches.filter(p => p.empId);
  resolveTypes(mapped);

  // Dedup cross-source por (emp, fecha-hora PY): las que ya existen quedan
  // 'duplicate'; las nuevas se insertan y quedan 'mapped'.
  const empIds = [...new Set(mapped.map(p => p.empId))];
  let seen = new Set();
  if (empIds.length) {
    const [existing] = await sequelize.query(
      `SELECT employee_id, DATE_FORMAT(\`timestamp\`, '%Y-%m-%d %H:%i:%s') AS ts
       FROM attendance_logs
       WHERE employee_id IN (${empIds.map(() => '?').join(',')}) AND \`timestamp\` BETWEEN ? AND ?`,
      { replacements: [...empIds, minTs, maxTs] }
    );
    seen = new Set(existing.map(r => `${r.employee_id}|${r.ts}`));
  }

  const toInsert = [];
  const dates = new Set();
  for (const p of mapped) {
    const key = `${p.empId}|${pyDateTimeStr(p.ts)}`;
    if (seen.has(key)) { p.status = 'duplicate'; report.skipped++; continue; }
    seen.add(key);
    p.status = 'mapped';
    toInsert.push([p.empId, device.id, p.ts, p.type, 'zkteco_direct']);
    dates.add(pyDateStr(p.ts));
  }
  for (const p of punches) if (!p.status) p.status = p.empId ? 'mapped' : 'unmapped';
  report.would_import = toInsert.length;

  // Modo dry-run: NO escribe nada (ni staging ni attendance_logs).
  if (dryRun) {
    report.staged = punches.length;
    report.dates = [...dates].sort();
    report.sample = toInsert.slice(0, 20).map(([empId, , ts, type]) => ({
      employee_id: empId, ts_py: pyDateTimeStr(ts), type,
    }));
    report.duration_ms = Date.now() - t0;
    return report;
  }

  // 1) STAGING idempotente de TODAS las marcas en rango (mapeadas o no).
  const hasRaw = await tableExists('raw_device_punches');
  if (hasRaw) {
    const rawRows = punches.map(p => [
      device.id, String(p.userId ?? ''), (p.raw && p.raw.userSn != null) ? p.raw.userSn : null,
      p.ts, pyDateTimeStr(p.ts), (p.raw && p.raw.ip) || device.ip_address || null,
      safeStringify(p.raw), 'zkteco_direct', p.status, p.empId || null,
    ]);
    const RCHUNK = 300;
    for (let i = 0; i < rawRows.length; i += RCHUNK) {
      const chunk = rawRows.slice(i, i + RCHUNK);
      const vals = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',');
      await sequelize.query(
        `INSERT INTO raw_device_punches
           (device_id, device_user_id, user_sn, record_time, record_time_py, ip, raw_json, source, mapping_status, employee_id)
         VALUES ${vals}
         ON DUPLICATE KEY UPDATE
           mapping_status = VALUES(mapping_status), employee_id = VALUES(employee_id),
           user_sn = VALUES(user_sn), record_time_py = VALUES(record_time_py), ip = VALUES(ip),
           updated_at = NOW()`,
        { replacements: chunk.flat() }
      );
    }
    report.staged = rawRows.length;
  }

  // 2) Insertar attendance_logs de las marcas mapeadas nuevas.
  const CHUNK = 500;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const vals = chunk.map(() => '(?,?,?,?,?)').join(',');
    const [r] = await sequelize.query(
      `INSERT IGNORE INTO attendance_logs (employee_id, device_id, \`timestamp\`, type, source) VALUES ${vals}`,
      { replacements: chunk.flat() }
    );
    report.imported += (r?.affectedRows ?? 0);
  }
  report.dates = [...dates].sort();

  // 3) Enlazar raw → attendance_logs (idempotente, set-based).
  if (hasRaw && report.imported > 0) {
    await sequelize.query(
      `UPDATE raw_device_punches r
       JOIN attendance_logs a
         ON a.device_id = r.device_id AND a.employee_id = r.employee_id
        AND a.\`timestamp\` = r.record_time AND a.source = 'zkteco_direct'
       SET r.imported_attendance_log_id = a.id, r.mapping_status = 'mapped'
       WHERE r.device_id = ? AND r.employee_id IS NOT NULL
         AND r.imported_attendance_log_id IS NULL
         AND r.record_time BETWEEN ? AND ?`,
      { replacements: [device.id, minTs, maxTs] }
    );
  }

  if (recalc && report.dates.length) {
    const { bulkRecalcDailySummary, materializeAbsents } = require('./scheduler');
    for (const d of report.dates) {
      try { await bulkRecalcDailySummary(d); await materializeAbsents(d); } catch (e) { /* seguir */ }
    }
  }

  if (pushAtt2000) {
    try {
      const { writeCheckinOut } = require('../config/att2000');
      report.att2000 = await writeCheckinOut(norm.filter(n => n.ts && n.userId).map(n => ({
        userId: n.userId, attTime: n.ts, inOutStatus: n.inout ?? 0,
        sensorId: device.id, verifyMode: 0,
      })));
    } catch (e) { report.att2000 = { error: e.message }; }
  }

  report.duration_ms = Date.now() - t0;
  return report;
}

// Serializa un registro crudo de forma segura (Date → ISO, BigInt → string).
function safeStringify(obj) {
  try {
    return JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch { return String(obj); }
}

/**
 * readDeviceRaw — Diagnóstico READ-ONLY de un reloj. NO escribe nada
 * (ni attendance_logs, ni devices.last_sync). Sirve para verificar si el
 * reloj sigue registrando marcas y qué forma tiene la data cruda.
 * opts: { timeoutMs=45000, recentSample=20, recentDays=10, raw=true }
 * Devuelve: conexión, cantidad leída, muestra CRUDA (raw), primera/última
 *   marca normalizada, últimas N marcas, histograma por día, info del reloj,
 *   y (si falla) pruebas de conexión TCP/UDP + recomendación.
 */
async function readDeviceRaw(device, opts = {}) {
  const { timeoutMs = 45000, recentSample = 20, recentDays = 10, raw = true } = opts;
  const t0 = Date.now();
  const report = {
    device_id: device.id, device: device.name, ip: device.ip_address,
    port: device.port, connection_mode: device.connection_mode || 'auto',
    connected: false, total_read: 0,
    first_mark: null, last_mark: null,
    device_info: null, raw: null,
    recent: [], per_day: [],
    probes: null, recommendation: null, error: null, duration_ms: 0,
  };

  try {
    const data = await withTimeout(
      withZK(device, async zk => {
        const res = await zk.getAttendances();
        const out = { result: res, info: null };
        try { if (typeof zk.getInfo === 'function') out.info = await zk.getInfo(); } catch {}
        return out;
      }, { maxAttempts: 2, delayMs: 3000 }),
      timeoutMs, 'lectura del reloj'
    );

    report.connected = true;
    const res = data.result;
    const logs = Array.isArray(res) ? res : (res && Array.isArray(res.data) ? res.data : []);
    report.total_read = logs.length;
    report.device_info = data.info || null;

    // (A) Diagnóstico CRUDO sin normalizar.
    if (raw) {
      report.raw = {
        result_type: typeof res,
        result_keys: res && typeof res === 'object' && !Array.isArray(res) ? Object.keys(res) : null,
        data_is_array: Array.isArray(logs),
        data_length: logs.length,
        detected_fields: detectFields(logs[0]),
        first: logs[0] ? safeStringify(logs[0]) : null,
        last: logs.slice(-10).map(safeStringify),
      };
    }

    // Normalización tolerante a distintos nombres de campo.
    const parsed = logs
      .map(normalizeRecord)
      .filter(n => n.ts)
      .sort((a, b) => a.ts - b.ts);

    if (parsed.length) {
      const fmt = n => ({ user_id: n.userId, ts_py: pyDateTimeStr(n.ts), in_out: n.inout ?? null });
      report.first_mark = fmt(parsed[0]);
      report.last_mark = fmt(parsed[parsed.length - 1]);
      report.recent = parsed.slice(-recentSample).reverse().map(fmt);

      const byDay = new Map();
      for (const n of parsed) { const d = pyDateStr(n.ts); byDay.set(d, (byDay.get(d) || 0) + 1); }
      report.per_day = [...byDay.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .slice(0, recentDays)
        .map(([date, count]) => ({ date, count }));
    }
  } catch (err) {
    report.error = err?.message || String(err);
    report.recommendation = recommendationFor(report.error);
    // (E) Al fallar la lectura, probar conexión TCP y UDP por separado para
    // distinguir "no conecta" de "conecta pero no responde la lectura".
    try {
      report.probes = [await probeMode(device, 'tcp'), await probeMode(device, 'udp')];
    } catch { /* diagnóstico best-effort */ }
  }

  report.duration_ms = Date.now() - t0;
  return report;
}

// Lee todos los relojes válidos (con IP), uno por uno, capturando errores.
// opts.deviceIds (array) → limita a esos relojes (para no bloquear los demás
// cuando uno está lento, p.ej. Lavadero con --device-id 2).
async function backupAllDevices(opts = {}) {
  const { deviceIds = null, mode = null, ...deviceOpts } = opts;
  let sql = "SELECT * FROM devices WHERE ip_address IS NOT NULL AND TRIM(ip_address) <> ''";
  const replacements = [];
  if (Array.isArray(deviceIds) && deviceIds.length) {
    sql += ` AND id IN (${deviceIds.map(() => '?').join(',')})`;
    replacements.push(...deviceIds);
  }
  sql += ' ORDER BY id';
  const [devices] = await sequelize.query(sql, { replacements });
  const results = [];
  const totals = { imported: 0, skipped: 0, notFound: 0, would_import: 0, junk: 0, in_range: 0 };
  const validMode = ['auto', 'tcp', 'udp'].includes(String(mode).toLowerCase()) ? String(mode).toLowerCase() : null;
  for (const device of devices) {
    // --mode fuerza el protocolo SÓLO para esta corrida (no persiste en la BD).
    if (validMode) device.connection_mode = validMode;
    try {
      const r = await backupDeviceDirect(device, deviceOpts);
      totals.imported += r.imported; totals.skipped += r.skipped;
      totals.notFound += r.notFound; totals.would_import += (r.would_import || 0);
      totals.junk += (r.junk || 0); totals.in_range += (r.in_range || 0);
      results.push({ ...r, ok: true });
    } catch (err) {
      results.push({ device_id: device.id, device: device.name, ip: device.ip_address, ok: false, error: err.message });
    }
  }
  return { devices: devices.length, totals, results };
}

module.exports = {
  openZK, withZK, backupDeviceDirect, backupAllDevices, readDeviceRaw,
  readAttendancesStable, buildEmployeeMatcher, getEmployeeMatchColumns, isJunkRaw,
  tableExists, getExistingColumns,
  pyDateStr, pyDateTimeStr,
  // Exportados para pruebas / reutilización.
  normalizeRecord, resolveTypes, explicitType, detectFields,
};
