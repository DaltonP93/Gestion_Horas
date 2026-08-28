/**
 * attendanceTime.js — Normalización de timestamps para INSERT en attendance_logs.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * INVARIANTE DEL PROYECTO: attendance_logs.timestamp ES WALL-CLOCK
 * ═══════════════════════════════════════════════════════════════════════
 *
 * La columna `attendance_logs.timestamp` (DATETIME) guarda HORA DE PARED. El
 * motor de jornada la lee como tal y NUNCA le aplica una zona horaria. El
 * defecto histórico —reinterpretar esa hora como UTC y correrla— no debe volver
 * a introducirse por la puerta de atrás al INSERTAR nuevas marcas.
 *
 * Hay dos clases de entrada, y se tratan distinto A PROPÓSITO:
 *
 *   A) NAIVE, proveniente de un reloj/dispositivo: "2026-08-27 18:30:15" o
 *      "2026-08-27T18:30". Ese valor YA ES hora de pared. Se persisten sus
 *      componentes exactos, sin ninguna conversión. Reinterpretarlo como UTC y
 *      convertirlo sería exactamente el defecto histórico.
 *
 *   B) INSTANTE real del sistema: un `Date` (p. ej. `new Date()` en el marcaje
 *      móvil) o un ISO con `Z`/offset explícito ("2026-08-27T21:30:15Z"). Ahí sí
 *      hay que convertir el instante a la hora de pared de la institución ANTES
 *      de persistir el DATETIME.
 *
 * La MISMA regla vale para device, manual, mobile y bridge: una sola primitiva,
 * no una interpretación distinta por fuente.
 *
 * Persistir la hora de pared como STRING "YYYY-MM-DD HH:mm:ss" (no un `Date`) es
 * lo que garantiza que mysql2 guarde exactamente esos componentes: un `Date` lo
 * serializaría con la zona de la conexión y volvería a mover la hora.
 *
 * NOTA: esto es para INSERT FUTUROS. No toca ni reescribe filas existentes.
 */

'use strict';

const pad2 = (n) => String(n).padStart(2, '0');

// Zona IANA de la institución. Se usa SÓLO para convertir instantes reales a
// hora de pared; para un naive nunca hay conversión.
const INSTITUTION_TZ = process.env.ATTENDANCE_TZ || 'America/Asuncion';

// Naive = fecha y hora SIN marca de zona (ni Z ni ±HH:MM al final). Acepta
// separador " " o "T" y segundos/fracción opcionales.
const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
// Con zona explícita: termina en Z o en ±HH:MM / ±HHMM.
const CON_ZONA_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;

const fmt = (y, mo, d, h, mi, s) => `${pad2(y)}-${pad2(mo)}-${pad2(d)} ${pad2(h)}:${pad2(mi)}:${pad2(s)}`;

/**
 * ¿Los componentes forman una fecha-hora de calendario REAL? La forma la valida
 * el regex; esto valida los RANGOS y el día dentro del mes (bisiestos incluidos).
 * No se delega en que MySQL rechace la marca: una fecha imposible debe frenarse
 * ANTES del INSERT, no persistir una hora inventada ni depender del modo SQL.
 *
 * Se verifica por round-trip de calendario en UTC (mismo principio que
 * WorkdayEngine.toWall): si algún componente se desborda —día 30 de febrero, mes
 * 13, hora 24, minuto/segundo 60— el Date normaliza y el round-trip no coincide.
 */
function naiveEsValido(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  if (h > 23 || mi > 59 || s > 59) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
      && dt.getUTCHours() === h && dt.getUTCMinutes() === mi && dt.getUTCSeconds() === s;
}

/**
 * Instante (Date) → hora de pared de la institución "YYYY-MM-DD HH:mm:ss".
 *
 * Resuelve la zona IANA para la FECHA CONCRETA del instante: aplica la tzdata
 * histórica de Paraguay (UTC-4 hasta 2024-10-06, UTC-3 después). Un offset fijo
 * -03:00 movería una hora los instantes anteriores al cambio (una carga manual
 * `2024-07-01T12:00:00Z` es 08:00 en Asunción, no 09:00). Acá SÍ corresponde la
 * tzdata: un instante real cambia de hora civil según el offset vigente; lo que
 * NO se convierte es un string naive, que ya es hora de pared.
 */
function instanteAWallClock(date, tz) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const g = {};
  for (const p of partes) if (p.type !== 'literal') g[p.type] = p.value;
  // Algunos ICU emiten '24' para la medianoche aun con hourCycle h23; se normaliza.
  const hora = g.hour === '24' ? '00' : g.hour;
  return `${g.year}-${g.month}-${g.day} ${hora}:${g.minute}:${g.second}`;
}

