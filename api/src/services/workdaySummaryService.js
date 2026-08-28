/**
 * workdaySummaryService.js — El ÚNICO camino de escritura de daily_summary
 * basado en el motor.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * QUÉ CIERRA
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Antes había DOS matemáticas: Marcadas pasaba por WorkdayEngine, pero
 * `recalcDailySummary` (operativo) calculaba por su cuenta —fecha civil, first
 * IN/last OUT propios, sábado/domingo hardcodeado, employees.schedule_id
 * ACTUAL—. Dos algoritmos sobre los mismos datos dan dos respuestas.
 *
 * Este servicio deja UN solo camino:
 *
 *   attendance_logs → WorkdayEngine → dailySummaryEngine → writer
 *
 * Reutiliza EXACTAMENTE el motor que usa Marcadas. No duplica first_in,
 * last_out, worked_minutes, late_minutes, break_minutes ni status.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * UNA MARCA PUEDE AFECTAR EL DÍA LABORAL ANTERIOR
 * ═══════════════════════════════════════════════════════════════════════
 *
 * No se recalcula `DATE(timestamp)` como única fecha. Un OUT de madrugada
 * (02/12 07:04) cierra una jornada que empezó el día anterior (01/12). Por eso
 * las fechas afectadas por una marca en `anchorDate` son, a lo sumo,
 * {anchorDate-1, anchorDate}: una jornada se fecha por su PRIMERA entrada, así
 * que una marca nunca puede pertenecer a una jornada fechada en el futuro. Se
 * lee una ventana ampliada (punchWindow) para no truncar la jornada nocturna, y
 * se recalculan esas dos fechas.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ESCRITURA CONTROLADA POR FLAG (default OFF)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `resolveSummary` es puro-lectura: devuelve las filas y las fechas afectadas.
 * Sólo escribe cuando el caller pide APPLY. En producción el flag
 * WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED arranca en OFF: el recalc operativo
 * conserva su comportamiento legacy hasta habilitar el rollout, y el
 * dry-run/auditor puede ejercitar este camino sin escribir.
 */

'use strict';

const { sequelize } = require('../config/database');
const engine = require('./workdayEngine');
const dsEngine = require('./dailySummaryEngine');
const { loadWorkdayConfig } = require('./workdayConfig');
const { withDayRecalcLock } = require('./recalcLock');
const { dbDateISO } = require('../utils/dbTime');

/** ¿Está habilitada la escritura de daily_summary por el motor nuevo? */
function isEngineSummaryWriteEnabled() {
  return process.env.WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED === 'true';
}

/** Fecha civil (wall-clock) de la marca ancla, en aritmética sin zona. */
function anchorDateISO(anchor) {
  // Acepta el string wall-clock persistido o un Date; dbDateISO deshace la
  // conversión del driver si viniera un Date.
  return dbDateISO(anchor) || (typeof anchor === 'string' ? anchor.slice(0, 10) : null);
}

/** Suma `dias` a una fecha 'YYYY-MM-DD' en aritmética de pared. */
function shiftDate(dateISO, dias) {
  const w = engine.toWall(`${dateISO} 00:00:00`);
  return engine.absToDateISO(w.abs + dias * 86400);
}

/**
 * Estados que emite el motor → ENUM real de daily_summary.
 *
 * `non_working` y `unconfigured` NO existen todavía en el ENUM (migración 074
 * propuesta, no ejecutada). Mientras tanto:
 *   - non_working  → 'weekend' (día no laborable, el valor más cercano).
 *   - unconfigured → null: no se escribe una fila inventada para un día del que
 *     no sabemos nada. El caller omite esas fechas.
 */
function statusParaDb(status) {
  switch (status) {
    case dsEngine.STATUS.PRESENT: return 'present';
    case dsEngine.STATUS.LATE: return 'late';
    case dsEngine.STATUS.ABSENT: return 'absent';
    case dsEngine.STATUS.PERMISSION: return 'permission';
    case dsEngine.STATUS.HOLIDAY: return 'holiday';
    case dsEngine.STATUS.WEEKEND: return 'weekend';
    case dsEngine.STATUS.NON_WORKING: return 'weekend';
    case dsEngine.STATUS.UNCONFIGURED: return null;
    default: return null;
  }
}

/**
 * Lee marcajes wall-clock de un empleado en la ventana [from, to] ampliada.
 * DATE_FORMAT devuelve la hora de pared cruda, independiente de la zona del
 * driver, que es lo que el motor necesita.
 */
