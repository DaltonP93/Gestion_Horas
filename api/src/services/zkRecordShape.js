'use strict';

/**
 * zkRecordShape.js — forma de los registros de asistencia ZKTeco y hora de
 * PARED del reloj. Funciones PURAS: sin base, red ni configuración.
 *
 * Extraídas sin cambios de zktecoReader.js para que el piloto aislado de
 * estados (services/zkPilot) clasifique registros igual que el lector sin
 * cargar sus caminos de importación, staging o recálculo. zktecoReader.js las
 * reutiliza desde aquí: una sola definición.
 */

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

// ─── Hora de PARED de una marca del reloj ────────────────────────
// El reloj guarda la hora de pared (sin zona) y node-zklib la decodifica con
// `new Date(año, mes, día, h, m, s)` (parseTimeToDate/parseHexToTime), es decir
// en la zona LOCAL del proceso. La inversa exacta son los getters locales, en
// cualquier zona del proceso; formatear ese Date en America/Asuncion sólo
// coincide si el proceso corre en esa zona. Lo mismo vale para el entero
// empaquetado (zkIntToDate), un Buffer o un texto sin zona.
// Un instante absoluto explícito (texto con Z/±hh:mm, o epoch) sí se convierte
// a la hora de pared de Paraguay.
// Límite: si la zona del PROCESO tuviera cambio de horario y la hora del reloj
// cayera en el salto, el Date ya llega corrido desde el decodificador.
const _pad2 = n => String(n).padStart(2, '0');
const ZONED_TEXT_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;
function localWall(d) {
  return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())} `
    + `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}:${_pad2(d.getSeconds())}`;
}
function isEpochNumber(v) {
  const sane = d => !isNaN(d.getTime()) && d.getFullYear() >= 2010 && d.getFullYear() <= 2100;
  return sane(new Date(v)) || sane(new Date(v * 1000));
}
/** 'YYYY-MM-DD HH:MM:SS' (hora de pared) del valor de hora de un registro; null si no se interpreta. */
function wallClockOf(v) {
  const d = coerceDate(v);
  if (!d) return null;
  if ((typeof v === 'string' && ZONED_TEXT_RE.test(v.trim())) || (typeof v === 'number' && isEpochNumber(v))) {
    return pyDateTimeStr(d);
  }
  return localWall(d);
}

// Devuelve { ts:Date|null, wall:string|null, userId:string|null, inout } desde
// un registro crudo. `ts` sólo ordena/compara dentro de la lectura; todo lo que
// se filtra, guarda o compara contra la base usa `wall`.
function normalizeRecord(l) {
  const raw = pickField(l, TS_FIELDS);
  const ts = coerceDate(raw);
  const wall = ts ? wallClockOf(raw) : null;
  const uid = pickField(l, UID_FIELDS);
  const inout = pickField(l, INOUT_FIELDS);
  return { ts, wall, userId: uid != null ? String(uid) : null, inout };
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

module.exports = {
  TS_FIELDS, UID_FIELDS, INOUT_FIELDS,
  pickField, zkIntToDate, coerceDate, wallClockOf, normalizeRecord, isJunkRaw,
  pyDateTimeStr, pyDateStr,
};
