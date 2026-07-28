/**
 * rawPunchStats.js — Definición ÚNICA de los KPI de marcas crudas del reloj
 * (raw_device_punches) para el dashboard y la página de sincronización.
 *
 * Clave: una marca está VINCULADA a un empleado cuando su `mapping_status` es
 * 'mapped' o 'duplicate'. El estado 'duplicate' es una marca vinculada que ya
 * existía en attendance_logs y se volvió a leer: esto es lo NORMAL en el
 * auto-polling, que relee el buffer completo del reloj en cada ciclo. Contar
 * sólo 'mapped' dejaba fuera las marcas de los relojes en modo automático
 * (aparecían en "crudas" pero no en "vinculadas"). 'unmapped' = sin empleado
 * (pendiente de vincular); 'invalid' = basura.
 *
 * El controlador usa `LINKED_SQL` en su agregación; `summarizeRawPunches` es la
 * implementación JS de referencia con la MISMA semántica, para las pruebas.
 */

// Estados de raw_device_punches que representan una marca vinculada a empleado.
const LINKED_STATUSES = ['mapped', 'duplicate'];

// Fragmento SQL reutilizable (misma definición que LINKED_STATUSES).
const LINKED_SQL = "mapping_status IN ('mapped','duplicate')";

/**
 * Implementación JS de referencia de los KPI de marcas crudas.
 * @param {Array<{record_time_py?:string, mapping_status:string}>} rows
 * @param {string} today  'YYYY-MM-DD' (hora Paraguay)
 * @returns {{raw_today:number, mapped_today:number, unmapped_pending:number, unmapped_today:number}}
 */
function summarizeRawPunches(rows, today) {
  const stats = { raw_today: 0, mapped_today: 0, unmapped_pending: 0, unmapped_today: 0 };
  for (const r of rows || []) {
    const isToday = String(r.record_time_py || '').slice(0, 10) === today;
    const linked = LINKED_STATUSES.includes(r.mapping_status);
    if (isToday) stats.raw_today++;
    if (isToday && linked) stats.mapped_today++;
    if (r.mapping_status === 'unmapped') stats.unmapped_pending++;
    if (isToday && r.mapping_status === 'unmapped') stats.unmapped_today++;
  }
  return stats;
}

module.exports = { LINKED_STATUSES, LINKED_SQL, summarizeRawPunches };
