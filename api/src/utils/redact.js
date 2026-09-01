/**
 * redact.js — redacción de datos sensibles antes de persistir/loggear.
 *
 * La auditoría guarda un `details` JSON libre con el antes/después de los
 * cambios. Para entidades con campos sensibles (credenciales, documentos,
 * remuneración, PII) el valor no debe quedar en claro en `audit_events`.
 *
 * `redactDetails(obj)` devuelve una copia profunda donde toda clave cuyo
 * nombre coincida (case-insensitive, por inclusión) con una clave sensible
 * queda reemplazada por el marcador `'[REDACTED]'`. No muta la entrada.
 *
 * Es deliberadamente conservador: redacta por NOMBRE de clave, no por
 * heurística de contenido, para que el comportamiento sea predecible y
 * testeable. El caller puede pasar claves adicionales.
 */

const DEFAULT_SENSITIVE_KEYS = [
  'password', 'password_hash', 'passwd', 'pwd',
  'token', 'access_token', 'refresh_token', 'secret', 'api_key', 'apikey',
  'authorization', 'jwt',
  'salary', 'salary_base', 'remuneration', 'remuneracion', 'sueldo',
  'tax_id', 'taxid', 'ruc', 'document_number', 'documento', 'ci', 'cedula',
  'ips_number', 'ips',
  'biometric', 'biometria', 'fingerprint', 'face', 'template',
];

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

function isSensitiveKey(key, sensitive) {
  const k = String(key).toLowerCase();
  return sensitive.some((s) => k === s || k.includes(s));
}

function redactValue(value, sensitive, depth) {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, sensitive, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k, sensitive)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactValue(v, sensitive, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * @param {*} details        objeto (o valor) a redactar.
 * @param {string[]} extraKeys claves sensibles adicionales.
 */
function redactDetails(details, extraKeys = []) {
  const sensitive = [...DEFAULT_SENSITIVE_KEYS, ...extraKeys.map((k) => String(k).toLowerCase())];
  return redactValue(details, sensitive, 0);
}

module.exports = { redactDetails, DEFAULT_SENSITIVE_KEYS, REDACTED };
