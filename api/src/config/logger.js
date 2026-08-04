const winston = require('winston');
const { serializeError, redactSecrets, redactStrict } = require('../utils/errorInfo');

const SPLAT = Symbol.for('splat');

/**
 * Rescata los argumentos extra de `logger.x('mensaje:', algo)`.
 *
 * Winston, sin formato de splat, descarta esos argumentos en silencio: por eso
 * los logs mostraban `Error cargando schedules HR: {}` — sin message, sin code
 * y sin stack. Y `splat()` por sí solo tampoco alcanza: cuando el mensaje no
 * tiene placeholders, hace Object.assign del argumento, así que un string se
 * esparce en un objeto con una clave por carácter.
 *
 * Reglas:
 *  - primitivos (string/número/boolean) → se anexan al mensaje;
 *  - Error → se serializa a `error` + `error_code`, sin secretos;
 *  - objetos planos → quedan como metadata (los resuelve splat()).
 */
/**
 * Redacción de un argumento extra primitivo — casi siempre un `err.message`.
 *
 * Winston los descartaba enteros; ahora que llegan al log hay que mirarlos.
 * Si el texto trae un literal entrecomillado se aplica la redacción dura: los
 * mensajes de MySQL meten los valores de fila entre comillas
 * ("Duplicate entry 'juan@empresa.com' for key 'email'"). Sin comillas se usa
 * la suave, para no perder datos útiles de operación como una IP y un puerto.
 */
function redactPrimitiveSplat(arg) {
  const s = String(arg);
  return /['"`]/.test(s) ? redactStrict(s) : redactSecrets(s);
}

const rescueSplat = winston.format((info) => {
  const extra = info[SPLAT];
  if (!Array.isArray(extra) || extra.length === 0) return info;

  // Con placeholders (%s, %d…) el formato printf de splat() hace lo correcto.
  if (typeof info.message === 'string' && /%[sdifjoOc%]/.test(info.message)) return info;

  const appended = [];
  const metas = [];
  for (const arg of extra) {
    if (arg instanceof Error) {
      // Winston ya copió las props enumerables del Error a la raíz del registro
      // (y errors() le agregó el stack crudo): se quitan para que quede una
      // sola versión, la serializada y redactada.
      for (const k of Object.keys(arg)) {
        if (info[k] === arg[k]) delete info[k];
      }
      if (info.stack === arg.stack) delete info.stack;
      const ser = serializeError(arg);
      metas.push({ error: ser, error_code: ser.error_code });
    } else if (arg === null || arg === undefined || typeof arg !== 'object') {
      appended.push(redactPrimitiveSplat(arg));
    } else {
      metas.push(arg);
    }
  }

  if (appended.length) info.message = `${info.message} ${appended.join(' ')}`.trim();
  info[SPLAT] = metas;
  return info;
});

/** Última barrera: ninguna credencial llega al log, venga de donde venga. */
const redactMessage = winston.format((info) => {
  if (typeof info.message === 'string') info.message = redactSecrets(info.message);
  if (typeof info.stack === 'string') info.stack = redactSecrets(info.stack);
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    rescueSplat(),
    winston.format.splat(),
    redactMessage(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

module.exports = logger;
