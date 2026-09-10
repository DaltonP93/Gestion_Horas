/**
 * monthlyWorkedFromEngine.js — Total trabajado del REPORTE MENSUAL por el motor.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * QUÉ CIERRA
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `GET /api/reports/monthly` sumaba `daily_summary.worked_minutes`, una tabla
 * que hoy escribe el motor LEGACY por FECHA CIVIL. Un turno nocturno que cruza
 * medianoche (entra el miércoles 21:00, sale el jueves 06:00) queda partido en
 * dos filas —una por cada fecha civil— y el total mensual no cierra con lo que
 * muestra el reporte de "Marcadas", que sí pasa por el motor bueno.
 *
 * Este helper calcula el total trabajado del mes con EXACTAMENTE el mismo motor
 * y el mismo camino de lectura que usa `scheduler.generateMarcadasReport`:
 *
 *   attendance_logs (hora de pared) → workdayEngine.buildWorkdays →
 *   clipToPeriod(work_date) → suma de worked_minutes por jornada
 *
 * La jornada se fecha por su PRIMERA entrada, así que un nocturno se atribuye
 * entero al día que empezó y no se parte. Es SÓLO LECTURA: no toca
 * `daily_summary` ni ningún flag.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * QUÉ CAMPO SE SUMA, Y POR QUÉ COINCIDE CON MARCADAS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Se suma `worked_minutes` de cada jornada = tramos entrada→salida menos el
 * descanso que corresponda descontar (la semántica "trabajado" pedida). En el
 * estado real de producción —sin configuración histórica vigente, jornadas en
 * `historical_fallback` con descanso `punched`— el motor NO descuenta de nuevo
 * (las pausas ya están fuera de la suma de tramos), así que
 * `worked_minutes === segment_minutes`, que es justo lo que la columna "Total"
 * de Marcadas suma. Por eso los dos reportes cierran entre sí. Marcadas usa
 * `segment_minutes` para su "Total Permanencia"; acá se usa `worked_minutes`
 * para conservar la semántica de "trabajado neto" de la columna mensual, y en
 * `historical_fallback` los dos números son el mismo.
 */

'use strict';

const { sequelize } = require('../config/database');
const engine = require('./workdayEngine');
const { loadWorkdayConfig } = require('./workdayConfig');

/**
 * Empleados procesados por lote — mismo criterio que Marcadas: el pico de
 * memoria depende del LOTE y no del período completo.
 */
const EMPLOYEE_CHUNK = 50;

/**
 * Tope duro de marcajes por lote — mismo criterio y valor que Marcadas. Se
 * prefiere fallar con un error tipado que diga qué achicar antes que morir por
 * OOM en un rango histórico enorme.
 */
const MAX_PUNCHES_PER_CHUNK = 400000;

/**
 * Minutos trabajados por empleado en `[from, to]`, calculados por el motor.
 *
 * @param {number[]} employeeIds  ids ya filtrados/acotados por el caller (RBAC).
 * @param {{from:string, to:string}} periodo  fechas civiles 'YYYY-MM-DD'.
 * @returns {Promise<Map<number, { workedMinutes:number, byDate:Map<string,number> }>>}
 *          Una entrada por empleado pedido (0 si no tiene jornadas). `byDate`
 *          mapea `work_date` → minutos trabajados de ESA jornada, para que el
 *          export pueda mostrar el total por día ya consolidado por el motor.
 */
async function monthlyWorkedByEmployee(employeeIds, { from, to } = {}) {
  const ids = [...new Set((employeeIds || []).map(Number).filter(Number.isInteger))];
  const result = new Map();
  for (const id of ids) result.set(id, { workedMinutes: 0, byDate: new Map() });
  if (!ids.length || !from || !to) return result;

  // Ventana ampliada: una jornada del último día puede cerrar al día siguiente,
  // y una del día anterior a `from` puede cerrar dentro del período. Es la misma
  // ventana que lee Marcadas, así que los dos ven las mismas jornadas.
  const ventana = engine.punchWindow({ from, to });

  for (let i = 0; i < ids.length; i += EMPLOYEE_CHUNK) {
    const lote = ids.slice(i, i + EMPLOYEE_CHUNK);

    // `timestamp >= ? AND < ?` es sargable sobre idx_emp_ts; el LIMIT acota la
    // materialización para no traer millones de filas de un rango largo.
    const [logs] = await sequelize.query(`
      SELECT
        al.id,
        al.employee_id,
        DATE_FORMAT(al.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp,
        al.type
      FROM attendance_logs al
      WHERE al.employee_id IN (${lote.map(() => '?').join(',')})
        AND al.timestamp >= ? AND al.timestamp < ?
      ORDER BY al.employee_id, al.timestamp, al.id
      LIMIT ${MAX_PUNCHES_PER_CHUNK + 1}
    `, { replacements: [...lote, ventana.from, ventana.to] });

    if (logs.length > MAX_PUNCHES_PER_CHUNK) {
      const err = new Error(
        `El período ${from}..${to} devuelve demasiados marcajes para procesar de una vez `
        + `(más de ${MAX_PUNCHES_PER_CHUNK} en un lote de ${lote.length} empleados). `
        + 'Acotar el rango de fechas o filtrar por departamento.',
      );
      err.status = 413;
      err.code = 'MONTHLY_TOO_MANY_PUNCHES';
      throw err;
    }

    const porEmpleado = new Map();
    for (const log of logs) {
      const arr = porEmpleado.get(log.employee_id);
      if (arr) arr.push(log); else porEmpleado.set(log.employee_id, [log]);
    }

    // Configuración del lote en consultas acotadas al rango, igual que Marcadas.
    const config = await loadWorkdayConfig(lote, { from, to });

    for (const empId of lote) {
      const marcajes = porEmpleado.get(empId) || [];
      const { workdays } = engine.buildWorkdays(marcajes, {
        resolveConfig: (workDate) => config.forDate(empId, workDate),
      });
      const delPeriodo = engine.clipToPeriod(workdays, { from, to });
      const agg = result.get(empId);
      for (const j of delPeriodo) {
        agg.workedMinutes += j.worked_minutes;
        agg.byDate.set(j.work_date, (agg.byDate.get(j.work_date) || 0) + j.worked_minutes);
      }
    }
  }

  return result;
}

module.exports = {
  monthlyWorkedByEmployee,
  EMPLOYEE_CHUNK,
  MAX_PUNCHES_PER_CHUNK,
};
