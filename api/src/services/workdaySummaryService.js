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
 * las fechas afectadas por una marca en `anchorDate` son {anchorDate-1,
 * anchorDate, anchorDate+1}: una jornada se fecha por su PRIMERA entrada, así
 * que la marca en sí pertenece a la del ancla o a la anterior, pero una marca
 * cargada FUERA DE ORDEN puede absorber una huérfana que ya se materializó como
 * fila del día siguiente, y esa fila obsoleta también debe reconciliarse (ver
 * el detalle en resolveSummary). Se lee una ventana ampliada (punchWindow) para
 * no truncar la jornada nocturna, y se recalculan esas tres fechas.
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
 * ¿Está aplicada la migración 074 (ENUM con 'non_working' y 'unconfigured')?
 *
 * Es una condición de ESQUEMA, no la del flag de escritura: 074 puede aplicarse
 * antes o después de habilitar el writer. Mientras 074 NO esté aplicada, escribir
 * esos valores rompería el INSERT (el ENUM no los admite), así que se colapsan a
 * los valores clásicos. Con 074 aplicada, se persisten como corresponde.
 */
function isStatus074Enabled() {
  return process.env.WORKDAY_ENGINE_STATUS_074_ENABLED === 'true';
}

/**
 * Estados que emite el motor → ENUM de daily_summary.
 *
 * `non_working` y `unconfigured` sólo existen en el ENUM con la migración 074
 * aplicada (ver isStatus074Enabled):
 *   - non_working  → 'non_working' con 074; si no, 'weekend' (el valor clásico
 *     más cercano para un día no laborable).
 *   - unconfigured → 'unconfigured' con 074; si no, null → el caller reconcilia
 *     la fila (no se inventa una para un día del que no sabemos nada).
 */
