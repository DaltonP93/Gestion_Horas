/**
 * workedReads.js — worked_minutes por el MOTOR de jornada para pantallas de LECTURA.
 *
 * `daily_summary.worked_minutes` lo escribe el motor LEGACY por FECHA CIVIL, así
 * que un turno que cruza medianoche (entra miércoles 21:00, sale jueves 06:00)
 * queda partido en dos filas y los totales no cierran. Igual que /monthly (#196),
 * estas utilidades piden al MOTOR los minutos trabajados atribuidos al día en que
 * la jornada EMPEZÓ (por su primera entrada). Son SÓLO LECTURA: no tocan
 * `daily_summary` ni ningún flag.
 *
 * Reusado por reports.js (semanal/diario/analítica) y me.js (self-service).
 */

'use strict';

const { monthlyWorkedByEmployee } = require('./monthlyWorkedFromEngine');
const logger = require('../config/logger');

/** Map<employee_id, Map<'YYYY-MM-DD', minutos>> por el motor. */
async function engineWorkedByDate(employeeIds, from, to) {
  const res = await monthlyWorkedByEmployee(employeeIds, { from, to });
  const out = new Map();
  for (const [id, agg] of res) out.set(Number(id), agg.byDate);
  return out;
}

/** Total de minutos trabajados por el motor para UN empleado en [from,to]. */
async function engineWorkedTotal(employeeId, from, to) {
  const res = await monthlyWorkedByEmployee([employeeId], { from, to });
  const agg = res.get(Number(employeeId));
  return agg ? agg.workedMinutes : 0;
}

/** Normaliza una fecha (Date | 'YYYY-MM-DD...') a 'YYYY-MM-DD'. */
function ymd(v) {
  if (v instanceof Date) return v.toISOString().split('T')[0];
  return String(v || '').slice(0, 10);
}

/**
 * Sobrescribe `worked_minutes` de cada fila con el valor del motor (jornada
 * atribuida a su día de inicio). Resiliente: si el motor no está disponible
 * (p. ej. 413 por rango enorme) conserva el valor legacy y marca la fila con
 * `worked_source: 'legacy_fallback'` para que la degradación sea observable,
 * sin romper la pantalla. En el camino normal cada fila queda con
 * `worked_source: 'engine'`.
 */
async function overrideWorkedFromEngine(rows, { from, to, idOf, dateOf, route }) {
  if (!rows || !rows.length) return;
  const ids = [...new Set(rows.map((r) => Number(idOf(r))).filter(Number.isInteger))];
  try {
    const worked = await engineWorkedByDate(ids, from, to);
    for (const r of rows) {
      const byDate = worked.get(Number(idOf(r)));
      r.worked_minutes = byDate ? (byDate.get(ymd(dateOf(r))) || 0) : 0;
      r.worked_source = 'engine';
    }
  } catch (err) {
    logger.warn('workedReads: worked_minutes por motor no disponible; se usa legacy', {
      route, reason: err.code || 'ENGINE_ERROR',
    });
    for (const r of rows) r.worked_source = 'legacy_fallback';
  }
}

module.exports = { engineWorkedByDate, engineWorkedTotal, ymd, overrideWorkedFromEngine };
