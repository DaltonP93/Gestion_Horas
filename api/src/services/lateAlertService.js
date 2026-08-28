/**
 * lateAlertService.js — La alerta de atraso, derivada del MOTOR.
 *
 * Antes `checkAndAlertLate` releía employees.schedule_id (el horario ACTUAL) y
 * calculaba la tardanza con `Date`/`setHours`, creando una SEGUNDA definición de
 * "llegó tarde" distinta de la del motor. Acá la alerta sale de la MISMA fila
 * que produce el materializador, así que hay una sola definición.
 *
 * Reglas (además de reutilizar el cálculo):
 *   - Sin configuración efectiva confiable (modo historical_fallback) → NO se
 *     inventa una tardanza ni se manda una alerta falsa.
 *   - Con conflicto de turnera → NO se alerta: el horario esperado es ambiguo y
 *     el motor deja la tardanza en null (no se elige una turnera arbitraria).
 */

'use strict';

const engine = require('./workdayEngine');
const workdaySummary = require('./workdaySummaryService');

async function checkAndAlertLate(emp, employeeId, anchor, io) {
  let result;
  try {
    // apply:false — sólo lectura. Reutiliza el motor: misma matemática que la
    // materialización y que Marcadas.
    result = await workdaySummary.resolveSummary(employeeId, anchor, { apply: false });
  } catch {
    return; // un fallo al resolver no debe tumbar el marcaje ni disparar alerta
  }

  const anchorISO = workdaySummary.anchorDateISO(anchor);
  const row = (result.rows || []).find((r) => r.date === anchorISO);
  if (!row) return;

  // Sin configuración efectiva: el motor no computa tardanza (queda en 0/null) y
  // el modo es historical_fallback. No se alerta.
  if (row.calculation_mode !== engine.MODE_CONFIGURED) return;

  // Conflicto de turnera: horario esperado ambiguo. No se alerta.
  if (Array.isArray(row.anomalies) && row.anomalies.includes(engine.ANOMALY.TURNERA_CONFLICT)) return;

  const lateMin = Number(row.late_minutes) || 0;
  if (lateMin <= 0) return;

  io.to('role:admin').to('role:hr').emit('alert:late', {
    employeeId,
    employeeName: `${emp.first_name} ${emp.last_name}`,
    lateMinutes: lateMin,
    timestamp: typeof anchor === 'string' ? anchor : new Date(anchor).toISOString(),
  });
}

module.exports = { checkAndAlertLate };
