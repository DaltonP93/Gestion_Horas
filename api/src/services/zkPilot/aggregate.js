'use strict';

/**
 * aggregate.js — agregado SANEADO de una lectura del piloto de estados.
 *
 * Entrada: los registros tal como los entrega node-zklib, con los campos que
 * agrega zkRawCapture (zkCapture, zkRecordFormat, zkPunchState, zkVerify,
 * zkRecordLength). Salida: sólo CONTEOS.
 *
 *   - Sin usuarios, IPs, registros individuales ni horas individuales: la hora
 *     sólo aparece como hora del día ("07") y la fecha como primera/última.
 *   - Las celdas por hora y los patrones por usuario-día con menos de
 *     `kMin` casos se muestran como "<kMin" (o se suman como suprimidos), para
 *     que un caso aislado no identifique a una persona.
 *   - Los bytes NO se interpretan: un valor de zkPunchState es un número, no
 *     "entrada" ni "salida". Disponer del byte no demuestra su semántica.
 *   - El tamaño es una ESTIMACIÓN (registros decodificados × tamaño del
 *     formato), no lo medido en la red; se declara como tal.
 */
const { isJunkRaw, normalizeRecord, pyDateTimeStr } = require('../zkRecordShape');
const { LAYOUTS } = require('../zkRawCapture');

const K_MIN = 5;
const MAX_PATTERN = 6;
const TOP_PATTERNS = 20;
const FUTURE_MARGIN_MIN = 10;
const FORMAT_BYTES = Object.freeze(Object.fromEntries(Object.entries(LAYOUTS).map(([len, l]) => [l.format, Number(len)])));
const CAPTURE_STATES = new Set(['ok', 'no_disponible', 'longitud_inesperada']);

const bump = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };
const suppress = (n, k) => (n < k ? `<${k}` : n);

/** 'NNN' si es un byte; 'ausente' si no vino; 'invalido' si vino otra cosa. */
function byteKey(v) {
  if (v === undefined || v === null) return 'ausente';
  return Number.isInteger(v) && v >= 0 && v <= 255 ? String(v) : 'invalido';
}

/** Suma minutos a una hora de pared 'YYYY-MM-DD HH:MM:SS' (aritmética de calendario, sin zona). */
function addMinutesWall(wall, minutes) {
  const [d, t] = wall.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, s] = t.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, da, h, mi + minutes, s)).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * @param {object[]} records registros decodificados (con campos de captura)
 * @param {{ nowPy?: string, kMin?: number }} [opts] nowPy: hora de pared actual en Paraguay
 */
