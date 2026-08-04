/**
 * netMetrics.js — línea base de consumo de red de la sincronización ZKTeco.
 *
 * Este módulo sólo MIDE. No cambia cómo se leen los relojes ni cuándo. Su
 * razón de ser es responder, con datos y no con intuición, cuánto tráfico
 * genera hoy cada equipo antes de reemplazar el flujo por uno incremental.
 *
 * Nada de lo que se guarda acá incluye secretos, tokens, biometría, payloads
 * de marcaciones ni datos personales: son contadores, duraciones y códigos.
 */

const { sequelize } = require('../config/database');

// ─── Modos de lectura ────────────────────────────────────────────
// Hoy sólo existen los dos de polling. `recovery` y `push` quedan declarados
// porque son los modos que introducirá la arquitectura PUSH-first, y así el
// agregado ya sabe agruparlos sin cambiar el contrato.
const MODES = ['push', 'polling_auto', 'polling_manual', 'recovery'];

/**
 * Modo a partir del origen del lock, que ya distingue automático de manual.
 * Se deriva en vez de pedirlo a cada llamador: menos superficie que tocar.
 */
function modeFromOrigin(origin) {
  switch (String(origin || '').toLowerCase()) {
    case 'automatic': return 'polling_auto';
    case 'recovery':  return 'recovery';
    case 'push':      return 'push';
    // 'manual' viene de la UI; 'script' de la línea de comandos y 'direct' es
    // el origen por defecto de deviceLock cuando el llamador no lo declara.
    // Los tres son lecturas disparadas por una persona: mismo modo.
    case 'manual':
    case 'script':
    case 'direct':    return 'polling_manual';
    default:          return origin ? 'polling_manual' : null;
  }
}

/**
 * Volumen del payload decodificado que entregó el reloj.
 *
 * Es una ESTIMACIÓN por muestreo, no bytes de cable: serializar el buffer
 * completo en un camino que ya vigila la memoria (ver logMem del lector)
 * sería pagar un MB de string para medir. Se toman unas pocas muestras, se
 * promedia y se multiplica. Quien consuma el dato recibe además la bandera
 * `estimated` para no leerlo como exacto.
 */
function estimateBytes(records, { sample = 5 } = {}) {
  if (!Array.isArray(records) || records.length === 0) {
    return { bytes: 0, estimated: false };
  }
  const n = Math.min(sample, records.length);
  let acc = 0;
  let medidos = 0;
  for (let i = 0; i < n; i++) {
    try {
      acc += Buffer.byteLength(
        JSON.stringify(records[i], (k, v) => (typeof v === 'bigint' ? v.toString() : v)) || '',
        'utf8'
      );
      medidos += 1;
    } catch { /* un registro no serializable no invalida la muestra */ }
  }
  if (!medidos) return { bytes: 0, estimated: true };
  const promedio = acc / medidos;
  return {
    bytes: Math.round(promedio * records.length),
    // Sólo es exacto si se midieron TODOS los registros.
    estimated: medidos < records.length,
  };
}

/**
 * Clasificación corta del error, para poder agrupar. `error_message` ya
 * guarda el texto; esto es la etiqueta estable.
 *
 * Nunca devuelve contenido del error: sólo una de estas constantes.
 */
function classifyErrorCode(errorOrMessage) {
  if (!errorOrMessage) return null;
  const msg = String(errorOrMessage?.message || errorOrMessage).toLowerCase();

  if (/timeout|etimedout|timed out/.test(msg))            return 'timeout';
  if (/truncat|incomplet|receiving packet/.test(msg))     return 'truncated';
  if (/econnrefused|ehostunreach|enetunreach|unreachable/.test(msg)) return 'unreachable';
  if (/econnreset|epipe|socket hang up/.test(msg))        return 'connection_reset';
  if (/lock|deadlock/.test(msg))                          return 'db_lock';
  if (/auth|denied|unauthor/.test(msg))                   return 'auth';
  return 'other';
}

/**
 * Ahorro que obtendría un flujo incremental sobre lo ya leído.
 *
 * El polling actual descarga el buffer entero del reloj y descarta casi todo:
 * si de 10.000 registros leídos sólo 12 son nuevos, el 99,9% del tráfico fue
 * en vano. Esa proporción es el argumento para cambiar la arquitectura, así
 * que se calcula explícitamente en lugar de dejarla a ojo.
 */
