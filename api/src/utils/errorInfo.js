/**
 * errorInfo.js
 * Serialización segura de errores para logs.
 *
 * El problema que resuelve: `logger.error('algo:', err.message)` con winston
 * sin `format.splat()` descarta el segundo argumento en silencio, y el log
 * queda como `algo: {}` — sin message, sin code, sin stack. Además, volcar el
 * error entero tampoco sirve: los errores de Sequelize/MySQL arrastran `sql`,
 * `parameters` y mensajes con datos personales.
 *
 * serializeError() extrae sólo los campos de diagnóstico y los redacta.
 */

const MAX_MESSAGE = 500;
const MAX_STACK_FRAMES = 8;
const MAX_CAUSE_DEPTH = 3;

// Claves cuyo valor nunca se serializa, venga de donde venga.
const SECRET_KEY_RE = /(pass(word)?|pwd|secret|token|jwt|authorization|auth|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|credential|cookie|session[_-]?id)/i;

// Campos que arrastran SQL, payloads o credenciales completas.
const NEVER_SERIALIZE = new Set([
  'sql', 'parameters', 'bind', 'replacements',
  'payload', 'body', 'data', 'config', 'request', 'response',
  'headers', 'env', 'options',
]);

const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{1,40}$/;

/**
 * Redacta credenciales de un texto libre: contraseñas, tokens, JWT, Bearer y
 * cadenas de conexión.
 *
 * A propósito NO enmascara IPs ni hostnames: en un log de operación, saber que
 * el destino era 127.0.0.1:8081 es justamente el dato que se necesita. Para
 * texto que puede arrastrar datos de fila (sqlMessage) está redactStrict().
 */
function redactSecrets(input) {
  if (input == null) return '';
  return String(input)
    // JWT (tres segmentos base64url)
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g, '***jwt***')
    // Bearer / Basic
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    // cadenas de conexión: mysql://user:pass@host:port/db
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s@/]+@[^\s]*/gi, '$1://***@***')
    // pares clave=valor / clave: valor con nombre sensible
    .replace(
      new RegExp(`\\b(${SECRET_KEY_RE.source})\\s*[=:]\\s*("[^"]*"|'[^']*'|\\S+)`, 'gi'),
      '$1=***'
    )
    // Lo mismo en JSON, donde la clave viene entrecomillada y el regex de
    // arriba no engancha. hrSourceSync lanza `HTTP 401: {"token":"…"}` con el
    // cuerpo de la respuesta de la fuente externa, y ese mensaje termina en
    // el log del cron.
    .replace(
      new RegExp(`(["'])(${SECRET_KEY_RE.source})\\1\\s*:\\s*("[^"]*"|'[^']*'|[^,}\\s]+)`, 'gi'),
      '$1$2$1:"***"'
    );
}

/**
 * Índice de la primera comilla que ABRE un literal.
 *
 * La comilla simple no cuenta si es un apóstrofo entre letras ("doesn't"):
 * si no, `Table 'db.t' doesn't exist` se cortaría en el lugar equivocado.
 */
function firstQuoteIndex(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === '`') return i;
    if (c === "'") {
      const prev = i > 0 ? s[i - 1] : '';
      const next = i + 1 < s.length ? s[i + 1] : '';
      const esApostrofo = /\p{L}/u.test(prev) && /\p{L}/u.test(next);
      if (!esApostrofo) return i;
    }
  }
  return -1;
}

/**
 * redactSecrets + todo lo que identifique a una persona, una fila o un host.
 * Para texto que puede traer datos de la base (sqlMessage, mensajes de MySQL).
 *
 * Corta en la primera comilla de apertura en vez de intentar emparejar: MySQL
 * anida y desbalancea comillas con total naturalidad — `Duplicate entry
 * 'O'Brien' for key 'name'`, o el `Couldn't execute 'show ... like 'uc_%''` del
 * bug #70907 — y cualquier intento de emparejar deja fragmentos del valor a la
 * vista. Lo que queda ("Duplicate entry", "Unknown column") más el error_code
 * alcanza para diagnosticar; el valor no hace falta.
 */
function redactStrict(input) {
  let s = redactSecrets(input)
    // correos, por si aparecen sin comillas
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '***@***')
    // IPv4
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '***.***.***.***');

  const q = firstQuoteIndex(s);
  if (q !== -1) s = `${s.slice(0, q).trimEnd()} '***'`;
  return s;
}

/**
 * ¿El error viene de la base? En ese caso su `message` suele ser el propio
 * mensaje del motor, con valores de fila adentro, así que va con redacción
 * dura — igual que sqlMessage.
 */
function isDbShaped(err) {
  if (!err || typeof err !== 'object') return false;
  const p = err.parent || err.original;
  const tiene = (o) => !!o && (o.sqlState !== undefined || o.sqlMessage !== undefined || o.sql !== undefined);
  if (tiene(err) || tiene(p)) return true;
  if (typeof err.name === 'string' && /^Sequelize/.test(err.name)) return true;
  const code = err.code || (p && p.code);
  return typeof code === 'string' && /^(ER_|SQLITE_|PROTOCOL_)/.test(code);
}

