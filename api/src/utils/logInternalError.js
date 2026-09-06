'use strict';

/**
 * logInternalError.js — log de errores 5xx sin filtrar datos internos.
 *
 * Reutiliza la utilidad segura del repo (`errorInfo.js`): NO duplica redacción.
 *
 * En PRODUCCIÓN se registran SÓLO metadatos seguros:
 *   - `event`: nombre estable del evento (no texto libre del error);
 *   - `route`: ruta lógica;
 *   - `error_code`: código allowlisted (`errorInfo.safeErrorCode`, nunca mensaje);
 *   - `error_class`: nombre de la clase del error (p. ej. `SequelizeDatabaseError`);
 *   - `request_id`: correlation/request id si el request lo trae.
 * Nunca `err.message`, `err.stack`, SQL, `replacements`, request body, tokens ni PII.
 *
 * En DESARROLLO puede adjuntarse detalle YA SANITIZADO (secretos/SQL/PII/stack
 * redactados por `serializeError`) sólo si `LOG_ERROR_DETAIL === 'true'`.
 * Nunca es el comportamiento productivo.
 */

const { safeErrorCode, serializeError } = require('./errorInfo');

function requestId(req) {
  if (!req) return undefined;
  const h = req.headers || {};
  return req.id || h['x-request-id'] || h['x-correlation-id'] || undefined;
}

/**
 * @param {{error: Function}} logger  el logger del repo (winston).
 * @param {{event:string, route?:string, err:unknown, req?:object}} ctx
 */
function logInternalError(logger, { event, route, err, req } = {}) {
  const meta = {
    event,
    route,
    error_code: safeErrorCode(err),
    error_class: (err && typeof err === 'object' && typeof err.name === 'string') ? err.name : typeof err,
  };
  const rid = requestId(req);
  if (rid) meta.request_id = String(rid).slice(0, 100);

  // Detalle sanitizado SÓLO fuera de producción y con opt-in explícito.
  if (process.env.NODE_ENV !== 'production' && process.env.LOG_ERROR_DETAIL === 'true') {
    meta.detail = serializeError(err);
  }

  logger.error(event, meta);
}

module.exports = { logInternalError };
