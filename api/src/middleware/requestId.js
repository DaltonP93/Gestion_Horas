/**
 * requestId.js — correlation id por request.
 *
 * Asigna a cada request un identificador de correlación estable y lo expone en
 * `req.correlationId` y en el header de respuesta `X-Correlation-Id`. Sirve
 * para atar entre sí todos los eventos de auditoría/log de una misma request
 * (o de una cadena que propaga el mismo id).
 *
 * Origen del id (en orden de preferencia):
 *   1. Header entrante `X-Correlation-Id` o `X-Request-Id`, si viene con un
 *      formato seguro (letras, dígitos, `-`, `_`, `.`, hasta 64 chars). Se
 *      valida para no reflejar entrada arbitraria en logs/headers.
 *   2. Un UUID v4 generado localmente.
 *
 * No corta la request: sólo etiqueta. No confía en el cliente más allá de un
 * id con formato acotado.
 */

const crypto = require('crypto');

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

function pickIncoming(req) {
  const raw = req?.headers?.['x-correlation-id'] || req?.headers?.['x-request-id'];
  if (typeof raw === 'string' && SAFE_ID.test(raw)) return raw;
  return null;
}

function requestId(req, res, next) {
  const id = pickIncoming(req) || crypto.randomUUID();
  req.correlationId = id;
  try {
    res.setHeader('X-Correlation-Id', id);
  } catch {
    // Si los headers ya se enviaron, no es fatal para el etiquetado interno.
  }
  next();
}

module.exports = { requestId, SAFE_ID };
