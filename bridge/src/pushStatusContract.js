/**
 * pushStatusContract.js
 * Contrato explícito API ↔ Bridge para el estado PUSH de un reloj.
 *
 * Existe porque la API preguntaba por `/devices/:id/push-state` usando el `id`
 * de MySQL, mientras que el Bridge identifica sus relojes por posición dentro
 * de ZKTECO_DEVICES: dos espacios de identificadores distintos que sólo
 * coincidían por casualidad. Este contrato se consulta por **serial o IP**, que
 * son los datos que ambos lados sí comparten.
 *
 * La respuesta NO incluye la IP del reloj ni ningún secreto: la API ya sabe la
 * dirección, y un endpoint de diagnóstico no tiene por qué repetirla.
 *
 * Versionado: `contract_version` cambia sólo ante cambios incompatibles. Un
 * consumidor que reciba una versión mayor a la que entiende debe rechazar la
 * respuesta en vez de interpretarla a medias.
 *
 * Este archivo está duplicado a propósito en api/src/services/: son dos
 * procesos distintos, sin paquete compartido, y una copia divergente es un
 * problema menor que un import entre servicios.
 */

const PUSH_STATUS_CONTRACT_VERSION = 1;

/** Cómo se resolvió el reloj. Nunca se devuelve la dirección en sí. */
const MATCHED_BY = Object.freeze({
  SERIAL: 'serial',
  IP: 'ip',
  // Dos o más relojes con la misma IP: no se puede atribuir el estado a
  // ninguno, así que no se atribuye a ninguno.
  AMBIGUOUS: 'ambiguous',
  NONE: 'none',
});

/**
 * Arma la respuesta del contrato.
 *
 * @param {{ serial?: string|null, lastPushAt?: string|null, lastEventAt?: string|null, matchedBy?: string }} data
 */
function buildPushStatusPayload(data = {}) {
  const found = !!(data.serial || data.lastPushAt || data.lastEventAt);
  return {
    contract_version: PUSH_STATUS_CONTRACT_VERSION,
    found,
    serial: data.serial || null,
    last_push_at: data.lastPushAt || null,
    last_event_at: data.lastEventAt || null,
    // 'ambiguous' sobrevive aunque no haya datos: dice POR QUÉ no los hay.
    matched_by: found
      ? (data.matchedBy || MATCHED_BY.NONE)
      : (data.matchedBy === MATCHED_BY.AMBIGUOUS ? MATCHED_BY.AMBIGUOUS : MATCHED_BY.NONE),
  };
}

const CONTRACT_KEYS = Object.freeze(
  ['contract_version', 'found', 'serial', 'last_push_at', 'last_event_at', 'matched_by']
);

function isIsoOrNull(v) {
  if (v === null) return true;
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/**
 * Valida una respuesta recibida. Devuelve { ok, reason } — nunca lanza, para
 * que un Bridge desactualizado o un proxy que devuelve HTML no tumben la ruta.
 *
 * Es EXACTA a propósito: se exige un objeto plano con estas claves y ninguna
 * más. Un Bridge que empiece a mandar `ip` o `bridge_url` de más tiene que
 * fallar como contrato roto y no colarse; éste es el único filtro antes de
 * que la API acepte el payload.
 */
function validatePushStatusPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'respuesta no es un objeto' };
  }
  const proto = Object.getPrototypeOf(payload);
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, reason: 'respuesta no es un objeto plano' };
  }

  const claves = Object.keys(payload);
  const sobran = claves.filter(k => !CONTRACT_KEYS.includes(k));
  if (sobran.length) return { ok: false, reason: `claves fuera del contrato: ${sobran.join(', ')}` };
  const faltan = CONTRACT_KEYS.filter(k => !claves.includes(k));
  if (faltan.length) return { ok: false, reason: `claves ausentes: ${faltan.join(', ')}` };

  if (payload.contract_version !== PUSH_STATUS_CONTRACT_VERSION) {
    return { ok: false, reason: `contract_version ${payload.contract_version} no soportada` };
  }
  if (typeof payload.found !== 'boolean') return { ok: false, reason: 'found ausente o no booleano' };
  if (payload.serial !== null && typeof payload.serial !== 'string') {
    return { ok: false, reason: 'serial inválido' };
  }
  if (!isIsoOrNull(payload.last_push_at)) return { ok: false, reason: 'last_push_at no es una fecha ISO ni null' };
  if (!isIsoOrNull(payload.last_event_at)) return { ok: false, reason: 'last_event_at no es una fecha ISO ni null' };
  if (!Object.values(MATCHED_BY).includes(payload.matched_by)) {
    return { ok: false, reason: `matched_by inválido: ${payload.matched_by}` };
  }
  return { ok: true };
}


/**
 * Resuelve el estado PUSH de un reloj a partir del mapa del Bridge.
 * Vive acá para que el endpoint y sus tests usen exactamente la misma lógica.
 *
 * Ante dos relojes con la misma IP no se elige ninguno: quedarse con el
 * primero reportaría el serial y la frescura de OTRO equipo.
 */
function resolvePushState(pushState, { serial, ip } = {}) {
  const mapa = pushState && typeof pushState === 'object' ? pushState : {};
  if (serial && mapa[serial]) {
    return { serial, state: mapa[serial], matchedBy: MATCHED_BY.SERIAL };
  }
  if (ip) {
    const porIp = Object.entries(mapa).filter(([, s]) => s && s.ip === ip);
    if (porIp.length === 1) return { serial: porIp[0][0], state: porIp[0][1], matchedBy: MATCHED_BY.IP };
    if (porIp.length > 1) return { serial: null, state: null, matchedBy: MATCHED_BY.AMBIGUOUS };
  }
  return { serial: null, state: null, matchedBy: MATCHED_BY.NONE };
}

/** Atajo: resolver + armar el payload. */
function buildPushStatusFor(pushState, query) {
  const { serial, state, matchedBy } = resolvePushState(pushState, query);
  return buildPushStatusPayload({
    serial,
    lastPushAt:  state ? state.lastSeen  || null : null,
    lastEventAt: state ? state.lastPunch || null : null,
    matchedBy,
  });
}

module.exports = {
  PUSH_STATUS_CONTRACT_VERSION,
  MATCHED_BY,
  buildPushStatusPayload,
  buildPushStatusFor,
  resolvePushState,
  validatePushStatusPayload,
};
