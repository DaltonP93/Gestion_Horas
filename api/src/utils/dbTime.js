/**
 * dbTime.js — Formateo de horas provenientes de columnas DATETIME.
 *
 * PROBLEMA QUE RESUELVE
 *
 * Las columnas DATETIME (`daily_summary.first_in`, `last_out`, …) no llevan
 * zona: guardan una hora de pared. mysql2 las entrega como objeto `Date`,
 * interpretándolas con el offset fijo declarado en la config de sequelize.
 *
 * Varios reportes intentaban recuperar la hora recortando el string:
 *
 *     String(rec.first_in).slice(11, 16)
 *
 * Eso asume el formato MySQL "YYYY-MM-DD HH:mm:ss". Sobre un `Date` real,
 * `String()` produce el formato de JS —"Tue Aug 12 2025 08:15:00 GMT…"— donde
 * las posiciones 11..16 caen sobre el AÑO. De ahí el "2025" impreso en la
 * columna Entrada del PDF mensual.
 *
 * POR QUÉ SE USA UN OFFSET FIJO Y NO LA TZDATA
 *
 * Para devolver exactamente la hora de pared que está guardada, hay que
 * deshacer la MISMA conversión que aplicó el driver al leerla. El driver usa
 * el offset fijo de la config; por lo tanto el formateo también. Así el
 * round-trip es exacto y —esto importa— el resultado NO depende de la zona
 * del proceso: da igual correr en UTC, en America/Asuncion o en Asia/Tokyo.
 *
 * Deliberadamente NO se usa `Intl` con `America/Asuncion` acá. Hacerlo
 * aplicaría la tzdata histórica (Paraguay estuvo en UTC-4 hasta 2024-10-06) y
 * correría una hora los valores históricos. Si esa corrección corresponde o no
 * es una pregunta abierta —depende de qué guardó cada import, y se responde
 * con las consultas de docs/sql/auditoria-reportes-readonly.sql—. Este helper
 * sólo arregla el formateo roto; no decide esa cuestión ni la prejuzga.
 */

const { DB_TIMEZONE } = require('../config/database');

/**
 * Offset a usar por defecto.
 *
 * `DB_TIMEZONE` es una constante literal de la config, no una variable de
 * entorno: que llegue vacía no significa "mal configurado" sino "el módulo de
 * base está mockeado", que es lo que pasa en gran parte de la suite. Por eso
 * acá se cae al mismo valor en vez de romper.
 *
 * La validación estricta sigue viva donde sí importa: `parseOffsetMinutes`
 * lanza ante un offset MAL ESCRITO, que es el caso que desplazaría en
 * silencio todas las horas del sistema.
 */
const TZ_POR_DEFECTO = DB_TIMEZONE || '-03:00';

/** "-03:00" | "+05:30" → minutos con signo. */
function parseOffsetMinutes(tz) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(String(tz || '').trim());
  if (!m) throw new Error(`Offset de zona inválido en la config: ${tz}`);
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Hora "HH:mm" de un valor DATETIME leído de la base.
 *
 * Acepta el `Date` que devuelve el driver y también el string crudo de MySQL,
 * por si alguna consulta corre con `dateStrings` activado.
 * Devuelve '' para nulos y para valores no interpretables — nunca lanza, para
 * que un dato aislado corrupto no tumbe la generación de un reporte entero.
 */
function dbTimeHHmm(value, tz = TZ_POR_DEFECTO) {
  if (value == null || value === '') return '';

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    // Hora de pared en el offset del driver = instante desplazado, leído en UTC.
    const shifted = new Date(value.getTime() + parseOffsetMinutes(tz) * 60000);
    return `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
  }

  const s = String(value);
  // "YYYY-MM-DD HH:mm:ss" o "YYYY-MM-DDTHH:mm:ss…" → tomar la hora tal cual,
  // que ya es hora de pared y no necesita conversión.
  const m = /^\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})/.exec(s);
  if (m) return `${m[1]}:${m[2]}`;

  // "HH:mm:ss" suelto (columnas TIME).
  const t = /^(\d{2}):(\d{2})/.exec(s);
  if (t) return `${t[1]}:${t[2]}`;

  return '';
}

/**
 * Partes de la hora de pared guardada: { date: 'YYYY-MM-DD', minutes }.
 *
 * `minutes` es el minuto del día (0..1439). Devuelve null si el valor no se
 * puede interpretar.
 *
 * Igual que dbTimeHHmm, deshace la conversión del driver con el offset fijo,
 * así que el resultado NO depende de la zona del proceso ni aplica la tzdata
 * histórica.
 */
function dbWallClock(value, tz = TZ_POR_DEFECTO) {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const d = new Date(value.getTime() + parseOffsetMinutes(tz) * 60000);
    return {
      date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
      minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
      seconds: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(),
    };
  }

  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value));
  if (!m) return null;
  const h = Number(m[2]), mi = Number(m[3]), se = Number(m[4] || 0);
  return { date: m[1], minutes: h * 60 + mi, seconds: h * 3600 + mi * 60 + se };
}

/** Fecha civil "YYYY-MM-DD" de la hora de pared guardada. */
function dbDateISO(value, tz = TZ_POR_DEFECTO) {
  const wc = dbWallClock(value, tz);
  return wc ? wc.date : null;
}

/** Minuto del día (0..1439) de la hora de pared guardada. */
function dbMinutesOfDay(value, tz = TZ_POR_DEFECTO) {
  const wc = dbWallClock(value, tz);
  return wc ? wc.minutes : null;
}

/** Segundo del día (0..86399) de la hora de pared guardada. */
function dbSecondsOfDay(value, tz = TZ_POR_DEFECTO) {
  const wc = dbWallClock(value, tz);
  return wc ? wc.seconds : null;
}

module.exports = {
  dbTimeHHmm,
  dbSecondsOfDay,
  parseOffsetMinutes,
  dbWallClock,
  dbDateISO,
  dbMinutesOfDay,
};
