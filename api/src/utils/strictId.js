'use strict';

/**
 * strictId.js — validación ÚNICA de identificadores enteros positivos.
 *
 * Acepta sólo:
 *   - number entero seguro > 0 (Number.isSafeInteger);
 *   - string decimal canónico: /^[1-9][0-9]*$/ cuyo valor sea entero seguro.
 * Rechaza todo lo demás: '1e2', '0x10', '1.5', '10abc', ' 7', '007', '0', '-1',
 * valores > Number.MAX_SAFE_INTEGER, booleanos, arrays, objetos, null.
 *
 * Quien autoriza y quien opera deben usar el MISMO valor devuelto por esta
 * función; nunca volver a interpretar la entrada original.
 */

const CANONICAL = /^[1-9][0-9]*$/;

/** @returns {number|null} */
function parsePositiveId(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v !== 'string' || !CANONICAL.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** Ausente = no enviado (undefined/null/''), distinto de "enviado e inválido". */
function isAbsent(v) {
  return v === undefined || v === null || v === '';
}

module.exports = { parsePositiveId, isAbsent };
