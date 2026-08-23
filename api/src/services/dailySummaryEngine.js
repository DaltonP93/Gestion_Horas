/**
 * dailySummaryEngine.js — `daily_summary` como materialización del motor.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * QUÉ PROBLEMA CIERRA
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `daily_summary` se calculaba con SU PROPIO algoritmo: los marcajes de una
 * fecha civil, primera entrada, última salida. El reporte de Marcadas usaba
 * otro. Dos algoritmos distintos sobre los mismos datos dan dos respuestas
 * distintas, y ninguna de las dos se puede declarar la correcta.
 *
 * Este módulo convierte la salida del motor en la fila de `daily_summary`.
 * A partir de acá el resumen diario es una MATERIALIZACIÓN del motor —una
 * caché consultable— y no un segundo cálculo.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SEMÁNTICA DE `worked_minutes` — LA DECISIÓN QUE IMPORTA
 * ═══════════════════════════════════════════════════════════════════════
 *
 * La columna `daily_summary.worked_minutes` viene guardando PERMANENCIA:
 * primera entrada a última salida, con el almuerzo adentro. El motor llama a
 * eso `presence_minutes`, y su `worked_minutes` es otra cosa (tramos menos
 * descanso).
 *
 * Este módulo NO cambia el significado de la columna por su cuenta. Expone las
 * dos y deja la elección explícita en `workedMinutesMode`:
 *
 *   'presence'  (por defecto)  conserva la semántica histórica. Un recálculo
 *               no reescribe el pasado con otra definición.
 *   'worked'    pasa la columna a tiempo trabajado neto. Cambia el significado
 *               de datos ya emitidos y por eso es una decisión de negocio, no
 *               un detalle de implementación.
 *
 * Cambiar esto en silencio movería todos los números históricos de RRHH sin
 * que nadie lo hubiera pedido.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ESTE MÓDULO NO ESCRIBE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Es puro: recibe marcajes y configuración, devuelve filas. Quien escriba
 * —el recálculo, cuando se habilite— lo hace afuera. Así el dry-run usa
 * exactamente el mismo código que usaría la escritura, que es la única forma
 * de que la comparación signifique algo.
 */

'use strict';

const engine = require('./workdayEngine');

/** Cómo se llena `daily_summary.worked_minutes`. */
const WORKED_PRESENCE = 'presence';
const WORKED_NET = 'worked';

/**
 * Estado del día.
 *
 * `holiday` y `weekend` sólo aplican cuando NO hubo marcajes: si la persona
 * trabajó un feriado, el día cuenta como trabajado y el feriado se refleja en
 * las horas extra, no en el estado. Es el criterio que ya tenía el sistema y
 * se conserva.
 */
function statusDe({ jornada, isHoliday, isWeekend }) {
  if (!jornada) {
    if (isHoliday) return 'holiday';
    if (isWeekend) return 'weekend';
    return 'absent';
  }
  if (jornada.non_working_kind === 'vacation' || jornada.non_working_kind === 'permiso') {
    return 'permission';
  }
  return (jornada.late_minutes || 0) > 0 ? 'late' : 'present';
}

/**
 * Filas de `daily_summary` para UN empleado, derivadas del motor.
 *
 * @param {Array}  punches   marcajes de la VENTANA (no de la fecha civil): un
 *                           turno nocturno cierra al día siguiente, así que
 *                           leer sólo el día perdería su salida.
 * @param {Object} options
 *        - `from` / `to`          período a materializar.
 *        - `resolveConfig`        resolvedor de configuración por fecha.
 *        - `holidays`             Set de fechas 'YYYY-MM-DD'.
 *        - `workedMinutesMode`    ver arriba. Por defecto 'presence'.
 *
 * @returns {Array} filas listas para comparar o escribir.
 */
function buildDailySummaryRows(punches, options = {}) {
  const {
    from, to,
    holidays = new Set(),
    workedMinutesMode = WORKED_PRESENCE,
  } = options;

  const { workdays } = engine.buildWorkdays(punches, options);
  const delPeriodo = engine.clipToPeriod(workdays, { from, to });

  return delPeriodo.map((j) => {
    const isHoliday = holidays.has(j.work_date);
    const dow = engine.dayOfWeekISO(j.work_date);
    const isWeekend = dow === 0 || dow === 6;

    return {
      date: j.work_date,
      first_in: j.first_in,
      last_out: j.last_out,
      worked_minutes: workedMinutesMode === WORKED_NET
        ? j.worked_minutes
        : j.presence_minutes,
      // Se conservan las dos para que la comparación pueda explicar una
      // diferencia sin volver a calcular nada.
      presence_minutes: j.presence_minutes,
      net_worked_minutes: j.worked_minutes,
      break_minutes: j.break_minutes,
      late_minutes: j.late_minutes || 0,
      // El motor mide exceso sobre el objetivo, no hora extra legal. Volcarlo
      // a `overtime_minutes` sin una política cargada convertiría una medición
      // en una liquidación; queda en 0 hasta que exista esa política.
      overtime_minutes: 0,
      contract_excess_minutes: j.contract_excess_minutes,
      status: statusDe({ jornada: j, isHoliday, isWeekend }),
      schedule_id: j.schedule_id,
      calculation_mode: j.calculation_mode,
      policy_version: j.policy_version,
      anomalies: j.anomalies.map((a) => a.code),
      crosses_midnight: j.crosses_midnight,
    };
  });
}

/**
 * Compara una fila guardada contra la que produciría el motor.
 *
 * @returns {{ iguales: boolean, difieren: Array<string> }}
 *
 * `null` en el lado guardado significa "el motor ve una jornada que
 * `daily_summary` no tiene", que es distinto de "los minutos no coinciden" y
 * por eso se informa aparte.
 */
function compararFila(guardada, calculada) {
  if (!guardada) return { iguales: false, difieren: ['sin_fila_guardada'] };
  if (!calculada) return { iguales: false, difieren: ['sin_jornada_calculada'] };

  const difieren = [];
  const num = (v) => (v == null ? null : Number(v));

  if (num(guardada.worked_minutes) !== num(calculada.worked_minutes)) difieren.push('worked_minutes');
  if (num(guardada.late_minutes) !== num(calculada.late_minutes)) difieren.push('late_minutes');
  if (num(guardada.break_minutes) !== num(calculada.break_minutes)) difieren.push('break_minutes');
  if (String(guardada.status || '') !== String(calculada.status || '')) difieren.push('status');

  // Las horas se comparan a nivel de minuto: `daily_summary` guarda DATETIME y
  // los segundos no aportan a la comparación, pero sí generarían ruido.
  const hhmm = (v) => (v == null ? null : String(v).slice(0, 16));
  if (hhmm(guardada.first_in) !== hhmm(calculada.first_in)) difieren.push('first_in');
  if (hhmm(guardada.last_out) !== hhmm(calculada.last_out)) difieren.push('last_out');

  return { iguales: difieren.length === 0, difieren };
}

module.exports = {
  buildDailySummaryRows,
  compararFila,
  statusDe,
  WORKED_PRESENCE,
  WORKED_NET,
};