/**
 * Normaliza un timestamp de marcaje a la hora de pared que debe persistirse.
 *
 * @param {string|Date} input  naive del dispositivo, ISO con zona, o `Date`.
 * @param {object} [opts]
 *        - `tz`  offset de la institución para el caso B (por defecto DB_TIMEZONE).
 * @returns {string} "YYYY-MM-DD HH:mm:ss" en hora de pared.
 * @throws si el valor no se puede interpretar (marca inválida: se rechaza, no se
 *         guarda una hora inventada).
 */
function normalizeAttendanceTimestampForDb(input, opts = {}) {
  const tz = opts.tz || INSTITUTION_TZ;

  // Caso B: un Date es un instante real → convertir a hora de pared.
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new Error('Timestamp de marcaje inválido (Date)');
    return instanteAWallClock(input, tz);
  }

  const s = String(input == null ? '' : input).trim();
  if (!s) throw new Error('Timestamp de marcaje vacío');

  // Caso A: string naive → hora de pared, se persiste tal cual (segundos a 0 si
  // no vinieron). NUNCA se convierte por zona.
  const naive = NAIVE_RE.exec(s);
  if (naive && !CON_ZONA_RE.test(s)) {
    const y = Number(naive[1]); const mo = Number(naive[2]); const d = Number(naive[3]);
    const h = Number(naive[4]); const mi = Number(naive[5]); const se = Number(naive[6] || 0);
    if (!naiveEsValido(y, mo, d, h, mi, se)) {
      throw new Error(`Timestamp de marcaje inválido (fecha/hora fuera de rango): ${s}`);
    }
    return fmt(y, mo, d, h, mi, se);
  }

  // Caso B: string con zona explícita (Z u offset) → instante → hora de pared.
  if (CON_ZONA_RE.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`Timestamp de marcaje inválido: ${s}`);
    return instanteAWallClock(d, tz);
  }

  throw new Error(`Formato de timestamp de marcaje no reconocido: ${s}`);
}

/**
 * Offset de la zona `tz` (en ms que la zona va ADELANTADA respecto de UTC) en un
 * instante dado. Sale de renderizar el instante en la zona y diferenciar; usa la
 * tzdata IANA, así que respeta el offset histórico vigente en esa fecha.
 */
function tzOffsetMs(instantMs, tz) {
  const wall = instanteAWallClock(new Date(instantMs), tz); // "YYYY-MM-DD HH:mm:ss"
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(wall);
  const asUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return asUTC - instantMs;
}

/**
 * Hora de pared institucional "YYYY-MM-DD HH:mm:ss" → INSTANTE real (Date).
 *
 * Es la INVERSA de instanteAWallClock: interpreta el wall-clock como hora local
 * de la institución (con la tzdata histórica de la fecha) y devuelve el Date del
 * instante correspondiente. Sirve para trazas/socket/audit/webhooks/logs, donde
 * hace falta un instante (ISO) sin depender de la zona del proceso Node —el
 * defecto de `new Date("2026-08-27 18:30:15")`, que parsea en la TZ local del
 * runtime y produce un instante distinto en UTC, en Asunción y en Tokio—.
 *
 * NO altera la persistencia: la columna sigue guardando el string wall-clock.
 *
 * @param {string} wallStr  "YYYY-MM-DD HH:mm:ss" (o con 'T'); hora de pared.
 * @param {object} [opts] - `tz` zona de la institución (por defecto INSTITUTION_TZ).
 * @returns {Date} instante real.
 * @throws si el string no tiene forma de wall-clock.
 */
function wallClockToInstitutionInstant(wallStr, opts = {}) {
  const tz = opts.tz || INSTITUTION_TZ;
  const m = NAIVE_RE.exec(String(wallStr == null ? '' : wallStr).trim());
  if (!m) throw new Error(`Wall-clock no reconocido para instante: ${wallStr}`);
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const h = Number(m[4]); const mi = Number(m[5]); const se = Number(m[6] || 0);
  // Se parte tratando los componentes COMO SI fueran UTC y se corrige por el
  // offset de la zona. Se refina una vez con el offset del instante candidato,
  // que basta salvo dentro de la hora exacta de un salto DST.
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi, se);
  const off1 = tzOffsetMs(utcGuess, tz);
  let instant = utcGuess - off1;
  const off2 = tzOffsetMs(instant, tz);
  if (off2 !== off1) instant = utcGuess - off2;
  return new Date(instant);
}

module.exports = { normalizeAttendanceTimestampForDb, wallClockToInstitutionInstant };
