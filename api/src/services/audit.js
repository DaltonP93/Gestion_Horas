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
 *
 * PRIVACIDAD (invariante): la auditoría NUNCA serializa PII ni texto libre en
 * la columna `details`. Un empleado, su nombre, su email, su usuario o cualquier
 * prosa escrita por el operador no deben viajar a la auditoría. El dato de
 * negocio, si hace falta, vive en su propia columna/tabla — no acá.
 *
 * Para hacerlo cumplir sin depender de que cada call site se acuerde,
 * `sanitizeDetails` aplica una ALLOWLIST de claves no-PII más un guardián de
 * valores: sólo pasan escalares seguros (números, booleanos y "tokens" cortos
 * sin espacios ni `@`, es decir enums/ids/fechas) o arrays de esos escalares.
 * Todo lo demás — claves fuera de la lista, objetos anidados, strings con
 * espacios/acentos/`@` (nombres, emails, frases) — se descarta en silencio.
 */
const { sequelize } = require('../config/database');
const logger = require('../config/logger');

// null = desconocido (probar con columna), true/false = capacidad conocida.
let _correlationColumnAvailable = null;

// Claves permitidas en `details`. Se excluyen deliberadamente las que por su
// propósito transportan VALORES de identidad (name, email, username, code,
// from, to, note, title, owner, origin, reason libre…): esas se descartan
// aunque el valor parezca inofensivo.
const ALLOWED_DETAIL_KEYS = new Set([
  // Identificadores estructurales (ids numéricos, nunca nombres/emails).
  'id', 'employee_id', 'device_id', 'doc_id', 'batch_id', 'job_id', 'rule_id',
  'attendance_log_id',
  // Conteos y métricas.
  'count', 'total', 'size', 'closed', 'closed_other_sessions', 'affected',
  'employees_updated', 'devices',
  // Banderas y enums cortos, no-PII. `reason` se admite pero el guardián de
  // valores sólo deja pasar la variante enum (sin espacios): 'bad_password' sí,
  // "Renuncia voluntaria" no.
  'found', 'ok', 'matched', 'enabled', 'active', 'reason_provided', 'reason',
  'role', 'status', 'type', 'category', 'mode', 'was',
  // Metadatos temporales operativos (no identidad de una persona).
  'date', 'period', 'termination_date', 'window',
  // Listas de NOMBRES de campo/clave que cambiaron — no sus valores.
  'field', 'fields', 'keys',
  // Trazabilidad estructural NO-PII (decisión del dueño: ampliar allowlist).
  // El guardián de valores (SAFE_STRING_RE) sigue podando cualquier valor con
  // espacios/`@`/acentos, así que un `username` que sea email, o un `from`/`to`
  // que contenga un nombre completo, se descartan igual: sólo pasan tokens
  // seguros (handles de login, códigos técnicos, enums, ids, fechas, números).
  'username', 'code', 'from', 'to',
]);

// "Token" seguro: sin espacios, sin `@`, sin acentos; hasta 64 chars. Cubre
// enums ('bad_password'), ids/códigos técnicos, fechas ('2026-07-01'),
// períodos ('2026-07') y zonas ('America/Asuncion'). Excluye nombres, emails
// y prosa (que llevan espacios, acentos o `@`).
const SAFE_STRING_RE = /^[\w.:+/-]{1,64}$/;

function isSafeScalar(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return true;
  if (typeof v === 'string') return SAFE_STRING_RE.test(v);
  return false;
}

// Devuelve el valor "podado" o `undefined` si no hay nada seguro que conservar.
function pickSafe(v) {
  if (isSafeScalar(v)) return v;
  if (Array.isArray(v)) {
    const out = [];
    for (const item of v) {
      if (isSafeScalar(item)) out.push(item);
      if (out.length >= 50) break;
    }
    return out; // puede quedar vacío; se serializa como []
  }
  return undefined; // objetos anidados y escalares no-seguros → fuera
}

/**
 * sanitizeDetails(details) → string JSON | null
 *   - null/undefined → null
 *   - string suelto (texto libre) o cualquier no-objeto → null (descartado)
 *   - objeto → JSON sólo con claves de la allowlist y valores seguros; si no
 *     queda ninguna clave, null.
 */
function sanitizeDetails(details) {
  if (details == null) return null;
  if (typeof details !== 'object' || Array.isArray(details)) return null;

  const out = {};
  for (const key of Object.keys(details)) {
    if (!ALLOWED_DETAIL_KEYS.has(key)) continue;
    const safe = pickSafe(details[key]);
    if (safe === undefined) continue;
    out[key] = safe;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

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
    // PRIVACIDAD (#192): pasar `details` por la allowlist antes de persistir,
    // así ninguna PII/prosa llega a la columna, con o sin correlation_id.
    sanitizeDetails(details),
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

module.exports = { log, sanitizeDetails, ALLOWED_DETAIL_KEYS, _resetCapability };
