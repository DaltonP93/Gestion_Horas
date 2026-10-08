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
 *   - Corte común (cutoffBlock): el conjunto histórico comparable entre dos
 *     corridas se resume SÓLO con conteos y una huella de conjunto con clave
 *     (HMAC; nunca registros ni un agregado del conjunto).
 */
const crypto = require('crypto');
const { isJunkRaw, normalizeRecord, pyDateTimeStr } = require('../zkRecordShape');
const { addMinutesWall, claveId, CANON_CORTE } = require('./corte');
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

/** Fecha de prueba en la hora que Paraguay saltaba al adelantar el reloj (00:00–00:59 del 1/10/2023). */
const DST_PROBE = [2023, 9, 1, 0, 30];

/**
 * La hora de pared de cada marca sale de getters LOCALES (zkRecordShape): es exacta sólo si la zona del
 * proceso no tiene horas inexistentes. En America/Asuncion, una marca a las 00:30 del día del cambio de
 * hora saldría corrida a la 01:30. El hijo de lectura corre en UTC y lo verifica con esto.
 */
function decodingZoneOk() {
  return new Date(...DST_PROBE).getHours() === DST_PROBE[3];
}

/**
 * Corte común: de los registros VÁLIDOS (no basura) separa el conjunto histórico comparable —hora de
 * pared ≤ `hasta`— de los posteriores. Sólo CONTEOS y una huella de conjunto: ni agregado del conjunto
 * (restado del agregado completo revelaría las marcas posteriores), ni registros.
 *
 * Huella: HMAC-SHA256 con la clave del operador (`clave`, 64 hex, nunca se publica) sobre la lista
 * canónica ORDENADA (multiconjunto) de [usuario, hora de pared, byte de estado, byte de verificación].
 * Sin clave no hay huella: una huella sin clave se rompe por fuerza bruta conociendo las demás marcas.
 * Tampoco la hay con menos de `kMin` marcas o usuarios, con captura incompleta o con formatos mezclados
 * (el mismo historial leído por TCP y por UDP no da la misma lista): `huella: null` y `huella_motivo`.
 *
 * @param {object[]} records
 * @param {{ hasta:string, clave?:string|null, nowPy?:string, kMin?:number, zona?:string|null }} o
 */
function cutoffBlock(records, { hasta, clave = null, nowPy = pyDateTimeStr(new Date()), kMin = K_MIN, zona = process.env.TZ || null }) {
  const list = Array.isArray(records) ? records : [];
  const futureLimit = addMinutesWall(nowPy, FUTURE_MARGIN_MIN);
  const lines = [];
  const users = new Set();
  const days = new Set();
  const formats = new Set();
  let capturaCompleta = true;
  let posteriores = 0;
  let futuras = 0;
  let basura = 0;
  for (const rec of list) {
    if (isJunkRaw(rec)) { basura += 1; continue; }
    const n = normalizeRecord(rec);
    if (!n.wall || n.wall > hasta) {
      posteriores += 1;
      if (n.wall && n.wall > futureLimit) futuras += 1;
      continue;
    }
    users.add(n.userId);
    days.add(n.wall.slice(0, 10));
    if (rec.zkCapture === 'ok' && FORMAT_BYTES[rec.zkRecordFormat]) formats.add(rec.zkRecordFormat);
    else capturaCompleta = false;
    lines.push(JSON.stringify([n.userId, n.wall, byteKey(rec.zkPunchState), byteKey(rec.zkVerify)]));
  }
  let motivo = null;
  if (!clave) motivo = 'sin_clave';
  else if (lines.length < kMin) motivo = 'pocos_registros';
  else if (users.size < kMin) motivo = 'pocos_usuarios';
  else if (!capturaCompleta) motivo = 'captura_incompleta';
  else if (formats.size !== 1) motivo = 'formatos_mixtos';
  const huella = motivo ? null : crypto.createHmac('sha256', Buffer.from(clave, 'hex'))
    .update(`${CANON_CORTE}\n${lines.length}\n${lines.sort().join('\n')}`).digest('hex');
  return {
    hasta,
    canon: CANON_CORTE,
    decodificacion: { zona },
    conjunto: {
      registros: lines.length,
      usuarios: suppress(users.size, kMin),
      dias_con_marcas: suppress(days.size, kMin),
      formato: formats.size === 1 ? [...formats][0] : (formats.size ? 'mixto' : null),
      captura_completa: capturaCompleta,
      huella,
      huella_tipo: 'hmac-sha256',
      clave_id: clave ? claveId(clave) : null,
      huella_motivo: motivo,
    },
    fuera: { posteriores, futuras, basura },
  };
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

module.exports = { aggregateRecords, cutoffBlock, decodingZoneOk, classifyReadError, byteKey, K_MIN, FORMAT_BYTES };
