'use strict';

/**
 * corte.js — piezas PURAS del corte temporal común del piloto de estados: sin
 * base, red, reloj, configuración ni logger. Las usan el proceso principal y
 * los CLI (que no deben cargar nada más) y el agregado del hijo.
 */
const crypto = require('crypto');

/** Versión de la canonicalización de la huella: dos salidas con otro canon no se comparan. */
const CANON_CORTE = 'sishoras.zk-raw-state-pilot.corte/2';
const CLAVE_ID_DOMINIO = 'sishoras.zk-raw-state-pilot.corte.clave-id/1';
/** Formato de PILOT_CORTE_CLAVE: 64 hex (32 bytes). */
const CLAVE_RE = /^[0-9a-f]{64}$/i;

/** Suma minutos a una hora de pared 'YYYY-MM-DD HH:MM:SS' (aritmética de calendario, sin zona). */
function addMinutesWall(wall, minutes) {
  const [d, t] = wall.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, s] = t.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, da, h, mi + minutes, s)).toISOString().slice(0, 19).replace('T', ' ');
}

/** Identificador público de la clave: dice si dos salidas usaron la misma, sin revelarla. */
function claveId(clave) {
  return crypto.createHmac('sha256', Buffer.from(clave, 'hex')).update(CLAVE_ID_DOMINIO).digest('hex').slice(0, 12);
}

/**
 * Compara el bloque `corte` de dos salidas del piloto. 'igual' sólo si son dos corridas DISTINTAS
 * (`corrida_id`) del MISMO reloj, ambas terminaron 'ok', con el mismo corte, canon, clave, formato y
 * zona de decodificación, ambas con huella, y coinciden la cantidad y la huella. Una huella distinta significa que el conjunto ≤ corte difiere: una marca alterada,
 * borrada o NUEVA con la hora del reloj atrasada más que el margen. Las posteriores nunca cuentan.
 * @returns {{ resultado:'igual'|'distinto'|'no_comparable', motivo:string|null, delta_registros:number|null }}
 */
function compararCortes(a, b) {
  const no = (motivo) => ({ resultado: 'no_comparable', motivo, delta_registros: null });
  if (!a || !b || a.resultado !== 'ok' || b.resultado !== 'ok') return no('resultado_no_ok');
  if (!a.reloj || !b.reloj || a.reloj.id == null || a.reloj.id !== b.reloj.id) return no('reloj_distinto');
  if (!a.corrida_id || !b.corrida_id) return no('sin_corrida');
  if (a.corrida_id === b.corrida_id) return no('misma_corrida');
  const ca = a.corte;
  const cb = b.corte;
  if (!ca || !cb || !ca.conjunto || !cb.conjunto) return no('sin_corte');
  if (ca.hasta !== cb.hasta) return no('corte_distinto');
  if (ca.canon !== cb.canon) return no('canon_distinto');
  if (!ca.decodificacion || !cb.decodificacion || ca.decodificacion.zona !== cb.decodificacion.zona) return no('zona_distinta');
  if (ca.conjunto.formato !== cb.conjunto.formato) return no('formato_distinto');
  if (ca.conjunto.clave_id !== cb.conjunto.clave_id) return no('clave_distinta');
  if (!ca.conjunto.huella || !cb.conjunto.huella) return no(ca.conjunto.huella_motivo || cb.conjunto.huella_motivo || 'sin_huella');
  const delta = cb.conjunto.registros - ca.conjunto.registros;
  const same = delta === 0 && ca.conjunto.huella === cb.conjunto.huella;
  return { resultado: same ? 'igual' : 'distinto', motivo: null, delta_registros: delta };
}

module.exports = { addMinutesWall, claveId, compararCortes, CANON_CORTE, CLAVE_RE };