function aggregateRecords(records, { nowPy = pyDateTimeStr(new Date()), kMin = K_MIN } = {}) {
  const list = Array.isArray(records) ? records : [];
  const out = {
    registros: list.length,
    basura: 0,
    validos: 0,
    captura: { ok: 0, no_disponible: 0, longitud_inesperada: 0, otro: 0 },
    validos_sin_captura: 0,
    formatos: {},
    fechas: { primera: null, ultima: null, dias_con_marcas: 0 },
    futuras: 0,
    duplicados_usuario_hora: 0,
    usuarios_distintos: 0,
    umbral_supresion: kMin,
    por_hora: {},
    patrones_dia: { patrones: {}, suprimidos: { patrones: 0, dias: 0 } },
    bytes_estimados: { valor: 4, es_estimacion: true, metodo: 'tamano_por_registro_decodificado', registros_sin_longitud: 0 },
  };
  const futureLimit = addMinutesWall(nowPy, FUTURE_MARGIN_MIN);
  const days = new Set();
  const users = new Set();
  const seen = new Set();
  const hours = {};
  const sequences = new Map();

  for (const rec of list) {
    const isObj = rec && typeof rec === 'object';
    const cap = isObj ? rec.zkCapture : undefined;
    out.captura[CAPTURE_STATES.has(cap) ? cap : 'otro'] += 1;

    let len;
    if (cap === 'ok') len = FORMAT_BYTES[rec.zkRecordFormat];
    else if (cap === 'longitud_inesperada' && Number.isInteger(rec.zkRecordLength)) len = rec.zkRecordLength;
    if (Number.isInteger(len)) out.bytes_estimados.valor += len;
    else out.bytes_estimados.registros_sin_longitud += 1;

    if (isJunkRaw(rec)) { out.basura += 1; continue; }
    out.validos += 1;

    let state;
    if (cap === 'ok') {
      const fmt = FORMAT_BYTES[rec.zkRecordFormat] ? rec.zkRecordFormat : 'desconocido';
      const f = out.formatos[fmt] || (out.formatos[fmt] = { validos: 0, zkPunchState: {}, zkVerify: {}, combinaciones: {} });
      const ps = byteKey(rec.zkPunchState);
      const vf = byteKey(rec.zkVerify);
      f.validos += 1;
      bump(f.zkPunchState, ps);
      bump(f.zkVerify, vf);
      bump(f.combinaciones, `${ps}/${vf}`);
      state = ps;
    } else {
      out.validos_sin_captura += 1;
      state = 'sin_captura';
    }

    const n = normalizeRecord(rec);
    if (!n.wall) continue;
    const day = n.wall.slice(0, 10);
    days.add(day);
    if (!out.fechas.primera || day < out.fechas.primera) out.fechas.primera = day;
    if (!out.fechas.ultima || day > out.fechas.ultima) out.fechas.ultima = day;
    if (n.wall > futureLimit) out.futuras += 1;
    const key = `${n.userId}|${n.wall}`;
    if (seen.has(key)) out.duplicados_usuario_hora += 1; else seen.add(key);
    users.add(n.userId);
    const hh = n.wall.slice(11, 13);
    bump(hours[hh] || (hours[hh] = {}), state);
    const sk = `${n.userId}|${day}`;
    if (!sequences.has(sk)) sequences.set(sk, []);
    sequences.get(sk).push([n.wall, state]);
  }

  out.fechas.dias_con_marcas = days.size;
  out.usuarios_distintos = users.size;
  for (const hh of Object.keys(hours).sort()) {
    out.por_hora[hh] = Object.fromEntries(Object.entries(hours[hh]).map(([s, c]) => [s, suppress(c, kMin)]));
  }

  const patterns = new Map();
  for (const seq of sequences.values()) {
    const states = seq.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]);
    const label = states.slice(0, MAX_PATTERN).join(',') + (states.length > MAX_PATTERN ? ',…' : '');
    patterns.set(label, (patterns.get(label) || 0) + 1);
  }
  const ranked = [...patterns.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  ranked.forEach(([label, count], i) => {
    if (count >= kMin && i < TOP_PATTERNS) {
      out.patrones_dia.patrones[label] = count;
    } else {
      out.patrones_dia.suprimidos.patrones += 1;
      out.patrones_dia.suprimidos.dias += count;
    }
  });
  return out;
}

/** Código corto del error de lectura. Nunca devuelve el mensaje (puede llevar IP o datos). */
function classifyReadError(err) {
  const msg = String((err && (err.message || (err.err && err.err.message))) || (typeof err === 'string' ? err : ''));
  if (/TIMEOUT_ON_WRITING/.test(msg)) return 'sin_respuesta_escritura';
  if (/ECONNREFUSED/.test(msg)) return 'conexion_rechazada';
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENOTFOUND|EAI_AGAIN/.test(msg)) return 'inalcanzable';
  if (/ETIMEDOUT|TIMEOUT/i.test(msg)) return 'timeout_reloj';
  if (/disconnected|ECONNRESET|EPIPE|socket hang up/i.test(msg)) return 'conexion_cortada';
  return 'error_lectura';
}

module.exports = { aggregateRecords, classifyReadError, byteKey, K_MIN, FORMAT_BYTES };