function estimateIncrementalSaving({ raw_count = 0, imported_count = 0, bytes_from_device = 0 }) {
  const leidos = Number(raw_count) || 0;
  const nuevos = Number(imported_count) || 0;
  const bytes  = Number(bytes_from_device) || 0;

  if (leidos <= 0) {
    return { wasted_ratio: 0, wasted_bytes: 0, useful_ratio: 0 };
  }
  const utiles = Math.min(nuevos, leidos);
  const useful_ratio = utiles / leidos;
  const wasted_ratio = 1 - useful_ratio;
  return {
    useful_ratio: Number(useful_ratio.toFixed(4)),
    wasted_ratio: Number(wasted_ratio.toFixed(4)),
    wasted_bytes: Math.round(bytes * wasted_ratio),
  };
}

/** Suma segura: MySQL devuelve los agregados como string. */
const num = (v) => Number(v) || 0;

/**
 * Agrega las filas de `device_sync_runs` por reloj y modo.
 *
 * Recibe filas ya consultadas para poder probarse sin base de datos.
 */
function aggregateRuns(rows) {
  const porDispositivo = new Map();

  for (const r of rows || []) {
    const key = r.device_id == null ? 'sin-dispositivo' : String(r.device_id);
    if (!porDispositivo.has(key)) {
      porDispositivo.set(key, {
        device_id: r.device_id ?? null,
        device_name: r.device_name || null,
        runs: 0, modes: {}, statuses: {}, error_codes: {},
        raw_count: 0, in_range_count: 0, imported_count: 0,
        duplicate_count: 0, unmapped_count: 0,
        bytes_from_device: 0, bytes_estimated: false,
        // Cuántas de esas corridas traen realmente la medición de red. Una
        // corrida anterior a la migración 070 tiene bytes NULL, y sumarla como
        // 0 abarataría el promedio sin que se note.
        measured_runs: 0, unmeasured_runs: 0,
        attempts: 0, duration_ms: 0,
        last_run_at: null,
      });
    }
    const d = porDispositivo.get(key);
    d.runs += 1;
    if (r.bytes_from_device == null) d.unmeasured_runs += 1;
    else d.measured_runs += 1;
    d.raw_count        += num(r.raw_count);
    d.in_range_count   += num(r.in_range_count);
    d.imported_count   += num(r.imported_count);
    d.duplicate_count  += num(r.duplicate_count);
    d.unmapped_count   += num(r.unmapped_count);
    d.bytes_from_device += num(r.bytes_from_device);
    d.attempts         += num(r.attempts);
    d.duration_ms      += num(r.duration_ms);
    if (r.bytes_estimated) d.bytes_estimated = true;

    const mode = r.mode || 'desconocido';
    d.modes[mode] = (d.modes[mode] || 0) + 1;
    const st = r.status || 'desconocido';
    d.statuses[st] = (d.statuses[st] || 0) + 1;
    if (r.error_code) d.error_codes[r.error_code] = (d.error_codes[r.error_code] || 0) + 1;

    const started = r.started_at ? new Date(r.started_at).getTime() : 0;
    const prev = d.last_run_at ? new Date(d.last_run_at).getTime() : 0;
    if (started > prev) d.last_run_at = r.started_at;
  }

  const devices = [...porDispositivo.values()].map(d => ({
    ...d,
    avg_duration_ms: d.runs ? Math.round(d.duration_ms / d.runs) : 0,
    duplicate_ratio: d.raw_count ? Number((d.duplicate_count / d.raw_count).toFixed(4)) : 0,
    saving: estimateIncrementalSaving(d),
  }));

  const totals = devices.reduce((acc, d) => ({
    runs: acc.runs + d.runs,
    raw_count: acc.raw_count + d.raw_count,
    imported_count: acc.imported_count + d.imported_count,
    bytes_from_device: acc.bytes_from_device + d.bytes_from_device,
    measured_runs: acc.measured_runs + d.measured_runs,
    unmeasured_runs: acc.unmeasured_runs + d.unmeasured_runs,
  }), {
    runs: 0, raw_count: 0, imported_count: 0, bytes_from_device: 0,
    measured_runs: 0, unmeasured_runs: 0,
  });

  return {
    devices: devices.sort((a, b) => b.bytes_from_device - a.bytes_from_device),
    totals: { ...totals, saving: estimateIncrementalSaving(totals) },
  };
}