function statusParaDb(status) {
  const con074 = isStatus074Enabled();
  switch (status) {
    case dsEngine.STATUS.PRESENT: return 'present';
    case dsEngine.STATUS.LATE: return 'late';
    case dsEngine.STATUS.ABSENT: return 'absent';
    case dsEngine.STATUS.PERMISSION: return 'permission';
    case dsEngine.STATUS.HOLIDAY: return 'holiday';
    case dsEngine.STATUS.WEEKEND: return 'weekend';
    case dsEngine.STATUS.NON_WORKING: return con074 ? 'non_working' : 'weekend';
    case dsEngine.STATUS.UNCONFIGURED: return con074 ? 'unconfigured' : null;
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

  // Fechas afectadas: {anchorDate-1, anchorDate, anchorDate+1}.
  //   · anchorDate-1: una jornada nocturna que empezó ayer se cierra hoy;
  //   · anchorDate:   la jornada de la propia marca;
  //   · anchorDate+1: aunque una jornada NUNCA se fecha en el futuro, una marca
  //     cargada fuera de orden puede ABSORBER una huérfana que ya se materializó
  //     como fila del día siguiente. Ej.: primero se guarda el OUT del 21 02:00
  //     (fila del 21 con actividad); al cargar después el IN del 20 22:00, la
  //     jornada correcta es del 20 y la fila del 21 queda obsoleta. Reconciliar
  //     anchorDate+1 la limpia en vez de duplicar la actividad en KPI/reportes.
  const from = shiftDate(anchorISO, -1);
  const to = shiftDate(anchorISO, 1);

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

  // anchorDate+1 es RECONCILE-ONLY: la marca del ancla nunca pertenece a una
  // jornada fechada en el futuro, así que esa fecha jamás debe INSERTAR una
  // fila nueva (materializar un día vacío ahí fabricaría una ausencia futura en
  // KPI/reportes). Sólo se usa para ACTUALIZAR o BORRAR una fila obsoleta que un
  // recalc anterior pudo materializar (la huérfana absorbida). Se pasa como set
  // de fechas donde el writer sólo reconcilia lo ya existente.
  const reconcileOnly = new Set([shiftDate(anchorISO, 1)]);

  if (apply) await escribirFilas(employeeId, rows, { reconcileOnly });

  return { rows, affectedDates };
}

/**
 * Escribe las filas de UN empleado en daily_summary, cada una bajo su lock.
 *
 * `opts.reconcileOnly` es un Set de fechas donde NO se puede INSERTAR una fila
 * nueva: sólo se actualiza/borra la que ya exista. Sirve para fechas que la
 * ventana amplió por reconciliación (anchorDate+1) pero a las que la marca del
 * ancla no puede pertenecer; insertar ahí fabricaría un día que nunca existió.
 */
async function escribirFilas(employeeId, rows, opts = {}) {
  const reconcileOnly = opts.reconcileOnly || new Set();
  for (const row of rows) {
    const soloReconciliar = reconcileOnly.has(row.date);
    const status = statusParaDb(row.status);
    if (status == null) {
      // unconfigured: no hay evidencia de jornada para esa fecha. No basta con NO
      // escribir: si el camino legacy ya dejó una fila (absent/holiday/weekend) y
      // después se corrige/elimina la config histórica, esa fila fabricada
      // quedaría visible para siempre. Se RECONCILIA bajo el lock por fecha:
      //   · una fila con JUSTIFICACIÓN MANUAL sobrevive —es una decisión de
      //     RR.HH. que el motor no conoce—, con su estado DERIVADO
      //     (injustificada → 'absent'; otra → 'permission') y sus minutos en cero
      //     (no hay jornada). Así no se pierde una ausencia ni un permiso manual;
      //   · las demás filas (automáticas: absent/holiday/weekend o permiso de
      //     turnera sin justificación) se borran como config obsoleta.
      await withDayRecalcLock(row.date, async (t) => {
        await sequelize.query(
          `UPDATE daily_summary
             SET status = CASE WHEN COALESCE(justification_type, '') = 'injustificada'
                               THEN 'absent' ELSE 'permission' END,
                 first_in = NULL, last_out = NULL,
                 worked_minutes = 0, break_minutes = 0, overtime_minutes = 0, late_minutes = 0
             WHERE employee_id = ? AND date = ?
               AND (justification IS NOT NULL OR justification_type IS NOT NULL)`,
          { replacements: [employeeId, row.date], transaction: t },
        );
        await sequelize.query(
          `DELETE FROM daily_summary
             WHERE employee_id = ? AND date = ?
               AND justification IS NULL AND justification_type IS NULL`,
          { replacements: [employeeId, row.date], transaction: t },
        );
      }, { label: `engineRecalcRec:${row.date}:${employeeId}` });
      continue;
    }
    // ¿La fila recalculada tiene una jornada real? Sólo si NO la tiene se
    // preserva el estado guardado, y SÓLO si es 'permission': un permiso lo
    // carga una justificación manual que el motor no conoce, así que el motor no
    // puede pisarlo. En cambio holiday/weekend son AUTOMÁTICOS —el motor los
    // deriva de la tabla de feriados vigente y de la config—, así que su valor
    // recalculado es el autoritativo: si se desactiva un feriado o el historial
    // vuelve laborable un descanso, el estado nuevo (absent) debe ganar, no
    // quedar congelado sobre una config obsoleta.
    const esDiaVacio = (row.workday_count || 0) === 0;

    if (soloReconciliar) {
      // Fecha RECONCILE-ONLY (anchorDate+1): jamás se inserta una fila nueva
      // —eso fabricaría un día que la marca del ancla no puede haber generado—.
      // Sólo se ACTUALIZA la fila que ya exista (UPDATE no-op si no hay fila),
      // con la misma matemática del motor y la misma preservación de la
      // justificación manual en un día vacío. Si un recalc anterior dejó una
      // huérfana con actividad y la jornada migró a otra fecha, este UPDATE la
      // corrige a su estado real (p. ej. absent con minutos en cero) sin duplicar.
      await withDayRecalcLock(row.date, async (t) => {
        await sequelize.query(`
          UPDATE daily_summary SET
            first_in = ?, last_out = ?,
            worked_minutes = ?, break_minutes = ?, overtime_minutes = ?, late_minutes = ?,
            status = CASE
              WHEN ? = 1 AND (justification IS NOT NULL OR justification_type IS NOT NULL)
                THEN CASE WHEN COALESCE(justification_type, '') = 'injustificada'
                          THEN 'absent' ELSE 'permission' END
              ELSE ?
            END
          WHERE employee_id = ? AND date = ?
        `, {
          replacements: [
            row.first_in || null,
            row.last_out || null,
            row.worked_minutes || 0,
            row.break_minutes || 0,
            row.overtime_minutes || 0,
            row.late_minutes || 0,
            esDiaVacio ? 1 : 0,
            status,
            employeeId, row.date,
          ],
          transaction: t,
        });
      }, { label: `engineRecalcRec:${row.date}:${employeeId}` });
      continue;
    }

    await withDayRecalcLock(row.date, async (t) => {
      await sequelize.query(`
        INSERT INTO daily_summary
          (employee_id, date, first_in, last_out, worked_minutes, break_minutes, overtime_minutes, late_minutes, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          -- first_in se REEMPLAZA, no se conserva: el motor relee toda la
          -- ventana, así que su valor es autoritativo. Si una marca migró a la
          -- jornada anterior y esta fecha queda sin entrada, VALUES(first_in)
          -- es NULL y debe borrar el first_in legacy; conservarlo dejaría una
          -- hora de entrada obsoleta con last_out NULL y minutos en cero.
          first_in       = VALUES(first_in),
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
          -- En un día SIN jornada (?=1), una JUSTIFICACIÓN MANUAL cargada por
          -- RR.HH. gana sobre el estado calculado, con su estado DERIVADO: una
          -- 'injustificada' es una AUSENCIA (→ 'absent'), cualquier otra es un
          -- permiso (→ 'permission'). Así no se pierde ni un permiso ni una
          -- ausencia manual que nómina/reportes legales deben contabilizar. Los
          -- estados AUTOMÁTICOS (holiday/weekend, permiso de turnera) no tienen
          -- justificación, así que el motor los recalcula. Con jornada real
          -- (?=0), el estado trabajado gana.
          status = CASE
            WHEN ? = 1 AND (daily_summary.justification IS NOT NULL OR daily_summary.justification_type IS NOT NULL)
              THEN CASE WHEN COALESCE(daily_summary.justification_type, '') = 'injustificada'
                        THEN 'absent' ELSE 'permission' END
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
          esDiaVacio ? 1 : 0,
        ],
        transaction: t,
      });
    }, { label: `engineRecalc:${row.date}:${employeeId}` });
  }
}

/**
 * Recálculo en bloque para una fecha, POR LOTE de empleados.
 *
 * Lee marcajes, feriados y configuración UNA sola vez para todo el lote (no por
 * empleado): loadWorkdayConfig ya acepta un array de ids y resuelve en memoria.
 * Así un reproceso de cientos de empleados por decenas de días no dispara miles
 * de viajes a la base. Incluye a los empleados SIN marcas para materializar sus
 * días vacíos desde la config histórica.
 *
 * @param {number[]} employeeIds
 * @param {string} date  fecha objetivo 'YYYY-MM-DD'.
 * @param {object} [opts] - `apply` escribir (por defecto false).
 * @returns {Promise<{ rowsByEmployee: Map<number, Array> }>}
 */
async function resolveSummaryBatchForDate(employeeIds, date, opts = {}) {
  const apply = opts.apply === true;
  const ids = [...new Set((employeeIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return { rowsByEmployee: new Map() };

  const from = shiftDate(date, -1);
  const to = date;
  const ventana = engine.punchWindow({ from, to });

  // Una lectura de marcajes para TODO el lote; una carga de config; un set de
  // feriados. El resto se resuelve en memoria.
  const [todosPunches, config, holidays] = await Promise.all([
    leerMarcajesLote(ids, ventana),
    loadWorkdayConfig(ids, { from, to }),
    leerFeriados(from, to),
  ]);

  const porEmpleado = new Map();
  for (const p of todosPunches) {
    const arr = porEmpleado.get(p.employee_id) || [];
    arr.push(p);
    porEmpleado.set(p.employee_id, arr);
  }

  const rowsByEmployee = new Map();
  for (const employeeId of ids) {
    const rows = dsEngine.buildDailySummaryRows(porEmpleado.get(employeeId) || [], {
      from,
      to,
      holidays,
      resolveConfig: (workDate) => config.forDate(employeeId, workDate),
      materializeEmptyDates: true,
    });
    rowsByEmployee.set(employeeId, rows);
    if (apply) await escribirFilas(employeeId, rows);
  }

  return { rowsByEmployee };
}

/** Marcajes wall-clock de VARIOS empleados en la ventana. */
async function leerMarcajesLote(employeeIds, ventana) {
  const marcas = employeeIds.map(() => '?').join(',');
  const [rows] = await sequelize.query(`
    SELECT al.employee_id, al.id,
           DATE_FORMAT(al.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp,
           al.type
    FROM attendance_logs al
    WHERE al.employee_id IN (${marcas})
      AND al.timestamp >= ? AND al.timestamp < ?
    ORDER BY al.employee_id, al.timestamp, al.id
  `, { replacements: [...employeeIds, ventana.from, ventana.to] });
  return rows;
}

module.exports = {
  isEngineSummaryWriteEnabled,
  resolveSummary,
  resolveSummaryBatchForDate,
  statusParaDb,
  anchorDateISO,
  shiftDate,
};
