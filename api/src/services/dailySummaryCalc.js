/**
 * dailySummaryCalc.js — Aritmética del resumen diario, en HORA DE PARED.
 *
 * POR QUÉ EXISTE
 *
 * El atraso se calculaba construyendo un instante con offset fijo:
 *
 *     new Date(`${date}T${hh}:${mm}:00-03:00`)
 *
 * Eso no representa a `America/Asuncion` históricamente —Paraguay estuvo en
 * UTC-4 hasta el 2024-10-06—, así que en fechas de invierno anteriores el
 * horario previsto quedaba corrido una hora y `late_minutes` salía mal
 * AUNQUE `first_in` fuese exacto. Es error del dato derivado, no de la
 * presentación: no se arregla formateando.
 *
 * LA REGLA
 *
 * Un turno se define en hora de pared ("entra 07:00") y un marcaje se guarda
 * en hora de pared. Comparar dos horas de pared no necesita zona horaria
 * ninguna: la conversión a instantes UTC era la que introducía el error.
 *
 * Todo acá trabaja con minutos del día (0..1439). El módulo es puro: no toca
 * la base ni la zona del proceso, y por eso los tests pueden fijar valores
 * absolutos y correr igual en UTC, America/Asuncion y Asia/Tokyo.
 */

/** En SEGUNDOS: los marcajes traen segundos y perderlos corre los totales. */
const HALF_DAY = 12 * 3600;
const DAY = 24 * 3600;

/**
 * "HH:mm" o "HH:mm:ss" → segundos del día. null si no se puede interpretar.
 * Los horarios se definen al minuto; los segundos se aceptan y se respetan.
 */
function scheduleSeconds(checkIn) {
  if (checkIn == null) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(checkIn).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3] || 0);
  if (h > 23 || min > 59 || s > 59) return null;
  return h * 3600 + min * 60 + s;
}

/**
 * Diferencia en segundos de `hasta` respecto de `desde`, resolviendo el cruce
 * de medianoche.
 *
 * La regla es ASIMÉTRICA a propósito, y ésta es la parte delicada:
 *
 * - Una diferencia muy NEGATIVA (menor a media jornada) sí se interpreta como
 *   el día siguiente: un turno que entra 23:00 y marca 00:30 da -1350 min en
 *   aritmética directa, y lo que ocurrió son 90 minutos de atraso.
 *
 * - Una diferencia POSITIVA nunca se envuelve. `recalcDailySummary` lee los
 *   marcajes de UN solo día, así que una diferencia positiva grande no puede
 *   ser un cruce de medianoche: es simplemente una jornada larga o una
 *   llegada muy tarde. Envolverla convertía una jornada de 13 horas
 *   (08:00→21:00 = +780 min) en -660 y por lo tanto en CERO minutos
 *   trabajados, y una llegada a las 20:00 con horario 07:00 en cero atraso.
 *
 * - Una diferencia levemente negativa tampoco se envuelve: llegar 06:00 con
 *   horario 07:00 da -60, que es anticipación, no 1380 minutos de atraso.
 */
function wallDelta(desde, hasta) {
  const d = hasta - desde;
  return d < -HALF_DAY ? d + DAY : d;
}

/**
 * Minutos de atraso respecto del horario previsto más la tolerancia.
 *
 * Devuelve 0 si llegó en hora o antes. Nunca negativo: la anticipación no es
 * atraso negativo, se mide aparte. Trunca hacia abajo, igual que antes.
 */
function lateMinutes({ firstInSeconds, checkInSeconds, toleranceMin = 0 }) {
  if (firstInSeconds == null || checkInSeconds == null) return 0;
  const limite = checkInSeconds + (toleranceMin || 0) * 60;
  const d = wallDelta(limite, firstInSeconds);
  return d > 0 ? Math.floor(d / 60) : 0;
}

/**
 * Minutos trabajados entre la primera entrada y la última salida.
 *
 * Se calcula en SEGUNDOS y recién al final se trunca a minutos. Pasar antes
 * por minutos del día sobrestimaba: 08:00:59 → 17:00:00 son 539 minutos
 * completos, pero restando minutos del día daban 540.
 *
 * Nota deliberada: NO descuenta pausas; conserva el criterio que ya tenía el
 * resumen diario (primera entrada → última salida). Cambiar eso alteraría
 * valores históricos y es una decisión aparte.
 */
function workedMinutes({ firstInSeconds, lastOutSeconds }) {
  if (firstInSeconds == null || lastOutSeconds == null) return 0;
  const d = wallDelta(firstInSeconds, lastOutSeconds);
  return d > 0 ? Math.floor(d / 60) : 0;
}

/**
 * Estado del día a partir de lo calculado.
 *
 * `holiday` y `weekend` sólo aplican cuando no hubo ningún marcaje: si la
 * persona trabajó un feriado, el día cuenta como trabajado y el feriado se
 * refleja en las horas extra, no en el estado.
 */
function dayStatus({ hasFirstIn, late, isHoliday = false, isWeekend = false }) {
  if (!hasFirstIn) {
    if (isHoliday) return 'holiday';
    if (isWeekend) return 'weekend';
    return 'absent';
  }
  return late > 0 ? 'late' : 'present';
}

module.exports = {
  scheduleSeconds,
  wallDelta,
  lateMinutes,
  workedMinutes,
  dayStatus,
  HALF_DAY,
  DAY,
};
