/**
 * bridgeClient.js
 * Único punto de acceso de la API al Bridge ZKTeco.
 *
 * Nace de un 502 en GET /api/devices/:id/push-status con el Bridge sano: la
 * llamada no mandaba la cabecera `x-api-key`, el Bridge respondía 401 y la
 * ruta lo convertía en un 502 genérico. `/health` seguía dando 200 porque es
 * la única ruta exenta de autenticación — de ahí que el Bridge "pareciera" bien.
 *
 * Todas las llamadas pasan por acá para que la clave, el timeout y el
 * correlation_id no dependan de que cada llamador se acuerde.
 */
const crypto = require('crypto');
const logger = require('../config/logger');
const { validatePushStatusPayload } = require('./pushStatusContract');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.BRIDGE_TIMEOUT_MS || '4000', 10);

/** Causas distinguibles. Cada una tiene su propio HTTP: nada de 502 para todo. */
const BRIDGE_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'BRIDGE_NOT_CONFIGURED',   // falta BRIDGE_API_KEY de este lado
  UNAUTHORIZED:   'BRIDGE_UNAUTHORIZED',     // el Bridge rechazó la clave
  ROUTE_MISSING:  'BRIDGE_ROUTE_MISSING',    // Bridge viejo, sin el endpoint
  TIMEOUT:        'BRIDGE_TIMEOUT',
  UNREACHABLE:    'BRIDGE_UNREACHABLE',
  BAD_CONTRACT:   'BRIDGE_BAD_CONTRACT',     // respondió algo que no es el contrato
  BRIDGE_ERROR:   'BRIDGE_ERROR',            // 5xx u otro estado inesperado
});

/** HTTP con el que la API responde a cada causa. */
const HTTP_FOR_CODE = Object.freeze({
  [BRIDGE_ERROR_CODES.NOT_CONFIGURED]: 503,
  [BRIDGE_ERROR_CODES.UNAUTHORIZED]:   503,   // es configuración nuestra, no del cliente
  [BRIDGE_ERROR_CODES.ROUTE_MISSING]:  502,
  [BRIDGE_ERROR_CODES.TIMEOUT]:        504,
  [BRIDGE_ERROR_CODES.UNREACHABLE]:    502,
  [BRIDGE_ERROR_CODES.BAD_CONTRACT]:   502,
  [BRIDGE_ERROR_CODES.BRIDGE_ERROR]:   502,
});

/** Mensajes fijos y publicables: nunca el texto crudo del error ni la URL. */
const MESSAGE_FOR_CODE = Object.freeze({
  [BRIDGE_ERROR_CODES.NOT_CONFIGURED]: 'El servicio de relojes no está configurado en el servidor.',
  [BRIDGE_ERROR_CODES.UNAUTHORIZED]:   'El servidor no está autorizado a consultar el servicio de relojes.',
  [BRIDGE_ERROR_CODES.ROUTE_MISSING]:  'El servicio de relojes no ofrece este diagnóstico (versión desactualizada).',
  [BRIDGE_ERROR_CODES.TIMEOUT]:        'El servicio de relojes no respondió a tiempo.',
  [BRIDGE_ERROR_CODES.UNREACHABLE]:    'No se pudo contactar al servicio de relojes.',
  [BRIDGE_ERROR_CODES.BAD_CONTRACT]:   'El servicio de relojes respondió en un formato inesperado.',
  [BRIDGE_ERROR_CODES.BRIDGE_ERROR]:   'El servicio de relojes respondió con un error.',
});

function bridgeBaseUrl() {
  return (process.env.BRIDGE_URL || 'http://localhost:8081').replace(/\/+$/, '');
}

function newCorrelationId() {
  return `sh-${crypto.randomBytes(6).toString('hex')}`;
}

function httpStatusFor(code) {
  return HTTP_FOR_CODE[code] || 502;
}

function failure(code, detail, correlationId) {
  return {
    ok: false,
    error_code: code,
    http_status: httpStatusFor(code),
    message: MESSAGE_FOR_CODE[code] || MESSAGE_FOR_CODE[BRIDGE_ERROR_CODES.BRIDGE_ERROR],
    detail: detail || null,        // sólo para logs internos, no para la respuesta
    correlation_id: correlationId,
  };
}

/**
 * Consulta el estado PUSH de un reloj identificándolo por serial o IP.
 *
 * Nunca lanza: devuelve `{ ok: true, data }` o `{ ok: false, error_code, ... }`.
 */
async function fetchPushStatus({ serial, ip, correlationId = newCorrelationId(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const apiKey = process.env.BRIDGE_API_KEY;
  if (!apiKey) {
    // Fallar acá y no contra el Bridge deja claro de qué lado está el problema.
    return failure(BRIDGE_ERROR_CODES.NOT_CONFIGURED, 'BRIDGE_API_KEY ausente', correlationId);
  }
  if (!serial && !ip) {
    return failure(BRIDGE_ERROR_CODES.BAD_CONTRACT, 'ni serial ni ip para identificar el reloj', correlationId);
  }

  const qs = new URLSearchParams();
  if (serial) qs.set('serial', serial);
  if (ip) qs.set('ip', ip);
  const url = `${bridgeBaseUrl()}/push-status?${qs.toString()}`;

  let res;
  try {
    res = await fetch(url, {
      headers: { 'x-api-key': apiKey, 'x-correlation-id': correlationId, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const esTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const code = esTimeout ? BRIDGE_ERROR_CODES.TIMEOUT : BRIDGE_ERROR_CODES.UNREACHABLE;
    return failure(code, err && err.message, correlationId);
  }

  if (res.status === 401 || res.status === 403) {
    return failure(BRIDGE_ERROR_CODES.UNAUTHORIZED, `bridge respondió ${res.status}`, correlationId);
  }
  if (res.status === 404) {
    return failure(BRIDGE_ERROR_CODES.ROUTE_MISSING, 'bridge respondió 404', correlationId);
  }
  if (!res.ok) {
    return failure(BRIDGE_ERROR_CODES.BRIDGE_ERROR, `bridge respondió ${res.status}`, correlationId);
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    return failure(BRIDGE_ERROR_CODES.BAD_CONTRACT, 'respuesta no es JSON', correlationId);
  }

  const check = validatePushStatusPayload(payload);
  if (!check.ok) {
    return failure(BRIDGE_ERROR_CODES.BAD_CONTRACT, check.reason, correlationId);
  }

  return { ok: true, data: payload, correlation_id: correlationId };
}

/** Log del fallo con el detalle técnico, que no viaja en la respuesta HTTP. */
function logBridgeFailure(result, extra = {}) {
  logger.warn('Consulta al Bridge falló', {
    component: 'bridge_client',
    error_code: result.error_code,
    http_status: result.http_status,
    correlation_id: result.correlation_id,
    detail: result.detail || undefined,
    ...extra,
  });
}

module.exports = {
  BRIDGE_ERROR_CODES,
  HTTP_FOR_CODE,
  MESSAGE_FOR_CODE,
  fetchPushStatus,
  logBridgeFailure,
  newCorrelationId,
  httpStatusFor,
  bridgeBaseUrl,
};
