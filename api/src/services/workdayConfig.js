/**
 * workdayConfig.js — Resolución de la configuración de jornada desde la base.
 *
 * Separa la LECTURA de la configuración del CÁLCULO de la jornada.
 * `workdayEngine` es puro y no toca la base; este módulo le arma la entrada.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * DEGRADACIÓN DELIBERADA
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `employee_schedule_history` la crea la migración 072, que NO está aplicada
 * en producción. Que falte no puede tumbar un reporte: si la tabla no existe,
 * este módulo devuelve historial vacío y TODAS las jornadas quedan en modo
 * `historical_fallback` —se describe lo que los marcajes dicen, sin atrasos
 * inventados—, que es exactamente el comportamiento correcto mientras la
 * vigencia no esté cargada.
 *
 * La distinción importa: se degrada ante "la tabla no existe" (42S02), no ante
 * cualquier error. Una caída de MySQL sigue propagándose, porque devolver
 * "sin configuración" ante una base caída convertiría una falla de
 * infraestructura en números silenciosamente distintos.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * QUÉ NO HACE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * NO usa `employees.schedule_id` como respaldo del historial. Esa columna
 * dice qué horario rige HOY y no tiene fecha; aplicarla a una jornada de 2024
 * es precisamente lo que fabrica atrasos retroactivos. Se usa sólo para la
 * fecha corriente, y sólo cuando el llamador lo pide explícitamente con
 * `allowCurrentAssignment`.
 */

'use strict';

const { sequelize } = require('../config/database');
const { isMissingTableError } = require('../utils/schemaState');
const logger = require('../config/logger');

/** Se avisa una sola vez por proceso: es una condición estable, no un evento. */
let avisoTablaAusente = false;

/**
 * Historial de vigencia de los empleados pedidos.
 *
 * @returns {Map<number, Array>} employee_id → tramos ordenados por valid_from.
 *          Un empleado sin tramos simplemente no aparece en el Map.
 */
async function loadScheduleHistory(employeeIds) {
  const ids = [...new Set((employeeIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return new Map();

  let rows;
  try {
    [rows] = await sequelize.query(`
      SELECT
        h.employee_id,
        h.schedule_id,
        DATE_FORMAT(h.valid_from, '%Y-%m-%d') AS valid_from,
        DATE_FORMAT(h.valid_to,   '%Y-%m-%d') AS valid_to,
        COALESCE(h.check_in,      s.check_in)      AS check_in,
        COALESCE(h.check_out,     s.check_out)     AS check_out,
        COALESCE(h.tolerance_in,  s.tolerance_in)  AS tolerance_in,
        COALESCE(h.tolerance_out, s.tolerance_out) AS tolerance_out,
        h.break_mode,
        h.break_minutes,
        h.break_after_minutes,
        h.weekly_target_minutes
      FROM employee_schedule_history h
      LEFT JOIN schedules s ON s.id = h.schedule_id
      WHERE h.employee_id IN (${ids.map(() => '?').join(',')})
      ORDER BY h.employee_id, h.valid_from
    `, { replacements: ids });
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    if (!avisoTablaAusente) {
      avisoTablaAusente = true;
      logger.warn(
        'employee_schedule_history no existe (migración 072 sin aplicar): '
        + 'las jornadas se calculan en modo historical_fallback',
      );
    }
    return new Map();
  }

  const porEmpleado = new Map();
  for (const r of rows) {
    const lista = porEmpleado.get(r.employee_id) || [];
    lista.push(normalizeConfigRow(r));
    porEmpleado.set(r.employee_id, lista);
  }
  return porEmpleado;
}

/**
 * Deja la fila lista para el motor.
 *
 * Los TIME de MySQL llegan como 'HH:mm:ss' y el motor los parsea así, pero un
 * driver configurado con `dateStrings` en false puede entregar otra cosa; se
 * normaliza a string acá para que el motor no tenga que adivinar.
 *
 * `weekly_target_minutes` se deja en null cuando no está cargado. No se
 * completa con 2880: el objetivo semanal es un dato de RRHH y suponerlo
 * convertiría una omisión de carga en horas extra o en déficit inventado.
 */
function normalizeConfigRow(r) {
  return {
    schedule_id: r.schedule_id != null ? Number(r.schedule_id) : null,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    check_in: r.check_in != null ? String(r.check_in) : null,
    check_out: r.check_out != null ? String(r.check_out) : null,
    tolerance_in: r.tolerance_in != null ? Number(r.tolerance_in) : 0,
    tolerance_out: r.tolerance_out != null ? Number(r.tolerance_out) : 0,
    break_mode: r.break_mode || 'punched',
    break_minutes: r.break_minutes != null ? Number(r.break_minutes) : 0,
    break_after_minutes: r.break_after_minutes != null ? Number(r.break_after_minutes) : 0,
    weekly_target_minutes: r.weekly_target_minutes != null ? Number(r.weekly_target_minutes) : null,
  };
}

module.exports = {
  loadScheduleHistory,
  normalizeConfigRow,
};
