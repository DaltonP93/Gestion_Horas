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
    const [, y, mo, d, h, mi, se] = naive;
    return fmt(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(se || 0));
  }

  // Caso B: string con zona explícita (Z u offset) → instante → hora de pared.
  if (CON_ZONA_RE.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`Timestamp de marcaje inválido: ${s}`);
    return instanteAWallClock(d, tz);
  }

  throw new Error(`Formato de timestamp de marcaje no reconocido: ${s}`);
}

module.exports = { normalizeAttendanceTimestampForDb };
