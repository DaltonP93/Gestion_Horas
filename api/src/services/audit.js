/**
 * audit.js — servicio centralizado de auditoría.
 * Escribe en audit_events sin bloquear al caller (fire & forget).
 *
 * Correlation id (FASE F1): cada evento guarda el `correlation_id` de la
 * request (req.correlationId, ver middleware/requestId.js) para poder trazar
 * juntos todos los eventos de una misma operación.
 *
 * DEGRADACIÓN DELIBERADA: la columna `audit_events.correlation_id` la agrega
 * la migración 077. Si todavía no está aplicada (esquema parcial en
 * producción), el primer INSERT falla con ER_BAD_FIELD_ERROR; se detecta, se
 * marca la capacidad como no disponible y se reintenta el INSERT SIN la
 * columna. Así la auditoría nunca se pierde por un esquema a medio migrar, y
 * cuando la columna aparezca se vuelve a usar en el próximo arranque.
 */
const { sequelize } = require('../config/database');
const logger = require('../config/logger');

// null = desconocido (probar con columna), true/false = capacidad conocida.
let _correlationColumnAvailable = null;

function getIp(req) {
  return req?.headers?.['x-forwarded-for']?.split(',')[0].trim()
      || req?.ip
      || req?.connection?.remoteAddress
      || null;
}
function getUA(req) {
  return req?.headers?.['user-agent']?.slice(0, 255) || null;
}

function isMissingColumnError(err) {
  let cur = err;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.code === 'ER_BAD_FIELD_ERROR' || cur.errno === 1054 || cur.sqlState === '42S22') {
      return true;
    }
    cur = cur.parent || cur.original || cur.cause;
  }
  return false;
}

async function insertWithCorrelation(base, correlationId) {
  await sequelize.query(
    `INSERT INTO audit_events
       (user_id, username, action, entity, entity_id, correlation_id, ip, user_agent, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { replacements: [...base.slice(0, 5), correlationId, ...base.slice(5)] },
  );
}

async function insertLegacy(base) {
  await sequelize.query(
    `INSERT INTO audit_events
       (user_id, username, action, entity, entity_id, ip, user_agent, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    { replacements: base },
  );
}

async function log({ req, user, action, entity = null, entity_id = null, details = null, correlationId = null }) {
  const corr = correlationId || req?.correlationId || null;
  // base = [user_id, username, action, entity, entity_id, ip, user_agent, details]
  const base = [
    user?.id || null,
    user?.username || null,
    action,
    entity,
    entity_id ? String(entity_id) : null,
    req ? getIp(req) : null,
    req ? getUA(req) : null,
    details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
  ];

  try {
    if (_correlationColumnAvailable === false) {
      await insertLegacy(base);
      return;
    }
    try {
      await insertWithCorrelation(base, corr);
      _correlationColumnAvailable = true;
    } catch (err) {
      if (!isMissingColumnError(err)) throw err;
      _correlationColumnAvailable = false;
      logger.warn('audit.correlation_id no disponible (migración 077 pendiente): se audita sin correlation id');
      await insertLegacy(base);
    }
  } catch (err) {
    // Nunca romper el flujo por falla de auditoría
    logger.warn(`audit.log falló (${action}): ${err.message}`);
  }
}

// Para tests: restablece la detección de capacidad.
function _resetCapability() { _correlationColumnAvailable = null; }

module.exports = { log, _resetCapability };
