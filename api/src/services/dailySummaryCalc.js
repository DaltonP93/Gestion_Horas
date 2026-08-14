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

/** Media jornada en minutos: umbral para decidir que hubo cruce de medianoche. */
const HALF_DAY = 720;
const DAY = 1440;

/**
 * "HH:mm" o "HH:mm:ss" → minutos del día. null si no se puede interpretar.
 */
function scheduleMinutes(checkIn) {
  if (checkIn == null) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(checkIn).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Diferencia en minutos de `hasta` respecto de `desde`, ambos minutos del día,
 * resolviendo el cruce de medianoche.
 *
 * Un turno nocturno que entra 23:00 y marca 00:30 da -1350 en aritmética
 * directa; lo que ocurrió en realidad son 90 minutos de atraso. La regla:
 * una diferencia menor a -720 se interpreta como el día siguiente, y una
 * mayor a +720 como el día anterior. Media jornada es el punto donde
 * "llegó tardísimo" deja de ser más probable que "es del otro día".
 */
function wallDelta(desde, hasta) {
  let d = hasta - desde;
  if (d < -HALF_DAY) d += DAY;
  else if (d > HALF_DAY) d -= DAY;
  return d;
}

/**
 * Minutos de atraso respecto del horario previsto más la tolerancia.
 *
 * Devuelve 0 si llegó en hora o antes. Nunca negativo: la anticipación no es
 * atraso negativo, se mide aparte.
 */
function lateMinutes({ firstInMinutes, checkInMinutes, toleranceMin = 0 }) {
  if (firstInMinutes == null || checkInMinutes == null) return 0;
  const limite = checkInMinutes + (toleranceMin || 0);
  const d = wallDelta(limite, firstInMinutes);
  return d > 0 ? d : 0;
}

/**
 * Minutos trabajados entre la primera entrada y la última salida.
 *
 * Se calcula en hora de pared y con la misma regla de cruce de medianoche,
 * así que una salida a las 02:00 sobre una entrada a las 22:00 da 240 y no
 * un número negativo.
 *
 * Nota deliberada: NO descuenta pausas; conserva el criterio que ya tenía el
 * resumen diario (primera entrada → última salida). Cambiar eso alteraría
 * valores históricos y es una decisión aparte.
 */
function workedMinutes({ firstInMinutes, lastOutMinutes }) {
  if (firstInMinutes == null || lastOutMinutes == null) return 0;
  const d = wallDelta(firstInMinutes, lastOutMinutes);
  return d > 0 ? d : 0;
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
  scheduleMinutes,
  wallDelta,
  lateMinutes,
  workedMinutes,
  dayStatus,
  HALF_DAY,
  DAY,
};