function truncate(s, max = MAX_MESSAGE) {
  const t = String(s == null ? '' : s);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Un código estable y publicable; nunca texto libre del motor. */
function safeErrorCode(err) {
  if (!err || typeof err !== 'object') return 'UNKNOWN_ERROR';
  if (typeof err.code === 'string' && SAFE_CODE_RE.test(err.code)) return err.code;
  if (typeof err.code === 'number') return `ERRNO_${Math.abs(err.code)}`;
  const parent = err.parent || err.original;
  if (parent && typeof parent.code === 'string' && SAFE_CODE_RE.test(parent.code)) return parent.code;
  if (typeof err.name === 'string' && /^Sequelize/.test(err.name)) {
    return err.name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  }
  return 'UNKNOWN_ERROR';
}

function shortStack(stack, redact = redactSecrets) {
  if (!stack || typeof stack !== 'string') return undefined;
  const lines = stack.split('\n').slice(0, MAX_STACK_FRAMES + 1);
  return redact(lines.join('\n'));
}

/**
 * Convierte cualquier cosa lanzada en un objeto plano y seguro para logs.
 *
 * @param {unknown} err
 * @param {{ includeStack?: boolean, stage?: string, _depth?: number, _seen?: WeakSet }} opts
 * @returns {object}
 */
function serializeError(err, opts = {}) {
  const { includeStack = true, stage, strict = false, _depth = 0, _seen = new WeakSet() } = opts;

  // No-Error: string, número, null, undefined…
  if (err == null) {
    return { name: 'NoError', message: '(sin error)', error_code: 'UNKNOWN_ERROR', ...(stage ? { stage } : {}) };
  }
  if (typeof err !== 'object') {
    // `strict` viene heredado del padre: una causa primitiva de un error de
    // base ("Duplicate entry 'x@y.com'…") necesita la misma redacción dura.
    return {
      name: typeof err,
      message: truncate((strict ? redactStrict : redactSecrets)(err)),
      error_code: 'NON_ERROR_THROWN',
      ...(stage ? { stage } : {}),
    };
  }
  if (_seen.has(err)) return { name: 'Circular', message: '(referencia circular)', error_code: 'UNKNOWN_ERROR' };
  _seen.add(err);

  const parent = (err.parent && typeof err.parent === 'object') ? err.parent
               : (err.original && typeof err.original === 'object') ? err.original
               : null;
  const pick = (k) => (err[k] !== undefined ? err[k] : (parent ? parent[k] : undefined));

  // Un error de base arrastra valores de fila en su propio message, no sólo en
  // sqlMessage; y sus causas suelen repetir el mismo texto.
  const duro = strict || isDbShaped(err);
  const redact = duro ? redactStrict : redactSecrets;

  const out = {
    name: typeof err.name === 'string' ? err.name : 'Error',
    message: truncate(redact(err.message !== undefined ? err.message : '(sin mensaje)')),
    error_code: safeErrorCode(err),
  };

  const code = pick('code');
  if (code !== undefined && !NEVER_SERIALIZE.has('code')) out.code = typeof code === 'string' ? redactSecrets(code) : code;
  const errno = pick('errno');
  if (errno !== undefined) out.errno = errno;
  const syscall = pick('syscall');
  if (syscall !== undefined) out.syscall = String(syscall);
  const sqlState = pick('sqlState');
  if (sqlState !== undefined) out.sqlState = String(sqlState);
  // sqlMessage sirve para diagnosticar (deadlock, columna inexistente) pero
  // puede traer valores de fila ("Duplicate entry 'juan@…'"): redacción dura.
  const sqlMessage = pick('sqlMessage');
  if (sqlMessage !== undefined) out.sqlMessage = truncate(redactStrict(sqlMessage), 200);
  const status = err.status ?? err.statusCode ?? (parent ? (parent.status ?? parent.statusCode) : undefined);
  if (status !== undefined && status !== null) out.status = status;

  const stg = stage || err.stage;
  if (stg) out.stage = String(stg);

  if (includeStack) {
    const st = shortStack(err.stack, redact);
    if (st) out.stack = st;
  }

  // Cadena de causas, acotada.
  const cause = err.cause;
  if (cause !== undefined && _depth < MAX_CAUSE_DEPTH) {
    out.cause = serializeError(cause, { includeStack: false, strict: duro, _depth: _depth + 1, _seen });
  }

  return out;
}

/** Igual que serializeError pero sin stack: para respuestas HTTP o logs externos. */
function serializeErrorPublic(err, opts = {}) {
  const { stack, ...rest } = serializeError(err, { ...opts, includeStack: false });
  return rest;
}

module.exports = {
  serializeError,
  isDbShaped,
  serializeErrorPublic,
  safeErrorCode,
  redactSecrets,
  redactStrict,
  NEVER_SERIALIZE,
};
