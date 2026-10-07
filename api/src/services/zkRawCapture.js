'use strict';

/**
 * zkRawCapture.js — Conserva bytes CRUDOS del registro de asistencia que
 * node-zklib (1.3.0) decodifica pero descarta. Diagnóstico: NO es tipo.
 *
 * Disposición de los registros según pyzk (zk/base.py → get_attendance):
 *   TCP, 40 bytes: uid H · user_id 24s · status B (26) · timestamp (27) · punch B (31) · 8 reservados
 *   UDP, 16 bytes: user_id I · timestamp (4) · status B (8) · punch B (9) · 2 reservados · workcode I
 *   UDP,  8 bytes: uid H · status B (2) · timestamp (3) · punch B (7)
 *
 * Campos agregados al registro decodificado (y por lo tanto a raw_json):
 *   zkCapture       'ok' | 'longitud_inesperada' | 'no_disponible'
 *   zkRecordFormat  'tcp40' | 'udp16' | 'udp8'          (sólo con 'ok')
 *   zkPunchState    byte de estado de marcación, 0–255  (sólo con 'ok')
 *   zkVerify        byte de modo de verificación, 0–255 (sólo con 'ok')
 *   zkRecordLength  longitud recibida                   (sólo con 'longitud_inesperada')
 *
 * Son datos CRUDOS: el valor del byte, sin interpretar. Tener el byte no
 * demuestra qué significa en cada reloj ni cómo está configurado. Los nombres
 * NO coinciden con los campos que reconoce el resolvedor de tipos
 * (inOutStatus/state/status/type/inout): ningún tipo, hora, deduplicación ni
 * recálculo los usa.
 *
 * Cómo se capturan: zklibtcp.js y zklibudp.js toman `decodeRecordData40` y
 * `decodeRecordData16` de `./utils` AL CARGARSE (desestructuración). Por eso
 * este módulo envuelve esos exports al cargarse el lector, ANTES de que
 * `openZK` cargue node-zklib. Si node-zklib ya estaba cargado, esos módulos
 * conservan el decodificador original: la captura no ocurre, se avisa en el log
 * (en Node, detectado por require.cache), `markMissing` deja
 * `zkCapture: 'no_disponible'` en cada registro y la lectura informa cuántos
 * (`raw_state_missing` en el detalle de cada intento, que se guarda en
 * device_sync_runs.attempts_detail). Así una captura omitida no pasa
 * inadvertida ni se confunde con un byte 0.
 */
const logger = require('../config/logger');

const LAYOUTS = Object.freeze({
  40: { format: 'tcp40', punch: 31, verify: 26 },
  16: { format: 'udp16', punch: 9, verify: 8 },
  8: { format: 'udp8', punch: 7, verify: 2 },
});
const RAW_FIELDS = Object.freeze(['zkCapture', 'zkRecordFormat', 'zkPunchState', 'zkVerify', 'zkRecordLength']);
const WRAPPED = Symbol.for('sishoras.zkRawCapture.wrapped');

const state = { installed: false, loadedBefore: [], error: null };

/** Agrega los campos crudos al registro decodificado `rec` a partir de su buffer. */
function annotate(rec, buf) {
  if (!rec || typeof rec !== 'object') return rec;
  const layout = Buffer.isBuffer(buf) ? LAYOUTS[buf.length] : null;
  if (!layout) {
    rec.zkCapture = 'longitud_inesperada';
    rec.zkRecordLength = Buffer.isBuffer(buf) ? buf.length : null;
    return rec;
  }
  rec.zkCapture = 'ok';
  rec.zkRecordFormat = layout.format;
  rec.zkPunchState = buf.readUInt8(layout.punch);
  rec.zkVerify = buf.readUInt8(layout.verify);
  return rec;
}

function wrap(original) {
  if (typeof original !== 'function' || original[WRAPPED]) return original;
  const wrapped = function decodeAndKeepRaw(recordData, ...rest) {
    return annotate(original.call(this, recordData, ...rest), recordData);
  };
  wrapped[WRAPPED] = true;
  return wrapped;
}

/** Envuelve los decodificadores de node-zklib/utils. Idempotente. */
function install() {
  if (state.installed) return status();
  try {
    const loadedBefore = [];
    for (const name of ['zklibtcp', 'zklibudp']) {
      const resolved = require.resolve(`node-zklib/${name}`);
      if (require.cache[resolved]) loadedBefore.push(name);
    }
    const utils = require('node-zklib/utils');
    utils.decodeRecordData40 = wrap(utils.decodeRecordData40);
    utils.decodeRecordData16 = wrap(utils.decodeRecordData16);
    state.installed = true;
    state.loadedBefore = loadedBefore;
    if (loadedBefore.length) {
      logger.warn(`[zkRawCapture] node-zklib (${loadedBefore.join(', ')}) se cargó antes que el lector: `
        + "esas lecturas no conservan el estado crudo y quedan marcadas zkCapture='no_disponible'");
    }
  } catch (err) {
    state.error = err.message;
    logger.warn(`[zkRawCapture] no se pudo instalar la captura del estado crudo: ${err.message}`);
  }
  return status();
}

/**
 * Marca los registros sin captura (decodificador no envuelto o lectura
 * inyectada) y devuelve cuántos marcó, para que la lectura lo informe.
 */
function markMissing(records) {
  let missing = 0;
  if (!Array.isArray(records)) return missing;
  for (const rec of records) {
    if (rec && typeof rec === 'object' && rec.zkCapture === undefined) {
      rec.zkCapture = 'no_disponible';
      missing++;
    }
  }
  return missing;
}

function status() {
  return { installed: state.installed, loadedBefore: [...state.loadedBefore], error: state.error };
}

module.exports = { install, annotate, markMissing, status, LAYOUTS, RAW_FIELDS };