let _colsCache = null;

/** Sólo para pruebas: olvida el esquema memorizado. */
function __resetColumnsCache() { _colsCache = null; }

/**
 * Columnas de métricas presentes, para funcionar sin la migración aplicada.
 *
 * Se memoriza: el esquema no cambia mientras el proceso vive, y esto lo
 * consultan tanto el endpoint de métricas como el historial de cada reloj.
 * Tras aplicar la migración hay que recargar la API — que es lo que ya se
 * hace en el despliegue.
 */
async function availableColumns() {
  if (_colsCache) return _colsCache;
  try {
    const [rows] = await sequelize.query(
      `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_sync_runs'
          AND COLUMN_NAME IN ('mode','bytes_from_device','bytes_estimated','error_code')`
    );
    _colsCache = rows.map(r => r.c);
    return _colsCache;
  } catch {
    // Un fallo puntual no se memoriza: se reintenta en la próxima consulta.
    return [];
  }
}

/**
 * Lee las ejecuciones de la ventana pedida. Selecciona sólo columnas de
 * conteo y control: ninguna trae datos personales.
 *
 * Devuelve `{ rows, truncated, limit }`. El tope existe para no traer una
 * ventana enorme a memoria, pero recortar en silencio sería peor que el
 * problema que evita: los totales saldrían bajos y nadie sabría por qué,
 * justo cuando el número se usa para decidir la arquitectura. Se pide uno de
 * más para poder AVISAR que faltan filas.
 */
async function fetchRuns({ from, to, deviceId = null, limit = 5000 }) {
  const cols = await availableColumns();
  const opt = (name) => (cols.includes(name) ? name : `NULL AS ${name}`);
  const tope = Number(limit) > 0 ? Math.floor(Number(limit)) : 5000;

  const where = ['r.started_at >= ?', 'r.started_at < ?'];
  const params = [from, to];
  if (deviceId) { where.push('r.device_id = ?'); params.push(deviceId); }

  const [rows] = await sequelize.query(
    `SELECT r.device_id, d.name AS device_name, r.started_at, r.status,
            r.raw_count, r.in_range_count, r.imported_count,
            r.duplicate_count, r.unmapped_count,
            r.attempts, r.duration_ms,
            ${opt('mode')}, ${opt('bytes_from_device')},
            ${opt('bytes_estimated')}, ${opt('error_code')}
       FROM device_sync_runs r
       LEFT JOIN devices d ON d.id = r.device_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.started_at DESC
      LIMIT ?`,
    { replacements: [...params, tope + 1] }
  );
  const truncated = rows.length > tope;
  return { rows: truncated ? rows.slice(0, tope) : rows, truncated, limit: tope };
}

/**
 * Estado de la cola, reutilizando las tablas que ya existen.
 *
 * El estado en espera de `sync_jobs` es 'queued' (migración 064 y
 * services/syncJobs.js). Filtrar por 'pending' devolvía siempre 0: la cola se
 * veía vacía aunque hubiera lecturas acumulándose.
 */
async function queueSnapshot() {
  const snap = { pending: 0, running: 0, locks: 0, oldest_pending_age_sec: null };
  try {
    const [[jobs]] = await sequelize.query(
      `SELECT
         SUM(status = 'queued')  AS pending,
         SUM(status = 'running') AS running,
         MIN(CASE WHEN status = 'queued' THEN created_at END) AS oldest
       FROM sync_jobs`
    );
    snap.pending = num(jobs?.pending);
    snap.running = num(jobs?.running);
    if (jobs?.oldest) {
      snap.oldest_pending_age_sec = Math.max(
        0, Math.round((Date.now() - new Date(jobs.oldest).getTime()) / 1000)
      );
    }
  } catch { /* la cola puede no existir todavía */ }

  try {
    const [[locks]] = await sequelize.query('SELECT COUNT(*) AS c FROM device_locks');
    snap.locks = num(locks?.c);
  } catch { /* idem */ }

  return snap;
}

module.exports = {
  MODES,
  modeFromOrigin,
  estimateBytes,
  classifyErrorCode,
  estimateIncrementalSaving,
  aggregateRuns,
  availableColumns,
  __resetColumnsCache,
  fetchRuns,
  queueSnapshot,
};
