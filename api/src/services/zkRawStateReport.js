'use strict';

/**
 * zkRawStateReport.js — Reporte de SOLO LECTURA del estado crudo conservado en
 * raw_device_punches.raw_json (ver zkRawCapture.js), por reloj y rango.
 *
 * Devuelve sólo CONTEOS: por estado de captura, por formato del registro y por
 * valor observado de cada byte (todos los valores vistos, más «invalido» y
 * «ausente»). Nunca nombres, ids de usuario o empleado, ni marcaciones
 * individuales. No escribe nada.
 *
 * Qué NO dice: que un valor signifique entrada o salida en ese reloj. Disponer
 * del byte no demuestra su semántica ni la configuración del equipo.
 */
const { sequelize } = require('../config/database');
const { isCivilDate, addCivilDays } = require('./syncSchedule');

const MAX_RANGE_DAYS = 92;
const SOURCE = 'zkteco_direct';
const FORMATS = new Set(['tcp40', 'udp16', 'udp8']);
const CAPTURE_STATES = ['ok', 'no_disponible', 'longitud_inesperada'];

/** Valida reloj/rango; devuelve { error, status } o null. */
function validateRange(from, to) {
  if (!isCivilDate(from) || !isCivilDate(to)) return 'from y to son obligatorios (YYYY-MM-DD, fecha real)';
  if (from > to) return 'from debe ser anterior o igual a to';
  if (addCivilDays(from, MAX_RANGE_DAYS - 1) < to) return `el rango no puede superar ${MAX_RANGE_DAYS} días`;
  return null;
}

const isByte = (v) => Number.isInteger(v) && v >= 0 && v <= 255;

/** Clasifica el valor de un campo crudo: 'NNN' (byte), 'invalido' o 'ausente'. */
function valueKey(type, value) {
  if (type == null) return 'ausente';
  const n = typeof value === 'string' && type === 'INTEGER' ? Number(value) : value;
  return type === 'INTEGER' && isByte(Number(n)) ? String(Number(n)) : 'invalido';
}

/**
 * @param {{ deviceId:number, from:string, to:string }} params
 * @returns {Promise<object>} conteos (ver tests/it/zkRawState.it.test.js)
 */
async function rawStateReport({ deviceId, from, to }) {
  // Agregación en la base: una fila por combinación observada, con su conteo.
  const [rows] = await sequelize.query(`
    SELECT
      CASE WHEN raw_json IS NULL THEN '__sin_raw_json'
           ELSE COALESCE(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.zkCapture')), '__sin_registro') END AS cap,
      JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.zkRecordFormat')) AS fmt,
      JSON_TYPE(JSON_EXTRACT(raw_json, '$.zkPunchState')) AS ps_type,
      CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.zkPunchState')) AS CHAR) AS ps,
      JSON_TYPE(JSON_EXTRACT(raw_json, '$.zkVerify')) AS vf_type,
      CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.zkVerify')) AS CHAR) AS vf,
      COUNT(*) AS n
    FROM raw_device_punches
    WHERE device_id = ? AND source = ? AND record_time_py >= ? AND record_time_py <= ?
    GROUP BY cap, fmt, ps_type, ps, vf_type, vf
  `, { replacements: [deviceId, SOURCE, `${from} 00:00:00`, `${to} 23:59:59`] });

  const report = {
    ok: true,
    device_id: deviceId,
    from,
    to,
    source: SOURCE,
    total: 0,
    capture: { ok: 0, no_disponible: 0, longitud_inesperada: 0, sin_registro: 0, sin_raw_json: 0, desconocido: 0 },
    formats: {},
  };
  const bump = (obj, key, n) => { obj[key] = (obj[key] || 0) + n; };

  for (const r of rows) {
    const n = Number(r.n);
    report.total += n;
    let cap = r.cap;
    if (cap === '__sin_raw_json') cap = 'sin_raw_json';
    else if (cap === '__sin_registro') cap = 'sin_registro';
    else if (!CAPTURE_STATES.includes(cap)) cap = 'desconocido';
    bump(report.capture, cap, n);
    if (cap !== 'ok') continue;

    const fmt = FORMATS.has(r.fmt) ? r.fmt : 'desconocido';
    const f = report.formats[fmt] || (report.formats[fmt] = { total: 0, zkPunchState: {}, zkVerify: {} });
    f.total += n;
    bump(f.zkPunchState, valueKey(r.ps_type, r.ps), n);
    bump(f.zkVerify, valueKey(r.vf_type, r.vf), n);
  }
  return report;
}

module.exports = { rawStateReport, validateRange, MAX_RANGE_DAYS };