async function leerMarcajes(employeeId, ventana) {
  const [rows] = await sequelize.query(`
    SELECT al.id,
           DATE_FORMAT(al.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp,
           al.type
    FROM attendance_logs al
    WHERE al.employee_id = ?
      AND al.timestamp >= ? AND al.timestamp < ?
    ORDER BY al.timestamp, al.id
  `, { replacements: [employeeId, ventana.from, ventana.to] });
  return rows;
}

/** Feriados activos dentro de [from, to] como Set de 'YYYY-MM-DD'. */
async function leerFeriados(from, to) {
  const [rows] = await sequelize.query(
    `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d FROM holidays WHERE active = 1 AND date >= ? AND date <= ?`,
    { replacements: [from, to] },
  );
  return new Set(rows.map((r) => r.d));
}

/**
 * Calcula (y opcionalmente escribe) las filas de daily_summary afectadas por
 * una marca del empleado.
 *
 * @param {number} employeeId
 * @param {string|Date} anchor  timestamp wall-clock de la marca que disparó el recalc.
 * @param {object} [opts]
 *        - `apply`  escribir en daily_summary (por defecto false).
 * @returns {Promise<{ rows: Array, affectedDates: string[] }>}
 */
async function resolveSummary(employeeId, anchor, opts = {}) {
  const apply = opts.apply === true;
  const anchorISO = anchorDateISO(anchor);
  if (!anchorISO) throw new Error(`Ancla de recalc inválida: ${anchor}`);

  // Fechas afectadas: la del ancla y la anterior (una jornada nocturna que
  // empezó ayer se cierra hoy). Nunca la posterior: una marca no puede
  // pertenecer a una jornada fechada en el futuro.
  const from = shiftDate(anchorISO, -1);
  const to = anchorISO;

  const ventana = engine.punchWindow({ from, to });
  const [punches, config, holidays] = await Promise.all([
    leerMarcajes(employeeId, ventana),
    loadWorkdayConfig([employeeId], { from, to }),
    leerFeriados(from, to),
  ]);

  const rows = dsEngine.buildDailySummaryRows(punches, {
    from,
    to,
    holidays,
    resolveConfig: (workDate) => config.forDate(employeeId, workDate),
    materializeEmptyDates: true,
  });

  const affectedDates = rows.map((r) => r.date);

  if (apply) {
    for (const row of rows) {
      const status = statusParaDb(row.status);
      if (status == null) continue; // unconfigured: no se escribe una fila inventada
      await withDayRecalcLock(row.date, async (t) => {
        await sequelize.query(`
          INSERT INTO daily_summary
            (employee_id, date, first_in, last_out, worked_minutes, break_minutes, overtime_minutes, late_minutes, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            first_in       = COALESCE(VALUES(first_in), first_in),
            last_out       = VALUES(last_out),
            worked_minutes = VALUES(worked_minutes),
            -- Se materializan TODOS los campos derivados del motor, no sólo
            -- algunos: dejar break/overtime sin escribir conservaría valores
            -- legacy obsoletos. En particular un overtime_minutes viejo y
            -- positivo podría seguir acreditándose en el banco de horas después
            -- de que el motor lo recalculó en cero (el motor no computa hora
            -- extra legal: la deja en 0 hasta que exista una política).
            break_minutes    = VALUES(break_minutes),
            overtime_minutes = VALUES(overtime_minutes),
            late_minutes     = VALUES(late_minutes),
            -- Se PRESERVAN los estados cargados a mano / por justificación:
            -- un feriado, un fin de semana o un permiso ya guardado no se pisa
            -- con el estado calculado (mismo criterio que el recálculo legacy).
            -- Recalcular ayer por una marca de hoy no puede borrar un permission
            -- que sigue justificado, aunque el materializador vería 'absent'.
            status = CASE
              WHEN daily_summary.status IN ('holiday','weekend','permission') THEN daily_summary.status
              ELSE VALUES(status)
            END
        `, {
          replacements: [
            employeeId, row.date,
            row.first_in || null,
            row.last_out || null,
            // worked_minutes = PERMANENCIA (presence), que es la semántica
            // histórica de la columna; el modo por defecto del materializador ya
            // usa presence. Cambiarla a neto es una decisión de negocio aparte.
            row.worked_minutes || 0,
            row.break_minutes || 0,
            // El motor no computa hora extra legal: siempre 0. Escribirlo limpia
            // cualquier overtime legacy que quedara colgado.
            row.overtime_minutes || 0,
            row.late_minutes || 0,
            status,
          ],
          transaction: t,
        });
      }, { label: `engineRecalc:${row.date}:${employeeId}` });
    }
  }

  return { rows, affectedDates };
}

module.exports = {
  isEngineSummaryWriteEnabled,
  resolveSummary,
  statusParaDb,
  anchorDateISO,
  shiftDate,
};
